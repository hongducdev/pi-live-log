/**
 * Path mapping. On Windows, POSIX paths written inside `wsl ...` commands or WSL scripts
 * are mapped to Windows paths the extension can read:
 *   /mnt/d/x  -> D:\x
 *   /tmp/x    -> \\wsl.localhost\<distro>\tmp\x  (fallback \\wsl$\<distro>\tmp\x)
 * On Linux/macOS (including inside WSL itself) POSIX paths are used as-is.
 */
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

let defaultDistroCache: string | undefined;

/** Default WSL distro from the Windows registry (cached); falls back to "Ubuntu". */
export function defaultDistro(): string {
	if (defaultDistroCache) return defaultDistroCache;
	defaultDistroCache = "Ubuntu";
	try {
		if (process.platform !== "win32") return defaultDistroCache;
		const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss";
		const q = (k: string, v: string) => execFileSync("reg", ["query", k, "/v", v], { encoding: "utf8", timeout: 2000, windowsHide: true });
		const guid = q(key, "DefaultDistribution").match(/DefaultDistribution\s+REG_SZ\s+(\S+)/)?.[1];
		const name = guid && q(`${key}\\${guid}`, "DistributionName").match(/DistributionName\s+REG_SZ\s+(.+)/)?.[1]?.trim();
		if (name) defaultDistroCache = name;
	} catch { /* keep fallback */ }
	return defaultDistroCache;
}

/**
 * Map a Windows/WSL/relative path to candidate readable paths (first existing one wins).
 * Returns [] for paths that cannot be resolved statically ($vars, globs, /dev/null, NUL).
 */
export function toCandidates(raw: string, cwd: string, distro?: string, platform: string = process.platform): string[] {
	const p = raw.trim().replace(/^["']|["']$/g, "");
	if (!p || /[$`%*?]/.test(p) || /^(\/dev\/|\$null$|nul$|NUL$)/.test(p)) return [];
	if (platform === "win32") {
		const mnt = p.match(/^\/mnt\/([a-zA-Z])(\/.*)?$/);
		if (mnt) return [`${mnt[1].toUpperCase()}:${(mnt[2] ?? "/").replace(/\//g, "\\")}`];
		if (p.startsWith("/")) {
			const d = distro ?? defaultDistro(), rest = p.replace(/\//g, "\\");
			return [`\\\\wsl.localhost\\${d}${rest}`, `\\\\wsl$\\${d}${rest}`];
		}
		if (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\")) return [p];
	}
	if (isAbsolute(p)) return [p];
	if (p.startsWith("~")) return [join(homedir(), p.slice(1))];
	return [resolve(cwd || process.cwd(), p)];
}
