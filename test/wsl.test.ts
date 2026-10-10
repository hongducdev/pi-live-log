import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { toCandidates } from "../src/wsl.ts";

test("windows: /mnt/<drive> maps to a drive path", () => {
	assert.deepEqual(toCandidates("/mnt/d/proj/a.log", "C:\\", "Ubuntu", "win32"), ["D:\\proj\\a.log"]);
	assert.deepEqual(toCandidates("/mnt/c", "C:\\", "Ubuntu", "win32"), ["C:\\"]);
});

test("windows: other POSIX paths map to the WSL distro share", () => {
	assert.deepEqual(toCandidates("/tmp/b.log", "C:\\", "Debian", "win32"), ["\\\\wsl.localhost\\Debian\\tmp\\b.log", "\\\\wsl$\\Debian\\tmp\\b.log"]);
	assert.deepEqual(toCandidates('"/tmp/x y.log"', "C:\\", "Ubuntu", "win32")[0], "\\\\wsl.localhost\\Ubuntu\\tmp\\x y.log");
});

test("windows: drive and UNC paths pass through", () => {
	assert.deepEqual(toCandidates("D:\\a.log", "C:\\", "Ubuntu", "win32"), ["D:\\a.log"]);
	assert.deepEqual(toCandidates("\\\\srv\\share\\a.log", "C:\\", "Ubuntu", "win32"), ["\\\\srv\\share\\a.log"]);
});

test("linux/macOS: POSIX paths are used as-is (no WSL mapping)", () => {
	assert.deepEqual(toCandidates("/tmp/b.log", "/home/u", undefined, "linux"), ["/tmp/b.log"]);
	assert.deepEqual(toCandidates("/mnt/d/a.log", "/home/u", undefined, "linux"), ["/mnt/d/a.log"]);
	assert.deepEqual(toCandidates("out/a.log", "/home/u", undefined, "darwin"), [resolve("/home/u", "out/a.log")]);
	assert.deepEqual(toCandidates("~/a.log", "/x", undefined, "linux"), [join(homedir(), "/a.log")]);
});

test("unresolvable targets are skipped", () => {
	for (const p of ["$LOG", "/dev/null", "$null", "NUL", "nul", "*.log", "%TEMP%\\a.log", ""]) assert.deepEqual(toCandidates(p, "/", "Ubuntu", "win32"), [], p);
});
