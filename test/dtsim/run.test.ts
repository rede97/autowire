import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../../src/dtsim/core/run.ts";

// A child that colours a line, redraws a progress line with \r and leaves
// its last line without a newline.
const SCRIPT =
	"printf '\\033[31mred\\033[0m line\\n'; printf 'step 1\\rstep 2\\rdone\\n'; printf 'tail'; exit 3";

describe("runProcess output lines", () => {
	for (const pty of [false, true]) {
		test(`${pty ? "pty (POSIX) / pipes (Windows)" : "pipes"}: lines arrive cleaned, the tee log gets them`, async () => {
			const dir = mkdtempSync(join(tmpdir(), "dtsim-run-"));
			const log = join(dir, "out.log");
			const lines: string[] = [];
			const code = await runProcess({
				argv: ["bash", "-c", SCRIPT],
				cwd: dir,
				env: { ...process.env } as Record<string, string>,
				captureLog: log,
				verbose: false,
				interactive: false,
				onLine: (line) => lines.push(line),
				pty,
			});
			expect(code).toBe(3);
			expect(lines).toEqual(["red line", "done", "tail"]);
			// On a PTY the log holds the cleaned lines; on pipes, the raw bytes.
			const text = readFileSync(log, "utf8");
			expect(text).toContain(
				pty && process.platform !== "win32" ? "red line\ndone\ntail\n" : "done",
			);
		});
	}
});
