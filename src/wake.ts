/**
 * Turning wake events into exactly one message for the model.
 *
 * Every wake costs a full-context turn, so two rules drive this file:
 *   1. Coalesce. Three jobs finishing together must produce one turn, not three.
 *   2. Be self-sufficient. Ship the log tail and the model's own note inside the
 *      notification so it does not have to spend extra tool calls re-orienting.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LongrunConfig } from "./config.js";
import { formatClock, formatDuration } from "./format.js";
import type { JobRecord, JobStore } from "./jobs.js";
import { estimateProgress, extractMetrics, formatMetrics, formatProgress } from "./metrics.js";
import { describeStatus } from "./tools.js";
import type { WakeEvent } from "./waits.js";

const COALESCE_MS = 1500;
const TAIL_ON_EXIT = 25;
const TAIL_ON_MATCH = 8;

export interface WakeDelivery {
	content: string;
	urgent: boolean;
	events: WakeEvent[];
}

function failed(job: JobRecord): boolean {
	return job.status === "unknown" || (job.exitCode ?? 0) !== 0;
}

function indent(lines: string[]): string[] {
	return lines.map((l) => `   | ${l}`);
}

function renderEvent(event: WakeEvent, store: JobStore, config: LongrunConfig, index: number, total: number): string[] {
	const label = total > 1 ? `${index + 1}. ` : "";
	const lines: string[] = [];
	const reason = event.reason;

	switch (reason.kind) {
		case "job_exit": {
			lines.push(`${label}job ${reason.job.id} ${describeStatus(reason.job, event.firedAt)}`);
			// Waking on exit while a pattern was pending means the pattern never hit.
			// Say so, otherwise the model assumes its regex was the thing that fired.
			if (event.wait.logPattern) {
				lines.push(`   note: your log_pattern /${event.wait.logPattern}/ never matched; the job ending is what woke you`);
			}
			break;
		}
		case "log_match": {
			lines.push(`${label}job ${reason.job.id} log matched /${reason.pattern}/`);
			lines.push(`   matched line: ${reason.line}`);
			break;
		}
		case "timer": {
			lines.push(`${label}scheduled wake-up (waited ${formatDuration(event.firedAt - event.wait.createdAt)})`);
			break;
		}
		case "file": {
			lines.push(`${label}file ${reason.created ? "appeared" : "changed"}: ${reason.path}`);
			break;
		}
		case "max_wait": {
			lines.push(`${label}wait timed out after ${formatDuration(event.firedAt - event.wait.createdAt)} without the condition firing`);
			break;
		}
	}

	if (event.wait.note) lines.push(`   your note: ${event.wait.note}`);

	const job = reason.kind === "job_exit" || reason.kind === "log_match" ? reason.job : undefined;
	if (job) {
		const tail = store.readLog(job, { tail: reason.kind === "job_exit" ? TAIL_ON_EXIT : TAIL_ON_MATCH });
		// Metrics come before the raw tail: they are what the model is usually after.
		const metrics = formatMetrics(extractMetrics(tail.lines, config));
		if (metrics) lines.push(`   metrics: ${metrics}`);
		if (job.status === "running") {
			const progress = estimateProgress(tail.lines, event.firedAt - job.startedAt, config);
			if (progress) lines.push(`   progress: ${formatProgress(progress)}`);
		}
		if (tail.lines.length > 0) {
			lines.push(`   log tail (${tail.lines.length} lines${tail.truncated ? " of a longer log" : ""}):`);
			lines.push(...indent(tail.lines));
		} else {
			lines.push("   log is empty");
		}
	}
	return lines;
}

export function formatWake(events: WakeEvent[], store: JobStore, cwd: string, config: LongrunConfig): WakeDelivery {
	const firedAt = events[0]?.firedAt ?? Date.now();
	const header =
		events.length === 1
			? `[longrun] wake at ${formatClock(firedAt)}`
			: `[longrun] ${events.length} wake conditions fired at ${formatClock(firedAt)}`;

	const body: string[] = [header, ""];
	events.forEach((event, i) => {
		body.push(...renderEvent(event, store, config, i, events.length));
		body.push("");
	});

	const stillRunning = store.running(cwd);
	body.push(
		stillRunning.length === 0
			? "No background jobs are still running."
			: `Still running: ${stillRunning.map((j) => `${j.id} (${formatDuration(firedAt - j.startedAt)})`).join(", ")}.`,
	);
	body.push(
		"The log tail above is current. Continue from here without re-reading logs unless you need output that is not shown.",
	);

	const urgent = events.some((e) => (e.reason.kind === "job_exit" ? failed(e.reason.job) : false));
	return { content: body.join("\n"), urgent, events };
}

/** Buffers wake events briefly so simultaneous ones become a single turn. */
export class WakeNotifier {
	private pending: WakeEvent[] = [];
	private timer: NodeJS.Timeout | undefined;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly store: JobStore,
		private readonly getCwd: () => string,
		private readonly getConfig: () => LongrunConfig,
		private readonly onDelivered?: (delivery: WakeDelivery) => void,
	) {}

	push(events: WakeEvent[]): void {
		if (events.length === 0) return;
		this.pending.push(...events);
		if (this.timer) return;
		this.timer = setTimeout(() => this.flush(), COALESCE_MS);
		this.timer.unref?.();
	}

	/** Deliver immediately, skipping the coalescing window. */
	flush(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		const events = this.pending.splice(0);
		if (events.length === 0) return;

		const delivery = formatWake(events, this.store, this.getCwd(), this.getConfig());
		this.pi.sendMessage(
			{
				customType: "longrun-wake",
				content: delivery.content,
				display: true,
				details: { events: events.map((e) => ({ reason: e.reason.kind, waitId: e.wait.id, note: e.wait.note })) },
			},
			{
				triggerTurn: true,
				// A failure should reach the model at the next LLM call; a clean finish can
				// wait until the agent is done with whatever it is doing.
				deliverAs: delivery.urgent ? "steer" : "followUp",
			},
		);
		this.onDelivered?.(delivery);
	}

	dispose(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		this.pending = [];
	}
}
