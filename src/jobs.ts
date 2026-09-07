/**
 * Detached background job store.
 *
 * Design notes:
 * - Jobs are spawned with `detached: true` and `unref()`, so they survive pi exiting.
 * - stdout/stderr go straight to a log file via file descriptors. Output never passes
 *   through pi's process and never lands in the conversation unless explicitly read.
 * - A shell EXIT trap persists the exit code to a `.status` file, so the outcome is
 *   still recoverable when pi was not running at the moment the job finished.
 * - One JSON file per job, written atomically. There is no shared registry file, so
 *   concurrent pi sessions cannot corrupt each other's state.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getShellConfig } from "@earendil-works/pi-coding-agent";
import { shellQuote, slugifyCommand } from "./format.js";

export type JobStatus = "running" | "exited" | "killed" | "unknown";

export interface JobRecord {
	id: string;
	name: string;
	command: string;
	cwd: string;
	pid: number;
	logPath: string;
	statusPath: string;
	startedAt: number;
	endedAt?: number;
	exitCode?: number | null;
	status: JobStatus;
	/** Session that started the job, for provenance. */
	sessionFile?: string;
	/** Set once a wake notification for the terminal state has been delivered. */
	notifiedAt?: number;
}

export interface StartOptions {
	command: string;
	cwd: string;
	name?: string;
	env?: Record<string, string>;
	sessionFile?: string;
}

export interface LogSlice {
	lines: string[];
	/** Total lines in the log (approximate for very large logs: counted within the scanned window). */
	totalLines: number;
	bytes: number;
	truncated: boolean;
}

export type TransitionListener = (job: JobRecord, previous: JobStatus) => void;

const POLL_INTERVAL_MS = 2000;
const TAIL_WINDOW_BYTES = 512 * 1024;

