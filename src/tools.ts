/** LLM-facing tools for starting and inspecting background jobs. */

import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatBytes, formatClock, formatDuration, oneLine } from "./format.js";
import type { JobRecord, JobStore } from "./jobs.js";

export function describeStatus(job: JobRecord, now = Date.now()): string {
	if (job.status === "running") return `running for ${formatDuration(now - job.startedAt)}`;
	const ran = formatDuration((job.endedAt ?? now) - job.startedAt);
	if (job.status === "unknown") return `ended after ${ran} (exit code unknown - killed or machine restarted)`;
	return `${job.status} after ${ran} with exit code ${job.exitCode ?? "?"}`;
}

/** One line per job, dense enough to keep bg_list cheap in context. */
export function jobLine(job: JobRecord, now = Date.now()): string {
	const marker = job.status === "running" ? "▶" : job.exitCode === 0 ? "✓" : "✗";
	const age = job.status === "running" ? formatDuration(now - job.startedAt) : formatDuration((job.endedAt ?? now) - job.startedAt);
	const outcome = job.status === "running" ? "running" : job.status === "unknown" ? "exit ?" : `exit ${job.exitCode ?? "?"}`;
	return `${marker} ${job.id.padEnd(20)} ${age.padStart(8)}  ${outcome.padEnd(10)} ${oneLine(job.command, 60)}`;
}

export function registerJobTools(pi: ExtensionAPI, store: JobStore, getSessionFile: () => string | undefined): void {
	pi.registerTool({
		name: "bg_start",
		label: "Background job",
		description:
			"Start a shell command as a detached background job and return immediately. " +
			"Use this for any command expected to run longer than about 60 seconds: training runs, builds, " +
			"long test suites, servers, downloads. The job keeps running even if pi exits. " +
			"stdout and stderr are written to a log file, not into this conversation. " +
			"Returns a job id to use with the other bg_* tools.",
		promptSnippet: "Start a long-running command in the background and get a job id back immediately",
		promptGuidelines: [
			"Use bg_start instead of bash for any command expected to take more than ~60 seconds. bash blocks the whole session until the command finishes.",
		],
		parameters: Type.Object({
			command: Type.String({ description: "Shell command to run" }),
			name: Type.Optional(Type.String({ description: "Short name for the job (defaults to the command's program name)" })),
			cwd: Type.Optional(Type.String({ description: "Working directory, absolute or relative to the session cwd" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cwd = params.cwd ? path.resolve(ctx.cwd, params.cwd) : ctx.cwd;
			const job = store.start({
				command: params.command,
				cwd,
				name: params.name,
				sessionFile: getSessionFile(),
			});
			const lines = [
				`Started background job ${job.id} (pid ${job.pid}) at ${formatClock(job.startedAt)}.`,
				`  command: ${oneLine(job.command, 200)}`,
				`  cwd:     ${job.cwd}`,
				`  log:     ${job.logPath}`,
				"",
				"The job is detached and survives pi restarts. Do not tail or poll the log.",
			];
			return { content: [{ type: "text", text: lines.join("\n") }], details: { job } };
		},
	});

	pi.registerTool({
		name: "bg_list",
		label: "Background jobs",
		description:
			"List background jobs started with bg_start, newest first. Shows status, runtime and exit code. " +
			"Defaults to jobs from the current working directory.",
		promptSnippet: "List background jobs and their status",
		parameters: Type.Object({
			all: Type.Optional(Type.Boolean({ description: "Include jobs from other working directories" })),
			limit: Type.Optional(Type.Number({ description: "Maximum number of jobs to show (default 20)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			store.checkAll();
			const limit = Math.max(1, Math.min(params.limit ?? 20, 100));
			const jobs = (params.all ? store.list() : store.listFor(ctx.cwd)).slice(0, limit);
			if (jobs.length === 0) {
				return { content: [{ type: "text", text: "No background jobs." }], details: { jobs: [] } };
			}
			const now = Date.now();
			const text = jobs.map((j) => jobLine(j, now)).join("\n");
			const runningCount = jobs.filter((j) => j.status === "running").length;
			return {
				content: [{ type: "text", text: `${jobs.length} job(s), ${runningCount} running:\n${text}` }],
				details: { jobs },
			};
		},
	});

	pi.registerTool({
		name: "bg_logs",
		label: "Background job logs",
		description:
			"Read the tail of a background job's log. Only use this after a wake notification tells you something " +
			"happened, or when the user explicitly asks about the log. Never call this in a loop to check progress.",
		promptSnippet: "Read the tail of a background job's log after being notified",
		parameters: Type.Object({
			job: Type.String({ description: "Job id or name from bg_start" }),
			tail: Type.Optional(Type.Number({ description: "Number of trailing lines (default 50, max 2000)" })),
			grep: Type.Optional(Type.String({ description: "Only return lines matching this regular expression" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const job = store.resolve(params.job, ctx.cwd);
			if (!job) throw new Error(`No background job matching "${params.job}". Use bg_list to see available jobs.`);
			store.check(job.id);
			const fresh = store.resolve(job.id) ?? job;
			const slice = store.readLog(fresh, { tail: params.tail, grep: params.grep });
			const header =
				`${fresh.id}: ${describeStatus(fresh)}` +
				`\nlog ${formatBytes(slice.bytes)}${slice.truncated ? ", showing tail only" : ""}` +
				(params.grep ? `, filtered by /${params.grep}/` : "");
			const body = slice.lines.length > 0 ? slice.lines.join("\n") : "(no matching output)";
			return { content: [{ type: "text", text: `${header}\n\n${body}` }], details: { job: fresh, slice } };
		},
	});

	pi.registerTool({
		name: "bg_kill",
		label: "Kill background job",
		description: "Send a signal to a background job's process group. Defaults to SIGTERM.",
		promptSnippet: "Stop a background job",
		parameters: Type.Object({
			job: Type.String({ description: "Job id or name" }),
			signal: Type.Optional(Type.String({ description: "Signal name, e.g. SIGTERM or SIGKILL (default SIGTERM)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const job = store.resolve(params.job, ctx.cwd);
			if (!job) throw new Error(`No background job matching "${params.job}". Use bg_list to see available jobs.`);
			const signal = (params.signal ?? "SIGTERM") as NodeJS.Signals;
			const result = store.kill(job, signal);
			if (!result.ok) throw new Error(`Could not signal ${job.id}: ${result.error}`);
			return {
				content: [{ type: "text", text: `Sent ${signal} to ${job.id} (pid ${job.pid}).` }],
				details: { job, signal },
			};
		},
	});
}
