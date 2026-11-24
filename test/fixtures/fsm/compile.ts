// Shared helpers for the fsm compiler tests: doc blocks and demo sources.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	compileFsmSource,
	fsmDslPath,
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

const IMPORT =
	'import { FsmGroup, Fsm, Input, Output, Dff, Const, ALWAYS_0, ALWAYS_1, SvPackage, SvFunction } from "./dsl.mjs";\n';

/** Compile a whole source (imports added); returns the file without its 2-line header. */
export async function compileText(text: string): Promise<string> {
	const g = await compileFsmSource({
		file: "x.mjs",
		abs: join(import.meta.dir, "x.mjs"),
		text: IMPORT + text,
		dsl: join(import.meta.dir, "dsl.mjs"),
	});
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

export function docModule(name: string): string {
	const sv = docSv.find((b) => b.startsWith(`package ${name}_pkg;`));
	if (!sv) throw new Error(`doc has no SV for ${name}`);
	return sv;
}

export async function compileDemo(file: string) {
	const abs = join(demo, file);
	return compileFsmSource({
		file,
		abs,
		text: readFileSync(abs, "utf8"),
		dsl: fsmDslPath(demo),
	});
}
