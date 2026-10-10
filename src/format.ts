/** Small text helpers shared by the renderer, watchdog and analysis. */

const ANSI = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;

/** Strip ANSI, keep only the text after the last \r of each line, drop blanks, keep last n. */
export function cleanLines(text: string, n: number): string[] {
	const out: string[] = [];
	for (let line of (text ?? "").replace(ANSI, "").split("\n")) {
		line = line.replace(/\r+$/, "");
		const cr = line.lastIndexOf("\r");
		if (cr >= 0) line = line.slice(cr + 1);
		line = line.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").replace(/\t/g, "  ").trimEnd();
		if (line.trim()) out.push(line);
	}
	return out.slice(-n);
}

/** Approximate terminal width of one char (combining = 0, East Asian wide/emoji = 2). */
export function charWidth(cp: number): number {
	if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || cp === 0xfe0f) return 0;
	if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
		(cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
		(cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)) return 2;
	return 1;
}

/** Truncate plain text to a visible width, adding an ellipsis when cut. */
export function fit(text: string, width: number): string {
	const chars = [...text], widths = chars.map((ch) => charWidth(ch.codePointAt(0) ?? 32));
	if (widths.reduce((a, b) => a + b, 0) <= width) return text;
	let w = 0, out = "";
	for (let i = 0; i < chars.length && w + widths[i] <= width - 1; i++) { w += widths[i]; out += chars[i]; }
	return out + "…";
}

/** "42s", "3m 5s", "1h 2m". */
export function fmtElapsed(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000)), m = Math.floor(s / 60), h = Math.floor(m / 60);
	return h ? `${h}h ${m % 60}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
}

/** Minutes as "4.5m", "45m", "1h30m". */
export const fmtMin = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? `${Math.round(m % 60)}m` : ""}` : `${Math.round(m * 10) / 10}m`);

/** Join the text parts of a tool result / message content array. */
export function textOf(content: any): string {
	return (Array.isArray(content) ? content : []).filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n");
}
