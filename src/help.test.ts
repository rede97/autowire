import { expect, test } from "bun:test";
import { HELP_TOPICS, renderHelp } from "./help.ts";

test("无 topic 打印全文，含接手约定", () => {
  const text = renderHelp();
  expect(text).toContain("本输出即工作约定");
  expect(text).toContain("不要另写项目提示词");
  expect(text).toContain("aw-mod");
  expect(text).toContain("aw-content");
  expect(text).toContain("aw-render");
  expect(text).toContain("aw-template");
  expect(text).toContain("Playwright MCP");
  expect(text).toContain("POST /api/dump");
  expect(text).toContain("先做 cli、再补测试，不允许");
  expect(text).toContain("autowire deps");
  expect(text).toContain("当前状态");
  expect(text).toContain("autowire.toml");
});

test("每个切片都能独立打印", () => {
  expect(renderHelp("agent")).toContain("接手说明");
  expect(renderHelp("status")).toContain("已落地");
  expect(renderHelp("workspace")).toContain("autowire.toml");
  expect(renderHelp("workspace")).toContain("docs/workspace-toml.md");
  expect(renderHelp("connect")).toContain("aw-mod");
  expect(renderHelp("connect")).toContain("docs/connect-html.md");
  expect(renderHelp("connect")).toContain("aw-content");
  expect(renderHelp("connect")).toContain("aw-render");
  expect(renderHelp("connect")).toContain("aw-template");
  expect(renderHelp("connect")).toContain("<autowire>");
  expect(renderHelp("dont")).toContain("autowire.toml");
  expect(renderHelp("web")).toContain("Playwright MCP");
  expect(renderHelp("dump")).toContain("/api/dump");
  expect(renderHelp("dump")).toContain("aw-render");
  expect(renderHelp("cli")).toContain("先做 cli");
  expect(renderHelp("deps")).toContain("RtlIndex");
  expect(renderHelp("dont")).toContain("连接专用 MCP");
  for (const topic of HELP_TOPICS) {
    expect(renderHelp(topic).trim().length).toBeGreaterThan(20);
  }
});

test("topics 列出全部切片", () => {
  const text = renderHelp("topics");
  for (const topic of HELP_TOPICS) expect(text).toContain(topic);
});

test("未知 topic 抛错并给出清单", () => {
  expect(() => renderHelp("emacs")).toThrow(/未知 help topic/);
  expect(() => renderHelp("emacs")).toThrow(/connect/);
});
