/**
 * Process-wide bus for subagents. Subagent extensions (e.g. @tintinweb/pi-subagents) run
 * child sessions in the same process; each gets its own live-log instance but no UI
 * (hasUI false). Child runs are published here so the UI instance (the parent) shows
 * them in its widget, and a child's auto-stop summary is delivered to the parent session
 * (ctx.abort() in the child aborts only the child; the parent's Agent call returns "aborted").
 */
export type ParentHandle = { id: number; send: (msg: string) => void; wake: () => void; notify: (m: string, level: string) => void };
export type Bus<R> = { parent?: ParentHandle; childRuns: Map<string, R>; agents: Map<string, string>; seq: number };

/** Shared across all live-log instances (and module copies) in this process. */
export function getBus<R>(): Bus<R> {
	return ((globalThis as any).__liveLogBus ??= { childRuns: new Map(), agents: new Map(), seq: 0 });
}

/** Label for a child run given the names of currently running Agent calls. */
export function agentLabel(names: string[]): string {
	return names.length === 1 ? names[0] : names.length ? `subagent (${names.length} running)` : "subagent";
}

/** Name of an Agent tool call from its args. */
export function agentName(args: any): string {
	return String(args?.name || args?.description || args?.subagent_type || "subagent");
}
