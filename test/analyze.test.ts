import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeLog, followUpMessage, stopMarkdown, verdict } from "../src/analyze.ts";
import { detectLang, reasonText } from "../src/i18n.ts";

const logs = {
	compile: ["Compiling .pio/build/foo.o", "src/foo.cpp:12:5: error: 'bar' was not declared in this scope", "*** [.pio/build/foo.o] Error 1", "========= [FAILED] ========="],
	download: ["Tool Manager: Installing toolchain-xtensa", "Downloading  [####      ]  42%"],
	prompt: ["Setting up", "Do you want to continue? (y/n)"],
	silent: [] as string[],
	compiling: ["[118/456] Compiling a.c", "[119/456] Compiling b.c"],
	loop: ["waiting for device", "waiting for device", "waiting for device", "waiting for device"],
	clean: ["Starting server", "Build finished with 0 errors", "Running post-build"],
};

test("analyzeLog heuristics", () => {
	const c = analyzeLog(logs.compile);
	assert.ok(c.hasError); assert.ok(c.errors.some((e) => e.includes("foo.cpp:12:5")));
	const d = analyzeLog(logs.download);
	assert.ok(!d.hasError); assert.match(d.why, /downloading/); assert.match(d.why, /42%/);
	assert.match(analyzeLog(logs.prompt).why, /waiting for input.*\(y\/n\)/);
	assert.match(analyzeLog(logs.silent).why, /no output at all/);
	assert.match(analyzeLog(logs.compiling).why, /\[119\/456\]/);
	assert.match(analyzeLog(logs.loop).why, /looks like a loop/);
	const ok = analyzeLog(logs.clean);
	assert.ok(!ok.hasError, "'0 errors' is not an error"); assert.match(ok.why, /no clear sign/);
});

test("verdict prefers file:line errors and is localized", () => {
	assert.equal(verdict(analyzeLog(logs.compile), "7m 2s"), "✗ Stopped after 7m 2s: error — src/foo.cpp:12:5: error: 'bar' was not declared in this scope");
	assert.match(verdict(analyzeLog(logs.prompt, "vi"), "1m", "vi"), /^⚠ Dừng sau 1m: không thấy lỗi; có vẻ đang chờ nhập/);
});

test("detectLang and reasons", () => {
	assert.equal(detectLang("Mình đã sửa xong, bạn khởi động lại nhé"), "vi");
	assert.equal(detectLang("Done, restart Pi please."), "en");
	assert.equal(detectLang(""), "en");
	assert.equal(reasonText("en", "max", "30"), "exceeded the 30 min limit");
	assert.equal(reasonText("vi", "stall", "10m 0s"), "treo 10m 0s không ra log");
	assert.equal(reasonText("en", "manual", ""), "stopped manually with /livelog stop");
});

const report = () => {
	const a = analyzeLog(logs.compile);
	return { tool: "bash", command: "pio   run", at: 0, elapsed: "3m 0s", reason: "no output for 3m 0s", analysis: a, analysisEn: a, lines: logs.compile, from: "/tmp/b.log" };
};

test("stop markdown in both languages", () => {
	assert.match(stopMarkdown(report(), "en"), /^# Stopped command summary[\s\S]*`pio run`[\s\S]*- Error\?: yes/);
	assert.match(stopMarkdown(report(), "vi"), /^# Tóm tắt lệnh bị dừng[\s\S]*- Có lỗi không: có/);
});

test("follow-up messages (main session and subagent)", () => {
	const m = followUpMessage(report(), "no output for 3m 0s");
	assert.match(m, /^\[live-log\] Auto-stopped `bash` after 3m 0s \(no output for 3m 0s\)/);
	assert.match(m, /Reply in the same language you have been using/);
	assert.match(m, /Last 4 lines of \/tmp\/b\.log/);
	const s = followUpMessage({ ...report(), agent: "builder" }, "x");
	assert.match(s, /Subagent "builder" was auto-stopped/);
	assert.match(followUpMessage({ ...report(), command: "x".repeat(400) }, "r"), /x{300}…/);
});
