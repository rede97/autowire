// `plugin fsm run`: compile every [fsm.<id>] mjs= source into
// plugins_dir/fsm/<Group>.sv (docs/state/async-fsm.md §11).

import { mkdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { Node } from "@babel/types";
import { writeIfChanged } from "../../core/write.ts";
import type { WorkspaceConfig } from "../../workspace.ts";
import { BodyCompiler, type Shared } from "./cfg.ts";
import { emitGroup } from "./emit.ts";
import { type Loader, parseUnit } from "./front.ts";
import { lower } from "./lower.ts";
import type { Fsm, FsmMethod, Unit } from "./model.ts";
import { FsmError, Src } from "./source.ts";

export interface CompiledGroup {
	/** Output file stem (`@FsmGroup({ file })`, default the class name). */
	file: string;
	sv: string;
	/** Absolute paths of the groups this one instantiates (other files). */
	instantiates: string[];
	/** Absolute paths of the files whose @SvEnum types this one imports. */
	enumFiles: string[];
	/** SV packages this file declares (@SvEnum). */
	packages: string[];
}

/** Parses fsm sources by absolute path, each once; `root` makes the printed paths relative. */
export class Sources {
	private readonly units = new Map<string, Promise<Unit>>();
	private readonly busy = new Set<string>();
	constructor(
		private readonly root: string,
		private readonly dsl: string,
		/** Source text by absolute path; defaults to the file on disk. */
		private readonly read: (abs: string) => Promise<string> = (p) =>
			readFile(p, "utf8"),
	) {}

	file(abs: string): string {
		return relative(this.root, abs).split(sep).join("/");
	}

	unit(abs: string, text?: string): Promise<Unit> {
		const key = process.platform === "win32" ? abs.toLowerCase() : abs;
		let u = this.units.get(key);
		if (!u) {
			u = this.parse(abs, key, text);
			this.units.set(key, u);
		}
		return u;
	}

	private async parse(abs: string, key: string, text?: string): Promise<Unit> {
		const src: Src = new Src(this.file(abs), text ?? (await this.read(abs)));
		this.busy.add(key);
		const load: Loader = async (target, from, node) => {
			const k = process.platform === "win32" ? target.toLowerCase() : target;
			if (this.busy.has(k))
				from.fail(node, `import cycle: ${this.file(target)} imports this file`);
			try {
				return await this.unit(target);
			} catch (e) {
				if (e instanceof Error && "code" in e && e.code === "ENOENT")
					return from.fail(node, `no such fsm source: ${this.file(target)}`);
				throw e;
			}
		};
		try {
			return await parseUnit(src, { abs, dsl: this.dsl, load });
		} finally {
			this.busy.delete(key);
		}
	}
}

/** Every `Instance(<obj>.<method>, ...)` call under `node`. */
function instanceTargets(node: Node, unit: Unit): FsmMethod[] {
	const out: FsmMethod[] = [];
	const walk = (n: unknown): void => {
		if (Array.isArray(n)) {
			for (const c of n) walk(c);
			return;
		}
		if (!n || typeof n !== "object" || !("type" in n)) return;
		const x = n as Node;
		const t = x.type === "CallExpression" ? x.arguments[0] : undefined;
		if (
			x.type === "CallExpression" &&
			x.callee.type === "Identifier" &&
			unit.builtins.get(x.callee.name) === "Instance" &&
			t?.type === "MemberExpression" &&
			t.property.type === "Identifier"
		) {
			const g =
				t.object.type === "ThisExpression"
					? unit.group
					: t.object.type === "Identifier"
						? unit.groups.get(t.object.name)
						: undefined;
			const name = t.property.name;
			const m = g?.methods.find((y) => y.name === name);
			if (m) out.push(m);
		}
		for (const [k, v] of Object.entries(x))
			if (
				k !== "loc" &&
				k !== "leadingComments" &&
				k !== "trailingComments" &&
				k !== "innerComments"
			)
				walk(v);
	};
	walk(node);
	return out;
}

/** Compile the @FsmGroup of `abs` (its imports load through `sources`). */
export async function compileFsm(
	sources: Sources,
	abs: string,
	text?: string,
): Promise<CompiledGroup> {
	const unit = await sources.unit(abs, text);
	const src: Src = unit.src;
	const g = unit.group;
	if (!g) throw new FsmError(`${src.file}: no @FsmGroup class`);
	// An instance cycle inside the group would never elaborate.
	const state = new Map<FsmMethod, "busy" | "done">();
	const visit = (m: FsmMethod) => {
		if (state.get(m) === "done") return;
		state.set(m, "busy");
		for (const t of instanceTargets(m.node.body, unit)) {
			if (t.group !== g) continue;
			if (state.get(t) === "busy")
				src.fail(m.node.key, `instance cycle: ${m.name} → ${t.name}`);
			visit(t);
		}
		state.set(m, "done");
	};
	const shared: Shared = { used: new Set(), results: new Map() };
	const fsms: Fsm[] = [];
	const instantiates = new Set<string>();
	const modules = new Set<string>();
	const add = (f: Fsm, node: Node) => {
		for (const name of [f.name, f.options.wrap ?? []].flat()) {
			if (modules.has(name))
				src.fail(node, `module ${name} is generated twice in this group`);
			modules.add(name);
		}
		fsms.push(f);
	};
	for (const m of g.methods) {
		if (m.sub) continue;
		visit(m);
		for (const t of instanceTargets(m.node.body, unit))
			if (t.group !== g) instantiates.add(t.group.unit.abs);
		const body = new BodyCompiler(unit, shared).compile(m);
		add(lower(src, m, body), m.node.key);
		// Caller servers (§5.4) follow the module that declares them.
		for (const s of body.servers) {
			const sb = new BodyCompiler(s.group.unit, shared).compile(s);
			add(lower(s.group.unit.src, s, sb), m.node.key);
		}
	}
	if (!g.exported)
		for (const m of g.methods)
			if (m.sub && !shared.used.has(m.node))
				src.fail(m.node.key, `sub-FSM ${m.name} is never called (§5)`);
	return {
		file: g.file,
		sv: emitGroup(
			{ name: g.name, comment: g.comment, fsms, enums: unit.ownEnums },
			src.file,
		),
		instantiates: [...instantiates],
		enumFiles: [
			...new Set(
				[...unit.enums.values()]
					.filter((t) => t.abs !== unit.abs)
					.map((t) => t.abs),
			),
		],
		packages: [...new Set(unit.ownEnums.map((t) => t.pkg))],
	};
}

/** Where the materialized DSL lives (src/plugins/fsm/dsl.mjs in the pack). */
export function fsmDslPath(root: string): string {
	return join(root, ".autowire", "dsl", "fsm", "dsl.mjs");
}

export async function generateAll(
	ws: WorkspaceConfig,
	only: string | undefined,
	force: boolean,
): Promise<string[]> {
	let sources = ws.fsmSources;
	if (only) {
		sources = sources.filter((s) => s.id === only);
		if (sources.length === 0)
			throw new Error(
				`fsm: no [fsm.${only}] in autowire.toml (have: ${ws.fsmSources.map((s) => s.id).join(", ")})`,
			);
	}
	const parsed = new Sources(ws.root, fsmDslPath(ws.root));
	const norm = (p: string) =>
		process.platform === "win32" ? p.toLowerCase() : p;
	const registered = new Set(ws.fsmSources.map((s) => norm(s.mjs)));
	const dir = ws.fsmDir;
	const groups = new Map<string, string>();
	const pkgs = new Map<string, string>();
	const outputs: { path: string; text: string }[] = [];
	for (const s of sources) {
		const g = await compileFsm(parsed, s.mjs);
		const file = parsed.file(s.mjs);
		for (const t of [...g.instantiates, ...g.enumFiles])
			if (!registered.has(norm(t)))
				throw new Error(
					`fsm: ${file} uses a module or an @SvEnum of ${parsed.file(t)}, which is not an [fsm.<id>] source`,
				);
		for (const p of g.packages) {
			const other = pkgs.get(p);
			if (other)
				throw new Error(
					`fsm: SV package ${p} is declared by @SvEnum in both ${other} and ${file}`,
				);
			pkgs.set(p, file);
		}
		// Keyed case-insensitively: Windows and macOS file systems fold case.
		const key = g.file.toLowerCase();
		const prev = groups.get(key);
		if (prev)
			throw new Error(
				`fsm: ${prev} and ${file} both write ${g.file}.sv; set @FsmGroup({ file }) apart`,
			);
		groups.set(key, file);
		outputs.push({ path: join(dir, `${g.file}.sv`), text: g.sv });
	}
	await mkdir(dir, { recursive: true });
	const paths: string[] = [];
	for (const o of outputs)
		if (await writeIfChanged(o.path, o.text, force)) paths.push(o.path);
	return paths;
}
