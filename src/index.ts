/**
 * pi-live-log: live output + stall watchdog for long-running shell tool calls in Pi.
 *
 * - In-row log: wraps the built-in bash/powershell tool renderer so the tail of the
 *   command's log file (or streamed stdout) appears inside the running tool row.
 * - Optional widget above the editor (/livelog widget on, /livelog <path>).
 * - Watchdog: per-command stall / max-runtime limits (category defaults + learned
 *   history); warns, then aborts the turn like Esc. A local heuristic analysis of the log
 *   is shown and the agent is asked for a summary in the conversation's language.
 * - Subagents: child-session commands are shown in the main widget; a stop aborts only
 *   the child and the summary goes to the main session.
 *
 * Never throws into Pi; fs errors are ignored silently. No network access.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { analyzeLog, followUpMessage, stopMarkdown, verdict, type Analysis, type StopReport } from "./analyze.ts";
import { loadSettings, paths, readJson, writeQuiet, type Settings } from "./config.ts";
import { inspectCommand, readTail, TAIL_BYTES, type Tail } from "./detect.ts";
import { cleanLines, fmtElapsed, textOf } from "./format.ts";
import { detectLang, reasonText, TXT, type Lang } from "./i18n.ts";
import { decorateResult, SHELL_TOOLS, widgetLines } from "./render.ts";
import { agentLabel, agentName, getBus } from "./subagent.ts";
import { toCandidates } from "./wsl.ts";
import {
	CATEGORIES, DEFAULT_CAT, QUICK_CAT, classify, computeLimits, evaluateWatchdog, limitsHeader, p90, recordHistory,
	type History, type Limits,
} from "./watchdog.ts";

export * from "./analyze.ts";
export * from "./detect.ts";
export * from "./format.ts";
export * from "./i18n.ts";
export * from "./render.ts";
export * from "./watchdog.ts";
export { toCandidates, defaultDistro } from "./wsl.ts";
export { DEFAULTS, paths, type Settings } from "./config.ts";

const WIDGET = "live-log";
const SHOW_AFTER_MS = 3000;

type Run = {
	/** set for runs inside a subagent session (shown in the parent widget) */
	agent?: string;
	id: string; tool: string; command: string; start: number; ctx: any;
	partial: string; logs: string[][]; tail: string[]; source: string; logPath?: string;
	lastActivity: number; logSig: string; maxGap: number; limits: Limits; timeoutSec?: number; warning?: string; warned?: string; kept?: boolean;
	stopped?: { reason: string; kind: "stall" | "max" | "manual"; detail: string; at: number; analysis?: Analysis; analysisEn?: Analysis; lines: string[]; from: string; sent?: boolean };
};

