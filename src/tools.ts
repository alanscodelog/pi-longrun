/** LLM-facing tools: start background jobs, and wait for things without burning turns. */

import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatBytes, formatClock, formatDuration, oneLine } from "./format.js";
import type { LongrunConfig } from "./config.js";
import { checkCommandAllowlist, normalizeJobCommand, type WaitBackoff } from "./guards.js";
import type { JobRecord, JobStore } from "./jobs.js";
import { extractMetrics, formatMetrics, summarizeJob } from "./metrics.js";
import type { WaitWatcher } from "./waits.js";

const MIN_WAIT_SECONDS = 5;
const MAX_WAIT_SECONDS = 7 * 24 * 60 * 60;

export interface ToolDeps {
	store: JobStore;
	waits: WaitWatcher;
	backoff: WaitBackoff;
	getConfig: () => LongrunConfig;
	getSessionFile: () => string | undefined;
}

export function describeStatus(job: JobRecord, now = Date.now()): string {
	if (job.status === "running") return `running for ${formatDuration(now - job.startedAt)}`;
	const ran = formatDuration((job.endedAt ?? now) - job.startedAt);
	if (job.status === "unknown") {
		return job.error
			? `failed to run after ${ran}: ${job.error}`
			: `ended after ${ran} (exit code unknown - killed or machine restarted)`;
	}
	return `${job.status} after ${ran} with exit code ${job.exitCode ?? "?"}`;
}

/** One line per job, dense enough to keep bg_task_list cheap in context. */
export function jobLine(job: JobRecord, now = Date.now()): string {
	const marker = job.status === "running" ? "▶" : job.exitCode === 0 ? "✓" : "✗";
	const age = formatDuration((job.status === "running" ? now : (job.endedAt ?? now)) - job.startedAt);
	const outcome = job.status === "running" ? "running" : job.status === "unknown" ? "exit ?" : `exit ${job.exitCode ?? "?"}`;
	return `${marker} ${job.id.padEnd(20)} ${age.padStart(8)}  ${outcome.padEnd(10)} ${oneLine(job.command, 60)}`;
}

