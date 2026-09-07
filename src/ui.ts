/** Footer status and the /jobs widget. Purely local UI: nothing here reaches the LLM. */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatDuration, oneLine } from "./format.js";
import type { JobStore } from "./jobs.js";

const STATUS_KEY = "longrun";
const WIDGET_KEY = "longrun-jobs";
const REFRESH_INTERVAL_MS = 5000;

export class JobUi {
	private ctx: ExtensionContext | undefined;
	private timer: NodeJS.Timeout | undefined;
	private widgetVisible = false;

	constructor(private readonly store: JobStore) {}

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
		ctx.ui.setStatus(STATUS_KEY, running.length > 0 ? `▶ ${running.length} job${running.length > 1 ? "s" : ""}` : undefined);

		if (!this.widgetVisible) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		ctx.ui.setWidget(WIDGET_KEY, this.widgetLines(ctx.cwd));
	}

	private widgetLines(cwd: string): string[] {
		const now = Date.now();
		const jobs = this.store.listFor(cwd).slice(0, 12);
		if (jobs.length === 0) return ["longrun: no background jobs"];
		const lines = ["longrun jobs (/jobs to hide)"];
		for (const job of jobs) {
			const marker = job.status === "running" ? "▶" : job.exitCode === 0 ? "✓" : "✗";
			const age = formatDuration((job.status === "running" ? now : (job.endedAt ?? now)) - job.startedAt);
			const outcome = job.status === "running" ? "" : ` exit ${job.exitCode ?? "?"}`;
			lines.push(`  ${marker} ${job.id}  ${age}${outcome}  ${oneLine(job.command, 48)}`);
		}
		return lines;
	}
}
