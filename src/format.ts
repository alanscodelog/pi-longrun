/** Small formatting helpers shared by tools, notifications and the TUI. */

export function formatDuration(ms: number): string {
	if (ms < 0) ms = 0;
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${s % 60 ? ` ${s % 60}s` : ""}`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
	const d = Math.floor(h / 24);
	return `${d}d${h % 24 ? ` ${h % 24}h` : ""}`;
}

/** Absolute local time, so the model never has to guess "when was that". */
export function formatClock(ts: number): string {
	const d = new Date(ts);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function formatBytes(n: number): string {
	if (n < 1024) return `${n}B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
	return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

/** POSIX single-quote escaping. */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Collapse a command to something usable as a job name / display label. */
export function slugifyCommand(command: string): string {
	const firstWord =
		command
			.trim()
			.split(/\s+/)
			.find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) ?? "job";
	const base = firstWord.split("/").pop() ?? firstWord;
	const slug = base.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 16);
	return slug.length > 0 ? slug : "job";
}

/** Single-line preview of a possibly multi-line command. */
export function oneLine(command: string, max = 72): string {
	const flat = command.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
