/**
 * Behavioural guardrails.
 *
 * The runtime primitives in this extension only pay off if the model actually
 * uses them. Left alone, models reach for `nohup ... &` followed by
 * `sleep 30; tail log` -- which is the exact pattern that makes a two minute
 * job cost eleven turns. So the two habits are blocked at the tool boundary,
 * with an error message that names the tool to use instead.
 */

import type { LongrunConfig } from "./config.js";
import { formatDuration, oneLine } from "./format.js";
import type { JobStore } from "./jobs.js";
import { summarizeJob } from "./metrics.js";
import type { WaitWatcher } from "./waits.js";

export interface GuardVerdict {
	reason: string;
}

const SINGLE_AMPERSAND_AT_END = /(?<![&>|])&(?!&)\s*(?:#.*)?$/;
const DETACHERS = /\b(?:nohup|setsid|disown)\b/;
const TAIL_FOLLOW = /\btail\b[^|;&\n]*?\s-[a-zA-Z]*f\b/;
const WATCH_COMMAND = /(?:^|[;&|]\s*)watch\s/;
const SLEEP_WITH_NUMBER = /\bsleep\s+(\d+(?:\.\d+)?)([smhd]?)\b/g;
const LOOP_WITH_SLEEP = /\b(?:while|until)\b[\s\S]*\bsleep\b/;

function sleepSeconds(value: string, unit: string): number {
	const n = Number(value);
	switch (unit) {
		case "m":
			return n * 60;
		case "h":
			return n * 3600;
		case "d":
			return n * 86400;
		default:
			return n;
	}
}

/** True when the command does something other than sleep. */
function isCompound(command: string): boolean {
	const withoutSleeps = command.replace(SLEEP_WITH_NUMBER, "").trim();
	return /[;&|\n]/.test(command.trim()) || withoutSleeps.replace(/[;&|\s]/g, "").length > 0;
}

/**
 * Decide whether a bash command is really a wait-and-check loop in disguise.
 * Returns undefined when the command should run normally.
 */
export function inspectBashCommand(command: string, config: LongrunConfig): GuardVerdict | undefined {
	if (!config.guardBash) return undefined;
	const trimmed = command.trim();

	// Opt-in: commands a project knows are long-running should never go through bash.
	for (const pattern of config.autoBackgroundPatterns) {
		try {
			if (new RegExp(pattern).test(trimmed)) {
				return {
					reason: `This project marks commands matching /${pattern}/ as long-running. Start it with bg_start and wait with bg_wait instead of blocking the session.`,
				};
			}
		} catch {
			/* an unparseable pattern must not break tool calls */
		}
	}

	if (TAIL_FOLLOW.test(trimmed)) {
		return {
			reason:
				"`tail -f` blocks this session for as long as the job runs. Use bg_wait with a log_pattern to be woken when the interesting line appears, then end your turn.",
		};
	}

	if (WATCH_COMMAND.test(trimmed)) {
		return { reason: "`watch` polls forever and blocks the session. Use bg_wait to be notified instead." };
	}

	if (LOOP_WITH_SLEEP.test(trimmed)) {
		return {
			reason:
				"This is a polling loop. Every iteration keeps the session busy for no benefit. Use bg_wait to register the condition you are waiting for, then end your turn -- you will be woken when it fires.",
		};
	}

	SLEEP_WITH_NUMBER.lastIndex = 0;
	let total = 0;
	let longest = 0;
	for (const match of trimmed.matchAll(SLEEP_WITH_NUMBER)) {
		const seconds = sleepSeconds(match[1] ?? "0", match[2] ?? "");
		total += seconds;
		longest = Math.max(longest, seconds);
	}
	if (total === 0) return undefined;

	if (isCompound(trimmed)) {
		if (total >= config.maxCompoundSleepSeconds) {
			return {
				reason:
					`This sleeps ${formatDuration(total * 1000)} alongside another command, which is a poll. ` +
					"To wait for something, use bg_wait (job exit, log_pattern, file, or a wall-clock time) and end your turn; waiting that way costs no tokens. " +
					"If the sleep is part of real work rather than a check, run the whole thing with bg_start.",
			};
		}
		return undefined;
	}

	if (longest >= config.maxBareSleepSeconds) {
		return {
			reason:
				`A blocking \`sleep ${formatDuration(longest * 1000)}\` freezes the whole session. ` +
				"Use bg_wait with after_seconds instead, then end your turn.",
		};
	}
	return undefined;
}

/**
 * bg_start already detaches the process and captures its output, so a command
 * handed to it should not do either itself. Models still write
 * `nohup ... > log 2>&1 &` out of habit; left alone, the redirect sends output
 * to a file the job log never sees, which makes wake notifications and bg_logs
 * come back empty. Strip the redundant parts and say so in the tool result.
 */
export function normalizeJobCommand(command: string): { command: string; notes: string[] } {
	const notes: string[] = [];
	let next = command;

	const detached = next.replace(/(^|[;&|]\s*)(?:nohup|setsid)\s+/g, "$1");
	if (detached !== next) {
		notes.push("dropped nohup/setsid: bg_start already runs the command detached");
		next = detached;
	}

	const foreground = next.replace(/(?<![&>|])&\s*$/, "");
	if (foreground !== next) {
		notes.push("dropped the trailing &: bg_start already returns immediately");
		next = foreground;
	}

	// Only stdout redirects to a real file are removed. /dev/null and stderr-only
	// redirects are deliberate choices and are left in place.
	const redirect = /\s(?:1?>{1,2})\s*("[^"]+"|'[^']+'|[^\s;&|]+)(\s+2>&1)?/g;
	let redirected = false;
	next = next.replace(redirect, (match, target: string) => {
		if (/^["']?\/dev\/null["']?$/.test(target)) return match;
		redirected = true;
		return "";
	});
	if (redirected) {
		notes.push("dropped the output redirect: bg_start captures stdout and stderr in the job log, which bg_logs and wake notifications read from");
	}

	return { command: next.trim(), notes };
}

/** Manual backgrounding bypasses the job store, so the runtime cannot watch or notify. */
export function inspectBackgroundLaunch(command: string, config: LongrunConfig): GuardVerdict | undefined {
	if (!config.guardBackgroundLaunch) return undefined;
	const trimmed = command.trim();
	const detached = DETACHERS.test(trimmed);
	const trailing = SINGLE_AMPERSAND_AT_END.test(trimmed.split("\n").pop() ?? trimmed);
	if (!detached && !trailing) return undefined;
	return {
		reason:
			"Use bg_start instead of backgrounding a command from bash. bg_start records the pid and exit code, keeps the log out of this conversation, and lets bg_wait notify you when the job ends. A process started with & or nohup is invisible to both.",
	};
}

/**
 * Enforce the user's own command allowlist for bg_start.
 *
 * bg_start runs arbitrary shell, so an auto-approval extension that exempts it
 * by name is exempting everything. This gives the user a way to make that
 * exemption bounded: the allowlist is checked here, inside the tool that asked
 * to be trusted. Returns an error message when the command is not allowed.
 */
export function checkCommandAllowlist(command: string, config: LongrunConfig): string | undefined {
	if (config.commandAllowlist.length === 0) return undefined;
	for (const pattern of config.commandAllowlist) {
		try {
			if (new RegExp(pattern).test(command)) return undefined;
		} catch {
			/* an unparseable pattern must not silently widen the allowlist */
		}
	}
	return (
		`bg_start refused "${oneLine(command, 80)}": this project restricts background jobs to commands matching ` +
		`${config.commandAllowlist.map((p) => `/${p}/`).join(", ")}. ` +
		"Run it with bash instead, or ask the user to add it to commandAllowlist in .pi/longrun.json."
	);
}

/**
 * Escalating minimum wait, so a model that keeps asking "is it done yet?" every
 * 30 seconds is slowed down by the runtime rather than by its own judgement.
 */
export class WaitBackoff {
	private consecutive = 0;
	private lastJobId: string | undefined;
	/** How many waits have been registered against a job that had already finished. */
	private readonly finishedJobWaits = new Map<string, number>();

	constructor(private readonly getConfig: () => LongrunConfig) {}

	/** Called for timer-only waits. Returns the seconds actually enforced. */
	enforce(requestedSeconds: number, jobId: string | undefined): { seconds: number; escalated: boolean } {
		const config = this.getConfig();
		if (config.disableBackoff) {
			const seconds = Math.max(requestedSeconds, config.backoffFloorSeconds);
			return { seconds, escalated: seconds > requestedSeconds };
		}
		if (jobId !== this.lastJobId) {
			this.lastJobId = jobId;
			this.consecutive = 0;
		}
		const floor = Math.min(config.backoffFloorSeconds * 2 ** this.consecutive, 30 * 60);
		this.consecutive++;
		const seconds = Math.max(requestedSeconds, floor);
		return { seconds, escalated: seconds > requestedSeconds };
	}

	/**
	 * Waiting for a job that has already finished is legitimate once: it is the
	 * race this extension exists to absorb, and the wake fires immediately.
	 * Doing it again means the model is spinning on a result it already has.
	 * Deliberately not cleared by reset(), which fires on every real wake.
	 */
	noteWaitOnFinishedJob(jobId: string): number {
		const count = (this.finishedJobWaits.get(jobId) ?? 0) + 1;
		this.finishedJobWaits.set(jobId, count);
		return count;
	}

	/** A real event (job exit, log match, file) means the model was not just spinning. */
	reset(): void {
		this.consecutive = 0;
		this.lastJobId = undefined;
	}
}

/**
 * The state block appended to the system prompt. Keeping running jobs and pending
 * wake-ups in front of the model is what stops it calling bg_list to re-orient.
 */
export function buildSystemPromptSection(
	store: JobStore,
	waits: WaitWatcher,
	cwd: string,
	config: LongrunConfig,
): string | undefined {
	const running = store.running(cwd);
	const pending = waits.list();
	if (running.length === 0 && pending.length === 0) return undefined;

	const now = Date.now();
	const lines = ["## Long-running work in progress", ""];

	if (running.length > 0) {
		lines.push("Background jobs currently running:");
		for (const job of running) {
			const summary = summarizeJob(store, job, config, now);
			lines.push(`- ${job.id} (${formatDuration(now - job.startedAt)}): ${oneLine(job.command, 80)}`);
			if (summary) lines.push(`  latest: ${summary}`);
		}
		lines.push("");
	}
	if (pending.length > 0) {
		lines.push("Wake-ups you already registered:");
		for (const wait of pending) {
			const when = wait.deadlineAt ? ` by ${formatDuration(Math.max(0, wait.deadlineAt - now))}` : "";
			lines.push(`- ${wait.id}${when}: ${oneLine(wait.note, 90)}`);
		}
		lines.push("");
	}
	lines.push(
		"This state is refreshed every turn, so you never need bg_list to find it.",
		"Do not tail, poll or sleep to check on these. Call bg_wait and end your turn; the runtime wakes you with the status and log tail.",
	);
	return lines.join("\n");
}
