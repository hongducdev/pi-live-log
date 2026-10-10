/** Local heuristic analysis of a stopped command's log (no LLM, no network). */
import { TXT, type Lang } from "./i18n.ts";

export type Analysis = { hasError: boolean; errors: string[]; why: string };

const ERROR_RE = /\berror\b|FAILED|\bfatal\b|undefined reference|No such file|Traceback|\bpanic\b|Exception|exit status [1-9]|\*\*\* \[|npm ERR!|permission denied|\bkilled\b|out of memory|timed out|Connection (?:refused|reset)|Could not resolve/i;
const NOT_ERROR_RE = /\b0 errors?\b|-Werror|error(?:s)?=0|\bno errors?\b/i;
const DL = /Downloading|Installing|Resolving|Fetching|Unpacking|Tool Manager|Cloning/i;

/** Classify the last log lines: error lines, and a hint for why the command ran long. */
export function analyzeLog(lines: string[], lang: Lang = "en"): Analysis {
	const T = TXT[lang];
	const errors = lines.filter((l) => ERROR_RE.test(l) && !NOT_ERROR_RE.test(l)).slice(-5).map((l) => l.trim().slice(0, 200));
	const last = lines.at(-1)?.trim() ?? "", recent = lines.slice(-10);
	const progress = (() => { for (const l of [...recent].reverse()) { const m = l.match(/\[\s*\d+\s*\/\s*\d+\s*\]|\b\d{1,3}(?:\.\d+)?%/); if (m) return m[0]; } return ""; })();
	let why: string;
	if (!lines.length) why = T.noOutput;
	else if (/\(y\/n\)|\[y\/n\]|\(yes\/no\)|press (?:any|enter|a key)|password|passphrase|continue\?|\?\s*$|(?:enter|input|choose|select)[^:]*:\s*$/i.test(last) && !ERROR_RE.test(last)) why = T.prompt(last.slice(0, 80));
	else if (lines.length >= 4 && lines.slice(-4).every((l) => l === lines.at(-1))) why = T.loop(last.slice(0, 60));
	else if (recent.some((l) => DL.test(l))) why = T.download(progress, recent.filter((l) => DL.test(l)).at(-1)!.trim().slice(0, 70));
	else if (recent.some((l) => /Compiling|Linking|Building|Archiving|Generating|Indexing/i.test(l))) why = T.compile(progress, last.slice(0, 60));
	else why = T.unclear(last.slice(0, 60));
	return { hasError: errors.length > 0, errors, why };
}

/** One-line verdict, e.g. "✗ Stopped after 7m 2s: error — src/a.cpp:12: error: ...". */
export function verdict(a: Analysis, elapsed: string, lang: Lang = "en"): string {
	// Prefer the most specific line (file:line: error / fatal error), else the first error line.
	const best = a.errors.find((e) => /:\d+(?::\d+)?:\s*(?:fatal\s+)?error\b/i.test(e)) ?? a.errors.find((e) => /\berror\b|Traceback|panic|npm ERR!/i.test(e)) ?? a.errors[0];
	return a.hasError ? TXT[lang].errVerdict(elapsed, best!) : TXT[lang].okVerdict(elapsed, a.why);
}

export type StopReport = {
	tool: string; command: string; at: number; elapsed: string; reason: string;
	analysis: Analysis; analysisEn: Analysis; lines: string[]; from: string; agent?: string;
};

/** Markdown written to <agent-dir>/live-log-last-stop.md (shown by /livelog last). */
export function stopMarkdown(r: StopReport, lang: Lang): string {
	const M = TXT[lang].md;
	return `# ${M.title}\n\n- ${M.when}: ${new Date(r.at).toLocaleString("sv-SE")}\n- ${M.cmd}: \`${r.command.replace(/\s+/g, " ").slice(0, 300)}\`\n` +
		`- ${M.runtime}: ${r.elapsed}\n- ${M.reason}: ${r.reason}\n- ${M.error}: ${r.analysis.hasError ? M.yes : M.no}\n` +
		r.analysis.errors.map((e) => `  - \`${e}\`\n`).join("") + `- ${M.why}: ${r.analysis.why}\n- ${M.src}: ${r.from}\n\n` +
		`## ${M.last(r.lines.length)}\n\n\`\`\`\n${r.lines.join("\n")}\n\`\`\`\n`;
}

/**
 * Follow-up message sent to the agent after an auto-stop. It is written in English but asks
 * the model to reply in the conversation's language. `reasonEn` is the English stop reason.
 */
export function followUpMessage(r: StopReport, reasonEn: string): string {
	const cmd = r.command.replace(/\s+/g, " "), short = cmd.length > 300 ? cmd.slice(0, 300) + "…" : cmd;
	const tail = `Command: ${short}\n` +
		`Local pre-analysis: ${verdict(r.analysisEn, r.elapsed, "en")}\n` +
		`Last ${r.lines.length} lines of ${r.from}:\n\`\`\`\n${r.lines.join("\n") || "(no output)"}\n\`\`\`\n`;
	if (r.agent) {
		return `[live-log] Subagent "${r.agent}" was auto-stopped while running \`${r.tool}\` after ${r.elapsed} (${reasonEn}); its Agent call returned as aborted.\n` + tail +
			"Give the user a short summary (command, runtime, stop reason, error yes/no with the exact lines, why it took long, next step) in the conversation's language. " +
			"Do not blindly re-run the subagent: rerun only with streamed output (`cmd 2>&1 | tee <log>`) or a longer limit (/livelog stall|max <min>) if the cause is unclear.";
	}
	return `[live-log] Auto-stopped \`${r.tool}\` after ${r.elapsed} (${reasonEn}).\n` + tail +
		"Before fixing anything, give a short summary with these headings:\n" +
		"**Stopped command summary** — Command (short) · Runtime · Stop reason · Error? (yes/no/unclear; quote the exact error lines) · " +
		"Why it took long (from the log: compiling many files, downloading packages/toolchain, waiting for input, network hang, infinite loop, deadlock, silent process) · Next step.\n" +
		"Reply in the same language you have been using with the user in this conversation (translate the headings too). " +
		"Then fix only if the error is clear; otherwise do not guess: propose rerunning with streamed output (`cmd 2>&1 | tee <log>`) or a longer limit (/livelog stall|max <min>).";
}
