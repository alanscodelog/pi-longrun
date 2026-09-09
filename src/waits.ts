/**
 * Wake conditions.
 *
 * A wait is registered by the model and then evaluated entirely by this extension.
 * While a wait is pending the model is not running: no turns, no tokens. The whole
 * point is that the cheap side of polling (a stat() every second) happens here
 * instead of inside the agent loop.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { JobRecord, JobStore } from "./jobs.js";

export interface WaitRecord {
	id: string;
	note: string;
	cwd: string;
	sessionFile?: string;
	createdAt: number;
	/** Wake when this job leaves the running state. */
	jobId?: string;
	/** Wake when new output of jobId matches this regex. */
	logPattern?: string;
	/** Bytes of the job log already scanned; only new output can match. */
	logOffset?: number;
	/** Wake when this path appears or its mtime changes. */
	filePath?: string;
	fileExisted?: boolean;
	fileMtime?: number;
	/** Wake at this wall-clock time. */
	deadlineAt?: number;
	/** Safety net so a wait can never hang forever. */
	maxWaitUntil?: number;
}

export type WakeReason =
	| { kind: "job_exit"; job: JobRecord }
	| { kind: "log_match"; job: JobRecord; pattern: string; line: string }
	| { kind: "timer" }
	| { kind: "file"; path: string; created: boolean }
	| { kind: "max_wait" };

export interface WakeEvent {
	wait: WaitRecord;
	reason: WakeReason;
	firedAt: number;
}

const TICK_MS = 1000;
const LOG_SCAN_LIMIT = 256 * 1024;

export class WaitWatcher {
	private readonly dir: string;
	private timer: NodeJS.Timeout | undefined;
	private onWake: ((events: WakeEvent[]) => void) | undefined;
	/** In-memory mirror, keyed by wait id. Disk is the source of truth across restarts. */
	private waits = new Map<string, WaitRecord>();

	constructor(
		private readonly store: JobStore,
		root: string,
	) {
		this.dir = path.join(root, "waits");
	}

	private recordPath(id: string): string {
		return path.join(this.dir, `${id}.json`);
	}

