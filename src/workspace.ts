// autowire.toml 加载与 hdxml 参数映射（契约见 docs/workspace-toml.md）。
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
  /** 带值宏（展开）→ -D NAME=VALUE */
  defines: Record<string, string>;
  /** 保原文宏（[defines] 空串项 ∪ 顶层 keep_raw）→ --keep-raw */
  keepRaw: string[];
  defineHeaders: string[];
  /** RtlIndex 输出目录（[index] dir，默认 .autowire/hdxml） */
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

  const rtl = isObj(doc.rtl) ? doc.rtl : {};
  const index = isObj(doc.index) ? doc.index : {};
  const dump = isObj(doc.dump) ? doc.dump : {};

  const defines: Record<string, string> = {};
  const keepRaw: string[] = [...strList(doc.keep_raw, "keep_raw")];
  if (doc.defines !== undefined) {
    if (!isObj(doc.defines)) throw new Error("autowire.toml: [defines] 必须是表");
    for (const [k, v] of Object.entries(doc.defines)) {
      if (typeof v === "string" && v.length > 0) defines[k] = v;
      else if (typeof v === "number" || typeof v === "boolean") defines[k] = String(v);
      else if (v === "" ) keepRaw.push(k); // 空串 = 保原文（null 语义；TOML 无 null 字面量）
      else throw new Error(`autowire.toml: [defines] ${k} 的值必须是字符串/数字/布尔`);
    }
  }

  const rel = (p: string) => (isAbsolute(p) ? p : join(root, p));
  return {
    root,
    filelists: strList(rtl.filelists, "rtl.filelists").map(rel),
    walkDirs: strList(rtl.walk_dirs, "rtl.walk_dirs").map(rel),
    sources: strList(rtl.sources, "rtl.sources").map(rel),
    incdirs: strList(rtl.incdirs, "rtl.incdirs").map(rel),
    excludeFilenames: strList(rtl.exclude_filenames, "rtl.exclude_filenames"),
    defines,
    keepRaw,
    defineHeaders: strList(doc.define_headers, "define_headers").map(rel),
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

# 宏定义头文件（等价 hdxml --define-headers）；默认保原文：一律转哨兵不展开，
# 需展开时用 [defines] 带值项覆盖同名
# define_headers = ["rtl/include/project_defines.svh"]

# 额外保原文宏（未出现在 define_headers 中的名字，如环境宏）；与 [defines] 空串项并集
# keep_raw = ["ENV_MACRO"]

[rtl]
# 三种来源可并存，并集去重
filelists = []
walk_dirs = ["rtl"]
sources = []
incdirs = []
exclude_filenames = []

[defines]
# 带值 = 展开；空串 = 保原文（TOML 无 null 字面量，空串即"登记不展开"）
# SYNTHESIS = "1"
# WIDTH = ""

[index]
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
