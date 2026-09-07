/**
 * Pulling the interesting numbers out of a job's log.
 *
 * A wake notification is worth far more if it says `loss=0.104 step=40/40` than
 * if it only says "the job finished". This is the difference between the model
 * answering from the notification and spending another turn on bg_logs.
 */

import type { LongrunConfig } from "./config.js";
import { formatDuration } from "./format.js";
import type { JobRecord, JobStore } from "./jobs.js";

/** key=value / key: value with a numeric value, which is what training logs emit. */
const GENERIC_METRIC = /\b([A-Za-z_][A-Za-z0-9_.\-/]*)\s*[=:]\s*(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\b/g;

export interface Metric {
	name: string;
	value: string;
}

export interface Progress {
	current: number;
	total: number;
	fraction: number;
	etaMs?: number;
}

/** Last value wins: training logs repeat the same keys every step. */
export function extractMetrics(lines: string[], config: LongrunConfig): Metric[] {
	if (!config.extractMetrics) return [];
	const found = new Map<string, string>();

	for (const rule of config.metricPatterns) {
		let re: RegExp;
		try {
			re = new RegExp(rule.pattern);
		} catch {
			continue;
		}
		for (const line of lines) {
			const match = re.exec(line);
			if (match) found.set(rule.name, match[1] ?? match[0]);
		}
	}

	const explicit = new Set(found.keys());
	for (const line of lines) {
		GENERIC_METRIC.lastIndex = 0;
		for (const match of line.matchAll(GENERIC_METRIC)) {
			const name = match[1];
			const value = match[2];
			if (!name || value === undefined || explicit.has(name)) continue;
			found.set(name, value);
		}
	}

	return [...found].slice(0, config.maxMetrics).map(([name, value]) => ({ name, value }));
}

export function formatMetrics(metrics: Metric[]): string | undefined {
	if (metrics.length === 0) return undefined;
	return metrics.map((m) => `${m.name}=${m.value}`).join(" ");
}

/**
 * Estimate how far along a job is from a `<current>/<total>` marker in its log.
 * Deliberately conservative: a bad guess here would push the model towards a
 * badly sized wait, which is exactly what this extension exists to prevent.
 */
export function estimateProgress(lines: string[], elapsedMs: number, config: LongrunConfig): Progress | undefined {
	let re: RegExp;
	try {
		re = new RegExp(config.progressPattern);
	} catch {
		return undefined;
	}
	for (let i = lines.length - 1; i >= 0; i--) {
		const match = re.exec(lines[i] ?? "");
		if (!match) continue;
		const current = Number(match[1]);
		const total = Number(match[2]);
		if (!Number.isFinite(current) || !Number.isFinite(total)) continue;
		if (total <= 1 || current <= 0 || current > total) continue;
		const fraction = current / total;
		const etaMs = fraction > 0 && fraction < 1 ? Math.round(elapsedMs / fraction - elapsedMs) : 0;
		return { current, total, fraction, etaMs };
	}
	return undefined;
}

export function formatProgress(progress: Progress): string {
	const pct = Math.round(progress.fraction * 100);
	const eta = progress.etaMs && progress.etaMs > 0 ? `, ETA ~${formatDuration(progress.etaMs)}` : "";
	return `${progress.current}/${progress.total} (${pct}%${eta})`;
}

/**
 * Progress and latest metrics for a job, in one line. Computed from the log tail
 * so it costs a read of at most a few KB and never a model turn.
 */
export function summarizeJob(store: JobStore, job: JobRecord, config: LongrunConfig, now = Date.now()): string | undefined {
	const tail = store.readLog(job, { tail: 40 });
	if (tail.lines.length === 0) return undefined;
	const parts: string[] = [];
	const progress = estimateProgress(tail.lines, (job.status === "running" ? now : (job.endedAt ?? now)) - job.startedAt, config);
	if (progress) parts.push(formatProgress(progress));
	const metrics = formatMetrics(extractMetrics(tail.lines, config));
	if (metrics) parts.push(metrics);
	return parts.length > 0 ? parts.join(", ") : undefined;
}
