/**
 * Log-file detection: find the file(s) a shell command writes its output to, so the
 * extension can tail them while the command runs.
 */
import { readFileSync, statSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { cleanLines } from "./format.ts";
import { toCandidates } from "./wsl.ts";

export const TAIL_BYTES = 16 * 1024;
const PATH_RE = String.raw`("[^"]+"|'[^']+'|[^\s;&|<>(){}"']+)`;

export type Tail = { path: string; lines: string[]; sig: string };

/** Directory of a leading `cd X` / Set-Location / pushd, used as the base for relative paths. */
export function baseDir(text: string, cwd: string, distro?: string, platform?: string): string {
	const m = text.match(new RegExp(String.raw`(?:^|[;&\n{]\s*)(?:cd|Set-Location|sl|pushd|Push-Location)\s+(?:-(?:Path|LiteralPath)\s+)?` + PATH_RE, "i"));
	return (m && toCandidates(m[1], cwd, distro, platform)[0]) || cwd;
}

/** Extract log-file targets from shell or PowerShell text. */
export function findRedirectTargets(text: string): string[] {
	const res = [
		new RegExp(String.raw`(?:^|[^\w=-])(?:\d|\*|&)?>>?\s*` + PATH_RE, "g"),
		new RegExp(String.raw`\btee(?:\s+-a|\s+--append)?\s+` + PATH_RE, "gi"),
		new RegExp(String.raw`\b(?:Out-File|Tee-Object|Add-Content|Set-Content)\s+(?:-(?:FilePath|LiteralPath|Path)\s+)?` + PATH_RE, "gi"),
		new RegExp(String.raw`-RedirectStandard(?:Output|Error)\s+` + PATH_RE, "gi"),
	];
	const found: string[] = [];
	const add = (t?: string) => { if (t && !t.startsWith("&") && !t.startsWith("-") && !found.includes(t)) found.push(t); };
	for (const re of res) for (const m of text.matchAll(re)) add(m[1]);
	// Log-like files that the command reads, deletes or tests (e.g. `Get-Content .tmp-build.log -Tail 8`).
	const ref = new RegExp(String.raw`\b(?:Get-Content|gc|cat|type|tail|Remove-Item|rm|del|Test-Path)\b(?:\s+-\w+(?:\s+\d+)?)*\s+(?:-(?:Path|LiteralPath)\s+)?` + PATH_RE, "gi");
	for (const m of text.matchAll(ref)) if (/\.(log|txt|out)["']?$/i.test(m[1])) add(m[1]);
	return found;
}

/** Log candidates, the text of scripts the command runs, and the directory it works in. */
export function inspectCommand(command: string, cwd: string, platform?: string): { logs: string[][]; scripts: string; dir: string } {
	let scripts = "", dir = "";
	const distro = command.match(/\bwsl(?:\.exe)?\b[^;|&\n]*?(?:-d|--distribution)\s+["']?([^\s"']+)/i)?.[1];
	const base = baseDir(command, cwd, distro, platform);
	const out: string[][] = [];
	const push = (c: string[]) => { if (c.length && !out.some((o) => o[0] === c[0])) out.push(c); };
	for (const t of findRedirectTargets(command)) push(toCandidates(t, base, distro, platform));
	const scriptRe = /("[^"]+\.(?:sh|bash|ps1)"|'[^']+\.(?:sh|bash|ps1)'|[^\s;&|<>"'{}]+\.(?:sh|bash|ps1))(?=$|[\s;&|)}"'])/gi;
	for (const m of command.matchAll(scriptRe)) {
		for (const file of toCandidates(m[1], base, distro, platform)) {
			try {
				if (statSync(file).size > 256 * 1024) continue;
				const text = readFileSync(file, "utf8");
				scripts += "\n" + text;
				const sbase = baseDir(text, base, distro, platform);
				dir ||= sbase !== base ? sbase : dirname(file); // the script's own `cd`, else its folder
				for (const t of findRedirectTargets(text)) push(toCandidates(t, sbase, distro, platform));
				break;
			} catch { /* script not readable: ignore */ }
		}
	}
	return { logs: out.slice(0, 6), scripts, dir: dir || base };
}

/** All log-file candidates for a command, including redirects inside scripts it runs. */
export function resolveLogs(command: string, cwd: string, platform?: string): string[][] { return inspectCommand(command, cwd, platform).logs; }

/** Read the last `bytes` of the first existing candidate modified at/after `since`. */
export async function readTail(cands: string[], n: number, since = 0, bytes = TAIL_BYTES): Promise<Tail | undefined> {
	for (const p of cands) {
		try {
			const st = await stat(p);
			if (!st.isFile() || st.mtimeMs < since) continue;
			const fh = await open(p, "r");
			try {
				const len = Math.min(st.size, bytes), buf = Buffer.alloc(len);
				await fh.read(buf, 0, len, st.size - len);
				return { path: p, lines: cleanLines(buf.toString("utf8"), n), sig: `${st.size}:${st.mtimeMs}` };
			} finally { await fh.close(); }
		} catch { /* missing / locked: try next */ }
	}
	return undefined;
}
