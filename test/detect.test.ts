import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { baseDir, findRedirectTargets, inspectCommand, readTail, resolveLogs } from "../src/detect.ts";

test("findRedirectTargets: shell and PowerShell forms", () => {
	assert.deepEqual(findRedirectTargets("make 2>&1 | tee -a out/build.log"), ["out/build.log"]);
	assert.deepEqual(findRedirectTargets("pio run > /tmp/build.log 2>&1"), ["/tmp/build.log"]);
	assert.deepEqual(findRedirectTargets("cmd *> 'C:\\logs\\a b.log'"), ["'C:\\logs\\a b.log'"]);
	assert.deepEqual(findRedirectTargets("npm test | Out-File -FilePath test.txt"), ["test.txt"]);
	assert.deepEqual(findRedirectTargets("Start-Process x -RedirectStandardOutput o.log -RedirectStandardError e.log"), ["o.log", "e.log"]);
	assert.deepEqual(findRedirectTargets("Get-Content .tmp-build.log -Tail 8; Remove-Item old.txt"), [".tmp-build.log", "old.txt"]);
	assert.deepEqual(findRedirectTargets("cat README.md"), [], "non-log file references are ignored");
	assert.deepEqual(findRedirectTargets("a 2>&1"), [], "&1 is not a file");
	assert.deepEqual(findRedirectTargets("x --opt=>y"), [], "= before > is not a redirect");
});

test("baseDir: leading cd / Set-Location", () => {
	assert.equal(baseDir("cd /work/app && make > b.log", "/home/u", undefined, "linux"), "/work/app");
	assert.equal(baseDir("Set-Location -Path 'D:\\proj'; x", "C:\\", undefined, "win32"), "D:\\proj");
	assert.equal(baseDir("make", "/home/u", undefined, "linux"), "/home/u");
});

test("inspectCommand: relative logs resolve against cd (linux)", () => {
	const r = inspectCommand("cd /work/app && Get-Content .tmp-build.log -Tail 8", "/elsewhere", "linux");
	assert.deepEqual(r.logs, [[resolve("/work/app", ".tmp-build.log")]]);
	assert.equal(r.dir, "/work/app");
});

test("inspectCommand: reads redirects inside a script it runs", () => {
	const dir = mkdtempSync(join(tmpdir(), "livelog-"));
	writeFileSync(join(dir, "build.sh"), "#!/bin/bash\ncd /opt/fw\npio run > /tmp/fw-build.log 2>&1\n");
	const r = inspectCommand(`bash ${join(dir, "build.sh")}`, dir, "linux");
	assert.deepEqual(r.logs, [["/tmp/fw-build.log"]]);
	assert.match(r.scripts, /pio run/);
	assert.equal(r.dir, "/opt/fw");
});

test("inspectCommand: WSL script on Windows maps /tmp to the distro UNC path", () => {
	const dir = mkdtempSync(join(tmpdir(), "livelog-"));
	writeFileSync(join(dir, "b.sh"), "pio run > /tmp/build.log 2>&1\n");
	// the script path itself is a native path here; the log inside it is a WSL path
	const logs = resolveLogs("wsl -d Debian bash b.sh", dir, "win32");
	assert.deepEqual(logs[0], ["\\\\wsl.localhost\\Debian\\tmp\\build.log", "\\\\wsl$\\Debian\\tmp\\build.log"]);
});

test("inspectCommand: Start-Job script block and at most 6 candidates", () => {
	const r = inspectCommand("$j = Start-Job { cd /w; make *> job.log }; Receive-Job $j", "/", "linux");
	assert.deepEqual(r.logs, [[resolve("/w", "job.log")]]);
	const many = Array.from({ length: 9 }, (_, i) => `echo ${i} > f${i}.log`).join("; ");
	assert.equal(inspectCommand(many, "/x", "linux").logs.length, 6);
});

test("readTail: newest lines of the first existing candidate, respects since", async () => {
	const dir = mkdtempSync(join(tmpdir(), "livelog-"));
	const f = join(dir, "a.log");
	writeFileSync(f, Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n"));
	const t = await readTail([join(dir, "missing.log"), f], 3);
	assert.equal(t?.path, f);
	assert.deepEqual(t?.lines, ["line 47", "line 48", "line 49"]);
	assert.equal(await readTail([f], 3, Date.now() + 60_000), undefined);
});
