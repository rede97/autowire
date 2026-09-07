import { expect, test } from "bun:test";
import { HELP_TOPICS, renderHelp } from "./help.ts";

test("no topic prints full text with onboarding contract", () => {
  const text = renderHelp();
  expect(text).toContain("This output is the working contract");
  expect(text).toContain("do not invent a separate project prompt");
  expect(text).toContain("aw-mod");
  expect(text).toContain("aw-content");
  expect(text).toContain("aw-render");
  expect(text).toContain("aw-template");
  expect(text).toContain("Playwright MCP");
  expect(text).toContain("POST /api/dump");
  expect(text).toContain("Building cli before tests is not allowed");
  expect(text).toContain("autowire deps");
  expect(text).toContain("Current status");
  expect(text).toContain("autowire.toml");
});

test("each slice prints independently", () => {
  expect(renderHelp("agent")).toContain("Agent onboarding");
  expect(renderHelp("status")).toContain("Landed");
  expect(renderHelp("workspace")).toContain("autowire.toml");
  expect(renderHelp("workspace")).toContain("docs/workspace-toml.md");
  expect(renderHelp("connect")).toContain("aw-mod");
  expect(renderHelp("connect")).toContain("aw-template@inst_name");
  expect(renderHelp("connect")).toContain("variable expressions only");
  expect(renderHelp("connect")).toContain("do not fold expressions or macros");
  expect(renderHelp("connect")).toContain("aw-localparams");
  expect(renderHelp("connect")).toContain("Mod__Inst__Param");
  expect(renderHelp("connect")).toContain("docs/connect-rules.md");
  expect(renderHelp("connect")).toContain("docs/connect-html.md");
  expect(renderHelp("connect")).toContain("aw-content");
  expect(renderHelp("connect")).toContain("aw-render");
  expect(renderHelp("connect")).toContain("overwrite");
  expect(renderHelp("connect")).toContain("aw-template");
  expect(renderHelp("connect")).toContain("aw-rewrite");
  expect(renderHelp("connect")).toContain("match");
  expect(renderHelp("connect")).toContain("inst_name");
  expect(renderHelp("connect")).toContain("<autowire>");
  expect(renderHelp("dont")).toContain("autowire.toml");
  expect(renderHelp("web")).toContain("Playwright MCP");
  expect(renderHelp("dump")).toContain("/api/dump");
  expect(renderHelp("dump")).toContain("aw-render");
  expect(renderHelp("cli")).toContain("do not build now");
  expect(renderHelp("deps")).toContain("RtlIndex");
  expect(renderHelp("dont")).toContain("connection-specific MCP");
  for (const topic of HELP_TOPICS) {
    expect(renderHelp(topic).trim().length).toBeGreaterThan(20);
  }
});

test("topics lists every slice", () => {
  const text = renderHelp("topics");
  for (const topic of HELP_TOPICS) expect(text).toContain(topic);
});

test("unknown topic throws with topic list", () => {
  expect(() => renderHelp("emacs")).toThrow(/unknown help topic/);
  expect(() => renderHelp("emacs")).toThrow(/connect/);
});
