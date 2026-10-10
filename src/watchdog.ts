/**
 * Watchdog: per-command limits (category defaults raised by learned history) and the
 * stall / max-runtime decision.
 */
import { fmtElapsed, fmtMin } from "./format.ts";

export type Limits = { category: string; sig: string; stallMin: number; maxMin: number; why: string };
export type HistoryEntry = { ms: number; gap: number; at: number };
export type History = Record<string, HistoryEntry[]>;
export type Classification = { category: string; stall: number; max: number; sig: string };

/** Command categories with default stall / max limits in minutes (first match wins). */
export const CATEGORIES = [
	{ name: "test", stall: 5, max: 30, re: /\b(?:pytest|vitest|jest|ctest)\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\b(?:cargo|flutter|dotnet|pio|go)\s+test\b/i },
	{ name: "install", stall: 5, max: 20, re: /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|ci)\b|\bpip3?\s+install\b|\bapt(?:-get)?\s+(?:install|update|upgrade)\b|\b(?:winget|choco|scoop)\s+install\b|\b(?:curl|wget|Invoke-WebRequest)\b|\bgit\s+clone\b|\bpio\s+pkg\b|\bflutter\s+pub\s+get\b/i },
	{ name: "build", stall: 10, max: 60, re: /\b(?:pio|platformio|idf\.py|cmake|make|ninja|msbuild|gradlew?|mvn)\b|\b(?:cargo|dotnet|flutter|tauri)\s+build\b|\bcargo\s+tauri\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b/i },
] as const;
const QUICK = /^(?:git|ls|dir|cat|type|gc|Get-Content|Get-ChildItem|gci|Get-Item|Select-String|sls|rg|grep|findstr|echo|Write-Output|Write-Host|Test-Path|pwd|cd|Set-Location|sl|head|tail|wc|which|where|Get-Command|Get-Location|Resolve-Path|Measure-Object|Sort-Object|Select-Object|Format-\w+|Out-String)$/i;
export const DEFAULT_CAT = { name: "default", stall: 5, max: 30 };
export const QUICK_CAT = { name: "quick", stall: 2, max: 5 };

/** Category + a normalized signature such as "pio run @ /home/me/firmware". */
export function classify(command: string, scripts: string, dir: string): Classification {
	const text = `${command}\n${scripts}`;
	for (const c of CATEGORIES) {
		const m = c.re.exec(text);
		if (m) {
			const w = text.slice(m.index).split(/\s+/), key = w.slice(0, w[1] === "run" ? 3 : 2).filter((x, i) => i === 0 || /^[A-Za-z][\w:.-]*$/.test(x)).join(" ");
			return { category: c.name, stall: c.stall, max: c.max, sig: `${key.toLowerCase().replace(/\s+/g, " ")} @ ${dir}` };
		}
	}
	const segs = command.split(/[;\n|]|&&|\|\|/).map((x) => x.trim()).filter(Boolean);
	const firstWords = segs.map((x) => x.split(/\s+/)[0]);
	const quick = segs.length > 0 && firstWords.every((w) => QUICK.test(w)) && !/\bgit\s+(?:clone|fetch|pull|push)\b/i.test(command);
	const c = quick ? QUICK_CAT : DEFAULT_CAT;
	return { category: c.name, stall: c.stall, max: c.max, sig: `${segs.slice(-1)[0]?.split(/\s+/).slice(0, 2).join(" ").toLowerCase() ?? "?"} @ ${dir}` };
}

export const p90 = (xs: number[]) => { const a = [...xs].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.ceil(a.length * 0.9) - 1)]; };

/** Limits for one command: category defaults, raised by history (2x p90 duration, 1.5x longest silent gap), then global overrides. */
export function computeLimits(cls: Classification, history: History, over: { stallMin: number | null; maxMin: number | null }): Limits {
	let stall = cls.stall, max = cls.max, why = "default";
	const h = (history[cls.sig] ?? []).filter((e) => e && e.ms > 0);
	if (h.length >= 2) {
		const p = p90(h.map((e) => e.ms)), gap = Math.max(...h.map((e) => e.gap || 0));
		max = Math.max(cls.max, Math.ceil((2 * p) / 60_000));
		stall = Math.max(cls.stall, Math.ceil((1.5 * gap) / 60_000));
		why = `history: ${h.length} runs, p90 ${fmtElapsed(p)}`;
	}
	if (over.stallMin != null || over.maxMin != null) why = `override${why === "default" ? "" : `; ${why}`}`;
	if (over.stallMin != null) stall = over.stallMin;
	if (over.maxMin != null) max = over.maxMin;
	return { category: cls.category, sig: cls.sig, stallMin: stall, maxMin: max, why };
}

/** Row/widget header, e.g. "⏱ build · stall 10m · max 45m (history: 6 runs, p90 18m)". */
export function limitsHeader(l: Limits, timeoutSec?: number): string {
	const t = timeoutSec && l.maxMin && timeoutSec < l.maxMin * 60 ? ` · ⚠ tool timeout ${timeoutSec}s < max` : "";
	return `⏱ ${l.category} · stall ${l.stallMin ? fmtMin(l.stallMin) : "off"} · max ${l.maxMin ? fmtMin(l.maxMin) : "off"} (${l.why})${t}`;
}

/** Add one successful run to the history (last 10 per signature, at most 200 signatures). Mutates and returns `history`. */
export function recordHistory(history: History, sig: string, entry: HistoryEntry, perSig = 10, maxSigs = 200): History {
	const list = (history[sig] ??= []);
	list.push(entry);
	history[sig] = list.slice(-perSig);
	const keys = Object.keys(history);
	if (keys.length > maxSigs) for (const k of keys.sort((x, y) => (history[x].at(-1)?.at ?? 0) - (history[y].at(-1)?.at ?? 0)).slice(0, keys.length - maxSigs)) delete history[k];
	return history;
}

export type WatchInput = { start: number; lastActivity: number; limits: Limits; kept?: boolean; stopped?: unknown };
export type WatchDecision =
	| { action: "none" }
	| { action: "warn"; kind: "stall" | "max"; reason: string; leftMs: number; warning: string }
	| { action: "stop"; kind: "stall" | "max"; reason: string; detail: string };

/**
 * Decide what the watchdog does for one run at time `now`. It warns `warnSec` seconds
 * (at most half the stall limit) before stopping on stall (no new output) or max runtime.
 */
export function evaluateWatchdog(run: WatchInput, now: number, warnSec: number, enabled = true): WatchDecision {
	if (!enabled || run.kept || run.stopped) return { action: "none" };
	const stallMs = run.limits.stallMin * 60_000, maxMs = run.limits.maxMin * 60_000;
	const warnMs = Math.min(warnSec * 1000, stallMs / 2 || Infinity);
	const idle = now - run.lastActivity, total = now - run.start;
	let reason = "", kind: "stall" | "max" = "stall", left = Infinity;
	if (stallMs > 0 && idle >= stallMs - warnMs) { left = stallMs - idle; reason = `no new output for ${fmtElapsed(idle)}`; }
	if (maxMs > 0 && total >= maxMs - warnMs && maxMs - total < left) { left = maxMs - total; reason = `running for ${fmtElapsed(total)} (max ${fmtMin(run.limits.maxMin)})`; kind = "max"; }
	if (!reason) return { action: "none" };
	if (left <= 0) return { action: "stop", kind, reason, detail: kind === "max" ? String(run.limits.maxMin) : fmtElapsed(idle) };
	return { action: "warn", kind, reason, leftMs: left, warning: `${reason}, auto-stop in ${Math.ceil(left / 1000)}s (/livelog keep to continue)` };
}
