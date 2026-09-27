import type { Command } from "commander";
import { loadPack, unpackPack } from "./pack.ts";

export function registerDocs(program: Command): void {
	const docs = program.command("docs").description("Bundled docs and demos");
	docs
		.command("unpack")
		.description("Write the bundled docs/ and demo/ tree to a directory")
		.argument("<dir>", "destination directory")
		.action(async (dir: string) => {
			const files = await loadPack();
			const written = await unpackPack(files, dir);
			console.log(`unpacked ${written.length} files to ${dir}`);
		});
}