export default function liveLog(pi: ExtensionAPI) {
	const BUS = getBus<Run>();
	const FILES = paths();
	const instanceId = ++BUS.seq;
	const anyPi = pi as any;
	/** a no-UI instance while a UI instance exists in this process = subagent child session */
	const isChild = (ctx: any) => ctx?.hasUI === false && !!BUS.parent && BUS.parent.id !== instanceId;
	const claimParent = (ctx: any) => {
		if (ctx?.hasUI !== true) return;
		ui = ctx?.ui ?? ui;
		BUS.parent = {
			id: instanceId,
			send: (msg: string) => { try { anyPi.sendUserMessage?.(msg, { deliverAs: "followUp" }); } catch { /* ignore */ } },
			wake: () => ensureTimer(),
			notify: (m: string, level: string) => notify(undefined, m, level),
		};
	};
	pi.on("session_start", (_e: any, ctx: any) => { try { claimParent(ctx); } catch { /* ignore */ } });

	const settings: Settings = loadSettings(FILES.settings);
	const save = () => writeQuiet(FILES.settings, JSON.stringify(settings, null, 2));

	const runs = new Map<string, Run>();
	const stopSummaries = new Map<string, string>(); // toolCallId -> verdict line shown in the final row
	let manual: { label: string; cands: string[]; tail: string[] } | undefined;
	let finalLine: { text: string; ok: boolean } | undefined;
	let ui: any, timer: ReturnType<typeof setInterval> | undefined, finalTimer: any;
	let shown = false, busy = false, requestRender = () => {};
	const inRow = typeof anyPi.registerToolRenderer === "function";
	const useWidget = () => settings.widget || !inRow;
	const notify = (ctx: any, m: string, level = "info") => { try { (ctx?.ui ?? ui)?.notify?.(m, level); } catch { /* ignore */ } };

	// ----- in-row rendering: append the log tail to the built-in shell row while it runs -----
	if (inRow) {
		anyPi.registerToolRenderer((toolName: string, next: () => any) => {
			const base = next();
			if (!SHELL_TOOLS.includes(toolName) || !base?.renderResult) return base;
			return {
				...base,
				renderResult(result: any, options: any, theme: any, context: any) {
					try {
						result = decorateResult(result, {
							isPartial: !!options?.isPartial, enabled: settings.enabled, watchdog: settings.watchdog,
							stopSummary: stopSummaries.get(context?.toolCallId), run: runs.get(context?.toolCallId),
						});
					} catch { /* fall back to the original result */ }
					return base.renderResult(result, options, theme, context);
				},
			};
		});
	}

	// ----- optional widget above the editor -----
	const latestRun = () => [...runs.values()].filter((r) => useWidget() && Date.now() - r.start >= SHOW_AFTER_MS).pop();
	/** subagent runs are never visible as rows in this TUI → always shown in the widget */
	const childRun = () => BUS.parent?.id === instanceId ? [...BUS.childRuns.values()].filter((r) => Date.now() - r.start >= SHOW_AFTER_MS).pop() : undefined;
	const render = (width: number, theme: any) => widgetLines({
		manual, run: latestRun() ?? childRun(), finalLine, showFinal: useWidget(), lines: settings.lines, watchdog: settings.watchdog, now: Date.now(),
	}, width, theme);
	function show() {
		if (shown || !ui?.setWidget) return;
		shown = true;
		try {
			ui.setWidget(WIDGET, (tui: any, theme: any) => {
				requestRender = () => { try { tui?.requestRender?.(); } catch { /* ignore */ } };
				return { render: (width: number) => render(width, theme), invalidate: () => requestRender() };
			}, { placement: "aboveEditor" });
		} catch { shown = false; }
	}
	function hide() {
		if (!shown) return;
		shown = false; requestRender = () => {};
		try { ui?.setWidget?.(WIDGET, undefined); } catch { /* ignore */ }
	}

	// ----- watchdog (per-run adaptive limits) -----
	const history: History = readJson<History>(FILES.history, {});
	const saveHistory = () => writeQuiet(FILES.history, JSON.stringify(history));
	function record(run: Run, ms: number) {
		try {
			if (ms < 3000) return;
			recordHistory(history, run.limits.sig, { ms, gap: Math.max(run.maxGap, Date.now() - run.lastActivity), at: Date.now() });
			saveHistory();
		} catch { /* ignore */ }
	}

	function watchdog(run: Run, now: number) {
		run.warning = undefined;
		const d = evaluateWatchdog(run, now, settings.warnSec, settings.watchdog);
		if (d.action === "stop") return void stopRun(run, d.reason, d.kind, d.detail);
		if (d.action !== "warn") return;
		run.warning = d.warning;
		if (run.warned !== d.kind) {
			run.warned = d.kind;
			if (run.agent) BUS.parent?.notify(`live-log: ⤷ ${run.agent}: ${run.warning}`, "warning");
			else notify(run.ctx, `live-log: ${run.warning}`, "warning");
		}
	}

	// ----- language of the extension's own texts: follows the conversation (or /livelog lang) -----
	let lastAssistantText = "";
	pi.on("message_end", (event: any) => {
		try {
			const m = event?.message;
			if (m?.role !== "assistant") return;
			const t = textOf(m.content);
			if (t.trim()) lastAssistantText = t.slice(-4000);
		} catch { /* ignore */ }
	});
	function lang(ctx?: any): Lang {
		if (settings.lang === "en" || settings.lang === "vi") return settings.lang;
		let text = lastAssistantText;
		try { // after /reload: fall back to the session history
			const entries = ctx?.sessionManager?.getEntries?.() ?? [];
			for (let i = entries.length - 1; !text && i >= 0 && i >= entries.length - 200; i--) {
				const m = entries[i]?.message;
				if (m?.role === "assistant") text = textOf(m.content);
			}
		} catch { /* ignore */ }
		return detectLang(text);
	}

	const report = (run: Run): StopReport => {
		const st = run.stopped!;
		return { tool: run.tool, command: run.command, at: st.at, elapsed: fmtElapsed(st.at - run.start), reason: "",
			analysis: st.analysis!, analysisEn: st.analysisEn!, lines: st.lines, from: st.from, agent: run.agent };
	};

	/** Analyse the log locally, record the summary, then abort the turn (like Esc; Pi kills the shell tree). */
	async function stopRun(run: Run, reason: string, kind: "stall" | "max" | "manual", detail: string) {
		if (run.stopped) return;
		const at = Date.now(), L = lang(run.ctx), T = TXT[L];
		run.stopped = { reason, kind, detail, at, lines: [], from: "stdout" };
		run.warning = `auto-stopping: ${reason}`;
		let all: string[] = [];
		try {
			for (const c of run.logs) { const t = await readTail(c, 200, run.start - 2000, 64 * 1024); if (t) { all = t.lines; run.stopped.from = t.path; break; } }
			if (!all.length) all = cleanLines(run.partial, 200);
		} catch { /* ignore */ }
		const elapsed = fmtElapsed(at - run.start), why = reasonText(L, kind, detail);
		const analysis = analyzeLog(all, L), line = verdict(analysis, elapsed, L);
		Object.assign(run.stopped, { analysis, analysisEn: L === "en" ? analysis : analyzeLog(all, "en"), lines: all.slice(-40) });
		stopSummaries.set(run.id, line);
		run.warning = line;
		if (useWidget()) { finalLine = { ok: false, text: line }; clearTimeout(finalTimer); finalTimer = setTimeout(() => { finalLine = undefined; void tick(); }, 15000); (finalTimer as any).unref?.(); }
		try { run.ctx?.abort?.(); } catch { /* ignore */ }
		if (run.agent) BUS.parent?.notify(`⤷ ${run.agent}: ${T.notify(line, why)}`, analysis.hasError ? "error" : "warning");
		else notify(run.ctx, T.notify(line, why), analysis.hasError ? "error" : "warning");
		writeQuiet(FILES.lastStop, stopMarkdown({ ...report(run), reason: why }, L));
		if (!runs.has(run.id)) void sendFollowUp(run); // tool already ended while we were analysing
	}

	/** After an auto-stop: wait for the agent to go idle, then ask for a summary (in the conversation's language) before any fix. */
	async function sendFollowUp(run: Run) {
		const st = run.stopped;
		if (!st?.analysis || st.sent) return; // stopRun calls again once the analysis is ready
		st.sent = true;
		const msg = followUpMessage(report(run), reasonText("en", st.kind, st.detail));
		if (run.agent) return void BUS.parent?.send(msg); // the child session is over (abort ended it) → tell the parent
		for (let i = 0; i < 75; i++) {
			try { if (!run.ctx?.isIdle || run.ctx.isIdle()) break; } catch { break; }
			await new Promise((r) => setTimeout(r, 200));
		}
		try {
			const idle = !run.ctx?.isIdle || run.ctx.isIdle();
			anyPi.sendUserMessage?.(msg, idle ? undefined : { deliverAs: "followUp" });
		} catch { /* ignore */ }
	}

	/** Refresh tails once per second, run the watchdog, show/hide the widget. */
	async function tick() {
		if (busy) return;
		busy = true;
		try {
			const now = Date.now();
			if (manual) manual.tail = (await readTail(manual.cands, settings.lines))?.lines ?? [];
			for (const run of runs.values()) {
				let got: Tail | undefined;
				for (const c of run.logs) if ((got = await readTail(c, settings.lines, run.start - 2000))) break;
				if (got) {
					run.tail = got.lines; run.source = basename(got.path); run.logPath = got.path;
					if (got.sig !== run.logSig) { run.logSig = got.sig; run.maxGap = Math.max(run.maxGap, now - run.lastActivity); run.lastActivity = now; }
				} else if (run.partial) { run.tail = cleanLines(run.partial, settings.lines); run.source = "stdout"; }
				else {
					for (const c of run.logs) if ((got = await readTail(c, settings.lines))) break;
					if (got) { run.tail = got.lines; run.source = `old ${basename(got.path)}`; }
				}
				watchdog(run, now);
			}
			const kids = BUS.parent?.id === instanceId && BUS.childRuns.size > 0;
			const wantWidget = manual || (settings.enabled && (latestRun() || childRun())) || (useWidget() && finalLine);
			if (wantWidget) { show(); requestRender(); } else hide();
			if (!manual && !runs.size && !kids && !finalLine && timer) { clearInterval(timer); timer = undefined; }
		} catch { /* never throw into Pi */ } finally { busy = false; }
	}
	const ensureTimer = () => { if (!timer) { timer = setInterval(() => void tick(), 1000); (timer as any).unref?.(); } };

	// ----- tool events -----
	pi.on("tool_execution_start", (event: any, ctx: any) => {
		try {
			claimParent(ctx);
			if (BUS.parent?.id === instanceId && event?.toolName === "Agent") {
				BUS.agents.set(event.toolCallId, agentName(event?.args));
				return;
			}
			const command = event?.args?.command;
			if (!settings.enabled || typeof command !== "string" || !command.trim()) return;
			const child = isChild(ctx);
			if (!child) ui = ctx?.ui ?? ui;
			const cwd = ctx?.cwd ?? process.cwd(), now = Date.now();
			const info = inspectCommand(command, cwd);
			const limits = computeLimits(classify(command, info.scripts, info.dir), history, settings);
			const timeoutSec = typeof event?.args?.timeout === "number" ? event.args.timeout : undefined;
			const run: Run = { id: event.toolCallId, tool: event.toolName ?? "shell", command, start: now, ctx, timeoutSec,
				partial: "", logs: info.logs, tail: [], source: "", lastActivity: now, logSig: "", maxGap: 0, limits };
			runs.set(run.id, run);
			if (child) {
				run.agent = agentLabel([...BUS.agents.values()]);
				BUS.childRuns.set(`${instanceId}:${run.id}`, run);
				BUS.parent?.wake();
			}
			ensureTimer();
		} catch { /* ignore */ }
	});

	pi.on("tool_execution_update", (event: any) => {
		try {
			const run = runs.get(event?.toolCallId);
			const text = textOf(event?.partialResult?.content);
			if (run && text) {
				const t = text.slice(-TAIL_BYTES);
				if (t !== run.partial) { const now = Date.now(); run.partial = t; run.maxGap = Math.max(run.maxGap, now - run.lastActivity); run.lastActivity = now; }
			}
		} catch { /* ignore */ }
	});

	pi.on("tool_execution_end", (event: any) => {
		try {
			if (BUS.agents.delete(event?.toolCallId)) return;
			const run = runs.get(event?.toolCallId);
			if (!run) return;
			runs.delete(run.id);
			if (run.agent) { BUS.childRuns.delete(`${instanceId}:${run.id}`); BUS.parent?.wake(); }
			if (run.stopped) { void sendFollowUp(run); return void tick(); }
			const ms = event?.durationMs ?? Date.now() - run.start;
			if (!event?.isError) record(run, ms);
			if (ms < SHOW_AFTER_MS || !useWidget()) return void tick();
			const text = (event?.result?.content ?? []).map((p: any) => p?.text ?? "").join("\n");
			const code = text.match(/exit(?:ed with)? code[:\s]+(-?\d+)/i)?.[1];
			const ok = !event?.isError && (!code || code === "0");
			finalLine = { ok, text: `${ok ? "✓ done" : `✗ failed${code ? ` (exit ${code})` : ""}`} in ${fmtElapsed(ms)} · ${run.command.replace(/\s+/g, " ")}` };
			clearTimeout(finalTimer);
			finalTimer = setTimeout(() => { finalLine = undefined; void tick(); }, 5000);
			(finalTimer as any).unref?.();
			void tick();
		} catch { /* ignore */ }
	});

	// ----- /livelog -----
	const onOff = (v: string) => v.toLowerCase() === "on";
	pi.registerCommand("livelog", {
		description: "Live log: /livelog <path>|off|lines <n>|widget on|off|watchdog on|off|stall|max <min>|auto|limits|forget|keep|stop|last|lang",
		handler: async (args: string, ctx: any) => {
			try {
				ui = ctx?.ui ?? ui;
				const a = (args ?? "").trim(), say = (m: string) => notify(ctx, m);
				let m: RegExpMatchArray | null;
				if (!a) {
					const running = [...runs.values()].map((r) => `${fmtElapsed(Date.now() - r.start)} ${r.source || "-"} ${limitsHeader(r.limits, r.timeoutSec)}${r.kept ? " (kept)" : ""}`).join("; ");
					return say(`live-log: auto ${settings.enabled ? "on" : "off"}, in-row ${inRow ? "on" : "unavailable"}, widget ${settings.widget ? "on" : "off"}, ${settings.lines} lines, lang ${settings.lang}${settings.lang === "auto" ? ` (${lang(ctx)})` : ""}\n` +
						`watchdog ${settings.watchdog ? "on" : "off"}: stall ${settings.stallMin == null ? "auto" : settings.stallMin || "off"}, max ${settings.maxMin == null ? "auto" : settings.maxMin || "off"}, warn ${settings.warnSec}s (/livelog limits)` +
						`${running ? `\nrunning: ${running}` : ""}${manual ? `\ntailing ${manual.label}` : ""}\n` +
						"Usage: /livelog <path> | off | lines <n> | widget on|off | auto on|off | watchdog on|off | stall <min>|auto | max <min>|auto (0 = off) | limits | forget <sig>|all | keep | stop | last | lang auto|en|vi");
				}
				if (a === "last") {
					try { return say(readFileSync(FILES.lastStop, "utf8").split("\n").slice(0, 70).join("\n")); } catch { return say(TXT[lang(ctx)].none); }
				}
				if (a === "off") { manual = undefined; await tick(); return say("live-log: manual tail stopped"); }
				if (a === "keep") {
					const live = [...runs.values()].filter((r) => !r.stopped);
					live.forEach((r) => { r.kept = true; r.warning = undefined; });
					return say(live.length ? "live-log: watchdog disabled for the running command" : "live-log: nothing running");
				}
				if (a === "stop") {
					const run = [...runs.values()].filter((r) => !r.stopped).pop();
					if (!run) return say("live-log: nothing running");
					run.ctx = run.ctx ?? ctx;
					return void stopRun(run, "stopped with /livelog stop", "manual", "");
				}
				if ((m = a.match(/^lang\s+(auto|en|vi)$/i))) { settings.lang = m[1].toLowerCase() as any; save(); return say(`live-log: lang ${settings.lang}`); }
				if ((m = a.match(/^lines\s+(\d+)$/i))) { settings.lines = Math.min(40, Math.max(1, +m[1])); save(); await tick(); return say(`live-log: ${settings.lines} lines`); }
				if ((m = a.match(/^(auto|widget|watchdog)\s+(on|off)$/i))) {
					const key = m[1].toLowerCase() === "auto" ? "enabled" : (m[1].toLowerCase() as "widget" | "watchdog");
					settings[key] = onOff(m[2]); save(); await tick(); return say(`live-log: ${m[1]} ${m[2]}`);
				}
				if ((m = a.match(/^(stall|max)\s+(auto|\d+(?:\.\d+)?)$/i))) {
					const key = m[1].toLowerCase() === "stall" ? "stallMin" : "maxMin", v = m[2].toLowerCase() === "auto" ? null : Math.max(0, +m[2]);
					settings[key] = v; save(); return say(`live-log: ${m[1].toLowerCase()} ${v == null ? "auto (per command)" : v ? v + "m (global override)" : "off"}`);
				}
				if (a === "limits") {
					const cats = [...CATEGORIES, QUICK_CAT, DEFAULT_CAT].map((c) => `  ${c.name}: stall ${c.stall}m, max ${c.max}m`).join("\n");
					const hist = Object.entries(history).map(([k, v]) => `  ${k}: ${v.length} runs, p90 ${fmtElapsed(p90(v.map((e) => e.ms)))}, longest silence ${fmtElapsed(Math.max(...v.map((e) => e.gap || 0)))}`).join("\n");
					return say(`live-log limits (override: stall ${settings.stallMin ?? "auto"}, max ${settings.maxMin ?? "auto"})\n${cats}\nlearned (${FILES.history}):\n${hist || "  (none yet)"}\n` +
						"With ≥2 successful runs: max = max(category, 2×p90), stall = max(category, 1.5×longest silence).");
				}
				if ((m = a.match(/^forget\s+(.+)$/i))) {
					const q = m[1].trim(), keys = q === "all" ? Object.keys(history) : Object.keys(history).filter((k) => k === q || k.toLowerCase().includes(q.toLowerCase()));
					keys.forEach((k) => delete history[k]); saveHistory();
					return say(`live-log: forgot ${keys.length} signature(s)${keys.length ? `: ${keys.join(", ")}` : ""}`);
				}
				const cands = toCandidates(a, ctx?.cwd ?? process.cwd());
				if (!cands.length) return say(`live-log: cannot resolve path ${a}`);
				manual = { label: cands.find((p) => existsSync(p)) ?? cands[0], cands, tail: [] };
				ensureTimer(); await tick();
				say(`live-log: tailing ${manual.label} (/livelog off to stop)`);
			} catch { /* ignore */ }
		},
	});

	pi.on("session_shutdown", () => {
		try {
			if (timer) clearInterval(timer); timer = undefined; clearTimeout(finalTimer);
			for (const [k, r] of BUS.childRuns) if (k.startsWith(`${instanceId}:`) && !r.stopped) BUS.childRuns.delete(k);
			if (BUS.parent?.id === instanceId) BUS.parent = undefined;
		} catch { /* ignore */ }
	});
}
