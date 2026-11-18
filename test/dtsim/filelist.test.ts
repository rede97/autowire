import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolPath, writeFlatFilelist } from "../../src/dtsim/core/filelist.ts";

describe("filelist flattening", () => {
	test("nested -f, files and +incdir resolve against the project root", async () => {
		const root = await mkdtemp(join(tmpdir(), "dtsim-fl-"));
		await mkdir(join(root, "rtl"), { recursive: true });
		await mkdir(join(root, "dt", "config"), { recursive: true });
		// rtl/soc.f is itself project-relative, as autowire.toml filelists are.
		await writeFile(
			join(root, "rtl", "soc.f"),
			"# leaves\nrtl/a.sv\n\nrtl/b.sv\n",
		);
		const top = join(root, "dt", "config", "file.lst");
		await writeFile(
			top,
			[
				"// sim universe",
				"+incdir+dt+rtl/inc",
				"-f rtl/soc.f",
				"dt/tb.sv",
				"$UVM_HOME/src/uvm.sv",
				"+define+FOO=1",
				"-v ip/lib.v",
				// biome-ignore lint/suspicious/noTemplateCurlyInString: dtsim placeholder
				"${verify}/extra.sv",
			].join("\n"),
		);
		const out = join(root, "dt", "simout", "filelist.f");
		await mkdir(join(root, "dt", "simout"), { recursive: true });
		writeFlatFilelist(top, out, root, (t) =>
			// biome-ignore lint/suspicious/noTemplateCurlyInString: dtsim placeholder
			t.replace("${verify}", join(root, "dt", "config")),
		);
		const r = (p: string) => toolPath(join(root, p));
		const lines = (await readFile(out, "utf8")).split("\n").slice(1, -1);
		expect(lines).toEqual([
			`+incdir+${r("dt")}+${r("rtl/inc")}`,
			r("rtl/a.sv"),
			r("rtl/b.sv"),
			r("dt/tb.sv"),
			"$UVM_HOME/src/uvm.sv",
			"+define+FOO=1",
			`-v ${r("ip/lib.v")}`,
			r("dt/config/extra.sv"),
		]);
	});

	test("missing nested filelist names its parent; cycles are rejected", async () => {
		const root = await mkdtemp(join(tmpdir(), "dtsim-fl-"));
		const a = join(root, "a.f");
		await writeFile(a, "-f nope.f\n");
		expect(() =>
			writeFlatFilelist(a, join(root, "o.f"), root, (t) => t),
		).toThrow(/filelist not found: .*nope\.f \(from .*a\.f\)/);
		await writeFile(a, "-f b.f\n");
		await writeFile(join(root, "b.f"), "-f a.f\n");
		expect(() =>
			writeFlatFilelist(a, join(root, "o.f"), root, (t) => t),
		).toThrow("filelist cycle");
	});
});
