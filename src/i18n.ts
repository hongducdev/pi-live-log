/** The extension's own (non-LLM) texts, in English and Vietnamese. */
export type Lang = "en" | "vi";

export const TXT = {
	en: {
		noOutput: "no output at all: the process was silent or hung from the start",
		prompt: (l: string) => `looks like it is waiting for input: "${l}"`,
		loop: (l: string) => `looks like a loop: "${l}" keeps repeating`,
		download: (p: string, l: string) => `downloading/installing packages or toolchain${p ? ` (${p})` : ""}: "${l}"`,
		compile: (p: string, l: string) => `still compiling${p ? `, progress ${p}` : ""}; last line: "${l}"`,
		unclear: (l: string) => `no clear sign; the process went silent after: "${l}"`,
		errVerdict: (t: string, e: string) => `✗ Stopped after ${t}: error — ${e}`,
		okVerdict: (t: string, w: string) => `⚠ Stopped after ${t}: no error found; ${w}`,
		stall: (t: string) => `no output for ${t}`, max: (m: number) => `exceeded the ${m} min limit`, manual: "stopped manually with /livelog stop",
		notify: (l: string, r: string) => `live-log: ${l} (reason: ${r}). See /livelog last`,
		md: { title: "Stopped command summary (live-log)", when: "Time", cmd: "Command", runtime: "Runtime", reason: "Stop reason", error: "Error?",
			yes: "yes", no: "no error found", why: "Why it took long (automatic analysis)", src: "Log source", last: (n: number) => `Last ${n} lines` },
		none: "live-log: no command has been stopped yet",
	},
	vi: {
		noOutput: "không có output nào: tiến trình im lặng hoặc bị treo ngay từ đầu",
		prompt: (l: string) => `có vẻ đang chờ nhập: "${l}"`,
		loop: (l: string) => `có vẻ bị lặp: dòng "${l}" lặp lại liên tục`,
		download: (p: string, l: string) => `đang tải/cài gói hoặc toolchain${p ? ` (${p})` : ""}: "${l}"`,
		compile: (p: string, l: string) => `vẫn đang biên dịch${p ? `, tiến độ ${p}` : ""}; dòng cuối: "${l}"`,
		unclear: (l: string) => `không thấy dấu hiệu rõ; tiến trình im lặng sau dòng cuối: "${l}"`,
		errVerdict: (t: string, e: string) => `✗ Dừng sau ${t}: có lỗi — ${e}`,
		okVerdict: (t: string, w: string) => `⚠ Dừng sau ${t}: không thấy lỗi; ${w}`,
		stall: (t: string) => `treo ${t} không ra log`, max: (m: number) => `vượt giới hạn ${m} phút`, manual: "dừng thủ công bằng /livelog stop",
		notify: (l: string, r: string) => `live-log: ${l} (lý do: ${r}). Xem /livelog last`,
		md: { title: "Tóm tắt lệnh bị dừng (live-log)", when: "Thời điểm", cmd: "Lệnh", runtime: "Thời gian chạy", reason: "Lý do dừng", error: "Có lỗi không",
			yes: "có", no: "không thấy lỗi", why: "Vì sao chạy lâu (phân tích tự động)", src: "Nguồn log", last: (n: number) => `${n} dòng cuối` },
		none: "live-log: chưa có lệnh nào bị dừng",
	},
};

/** Vietnamese if the text has several Vietnamese-only diacritics, else English. */
export function detectLang(text: string): Lang {
	return (text.match(/[ăđơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/gi) ?? []).length >= 3 ? "vi" : "en";
}

/** Human stop reason in the given language. */
export const reasonText = (L: Lang, kind: string, detail: string) =>
	kind === "manual" ? TXT[L].manual : kind === "max" ? TXT[L].max(+detail) : TXT[L].stall(detail);
