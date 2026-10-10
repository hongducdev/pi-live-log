import { test } from "node:test";
import assert from "node:assert/strict";
import { charWidth, cleanLines, fit, fmtElapsed, fmtMin } from "../src/format.ts";
import { decorateResult, widgetLines } from "../src/render.ts";
import { agentLabel, agentName } from "../src/subagent.ts";

const limits = { category: "build", sig: "s", stallMin: 10, maxMin: 60, why: "default" };
const width = (s: string) => [...s].reduce((w, ch) => w + charWidth(ch.codePointAt(0)!), 0);

test("cleanLines strips ANSI, CR progress and blanks", () => {
	assert.deepEqual(cleanLines("\x1b[32mok\x1b[0m\r\n10%\r50%\r100%\n\n", 8), ["ok", "100%"]);
	assert.deepEqual(cleanLines("a\nb\nc", 2), ["b", "c"]);
});

test("fit truncates by display width", () => {
	assert.equal(fit("hello", 10), "hello");
	assert.equal(fit("hello world", 6), "hello…");
	const t = fit("构建中构建中构建中", 7);
	assert.equal(t, "构建中…");
	assert.ok(width(t) <= 7, t);
	assert.equal(width("🚀a"), 3);
	assert.equal(fit("Tiếng Việt có dấu", 8), "Tiếng V…", "combining marks / precomposed count as 1");
});

test("formatting", () => {
	assert.equal(fmtElapsed(5_000), "5s"); assert.equal(fmtElapsed(125_000), "2m 5s"); assert.equal(fmtElapsed(3_720_000), "1h 2m");
	assert.equal(fmtMin(4.5), "4.5m"); assert.equal(fmtMin(90), "1h30m"); assert.equal(fmtMin(120), "2h");
});

test("decorateResult: in-row tail while running, verdict when stopped", () => {
	const run = { tail: ["[1/2] Compiling a.c", "[2/2] Linking"], partial: "", logPath: "/tmp/build.log", limits, warning: "no new output for 9m, auto-stop in 60s" };
	const r = decorateResult({ content: [{ type: "text", text: "started" }] }, { isPartial: true, enabled: true, watchdog: true, run });
	assert.equal(r.content[0].text, "started\n──\n[1/2] Compiling a.c\n[2/2] Linking\n⏱ build · stall 10m · max 1h (default) · log build.log\n⚠ no new output for 9m, auto-stop in 60s");
	const noLog = decorateResult({ content: [] }, { isPartial: true, enabled: true, watchdog: false, run: { ...run, logPath: undefined, warning: undefined } });
	assert.equal(noLog.content[0].text, "");
	const original = { content: [{ type: "text", text: "x" }] };
	assert.equal(decorateResult(original, { isPartial: false, enabled: true, watchdog: true, run }), original, "final rows untouched");
	assert.equal(decorateResult(original, { isPartial: false, enabled: true, watchdog: true, stopSummary: "✗ Stopped" }).content[0].text, "x\n✗ Stopped");
});

test("widgetLines: manual tail, run, subagent label, final line, width-safe", () => {
	const theme = { fg: (_k: string, s: string) => s };
	assert.deepEqual(widgetLines({ manual: { label: "/a.log", tail: [] }, showFinal: false, lines: 8, watchdog: true, now: 0 }, 60, theme),
		["▸ tail /a.log", "  (file empty or not found yet)"]);
	const run = { tail: [], partial: "step 1\nstep 2 " + "x".repeat(200), limits, command: "make   all", start: 0, source: "stdout", agent: "builder" };
	const lines = widgetLines({ run, showFinal: true, lines: 8, watchdog: true, now: 65_000 }, 40, theme);
	assert.ok(lines[0].startsWith("▸ ⤷ builder: 1m 5s · make all"));
	assert.ok(lines[0].endsWith("[stdout]"));
	assert.ok(lines.every((l) => width(l) <= 40), lines.join("\n"));
	assert.ok(lines.at(-1)!.includes("⏱ build"));
	assert.deepEqual(widgetLines({ finalLine: { ok: true, text: "✓ done" }, showFinal: true, lines: 8, watchdog: true, now: 0 }, 40, theme), ["✓ done"]);
	assert.deepEqual(widgetLines({ finalLine: { ok: true, text: "✓ done" }, showFinal: false, lines: 8, watchdog: true, now: 0 }, 40, theme), []);
});

test("subagent labels", () => {
	assert.equal(agentLabel([]), "subagent"); assert.equal(agentLabel(["a"]), "a"); assert.equal(agentLabel(["a", "b"]), "subagent (2 running)");
	assert.equal(agentName({ description: "Build fw" }), "Build fw"); assert.equal(agentName({}), "subagent");
});
