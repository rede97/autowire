// autowire.toml 加载与 hdxml 参数映射（契约见 docs/workspace-toml.md）。
// hdxml 不读 toml：一切配置经本模块映射为 hdxml CLI 参数传递。
// 查找：从 CWD（或 --workspace）向上取最近一份 autowire.toml；toml 内相对路径相对其所在目录（工作区根）。

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse } from "smol-toml";

export interface WorkspaceConfig {
  /** autowire.toml 所在目录（工作区根） */
  root: string;
  filelists: string[];
  walkDirs: string[];
  sources: string[];
  incdirs: string[];
  excludeFilenames: string[];
  /** 展开宏（[analysis.defines] 带值项）→ -D NAME=VALUE */
  defines: Record<string, string>;
  /** 保原文宏（[analysis].keep_raw）→ --keep-raw */
  keepRaw: string[];
  defineHeaders: string[];
  /** RtlIndex 输出目录（[analysis.index] dir，默认 .autowire/hdxml） */
  indexDir: string;
  /** dump RTL 输出目录（[dump] dir，默认 gen） */
  dumpDir: string;
}

/** 自 startDir 向上查找 autowire.toml，返回文件路径；找不到返回 null */
export function findWorkspace(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, "autowire.toml");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function strList(v: unknown, key: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new Error(`autowire.toml: ${key} 必须是字符串数组`);
  }
  return v as string[];
}

export async function loadWorkspace(tomlPath: string): Promise<WorkspaceConfig> {
  const root = dirname(tomlPath);
  const doc: unknown = parse(await readFile(tomlPath, "utf8"));
  if (!isObj(doc)) throw new Error(`autowire.toml: 解析失败（非 TOML 表）`);

  const analysis = isObj(doc.analysis) ? doc.analysis : {};
  const rtl = isObj(analysis.rtl) ? analysis.rtl : {};
  const index = isObj(analysis.index) ? analysis.index : {};
  const dump = isObj(doc.dump) ? doc.dump : {};

  const defines: Record<string, string> = {};
  if (analysis.defines !== undefined) {
    if (!isObj(analysis.defines)) throw new Error("autowire.toml: [analysis.defines] 必须是表");
    for (const [k, v] of Object.entries(analysis.defines)) {
      if (typeof v === "string" && v.length > 0) defines[k] = v;
      else if (typeof v === "number" || typeof v === "boolean") defines[k] = String(v);
      else if (v === "") {
        throw new Error(
          `autowire.toml: [analysis.defines] ${k} 空串已废弃——保原文宏请列入 analysis.keep_raw`,
        );
      } else {
        throw new Error(`autowire.toml: [analysis.defines] ${k} 的值必须是字符串/数字/布尔`);
      }
    }
  }

  const rel = (p: string) => (isAbsolute(p) ? p : join(root, p));
  return {
    root,
    filelists: strList(rtl.filelists, "analysis.rtl.filelists").map(rel),
    walkDirs: strList(rtl.walk_dirs, "analysis.rtl.walk_dirs").map(rel),
    sources: strList(rtl.sources, "analysis.rtl.sources").map(rel),
    incdirs: strList(rtl.incdirs, "analysis.rtl.incdirs").map(rel),
    excludeFilenames: strList(rtl.exclude_filenames, "analysis.rtl.exclude_filenames"),
    defines,
    keepRaw: strList(analysis.keep_raw, "analysis.keep_raw"),
    defineHeaders: strList(analysis.define_headers, "analysis.define_headers").map(rel),
    indexDir: rel(typeof index.dir === "string" ? index.dir : ".autowire/hdxml"),
    dumpDir: rel(typeof dump.dir === "string" ? dump.dir : "gen"),
  };
}

/** WorkspaceConfig → hdxml analysis argv（不含 "analysis" 本身；顺序稳定便于测试） */
export function hdxmlArgs(cfg: WorkspaceConfig): string[] {
  const args: string[] = [];
  const group = (flag: string, values: string[]) => {
    if (values.length > 0) args.push(flag, ...values);
  };
  group("-f", cfg.filelists);
  group("-s", cfg.sources);
  group("-w", cfg.walkDirs);
  group("--exclude-filenames", cfg.excludeFilenames);
  group("-I", cfg.incdirs);
  group("--define-headers", cfg.defineHeaders);
  group(
    "-D",
    Object.entries(cfg.defines)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([n, v]) => `${n}=${v}`),
  );
  group("--keep-raw", [...cfg.keepRaw].sort());
  args.push("--xml", cfg.indexDir);
  return args;
}

/** init 写入的默认配置（对齐 docs/workspace-toml.md §4） */
export const DEFAULT_TOML = `# autowire 工作区配置（契约见 docs/workspace-toml.md）
# hdxml 不读本文件：autowire analysis 负责把配置映射为 hdxml CLI 参数。

[analysis]
# 宏定义头文件（等价 hdxml --define-headers）；默认保原文：一律转哨兵不展开，
# 需展开时用 [analysis.defines] 带值项覆盖同名
# define_headers = ["rtl/include/project_defines.svh"]

# 保原文宏（端口表达式保留 \`NAME 原文，\`ifdef 判真，dump 时还原）
# keep_raw = ["WIDTH", "ENV_MACRO"]

[analysis.rtl]
# 三种来源可并存，并集去重
filelists = []
walk_dirs = ["rtl"]
sources = []
# 源文件与 define_headers 提取共用（头文件内 \`include 同规则）
incdirs = []
exclude_filenames = []

[analysis.defines]
# 带值 = 展开（等价 -D）；保原文宏不要写在这里，列入上方 keep_raw
# SYNTHESIS = "1"

[analysis.index]
# RtlIndex XML 目录；固定在工作区生成临时目录 .autowire 下
dir = ".autowire/hdxml"

[dump]
# dump 写出的 RTL 目录（产物，交给 DV；不放 .autowire）
dir = "gen"

[connect]
# 可选：默认作者 HTML / 连接树逻辑顶
# html = "connect/phy_wrap.html"
# top = "phy_wrap"
`;