/** Records older than this (since they ended) are pruned on startup. */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export class JobStore {
	readonly root: string;
	private readonly jobsDir: string;
	private readonly logsDir: string;
	private readonly listeners = new Set<TransitionListener>();
	private timer: NodeJS.Timeout | undefined;
	private dirsReady = false;
	/** Jobs spawned by this process, kept so we can react to exit instantly. */
	private readonly owned = new Map<string, { unref: () => void }>();

	constructor(root?: string) {
		this.root = root ?? path.join(getAgentDir(), "longrun");
		this.jobsDir = path.join(this.root, "jobs");
		this.logsDir = path.join(this.root, "logs");
	}

	/** Directories are created on first use, never at extension load time. */
	private ensureDirs(): void {
		if (this.dirsReady) return;
		fs.mkdirSync(this.jobsDir, { recursive: true });
		fs.mkdirSync(this.logsDir, { recursive: true });
		this.dirsReady = true;
	}

	// --- persistence -------------------------------------------------------

	private recordPath(id: string): string {
		return path.join(this.jobsDir, `${id}.json`);
	}

	private write(job: JobRecord): void {
		this.ensureDirs();
		const target = this.recordPath(job.id);
		const tmp = `${target}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(job, null, 2));
		fs.renameSync(tmp, target);
	}

	private read(id: string): JobRecord | undefined {
		try {
			return JSON.parse(fs.readFileSync(this.recordPath(id), "utf8")) as JobRecord;
		} catch {
			return undefined;
		}
	}

	list(): JobRecord[] {
		let entries: string[];
		try {
			entries = fs.readdirSync(this.jobsDir);
		} catch {
			return [];
		}
		const jobs: JobRecord[] = [];
		for (const entry of entries) {
			if (!entry.endsWith(".json")) continue;
			const job = this.read(entry.slice(0, -".json".length));
			if (job) jobs.push(job);
		}
		return jobs.sort((a, b) => b.startedAt - a.startedAt);
	}

	/** Jobs belonging to a working directory, newest first. */
	listFor(cwd: string): JobRecord[] {
		return this.list().filter((j) => j.cwd === cwd);
	}

	running(cwd?: string): JobRecord[] {
		const jobs = cwd ? this.listFor(cwd) : this.list();
		return jobs.filter((j) => j.status === "running");
	}

	/** Resolve a user/model supplied reference: exact id, exact name, then unique prefix. */
	resolve(ref: string, cwd?: string): JobRecord | undefined {
		const trimmed = ref.trim();
		const pool = cwd ? [...this.listFor(cwd), ...this.list()] : this.list();
		const seen = new Set<string>();
		const jobs = pool.filter((j) => (seen.has(j.id) ? false : (seen.add(j.id), true)));
		return (
			jobs.find((j) => j.id === trimmed) ??
			jobs.find((j) => j.name === trimmed) ??
			jobs.find((j) => j.id.startsWith(trimmed)) ??
			jobs.find((j) => j.name.startsWith(trimmed))
		);
	}

	update(id: string, patch: Partial<JobRecord>): JobRecord | undefined {
		const current = this.read(id);
		if (!current) return undefined;
		const next = { ...current, ...patch };
		this.write(next);
		return next;
	}

	/** Delete records for jobs that finished long ago, plus their logs. */
	prune(now = Date.now()): number {
		let removed = 0;
		for (const job of this.list()) {
			if (job.status === "running") continue;
			if (now - (job.endedAt ?? job.startedAt) < RETENTION_MS) continue;
			for (const p of [this.recordPath(job.id), job.logPath, job.statusPath]) {
				try {
					fs.rmSync(p, { force: true });
				} catch {
					/* best effort */
				}
			}
			removed++;
		}
		return removed;
	}

	// --- lifecycle ---------------------------------------------------------

	private allocateId(name: string): string {
		for (let attempt = 0; attempt < 8; attempt++) {
			const id = `${name}-${randomBytes(2).toString("hex")}`;
			if (!fs.existsSync(this.recordPath(id))) return id;
		}
		return `${name}-${randomBytes(6).toString("hex")}`;
	}

	start(options: StartOptions): JobRecord {
		const name = (options.name?.trim() || slugifyCommand(options.command)).replace(/[^A-Za-z0-9._-]/g, "");
		const id = this.allocateId(name.length > 0 ? name : "job");
		this.ensureDirs();
		const logPath = path.join(this.logsDir, `${id}.log`);
		const statusPath = path.join(this.logsDir, `${id}.status`);

		// EXIT trap records the exit code even if pi is not running when the job ends.
		// INT/TERM traps make sure the trap still fires when the process group is signalled.
		const script = [
			`__pi_lr_status=${shellQuote(statusPath)}`,
			`trap 'printf "%s" "$?" > "$__pi_lr_status"' EXIT`,
			`trap 'exit 130' INT`,
			`trap 'exit 143' TERM`,
			"",
			options.command,
			"",
		].join("\n");

		const { shell, args } = getShellConfig();
		const fd = fs.openSync(logPath, "a");
		try {
			const child = spawn(shell, [...args, script], {
				cwd: options.cwd,
				env: { ...process.env, ...options.env },
				detached: true,
				stdio: ["ignore", fd, fd],
			});
			child.unref();
			if (child.pid === undefined) throw new Error("failed to spawn background job");

			const job: JobRecord = {
				id,
				name,
				command: options.command,
				cwd: options.cwd,
				pid: child.pid,
				logPath,
				statusPath,
				startedAt: Date.now(),
				status: "running",
				sessionFile: options.sessionFile,
			};
			this.write(job);
			this.owned.set(id, { unref: () => child.unref() });
			child.on("exit", () => this.check(id));
			child.on("error", () => this.check(id));
			this.ensurePolling();
			return job;
		} finally {
			fs.closeSync(fd);
		}
	}

	/** Signal a job's whole process group. */
	kill(job: JobRecord, signal: NodeJS.Signals = "SIGTERM"): { ok: boolean; error?: string } {
		if (job.status !== "running") return { ok: false, error: `job is already ${job.status}` };
		try {
			// detached spawn makes the child a process group leader, so -pid hits its children too.
			process.kill(-job.pid, signal);
		} catch {
			try {
				process.kill(job.pid, signal);
			} catch (err) {
				return { ok: false, error: err instanceof Error ? err.message : String(err) };
			}
		}
		return { ok: true };
	}

	private isAlive(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch (err) {
			// EPERM means the process exists but belongs to another user.
			return (err as NodeJS.ErrnoException).code === "EPERM";
		}
	}

	private readStatusFile(job: JobRecord): { code: number; endedAt: number } | undefined {
		try {
			const raw = fs.readFileSync(job.statusPath, "utf8").trim();
			const code = Number.parseInt(raw, 10);
			const endedAt = fs.statSync(job.statusPath).mtimeMs;
			return { code: Number.isNaN(code) ? -1 : code, endedAt };
		} catch {
			return undefined;
		}
	}

	/**
	 * Re-evaluate one job against the filesystem and the process table.
	 * Idempotent: a job only transitions out of "running" once.
	 */
	check(id: string): JobRecord | undefined {
		const job = this.read(id);
		if (!job || job.status !== "running") return job;

		const status = this.readStatusFile(job);
		if (status) {
			const next = this.update(id, {
				status: status.code === 0 ? "exited" : status.code === 130 || status.code === 143 ? "killed" : "exited",
				exitCode: status.code,
				endedAt: status.endedAt,
			});
			if (next) this.emit(next, "running");
			this.owned.delete(id);
			return next;
		}

		if (!this.isAlive(job.pid)) {
			// Died without writing a status file (SIGKILL, OOM killer, machine reboot).
			const next = this.update(id, { status: "unknown", exitCode: null, endedAt: Date.now() });
			if (next) this.emit(next, "running");
			this.owned.delete(id);
			return next;
		}

		return job;
	}

	/** Check every running job. Returns the ones that just transitioned. */
	checkAll(): JobRecord[] {
		const changed: JobRecord[] = [];
		for (const job of this.list()) {
			if (job.status !== "running") continue;
			const next = this.check(job.id);
			if (next && next.status !== "running") changed.push(next);
		}
		return changed;
	}

	// --- watching ----------------------------------------------------------

	onTransition(listener: TransitionListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(job: JobRecord, previous: JobStatus): void {
		for (const listener of this.listeners) {
			try {
				listener(job, previous);
			} catch {
				/* a listener must never break the store */
			}
		}
	}

	/**
	 * Poll running jobs. This costs a couple of syscalls per tick and zero tokens --
	 * it is the cheap side of the polling tradeoff, deliberately kept out of the model loop.
	 */
	ensurePolling(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			try {
				this.checkAll();
			} catch {
				/* keep the interval alive */
			}
		}, POLL_INTERVAL_MS);
		this.timer.unref?.();
	}

	stopPolling(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = undefined;
	}

	// --- logs --------------------------------------------------------------

	logSize(job: JobRecord): number {
		try {
			return fs.statSync(job.logPath).size;
		} catch {
			return 0;
		}
	}

	/** Read the tail of a job's log, optionally filtered by a regex. */
	readLog(job: JobRecord, options: { tail?: number; grep?: string } = {}): LogSlice {
		const tail = Math.max(1, Math.min(options.tail ?? 50, 2000));
		let size = 0;
		let text = "";
		try {
			const fd = fs.openSync(job.logPath, "r");
			try {
				size = fs.fstatSync(fd).size;
				const window = Math.min(size, TAIL_WINDOW_BYTES);
				const buffer = Buffer.alloc(window);
				fs.readSync(fd, buffer, 0, window, size - window);
				text = buffer.toString("utf8");
			} finally {
				fs.closeSync(fd);
			}
		} catch {
			return { lines: [], totalLines: 0, bytes: 0, truncated: false };
		}

		let lines = text.split("\n");
		// A partial first line is an artifact of the byte window, not real content.
		if (size > TAIL_WINDOW_BYTES && lines.length > 0) lines = lines.slice(1);
		if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

		if (options.grep) {
			const re = new RegExp(options.grep);
			lines = lines.filter((l) => re.test(l));
		}

		const totalLines = lines.length;
		const selected = lines.slice(-tail);
		return {
			lines: selected,
			totalLines,
			bytes: size,
			truncated: totalLines > selected.length || size > TAIL_WINDOW_BYTES,
		};
	}

	/** Reconcile all records with reality. Returns jobs that ended while nobody was watching. */
	reconcile(): JobRecord[] {
		this.prune();
		const changed = this.checkAll();
		if (this.running().length > 0) this.ensurePolling();
		return changed;
	}

	dispose(): void {
		this.stopPolling();
		this.listeners.clear();
		this.owned.clear();
	}
}

/** Default store location, exposed for tests and diagnostics. */
export function defaultStoreRoot(): string {
	return path.join(getAgentDir(), "longrun");
}

export function tmpStoreRoot(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-longrun-"));
}
