import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TOML, findWorkspace, hdxmlArgs, loadWorkspace } from "./workspace.js";

function tempWorkspace(toml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "aw_ws_test_"));
  writeFileSync(join(dir, "autowire.toml"), toml);
  return dir;
}

describe("workspace", () => {
  test("默认模板可解析且映射为最小参数集", async () => {
    const dir = tempWorkspace(DEFAULT_TOML.replace('walk_dirs = ["rtl"]', "walk_dirs = []"));
    const cfg = await loadWorkspace(join(dir, "autowire.toml"));
    expect(cfg.root).toBe(dir);
    expect(cfg.indexDir).toBe(join(dir, ".autowire/hdxml"));
    expect(cfg.dumpDir).toBe(join(dir, "gen"));
    expect(hdxmlArgs(cfg)).toEqual(["--xml", join(dir, ".autowire/hdxml")]);
  });

  test("analysis.* 映射：defines 带值→-D，keep_raw→--keep-raw，数字值字符串化", async () => {
    const dir = tempWorkspace(`
[analysis]
keep_raw = ["ENV_MACRO", "WIDTH"]
define_headers = ["include/defs.svh"]

[analysis.rtl]
walk_dirs = ["rtl"]
incdirs = ["rtl/include"]
exclude_filenames = ["tb_top.sv"]

[analysis.defines]
SYNTHESIS = "1"
DEPTH = 16
`);
    const cfg = await loadWorkspace(join(dir, "autowire.toml"));
    expect(cfg.keepRaw).toEqual(["ENV_MACRO", "WIDTH"]);
    expect(cfg.defines).toEqual({ SYNTHESIS: "1", DEPTH: "16" });
    expect(hdxmlArgs(cfg)).toEqual([
      "-w", join(dir, "rtl"),
      "--exclude-filenames", "tb_top.sv",
      "-I", join(dir, "rtl/include"),
      "--define-headers", join(dir, "include/defs.svh"),
      "-D", "DEPTH=16", "SYNTHESIS=1",
      "--keep-raw", "ENV_MACRO", "WIDTH",
      "--xml", join(dir, ".autowire/hdxml"),
    ]);
  });

  test("defines 空串已废弃：报错并指向 keep_raw", async () => {
    const dir = tempWorkspace('[analysis.defines]\nWIDTH = ""\n');
    await expect(loadWorkspace(join(dir, "autowire.toml"))).rejects.toThrow("keep_raw");
  });

  test("findWorkspace 自子目录向上查找", () => {
    const dir = tempWorkspace("[analysis.rtl]\n");
    mkdirSync(join(dir, "a/b"), { recursive: true });
    expect(findWorkspace(join(dir, "a/b"))).toBe(join(dir, "autowire.toml"));
    expect(findWorkspace(tmpdir())).toBe(findWorkspace(tmpdir())); // 不报错即可
  });

  test("类型错误给出键名定位", async () => {
    const dir = tempWorkspace('[analysis.rtl]\nwalk_dirs = "rtl"\n');
    await expect(loadWorkspace(join(dir, "autowire.toml"))).rejects.toThrow(
      "analysis.rtl.walk_dirs",
    );
  });
});