/** Accepts ISO-8601, "YYYY-MM-DD HH:MM" and bare "HH:MM" (next occurrence). */
export function parseAt(value: string, now = Date.now()): number {
	const trimmed = value.trim();
	const hhmm = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
	if (hhmm) {
		const hours = Number(hhmm[1]);
		const minutes = Number(hhmm[2]);
		if (hours > 23 || minutes > 59) throw new Error(`Invalid time "${value}"`);
		const target = new Date(now);
		target.setHours(hours, minutes, 0, 0);
		if (target.getTime() <= now) target.setDate(target.getDate() + 1);
		return target.getTime();
	}
	const parsed = Date.parse(trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T"));
	if (Number.isNaN(parsed)) throw new Error(`Could not parse "${value}" as a time. Use "HH:MM" or an ISO-8601 timestamp.`);
	return parsed;
}

export function registerTools(pi: ExtensionAPI, deps: ToolDeps): void {
	const { store, waits, backoff, getConfig, getSessionFile } = deps;

	pi.registerTool({
		name: "bg_task_start",
		label: "Background job",
		description:
			"Start a shell command as a detached background job and return immediately. " +
			"Use this for any command expected to run longer than about 60 seconds: training runs, builds, " +
			"long test suites, servers, downloads. The job keeps running even if pi exits. " +
			"stdout and stderr are written to a log file, not into this conversation. " +
			"Returns a job id. To wait for it, call bg_task_wait and end your turn.",
		promptSnippet: "Start a long-running command in the background and get a job id back immediately",
		promptGuidelines: [
			"Use bg_task_start instead of bash for any command expected to take more than ~60 seconds. bash blocks the whole session until the command finishes.",
			"After bg_task_start, use bg_task_wait to be woken when the job finishes. Never poll bg_task_logs or sleep in a loop to check on a job.",
		],
		parameters: Type.Object({
			command: Type.String({ description: "Shell command to run" }),
			name: Type.Optional(Type.String({ description: "Short name for the job (defaults to the command's program name)" })),
			cwd: Type.Optional(Type.String({ description: "Working directory, absolute or relative to the session cwd" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cwd = params.cwd?.trim() ? path.resolve(ctx.cwd, params.cwd.trim()) : ctx.cwd;
			const normalized = normalizeJobCommand(params.command);
			if (normalized.command.length === 0) throw new Error("The command is empty after removing redundant backgrounding.");
			const refusal = checkCommandAllowlist(normalized.command, getConfig());
			if (refusal) throw new Error(refusal);
			const job = store.start({ command: normalized.command, cwd, name: params.name, sessionFile: getSessionFile() });
			const lines = [
				`Started background job ${job.id} (pid ${job.pid}) at ${formatClock(job.startedAt)}.`,
				`  command: ${oneLine(job.command, 200)}`,
				`  cwd:     ${job.cwd}`,
				`  log:     ${job.logPath}`,
				"",
				...normalized.notes.map((note) => `  note: ${note}`),
				normalized.notes.length > 0 ? "" : undefined,
				"The job is detached and survives pi restarts. Do not tail or poll the log.",
				`To be notified when it finishes, call bg_task_wait with job="${job.id}" and then end your turn.`,
			].filter((l): l is string => l !== undefined);
			return { content: [{ type: "text", text: lines.join("\n") }], details: { job } };
		},
	});

	pi.registerTool({
		name: "bg_task_wait",
		label: "Wait for wake-up",
		description:
			"Register a wake-up condition and return immediately. This does NOT block. " +
			"Whenever this tool succeeds you WILL be woken exactly once, so end your turn and stop working: " +
			"no further tool calls, no summary that keeps going. This holds even when the job has already finished " +
			"by the time you call: the wake simply arrives right away. " +
			"The notification contains the job status, the tail of its log, and the note you leave here. " +
			"Waiting costs no tokens, so prefer one long wait over repeated short ones. " +
			"Conditions can be combined; whichever happens first wakes you.",
		promptSnippet: "Sleep until a job finishes, a log line matches, a file appears, or a time is reached",
		promptGuidelines: [
			"Use bg_task_wait to wait for background work. It costs nothing while waiting, unlike sleeping in bash or repeatedly calling bg_task_logs.",
			"When bg_task_wait succeeds, end your turn immediately: a wake is guaranteed and it carries the job status and log tail. When bg_task_wait returns an error, no wake is coming, so handle the error instead of ending your turn.",
			"Prefer waiting on a condition (job exit, or log_pattern for a metric line) over waiting on a fixed number of seconds.",
		],
		parameters: Type.Object({
			note: Type.String({
				description:
					"A message to your future self, returned verbatim when you wake. Say what you were doing and what to do next.",
			}),
			job: Type.Optional(Type.String({ description: "Job id or name: wake when this job stops running" })),
			log_pattern: Type.Optional(
				Type.String({
					description:
						"Regular expression matched against raw log lines as they are written, e.g. 'eval_loss' or 'Traceback'. " +
						"Only output produced after this call can match. Requires job.",
				}),
			),
			after_seconds: Type.Optional(Type.Number({ description: "Wake this many seconds from now" })),
			at: Type.Optional(Type.String({ description: 'Wake at a wall-clock time: "HH:MM" or an ISO-8601 timestamp' })),
			file: Type.Optional(Type.String({ description: "Wake when this path appears or its mtime changes" })),
			max_wait_seconds: Type.Optional(
				Type.Number({ description: "Safety net: wake even if nothing else fired (default: none)" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const now = Date.now();
			if (params.log_pattern && !params.job) {
				throw new Error("log_pattern requires job. Pass the job id whose log should be watched.");
			}
			if (params.log_pattern) {
				try {
					new RegExp(params.log_pattern);
				} catch (err) {
					throw new Error(`log_pattern is not a valid regular expression: ${err instanceof Error ? err.message : err}`);
				}
			}

			let job: JobRecord | undefined;
			if (params.job) {
				job = store.resolve(params.job, ctx.cwd);
				if (!job) throw new Error(`No background job matching "${params.job}". Use bg_task_list to see available jobs.`);
				store.check(job.id);
				job = store.resolve(job.id) ?? job;

				// A job that finished before the model got here still gets a wake. Returning
				// the result inline instead would break the one contract this tool has --
				// "call it and you will be woken" -- and a model that dutifully ends its turn
				// on a tool that quietly registered nothing waits forever.
				if (job.status !== "running") {
					const attempts = backoff.noteWaitOnFinishedJob(job.id);
					if (attempts > 1) {
						throw new Error(
							`Job ${job.id} ${describeStatus(job, now)}, and you have already been woken with its result. ` +
								"Use that result instead of waiting for it again.",
						);
					}
				}
			}

			const deadlines: number[] = [];
			let escalatedTo: number | undefined;
			if (params.after_seconds !== undefined) {
				const requested = Math.min(Math.max(params.after_seconds, MIN_WAIT_SECONDS), MAX_WAIT_SECONDS);
				// Repeatedly asking to be woken in 30 seconds is a poll wearing a different hat.
				const enforced = backoff.enforce(requested, job?.id);
				if (enforced.escalated) escalatedTo = enforced.seconds;
				deadlines.push(now + Math.min(enforced.seconds, MAX_WAIT_SECONDS) * 1000);
			}
			if (params.at !== undefined) deadlines.push(parseAt(params.at, now));

			const filePath = params.file ? path.resolve(ctx.cwd, params.file) : undefined;
			if (deadlines.length === 0 && !job && !filePath) {
				throw new Error("bg_task_wait needs at least one condition: job, after_seconds, at, or file.");
			}

			const wait = waits.register({
				note: params.note,
				cwd: ctx.cwd,
				sessionFile: getSessionFile(),
				jobId: job?.id,
				logPattern: params.log_pattern,
				filePath,
				deadlineAt: deadlines.length > 0 ? Math.min(...deadlines) : undefined,
				maxWaitUntil:
					params.max_wait_seconds !== undefined
						? now + Math.min(Math.max(params.max_wait_seconds, MIN_WAIT_SECONDS), MAX_WAIT_SECONDS) * 1000
						: undefined,
			});

			// A pattern that matches nothing in the output so far is usually a guess at
			// the log format rather than a deliberate choice. Say so now, not in an hour.
			let patternHint: string | undefined;
			if (job && params.log_pattern) {
				const existing = store.readLog(job, { tail: 20 });
				if (existing.lines.length > 0) {
					const re = new RegExp(params.log_pattern);
					if (!existing.lines.some((line) => re.test(line))) {
						patternHint =
							`Heads up: /${params.log_pattern}/ does not match any of the last ${existing.lines.length} lines already in the log, ` +
							`for example "${existing.lines[existing.lines.length - 1]}". If that is not the format you expected, the job ending will still wake you.`;
					}
				}
			}

			const alreadyFinished = job !== undefined && job.status !== "running";
			const conditions: string[] = [];
			if (alreadyFinished && job) {
				conditions.push(`immediately, because job ${job.id} has already finished`);
			} else if (job && params.log_pattern) {
				conditions.push(`when job ${job.id} log matches /${params.log_pattern}/, or when it stops running`);
			} else if (job) {
				conditions.push(`when job ${job.id} stops running`);
			}
			if (filePath) conditions.push(`when ${filePath} appears or changes`);
			if (wait.deadlineAt) conditions.push(`when the clock reaches ${formatClock(wait.deadlineAt)}`);
			if (wait.maxWaitUntil) conditions.push(`at the latest ${formatClock(wait.maxWaitUntil)}`);

			waits.poke();

			const text = [
				`Wake condition ${wait.id} registered. You will be woken ${conditions.join(", or ")}.`,
				...(patternHint ? ["", patternHint] : []),
				...(escalatedTo !== undefined
					? [
							"",
							`Note: the timer was extended to ${escalatedTo}s, the minimum wake interval. It doubles for each consecutive short timer on the same job, because waking early re-reads the whole context without learning anything new. Prefer waiting on the job itself, or on a log_pattern.`,
						]
					: []),
				"",
				"End your turn now. Do not call more tools and do not keep working on this thread.",
				"Waiting is free: no tokens are spent until you are woken.",
			].join("\n");
			return { content: [{ type: "text", text }], details: { wait, registered: true } };
		},
	});

	pi.registerTool({
		name: "bg_task_list",
		label: "Background jobs",
		description:
			"List background jobs started with bg_task_start, newest first. Shows status, runtime and exit code. " +
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
			const config = getConfig();
			const rows = jobs.flatMap((job) => {
				const line = jobLine(job, now);
				if (job.status !== "running") return [line];
				const summary = summarizeJob(store, job, config, now);
				return summary ? [line, `    latest: ${summary}`] : [line];
			});
			const pending = waits.list();
			const footer =
				pending.length > 0
					? `\n\n${pending.length} pending wake condition(s); you will be notified, do not poll.`
					: "";
			return {
				content: [
					{
						type: "text",
						text: `${jobs.length} job(s), ${jobs.filter((j) => j.status === "running").length} running:\n${rows.join("\n")}${footer}`,
					},
				],
				details: { jobs },
			};
		},
	});

	pi.registerTool({
		name: "bg_task_logs",
		label: "Background job logs",
		description:
			"Read the tail of a background job's log. Only use this after a wake notification tells you something " +
			"happened and you need output beyond the tail already included in that notification, or when the user asks. " +
			"Never call this in a loop to check progress: use bg_task_wait instead.",
		promptSnippet: "Read the tail of a background job's log after being notified",
		parameters: Type.Object({
			job: Type.String({ description: "Job id or name from bg_task_start" }),
			tail: Type.Optional(Type.Number({ description: "Number of trailing lines (default 50, max 2000)" })),
			grep: Type.Optional(Type.String({ description: "Only return lines matching this regular expression" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const job = store.resolve(params.job, ctx.cwd);
			if (!job) throw new Error(`No background job matching "${params.job}". Use bg_task_list to see available jobs.`);
			store.check(job.id);
			const fresh = store.resolve(job.id) ?? job;
			const slice = store.readLog(fresh, { tail: params.tail, grep: params.grep });
			const metrics = formatMetrics(extractMetrics(slice.lines, getConfig()));
			const header =
				`${fresh.id}: ${describeStatus(fresh)}` +
				`\nlog ${formatBytes(slice.bytes)}${slice.truncated ? ", showing tail only" : ""}` +
				(params.grep ? `, filtered by /${params.grep}/` : "") +
				(metrics ? `\nmetrics: ${metrics}` : "");
			const body = slice.lines.length > 0 ? slice.lines.join("\n") : "(no matching output)";
			return { content: [{ type: "text", text: `${header}\n\n${body}` }], details: { job: fresh, slice } };
		},
	});

	pi.registerTool({
		name: "bg_task_kill",
		label: "Kill background job",
		description: "Send a signal to a background job's process group. Defaults to SIGTERM.",
		promptSnippet: "Stop a background job",
		parameters: Type.Object({
			job: Type.String({ description: "Job id or name" }),
			signal: Type.Optional(Type.String({ description: "Signal name, e.g. SIGTERM or SIGKILL (default SIGTERM)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const job = store.resolve(params.job, ctx.cwd);
			if (!job) throw new Error(`No background job matching "${params.job}". Use bg_task_list to see available jobs.`);
			const signal = (params.signal ?? "SIGTERM") as NodeJS.Signals;
			const result = store.kill(job, signal);
			if (!result.ok) throw new Error(`Could not signal ${job.id}: ${result.error}`);
			return { content: [{ type: "text", text: `Sent ${signal} to ${job.id} (pid ${job.pid}).` }], details: { job, signal } };
		},
	});
}
