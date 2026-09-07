// autowire CLI 入口（bun）。当前命令：
//   help [topic]  Agent 接手说明（无参数时也打印全文）
//   deps <path>   打印 RTL 模块依赖树（path 为 RtlIndex 目录；若是 RTL 源码目录则先调 hdxml sidecar 分析）

import { Command } from "commander";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { renderHelp } from "./src/help.js";
import { loadRtlIndex } from "./src/rtlindex.js";
import { renderSummary, renderTrees } from "./src/tree.js";

/** 定位 hdxml 二进制：--hdxml > $HDXML_BIN > 仓库内 target/{release,debug} > PATH */
function findHdxml(explicit?: string): string {
  const candidates = [
    explicit,
    process.env.HDXML_BIN,
    join(import.meta.dir, "hdxml/target/release/hdxml"),
    join(import.meta.dir, "hdxml/target/debug/hdxml"),
  ].filter((c): c is string => typeof c === "string" && c.length > 0);
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return "hdxml"; // 交给 PATH 解析；不存在时 spawn 报错
}

/** path 指向 RTL 源码目录时，调 hdxml sidecar 生成索引（固定项目 tmp/rtlindex；GC 保证增量无残留） */
function analyzeWithSidecar(rtlDir: string, hdxmlBin: string, incdirs: string[]): string {
  const outDir = join(import.meta.dir, "tmp/rtlindex");
  const args = ["analysis", "-w", rtlDir, "--xml", outDir];
  for (const i of incdirs) args.push("-I", i);
  const proc = Bun.spawnSync({ cmd: [hdxmlBin, ...args], stdout: "inherit", stderr: "inherit" });
  if (!existsSync(join(outDir, "index.xml"))) {
    console.error(`hdxml 分析失败（exit ${proc.exitCode}），未产出 index.xml`);
    process.exit(1);
  }
  console.error(`索引目录: ${outDir}`);
  return outDir;
}

const program = new Command();
program
  .name("autowire")
  .description("RTL 寄存器与连接工具。Agent 先跑 help，不要另写项目提示词。")
  .addHelpText("after", "\n接手说明（用法 + 思路）：  bun index.ts help\n切片：  bun index.ts help topics\n");

program.addHelpCommand(false);
program
  .command("help")
  .description("打印 Agent 接手说明（用法 + 思路）；topic 见 help topics")
  .argument("[topic]", "agent | status | workspace | connect | web | dump | cli | deps | dont | topics")
  .action((topic?: string) => {
    try {
      console.log(renderHelp(topic));
    } catch (e) {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    }
  });

program
  .command("deps")
  .description("打印 RTL 模块依赖树（彩色）；<path> 为 RtlIndex 目录或 RTL 源码目录")
  .argument("<path>", "RtlIndex 目录（含 index.xml）或 RTL 源码目录")
  .option("--top <name>", "只打印指定顶层的树")
  .option("--depth <n>", "限制展开深度", (v) => Number(v))
  .option("-I, --incdir <dir...>", "源码模式：include 搜索路径（透传 hdxml）")
  .option("--hdxml <bin>", "源码模式：hdxml 二进制路径")
  .action(async (path: string, opts: { top?: string; depth?: number; incdir?: string[]; hdxml?: string }) => {
    const indexDir = existsSync(join(path, "index.xml"))
      ? path
      : analyzeWithSidecar(path, findHdxml(opts.hdxml), opts.incdir ?? []);
    const index = await loadRtlIndex(indexDir);
    for (const line of renderSummary(index)) console.log(line);
    for (const line of renderTrees(index, { top: opts.top, depth: opts.depth })) console.log(line);
  });

if (process.argv.slice(2).length === 0) {
  console.log(renderHelp());
} else {
  program.parse();
}
