#!/usr/bin/env bun
// 拉取测试语料与 RTL 项目（docs/hdxml/testing.md）：blobless + sparse 浅克隆，
// 提交哈希记录到 tests/MANIFEST.txt 以便复现。
// 用法: bun hdxml/tests/fetch.ts [名称...]  （无参数 = 全部）
import {
	appendFileSync,
	existsSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

const root = import.meta.dir;
const manifest = join(root, "MANIFEST.txt");

interface Target {
	name: string;
	kind: "corpus" | "projects";
	url: string;
	branch: string;
	sparse: string[];
}

const TARGETS: Target[] = [
	{
		name: "sv-parser",
		kind: "corpus",
		url: "https://github.com/dalance/sv-parser.git",
		branch: "master",
		sparse: ["sv-parser/testcases"],
	},
	{
		name: "slang",
		kind: "corpus",
		url: "https://github.com/MikePopoloski/slang.git",
		branch: "master",
		sparse: ["tests/unittests/data", "tests/regression"],
	},
	{
		name: "verible",
		kind: "corpus",
		url: "https://github.com/chipsalliance/verible.git",
		branch: "master",
		sparse: ["verible/verilog"],
	},
	{
		name: "verilog-mode",
		kind: "corpus",
		url: "https://github.com/veripool/verilog-mode.git",
		branch: "master",
		sparse: ["tests", "tests_ok"],
	},
	{
		name: "ibex",
		kind: "projects",
		url: "https://github.com/lowRISC/ibex.git",
		branch: "master",
		sparse: [
			"rtl",
			"dv",
			"vendor/lowrisc_ip/ip/prim/rtl",
			"vendor/lowrisc_ip/dv/sv/dv_utils",
		],
	},
	{
		name: "cv32e40p",
		kind: "projects",
		url: "https://github.com/openhwgroup/cv32e40p.git",
		branch: "master",
		sparse: ["rtl", "bhv"],
	},
	{
		name: "cva6",
		kind: "projects",
		url: "https://github.com/openhwgroup/cva6.git",
		branch: "master",
		sparse: ["core"],
	},
	{
		name: "cv-hpdcache",
		kind: "projects",
		url: "https://github.com/openhwgroup/cv-hpdcache.git",
		branch: "master",
		sparse: ["rtl"],
	},
	{
		name: "common_cells",
		kind: "projects",
		url: "https://github.com/pulp-platform/common_cells.git",
		branch: "master",
		sparse: ["src", "include"],
	},
	{
		name: "axi",
		kind: "projects",
		url: "https://github.com/pulp-platform/axi.git",
		branch: "master",
		sparse: ["src", "include"],
	},
	{
		name: "apb",
		kind: "projects",
		url: "https://github.com/pulp-platform/apb.git",
		branch: "master",
		sparse: ["src", "include"],
	},
	{
		name: "veer-el2",
		kind: "projects",
		url: "https://github.com/chipsalliance/Cores-VeeR-EL2.git",
		branch: "main",
		sparse: ["design", "configs", "tools"],
	},
	{
		name: "opentitan",
		kind: "projects",
		url: "https://github.com/lowRISC/opentitan.git",
		branch: "master",
		sparse: ["hw/ip/uart", "hw/ip/tlul", "hw/ip/prim"],
	},
];

function sh(cmd: string[], cwd?: string): number {
	return Bun.spawnSync({ cmd, cwd, stdout: "inherit", stderr: "inherit" })
		.exitCode;
}

function shOut(cmd: string[], cwd?: string): string {
	return new TextDecoder().decode(Bun.spawnSync({ cmd, cwd }).stdout).trim();
}

function fetch(t: Target): boolean {
	const dest = join(root, t.kind, t.name);
	if (existsSync(join(dest, ".git"))) {
		console.log(`== ${t.name}: already present, skipping (delete to re-fetch)`);
		return true;
	}
	console.log(`== ${t.name} -> ${dest}`);
	const code = sh([
		"git",
		"clone",
		"-q",
		"--depth",
		"1",
		"--filter=blob:none",
		"--sparse",
		"--branch",
		t.branch,
		t.url,
		dest,
	]);
	if (code !== 0) {
		console.error(`!! ${t.name} clone failed`);
		return false;
	}
	sh(["git", "sparse-checkout", "set", ...t.sparse], dest);
	const sha = shOut(["git", "rev-parse", "HEAD"], dest);
	appendFileSync(manifest, `${t.name.padEnd(16)} ${sha}  ${t.url}\n`);
	console.log(`   ${t.name} @ ${sha}`);
	return true;
}

const names = process.argv.slice(2);
if (names.length === 0) {
	writeFileSync(manifest, "");
	for (const t of TARGETS) fetch(t);
} else {
	for (const n of names) {
		const t = TARGETS.find((x) => x.name === n);
		if (!t) {
			console.error(
				`unknown target: ${n} (choices: ${TARGETS.map((x) => x.name).join(" ")})`,
			);
			process.exit(2);
		}
		fetch(t);
	}
}

console.log("\n== done, stats:");
for (const kind of ["corpus", "projects"]) {
	for (const e of readdirSync(join(root, kind), { withFileTypes: true })) {
		if (!e.isDirectory()) continue;
		let n = 0;
		const count = (dir: string) => {
			for (const f of readdirSync(dir, { withFileTypes: true })) {
				if (f.name === ".git") continue;
				const p = join(dir, f.name);
				if (f.isDirectory()) count(p);
				else if (/\.(sv|v|svh)$/.test(f.name)) n++;
			}
		};
		count(join(root, kind, e.name));
		console.log(`   ${join(kind, e.name).padEnd(40)} ${n} SV-related files`);
	}
}
