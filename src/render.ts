/** Rendering: the in-row log tail for shell tool rows, and the optional widget. */
import { basename } from "node:path";
import { cleanLines, fit, fmtElapsed, textOf } from "./format.ts";
import { limitsHeader, type Limits } from "./watchdog.ts";

export const SHELL_TOOLS = ["powershell", "bash"];

export type RowRun = { tail: string[]; partial: string; logPath?: string; limits: Limits; timeoutSec?: number; warning?: string };
export type RowOptions = { isPartial: boolean; enabled: boolean; watchdog: boolean; stopSummary?: string; run?: RowRun };

/**
 * Transform a shell tool result before the built-in renderer draws it:
 * - while running: append the log tail (when a log file is used), the limits header and any warning;
 * - when finished after an auto-stop: append the stop verdict.
 */
export function decorateResult(result: any, o: RowOptions): any {
	if (!o.isPartial && o.stopSummary) {
		const own = textOf(result?.content).trimEnd();
		result = { ...result, content: [{ type: "text", text: [own, o.stopSummary].filter(Boolean).join("\n") }] };
	}
	const run = o.run;
	if (o.isPartial && run && o.enabled) {
		const own = textOf(result?.content).trimEnd();
		const body = run.logPath ? [own ? "──" : "", ...run.tail] : [];
		const head = limitsHeader(run.limits, run.timeoutSec) + (run.logPath ? ` · log ${basename(run.logPath)}` : "");
		const text = [own, ...body, o.watchdog ? head : "", run.warning ? `⚠ ${run.warning}` : ""].filter(Boolean).join("\n");
		result = { ...result, content: [{ type: "text", text }] };
	}
	return result;
}

/** Log/stdout tail plus watchdog warning for a run (plain text lines). */
export function runLines(run: RowRun, n: number): string[] {
	const tail = run.tail.length ? run.tail : cleanLines(run.partial, n);
	return run.warning ? [...tail, `⚠ ${run.warning}`] : tail;
}

export type WidgetRun = RowRun & { agent?: string; command: string; start: number; source: string };
export type WidgetState = {
	manual?: { label: string; tail: string[] };
	run?: WidgetRun;
	finalLine?: { text: string; ok: boolean };
	showFinal: boolean;
	lines: number;
	watchdog: boolean;
	now: number;
};

/** Widget lines, truncated to `width` (wide chars counted as 2 columns). */
export function widgetLines(s: WidgetState, width: number, theme: any): string[] {
	const w = Math.max(20, width), c = (k: string, t: string) => { try { return theme?.fg ? theme.fg(k, t) : t; } catch { return t; } };
	if (s.manual) return [c("accent", fit(`▸ tail ${s.manual.label}`, w)),
		...(s.manual.tail.length ? s.manual.tail : ["(file empty or not found yet)"]).map((l) => c("dim", fit(`  ${l}`, w)))];
	const run = s.run;
	if (run) {
		const head = `▸ ${run.agent ? `⤷ ${run.agent}: ` : ""}${fmtElapsed(s.now - run.start)} · ${run.command.replace(/\s+/g, " ")}`;
		const src = run.source ? ` [${run.source}]` : "";
		const lines = s.watchdog ? [...runLines(run, s.lines), limitsHeader(run.limits, run.timeoutSec)] : runLines(run, s.lines);
		return [c("accent", fit(fit(head, w - src.length) + src, w)),
			...(lines.length ? lines : ["(no output yet)"]).map((l) => c(l.startsWith("⚠") ? "warning" : "dim", fit(`  ${l}`, w)))];
	}
	if (s.finalLine && s.showFinal) return [c(s.finalLine.ok ? "success" : "error", fit(s.finalLine.text, w))];
	return [];
}
