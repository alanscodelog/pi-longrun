/** Footer status and the /jobs widget. Purely local UI: nothing here reaches the LLM. */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LongrunConfig } from "./config.js";
import { formatDuration, oneLine } from "./format.js";
import type { JobStore } from "./jobs.js";
import { summarizeJob } from "./metrics.js";
import type { WaitWatcher } from "./waits.js";

const STATUS_KEY = "longrun";
const WIDGET_KEY = "longrun-jobs";
const REFRESH_INTERVAL_MS = 5000;

export class JobUi {
	private ctx: ExtensionContext | undefined;
	private timer: NodeJS.Timeout | undefined;
	private widgetVisible = false;

	constructor(
		private readonly store: JobStore,
		private readonly waits: WaitWatcher,
		private readonly getConfig: () => LongrunConfig,
	) {}

	attach(ctx: ExtensionContext): void {
		this.ctx = ctx;
		if (!ctx.hasUI) return;
		this.refresh();
		this.timer ??= setInterval(() => this.refresh(), REFRESH_INTERVAL_MS);
		this.timer.unref?.();
	}

	detach(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		if (this.ctx?.hasUI) {
			this.ctx.ui.setStatus(STATUS_KEY, undefined);
			this.ctx.ui.setWidget(WIDGET_KEY, undefined);
		}
		this.widgetVisible = false;
		this.ctx = undefined;
	}

	notify(message: string, type: "info" | "warning" | "error" = "info"): void {
		if (this.ctx?.hasUI) this.ctx.ui.notify(message, type);
	}

	toggleWidget(): boolean {
		this.widgetVisible = !this.widgetVisible;
		this.refresh();
		return this.widgetVisible;
	}

	/** Recompute the footer status and, when open, the job widget. */
	refresh(): void {
		const ctx = this.ctx;
		if (!ctx?.hasUI) return;

		const running = this.store.running(ctx.cwd);
		const pending = this.waits.list();
		const parts: string[] = [];
		if (running.length > 0) parts.push(`▶ ${running.length} job${running.length > 1 ? "s" : ""}`);
		if (pending.length > 0) {
			const next = this.waits.nextDeadline();
			parts.push(next !== undefined ? `⏰ wake in ${formatDuration(next - Date.now())}` : `⏰ ${pending.length} wait`);
		}
		ctx.ui.setStatus(STATUS_KEY, parts.length > 0 ? parts.join("  ") : undefined);

		if (!this.widgetVisible) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		ctx.ui.setWidget(WIDGET_KEY, this.widgetLines(ctx.cwd));
	}

	private widgetLines(cwd: string): string[] {
		const now = Date.now();
		const jobs = this.store.listFor(cwd).slice(0, 12);
		const pending = this.waits.list();
		if (jobs.length === 0 && pending.length === 0) return ["longrun: no background jobs"];
		const lines = ["longrun jobs (/jobs to hide)"];
		for (const job of jobs) {
			const marker = job.status === "running" ? "▶" : job.exitCode === 0 ? "✓" : "✗";
			const age = formatDuration((job.status === "running" ? now : (job.endedAt ?? now)) - job.startedAt);
			const outcome = job.status === "running" ? "" : ` exit ${job.exitCode ?? "?"}`;
			lines.push(`  ${marker} ${job.id}  ${age}${outcome}  ${oneLine(job.command, 48)}`);
			if (job.status === "running") {
				const summary = summarizeJob(this.store, job, this.getConfig(), now);
				if (summary) lines.push(`      ${oneLine(summary, 70)}`);
			}
		}
		for (const wait of pending) {
			lines.push(`  ⏰ ${wait.id}  ${oneLine(wait.note, 56)}`);
		}
		return lines;
	}
}
