import { expect, test } from "bun:test";
import { HELP_TOPICS, renderHelp } from "../src/cli/help.ts";

test("no topic prints command index and one-line agent pointer", () => {
	const text = renderHelp();
	expect(text).toContain("Autowire — commands");
	expect(text).toContain("help [topic]");
	expect(text).toContain("init");
	expect(text).toContain("analysis");
	expect(text).toContain("deps");
	expect(text).toContain("check");
	expect(text).toContain("help agent");
	expect(text).toContain("do not invent a project prompt");
	expect(text).not.toContain("Pipeline");
	expect(text).not.toContain("aw-template@inst_name");
});

test("agent topic holds the working contract", () => {
	const text = renderHelp("agent");
	expect(text).toContain("Agent contract");
	expect(text).toContain("do not invent a separate project prompt");
	expect(text).toContain("Playwright MCP");
	expect(text).toContain("POST /api/dump");
	expect(text).toContain("help status");
	expect(text).toContain("docs/connect/html.md");
});

test("each slice prints independently", () => {
	expect(renderHelp("status")).toContain("Landed");
	expect(renderHelp("workspace")).toContain(".autowire/hdxml");
	expect(renderHelp("workspace")).toContain(".autowire/connect");
	expect(renderHelp("workspace")).toContain("/api/connect");
	expect(renderHelp("web")).toContain("/api/connect?id=");
	expect(renderHelp("analysis")).toContain("autowire init");
	expect(renderHelp("connect")).toContain("aw-mod");
	expect(renderHelp("connect")).toContain("aw-template@inst_name");
	expect(renderHelp("connect")).toContain("variable expressions only");
	expect(renderHelp("connect")).toContain("do not fold expressions or macros");
	expect(renderHelp("connect")).toContain("aw-localparams");
	expect(renderHelp("connect")).toContain("Mod__Inst__Param");
	expect(renderHelp("connect")).toContain("docs/connect/rules.md");
	expect(renderHelp("connect")).toContain("docs/connect/html.md");
	expect(renderHelp("connect")).toContain("aw-content");
	expect(renderHelp("connect")).toContain("aw-render");
	expect(renderHelp("connect")).toContain("overwrite");
	expect(renderHelp("connect")).toContain("aw-rewrite");
	expect(renderHelp("connect")).toContain("<autowire>");
	expect(renderHelp("dont")).toContain("autowire.toml");
	expect(renderHelp("web")).toContain("autowire web");
	expect(renderHelp("web")).toContain("help agent");
	expect(renderHelp("web")).toContain("[Check]");
	expect(renderHelp("web")).toContain("NOT aw-render");
	expect(renderHelp("web")).toContain("depends on Check");
	expect(renderHelp("web")).toContain("?check=1");
	expect(renderHelp("web")).toContain("?dump=1");
	expect(renderHelp("connect")).toContain("docs/connect/check.md");
	expect(renderHelp("connect")).toContain("identity same-name");
	expect(renderHelp("check")).toContain("docs/connect/check.md");
	expect(renderHelp("check")).toContain("Check green is not dump-ready");
	expect(renderHelp("check")).toContain("autowire check");
	expect(renderHelp("check")).toContain("aw-content");
	expect(renderHelp("check")).toContain("Does NOT require render");
	expect(renderHelp("check")).toContain("Render depends on Check");
	expect(renderHelp("check")).toContain("/api/check");
	expect(renderHelp("check")).toContain("Does NOT write");
	expect(renderHelp("dump")).toContain("/api/dump");
	expect(renderHelp("dump")).toContain("aw-render");
	expect(renderHelp("dump")).toContain("not a substitute for check");
	expect(renderHelp("cli")).toContain("do not build now");
	expect(renderHelp("cli")).toContain("--check");
	expect(renderHelp("deps")).toContain("RtlIndex");
	expect(renderHelp("dont")).toContain("blur tools vs MCP");
	expect(renderHelp("dont")).toContain("Workspace MCP");
	expect(renderHelp("dont")).toContain("treat dump as the only validation");
	expect(renderHelp("dont")).toContain("skip check before render");
	expect(renderHelp("agent")).toContain("docs/mcp/");
	expect(renderHelp("status")).toContain("Workspace MCP");
	for (const topic of HELP_TOPICS) {
		expect(renderHelp(topic).trim().length).toBeGreaterThan(20);
	}
});

test("topics lists every slice", () => {
	const text = renderHelp("topics");
	for (const topic of HELP_TOPICS) expect(text).toContain(topic);
	expect(text).toContain("command index");
});

test("unknown topic throws with topic list", () => {
	expect(() => renderHelp("emacs")).toThrow(/unknown help topic/);
	expect(() => renderHelp("emacs")).toThrow(/connect/);
});
