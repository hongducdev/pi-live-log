import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "livelog-ext-"));
process.env.LIVE_LOG_SETTINGS = join(dir, "live-log.json");
const { default: liveLog } = await import("../src/index.ts");
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

function setup(ctxExtra: any = {}) {
	(globalThis as any).__liveLogBus = undefined;
	const handlers: Record<string, Function> = {}, commands: Record<string, any> = {}, sent: any[] = [], notes: string[] = [];
	let renderer: any;
	const pi: any = {
		on: (e: string, h: Function) => (handlers[e] = h),
		registerCommand: (n: string, o: any) => (commands[n] = o),
		registerToolRenderer: (f: any) => (renderer = f),
		sendUserMessage: (m: string, o: any) => sent.push({ m, o }),
	};
	let aborts = 0;
	const ctx: any = { hasUI: true, cwd: dir, ui: { notify: (m: string) => notes.push(m), setWidget() {} }, abort: () => aborts++, isIdle: () => true, ...ctxExtra };
	liveLog(pi);
	handlers.session_start?.({}, ctx);
	return { handlers, commands, sent, notes, ctx, renderer: () => renderer, aborts: () => aborts };
}

test("registers a renderer only for shell tools", () => {
	const t = setup();
	const base = { renderResult: (r: any) => r };
	assert.notEqual(t.renderer()("bash", () => base), base);
	assert.equal(t.renderer()("read", () => base), base);
	assert.ok(t.commands.livelog);
});

test("stall watchdog: warns, aborts, writes report, sends follow-up (fake timers)", async () => {
	mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: 1_000_000 });
	try {
		const t = setup();
		await t.commands.livelog.handler("stall 1", t.ctx);
		t.handlers.tool_execution_start({ toolCallId: "c1", toolName: "bash", args: { command: "python long.py" } }, t.ctx);
		t.handlers.tool_execution_update({ toolCallId: "c1", partialResult: { content: [{ type: "text", text: "Do you want to continue? (y/n)" }] } });
		for (let s = 0; s < 35; s++) { mock.timers.tick(1000); await flush(); }
		assert.ok(t.notes.some((n) => /auto-stop in \d+s/.test(n)), "warning notified");
		assert.equal(t.aborts(), 0);
		for (let s = 0; s < 30; s++) { mock.timers.tick(1000); await flush(); }
		assert.equal(t.aborts(), 1, "aborted after stall");
		const md = readFileSync(join(dir, "live-log-last-stop.md"), "utf8");
		assert.match(md, /waiting for input/);
		t.handlers.tool_execution_end({ toolCallId: "c1", isError: true });
		await flush();
		assert.equal(t.sent.length, 1);
		assert.match(t.sent[0].m, /Auto-stopped `bash`/);
		await t.commands.livelog.handler("stall auto", t.ctx);
		t.handlers.session_shutdown();
	} finally { mock.timers.reset(); }
});

test("/livelog keep cancels; /livelog stop aborts immediately; lang vi", async () => {
	const t = setup();
	await t.commands.livelog.handler("lang vi", t.ctx);
	t.handlers.tool_execution_start({ toolCallId: "k", toolName: "bash", args: { command: "make" } }, t.ctx);
	await t.commands.livelog.handler("keep", t.ctx);
	assert.match(t.notes.at(-1)!, /watchdog disabled/);
	t.handlers.tool_execution_end({ toolCallId: "k" });
	t.handlers.tool_execution_start({ toolCallId: "s", toolName: "bash", args: { command: "make" } }, t.ctx);
	await t.commands.livelog.handler("stop", t.ctx);
	await flush();
	assert.equal(t.aborts(), 1);
	assert.ok(t.notes.some((n) => n.includes("dừng thủ công")));
	await t.commands.livelog.handler("lang auto", t.ctx);
	t.handlers.session_shutdown();
});

test("history: successful runs are learned and shown by /livelog limits", async () => {
	mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 5_000_000 });
	try {
		const t = setup();
		for (const id of ["h1", "h2"]) {
			t.handlers.tool_execution_start({ toolCallId: id, toolName: "bash", args: { command: "pio run" } }, t.ctx);
			t.handlers.tool_execution_end({ toolCallId: id, durationMs: 25 * 60_000 });
		}
		await t.commands.livelog.handler("limits", t.ctx);
		assert.match(t.notes.at(-1)!, /pio run @ .*: 2 runs, p90 25m 0s/);
		await t.commands.livelog.handler("forget all", t.ctx);
		assert.equal(readFileSync(join(dir, "live-log-history.json"), "utf8"), "{}");
		t.handlers.session_shutdown();
	} finally { mock.timers.reset(); }
});

test("subagent: child run shown in parent widget, stop aborts child only, summary to parent", async () => {
	(globalThis as any).__liveLogBus = undefined;
	const mk = (hasUI: boolean) => {
		const h: Record<string, Function> = {}, c: Record<string, any> = {}, sent: string[] = [];
		liveLog({ on: (e: string, f: Function) => (h[e] = f), registerCommand: (n: string, o: any) => (c[n] = o), registerToolRenderer() {}, sendUserMessage: (m: string) => sent.push(m) } as any);
		return { h, c, sent };
	};
	let widget: any;
	const parent = mk(true), child = mk(false);
	let parentAborts = 0, childAborts = 0;
	const pctx = { hasUI: true, cwd: dir, ui: { notify() {}, setWidget: (_k: string, f: any) => { widget = f?.({ requestRender() {} }, {}); } }, abort: () => parentAborts++ };
	const cctx = { hasUI: false, cwd: dir, abort: () => childAborts++, isIdle: () => true };
	parent.h.session_start({}, pctx);
	parent.h.tool_execution_start({ toolCallId: "a1", toolName: "Agent", args: { description: "fw-builder" } }, pctx);
	child.h.tool_execution_start({ toolCallId: "x1", toolName: "bash", args: { command: "pio run" } }, cctx);
	child.h.tool_execution_update({ toolCallId: "x1", partialResult: { content: [{ type: "text", text: "Compiling a.c" }] } });
	const bus = (globalThis as any).__liveLogBus;
	[...bus.childRuns.values()][0].start -= 5000; // pretend it has run for 5s
	await new Promise((r) => setTimeout(r, 1200));
	assert.ok(widget?.render(80)[0].includes("⤷ fw-builder:"), "child run in parent widget");
	await child.c.livelog.handler("stop", cctx);
	await flush();
	child.h.tool_execution_end({ toolCallId: "x1", isError: true });
	await flush();
	assert.equal(childAborts, 1); assert.equal(parentAborts, 0);
	assert.equal(child.sent.length, 0);
	assert.match(parent.sent.at(-1)!, /Subagent "fw-builder" was auto-stopped/);
	parent.h.tool_execution_end({ toolCallId: "a1" });
	child.h.session_shutdown(); parent.h.session_shutdown();
});
