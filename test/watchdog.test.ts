import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, computeLimits, evaluateWatchdog, limitsHeader, recordHistory, type History } from "../src/watchdog.ts";

test("classify: categories and signatures", () => {
	const cases: [string, string][] = [
		["pio run -e esp32", "build"], ["npm run build", "build"], ["cargo build --release", "build"], ["cmake --build out", "build"],
		["npm test", "test"], ["pio test -e native", "test"], ["pytest -q", "test"],
		["npm ci", "install"], ["pip install -r req.txt", "install"], ["git clone https://x/y", "install"],
		["git status; ls", "quick"], ["Get-ChildItem | Select-Object Name", "quick"],
		["python train.py", "default"], ["git pull", "default"],
	];
	for (const [cmd, want] of cases) assert.equal(classify(cmd, "", "/p").category, want, cmd);
	assert.equal(classify("pio run -e esp32", "", "/fw").sig, "pio run @ /fw");
	assert.equal(classify("npm run build", "", "/w").sig, "npm run build @ /w");
	assert.equal(classify("bash b.sh", "make -j8 > b.log", "/w").category, "build", "script text counts");
});

test("computeLimits: defaults, history, overrides", () => {
	const cls = classify("pio run", "", "/fw");
	const none = computeLimits(cls, {}, { stallMin: null, maxMin: null });
	assert.deepEqual([none.stallMin, none.maxMin, none.why], [10, 60, "default"]);
	assert.match(limitsHeader(none, 300), /⚠ tool timeout 300s < max/);
	const min = 60_000;
	const hist: History = { [cls.sig]: [5, 8, 10, 12, 15, 18].map((m) => ({ ms: m * min, gap: 9 * min, at: 1 })) };
	const learned = computeLimits(cls, hist, { stallMin: null, maxMin: null });
	assert.deepEqual([learned.stallMin, learned.maxMin, learned.why], [14, 60, "history: 6 runs, p90 18m 0s"]);
	const big: History = { [cls.sig]: [40, 45].map((m) => ({ ms: m * min, gap: 0, at: 1 })) };
	assert.deepEqual([computeLimits(cls, big, { stallMin: null, maxMin: null }).maxMin, computeLimits(cls, big, { stallMin: null, maxMin: null }).stallMin], [90, 10]);
	const ov = computeLimits(cls, big, { stallMin: 3, maxMin: null });
	assert.equal(ov.stallMin, 3); assert.equal(ov.maxMin, 90); assert.match(ov.why, /^override; history/);
	assert.match(limitsHeader({ ...ov, stallMin: 0 }), /stall off/);
});

test("recordHistory keeps 10 per signature and 200 signatures", () => {
	const h: History = {};
	for (let i = 0; i < 15; i++) recordHistory(h, "a", { ms: i, gap: 0, at: i });
	assert.equal(h.a.length, 10); assert.equal(h.a[0].ms, 5);
	for (let i = 0; i < 205; i++) recordHistory(h, `s${i}`, { ms: 1, gap: 0, at: 1000 + i });
	assert.equal(Object.keys(h).length, 200);
	assert.ok(!("a" in h), "oldest signature evicted");
});

test("evaluateWatchdog timing: warn before stall, then stop", () => {
	const limits = { category: "build", sig: "x", stallMin: 10, maxMin: 60, why: "" };
	const run = { start: 0, lastActivity: 0, limits };
	const m = 60_000;
	assert.equal(evaluateWatchdog(run, 8 * m, 60).action, "none");
	const w = evaluateWatchdog(run, 9 * m + 30_000, 60);
	assert.equal(w.action, "warn");
	if (w.action === "warn") { assert.equal(w.kind, "stall"); assert.match(w.warning, /no new output for 9m 30s, auto-stop in 30s \(\/livelog keep/); }
	const s = evaluateWatchdog(run, 10 * m, 60);
	assert.deepEqual(s, { action: "stop", kind: "stall", reason: "no new output for 10m 0s", detail: "10m 0s" });
	// activity resets stall; max still applies
	const active = { start: 0, lastActivity: 60 * m - 1000, limits };
	const mx = evaluateWatchdog(active, 60 * m, 60);
	assert.equal(mx.action, "stop"); if (mx.action === "stop") { assert.equal(mx.kind, "max"); assert.equal(mx.detail, "60"); }
	// warn window is at most half the stall limit
	const short = { start: 0, lastActivity: 0, limits: { ...limits, stallMin: 1 } };
	assert.equal(evaluateWatchdog(short, 29_000, 60).action, "none");
	assert.equal(evaluateWatchdog(short, 31_000, 60).action, "warn");
	// kept / disabled / zero limits
	assert.equal(evaluateWatchdog({ ...run, kept: true }, 99 * m, 60).action, "none");
	assert.equal(evaluateWatchdog(run, 99 * m, 60, false).action, "none");
	assert.equal(evaluateWatchdog({ ...run, limits: { ...limits, stallMin: 0, maxMin: 0 } }, 999 * m, 60).action, "none");
});
