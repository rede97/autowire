// Shared helpers for the fsm compiler tests: doc blocks and demo sources.
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	compileFsm,
	fsmDslPath,
	Sources,
} from "../../../src/plugins/fsm/generate.ts";

export const root = join(import.meta.dir, "../../..");
export const demo = join(root, "demo/state");
const md = readFileSync(join(root, "docs/state/async-fsm.md"), "utf8");
const blocks = (lang: string) =>
	[...md.matchAll(new RegExp(`\`\`\`${lang}\\n([\\s\\S]*?)\`\`\``, "g"))].map(
		(m) => m[1] ?? "",
	);
export const docJs = blocks("js");
export const docSv = blocks("systemverilog");

export const IMPORT =
	'import { FsmGroup, Fsm, FsmPort, Input, Output, Dff, Const, PushPort, PopPort, Chan, Instance, Caller, Escape, Raise, SvEnum, ALWAYS_0, ALWAYS_1, SvPackage, SvFunction } from "./dsl.mjs";\n';

/** Compile a whole source (imports added); `more` are other in-memory files it may import.
 *  Returns the file without its 2-line header. */
export async function compileText(
	text: string,
	more: Record<string, string> = {},
): Promise<string> {
	const dir = import.meta.dir;
	const files = new Map(
		Object.entries({ "x.mjs": text, ...more }).map(([f, t]) => [
			join(dir, f).toLowerCase(),
			IMPORT + t,
		]),
	);
	const sources = new Sources(dir, join(dir, "dsl.mjs"), async (p) => {
		const t = files.get(p.toLowerCase());
		return t ?? readFile(p, "utf8");
	});
	const g = await compileFsm(sources, join(dir, "x.mjs"));
	return g.sv.split("\n").slice(2).join("\n");
}

/** Compile class-body text inside an @FsmGroup class. */
export const compileBody = (body: string) =>
	compileText(`@FsmGroup\nclass G {\n${body}\n}\n`);

/** The doc's DSL for `name`: a method fragment, or a whole file when it holds a class. */
export function docDsl(name: string): { text: string; whole: boolean } {
	const b = docJs.find((x) => x.includes(`async ${name}(`));
	if (!b) throw new Error(`doc has no DSL for ${name}`);
	return { text: b, whole: b.includes("class ") };
}

/** The doc's SV for `name` as its units (each package ... endpackage, each
 *  commented module ... endmodule). A generated file puts every package first,
 *  so a doc block that shows one module's package next to the module is checked
 *  unit by unit. */
export function docModule(name: string): string[] {
	const sv = docSv.find((b) => b.startsWith(`package ${name}_pkg;`));
	if (!sv) throw new Error(`doc has no SV for ${name}`);
	return sv
		.split(/\n\n(?=(?:\/\/.*\n)*(?:package|module) )/)
		.map((u) => (u.endsWith("\n") ? u : `${u}\n`));
}

export async function compileDemo(file: string) {
	return compileFsm(new Sources(demo, fsmDslPath(demo)), join(demo, file));
}
