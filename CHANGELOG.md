# Changelog

## 0.1.0 — 2026-10-11

First standalone release, extracted from a personal Pi setup.

- Live log tail inside running `bash` / `powershell` tool rows (tool renderer), optional widget above the editor.
- Log-file detection: `>`, `>>`, `*>`, `2>&1`, `tee [-a]`, `Out-File`, `Tee-Object`, `Add-Content`, `Set-Content`, `-RedirectStandardOutput/Error`, log files read by `Get-Content`/`cat`/`tail`/…, redirects inside `.sh`/`.bash`/`.ps1` scripts the command runs (including `Start-Job` blocks), relative paths resolved against a leading `cd`/`Set-Location`.
- Windows only: WSL path mapping (`/mnt/x/...` → `X:\...`, `/tmp/...` → `\\wsl.localhost\<distro>\...`).
- Watchdog with per-command categories (build / test / install / quick / default), learned history, warning before stop, `/livelog keep` and `/livelog stop`.
- Local stop analysis (errors, waiting for input, loops, downloads, compiling) and a follow-up asking the agent for a summary in the conversation's language. Built-in texts in English and Vietnamese.
- Subagent support: child-session commands show in the main widget; a stop aborts only the child and the summary goes to the main session.
- Files under the Pi agent dir (`PI_CODING_AGENT_DIR`, default `~/.pi/agent`); `LIVE_LOG_SETTINGS` override.
