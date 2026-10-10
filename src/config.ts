/**
 * Settings and file locations. Files live in the Pi agent directory
 * (PI_CODING_AGENT_DIR, default ~/.pi/agent):
 *   live-log.json            settings (changed with /livelog ...)
 *   live-log-history.json    learned run durations per command signature
 *   live-log-last-stop.md    report of the last stopped command (/livelog last)
 * LIVE_LOG_SETTINGS=<file> moves the settings file; the other two files go next to it.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Lang } from "./i18n.ts";

export type Settings = {
	enabled: boolean; lines: number; widget: boolean; watchdog: boolean;
	stallMin: number | null; maxMin: number | null; warnSec: number; lang: "auto" | Lang;
};
export const DEFAULTS: Settings = { enabled: true, lines: 8, widget: false, watchdog: true, stallMin: null, maxMin: null, warnSec: 60, lang: "auto" };

export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function paths(env: NodeJS.ProcessEnv = process.env) {
	const settings = env.LIVE_LOG_SETTINGS || join(agentDir(env), "live-log.json");
	const dir = dirname(settings);
	return { settings, history: join(dir, "live-log-history.json"), lastStop: join(dir, "live-log-last-stop.md") };
}

export function readJson<T>(file: string, fallback: T): T {
	try { return JSON.parse(readFileSync(file, "utf8")) ?? fallback; } catch { return fallback; }
}

/** Write a file, creating its folder; never throws. */
export function writeQuiet(file: string, text: string): void {
	try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text, "utf8"); } catch { /* ignore */ }
}

export function loadSettings(file: string): Settings {
	return { ...DEFAULTS, ...readJson<Partial<Settings>>(file, {}) };
}