	private persist(wait: WaitRecord): void {
		fs.mkdirSync(this.dir, { recursive: true });
		const target = this.recordPath(wait.id);
		const tmp = `${target}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(wait, null, 2));
		fs.renameSync(tmp, target);
	}

	private forget(id: string): void {
		this.waits.delete(id);
		try {
			fs.rmSync(this.recordPath(id), { force: true });
		} catch {
			/* best effort */
		}
	}

	/** Load waits belonging to a session file. Called on session_start. */
	load(sessionFile: string | undefined): WaitRecord[] {
		this.waits.clear();
		if (!sessionFile) return [];
		let entries: string[] = [];
		try {
			entries = fs.readdirSync(this.dir);
		} catch {
			return [];
		}
		const loaded: WaitRecord[] = [];
		for (const entry of entries) {
			if (!entry.endsWith(".json")) continue;
			try {
				const wait = JSON.parse(fs.readFileSync(path.join(this.dir, entry), "utf8")) as WaitRecord;
				if (wait.sessionFile !== sessionFile) continue;
				this.waits.set(wait.id, wait);
				loaded.push(wait);
			} catch {
				/* ignore unreadable records */
			}
		}
		return loaded;
	}

	list(): WaitRecord[] {
		return [...this.waits.values()].sort((a, b) => a.createdAt - b.createdAt);
	}

	/** Earliest scheduled wall-clock wake, if any. Used for the footer hint. */
	nextDeadline(): number | undefined {
		let next: number | undefined;
		for (const wait of this.waits.values()) {
			for (const candidate of [wait.deadlineAt, wait.maxWaitUntil]) {
				if (candidate !== undefined && (next === undefined || candidate < next)) next = candidate;
			}
		}
		return next;
	}

	register(input: Omit<WaitRecord, "id" | "createdAt">): WaitRecord {
		const wait: WaitRecord = { ...input, id: `w-${randomBytes(4).toString("hex")}`, createdAt: Date.now() };

		if (wait.jobId && wait.logPattern) {
			const job = this.store.resolve(wait.jobId);
			wait.logOffset = job ? this.store.logSize(job) : 0;
		}
		if (wait.filePath) {
			const stat = statOrUndefined(wait.filePath);
			wait.fileExisted = stat !== undefined;
			wait.fileMtime = stat?.mtimeMs;
		}

		this.waits.set(wait.id, wait);
		if (wait.sessionFile) this.persist(wait);
		this.ensureTicking();
		return wait;
	}

	/**
	 * Evaluate now instead of waiting for the next tick. Used right after
	 * registering, so a condition that is already true (the job finished before
	 * the model got around to calling bg_wait) wakes without a second of dead time.
	 */
	poke(): void {
		let events: WakeEvent[] = [];
		try {
			events = this.evaluate();
		} catch {
			return;
		}
		if (events.length > 0) this.onWake?.(events);
	}

	cancel(id: string): boolean {
		if (!this.waits.has(id)) return false;
		this.forget(id);
		return true;
	}

	cancelAll(): number {
		const ids = [...this.waits.keys()];
		for (const id of ids) this.forget(id);
		return ids.length;
	}

	/** Evaluate every pending wait once. Fired waits are removed. */
	evaluate(now = Date.now()): WakeEvent[] {
		const events: WakeEvent[] = [];
		for (const wait of [...this.waits.values()]) {
			const reason = this.evaluateOne(wait, now);
			if (!reason) continue;
			this.forget(wait.id);
			events.push({ wait, reason, firedAt: now });
		}
		return events;
	}

	private evaluateOne(wait: WaitRecord, now: number): WakeReason | undefined {
		if (wait.jobId) {
			const job = this.store.check(wait.jobId) ?? this.store.resolve(wait.jobId);
			if (!job) return { kind: "max_wait" };

			if (wait.logPattern) {
				const match = this.scanLog(wait, job);
				if (match) return { kind: "log_match", job, pattern: wait.logPattern, line: match };
			}
			// A job that ends always wakes its waiter, even one waiting on a log pattern:
			// the pattern can no longer appear, so continuing to wait would hang.
			if (job.status !== "running") return { kind: "job_exit", job };
		}

		if (wait.filePath) {
			const stat = statOrUndefined(wait.filePath);
			if (stat && !wait.fileExisted) return { kind: "file", path: wait.filePath, created: true };
			if (stat && wait.fileMtime !== undefined && stat.mtimeMs > wait.fileMtime) {
				return { kind: "file", path: wait.filePath, created: false };
			}
		}

		if (wait.deadlineAt !== undefined && now >= wait.deadlineAt) return { kind: "timer" };
		if (wait.maxWaitUntil !== undefined && now >= wait.maxWaitUntil) return { kind: "max_wait" };
		return undefined;
	}

	/** Scan only the output produced since the last check, and remember how far we got. */
	private scanLog(wait: WaitRecord, job: JobRecord): string | undefined {
		const size = this.store.logSize(job);
		const from = wait.logOffset ?? 0;
		if (size <= from) {
			// Truncated or rotated: restart from the new end rather than rescanning.
			if (size < from) wait.logOffset = size;
			return undefined;
		}
		const length = Math.min(size - from, LOG_SCAN_LIMIT);
		let chunk = "";
		try {
			const fd = fs.openSync(job.logPath, "r");
			try {
				const buffer = Buffer.alloc(length);
				fs.readSync(fd, buffer, 0, length, from);
				chunk = buffer.toString("utf8");
			} finally {
				fs.closeSync(fd);
			}
		} catch {
			return undefined;
		}

		// Keep an unterminated trailing line for the next tick so patterns are never split.
		const lastNewline = chunk.lastIndexOf("\n");
		const complete = lastNewline === -1 ? "" : chunk.slice(0, lastNewline);
		wait.logOffset = from + (lastNewline === -1 ? 0 : Buffer.byteLength(chunk.slice(0, lastNewline + 1), "utf8"));
		if (wait.sessionFile) this.persist(wait);
		if (complete.length === 0) return undefined;

		let re: RegExp;
		try {
			re = new RegExp(wait.logPattern ?? "");
		} catch {
			return undefined;
		}
		for (const line of complete.split("\n")) {
			if (re.test(line)) return line;
		}
		return undefined;
	}

	// --- ticking -----------------------------------------------------------

	start(onWake: (events: WakeEvent[]) => void): void {
		this.onWake = onWake;
		if (this.waits.size > 0) this.ensureTicking();
	}

	private ensureTicking(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			let events: WakeEvent[] = [];
			try {
				events = this.evaluate();
			} catch {
				/* never let a bad regex kill the ticker */
			}
			if (this.waits.size === 0) this.stopTicking();
			if (events.length > 0) this.onWake?.(events);
		}, TICK_MS);
		this.timer.unref?.();
	}

	private stopTicking(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = undefined;
	}

	dispose(): void {
		this.stopTicking();
		this.onWake = undefined;
		this.waits.clear();
	}
}

function statOrUndefined(p: string): fs.Stats | undefined {
	try {
		return fs.statSync(p);
	} catch {
		return undefined;
	}
}
