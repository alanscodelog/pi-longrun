import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { JobStore, tmpStoreRoot } from "../src/jobs.js";
import { formatWake } from "../src/wake.js";
import { WaitWatcher } from "../src/waits.js";

const roots: string[] = [];

function newPair(): { store: JobStore; waits: WaitWatcher; root: string } {
	const root = tmpStoreRoot();
	roots.push(root);
	const store = new JobStore(root);
	return { store, waits: new WaitWatcher(store, root), root };
}

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

async function until<T>(fn: () => T | undefined, timeoutMs = 10_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = fn();
		if (value !== undefined) return value;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error("condition not met in time");
}

describe("WaitWatcher", () => {
	it("fires when the watched job exits", async () => {
		const { store, waits } = newPair();
		const job = store.start({ command: "sleep 0.3", cwd: process.cwd() });
		waits.register({ note: "check result", cwd: process.cwd(), jobId: job.id });

		const events = await until(() => {
			const e = waits.evaluate();
			return e.length > 0 ? e : undefined;
		});
		expect(events[0]?.reason.kind).toBe("job_exit");
		expect(events[0]?.wait.note).toBe("check result");
		// One-shot: the wait is gone afterwards.
		expect(waits.list()).toHaveLength(0);
		expect(waits.evaluate()).toHaveLength(0);
	});

	it("fires on a log pattern before the job ends, and only on new output", async () => {
		const { store, waits } = newPair();
		const job = store.start({
			command: "echo before-registration; sleep 0.4; echo 'eval_loss=0.42'; sleep 5",
			cwd: process.cwd(),
		});
		await until(() => (store.readLog(job).lines.length > 0 ? true : undefined));

		waits.register({ note: "read the metric", cwd: process.cwd(), jobId: job.id, logPattern: "eval_loss" });
		// Output that existed before registration must not match.
		expect(waits.evaluate()).toHaveLength(0);

		const events = await until(() => {
			const e = waits.evaluate();
			return e.length > 0 ? e : undefined;
		});
		const reason = events[0]?.reason;
		expect(reason?.kind).toBe("log_match");
		if (reason?.kind === "log_match") expect(reason.line).toBe("eval_loss=0.42");
		store.kill(store.resolve(job.id) ?? job, "SIGKILL");
	});

	it("wakes on job exit even when waiting for a pattern that never appears", async () => {
		const { store, waits } = newPair();
		const job = store.start({ command: "echo nothing-useful; exit 1", cwd: process.cwd() });
		waits.register({ note: "n", cwd: process.cwd(), jobId: job.id, logPattern: "never-matches" });
		const events = await until(() => {
			const e = waits.evaluate();
			return e.length > 0 ? e : undefined;
		});
		expect(events[0]?.reason.kind).toBe("job_exit");
	});

	it("fires on a deadline and on a file appearing", async () => {
		const { store, waits, root } = newPair();
		waits.register({ note: "timer", cwd: process.cwd(), deadlineAt: Date.now() + 30 });
		const target = path.join(root, "checkpoint.pt");
		waits.register({ note: "file", cwd: process.cwd(), filePath: target });

		await new Promise((r) => setTimeout(r, 60));
		let events = waits.evaluate();
		expect(events.map((e) => e.reason.kind)).toEqual(["timer"]);

		fs.writeFileSync(target, "x");
		events = waits.evaluate();
		expect(events[0]?.reason.kind).toBe("file");
		expect(store.list()).toHaveLength(0);
	});

	it("persists waits for a session and restores them in a new watcher", async () => {
		const { store, waits, root } = newPair();
		const job = store.start({ command: "sleep 0.2", cwd: process.cwd() });
		waits.register({ note: "survive restart", cwd: process.cwd(), sessionFile: "/tmp/session-a.jsonl", jobId: job.id });

		const restarted = new WaitWatcher(store, root);
		expect(restarted.load("/tmp/session-b.jsonl")).toHaveLength(0);
		const restored = restarted.load("/tmp/session-a.jsonl");
		expect(restored).toHaveLength(1);
		expect(restored[0]?.note).toBe("survive restart");

		const events = await until(() => {
			const e = restarted.evaluate();
			return e.length > 0 ? e : undefined;
		});
		expect(events[0]?.reason.kind).toBe("job_exit");
	});

	it("reports the earliest deadline for the footer", () => {
		const { waits } = newPair();
		const now = Date.now();
		waits.register({ note: "a", cwd: process.cwd(), deadlineAt: now + 60_000 });
		waits.register({ note: "b", cwd: process.cwd(), deadlineAt: now + 10_000 });
		expect(waits.nextDeadline()).toBe(now + 10_000);
	});
});

describe("formatWake", () => {
	it("includes the note, the outcome and the log tail in one message", async () => {
		const { store, waits } = newPair();
		const job = store.start({ command: "echo line-one; echo line-two; exit 0", cwd: process.cwd() });
		waits.register({ note: "launch the next variant", cwd: process.cwd(), jobId: job.id });
		const events = await until(() => {
			const e = waits.evaluate();
			return e.length > 0 ? e : undefined;
		});

		const delivery = formatWake(events, store, process.cwd(), DEFAULT_CONFIG);
		expect(delivery.content).toContain("[longrun] wake at");
		expect(delivery.content).toContain("exit code 0");
		expect(delivery.content).toContain("your note: launch the next variant");
		expect(delivery.content).toContain("line-two");
		expect(delivery.content).toContain("No background jobs are still running.");
		expect(delivery.urgent).toBe(false);
	});

	it("marks a failed job as urgent and coalesces several events into one message", async () => {
		const { store, waits } = newPair();
		const ok = store.start({ command: "true", cwd: process.cwd(), name: "good" });
		const bad = store.start({ command: "exit 2", cwd: process.cwd(), name: "bad" });
		waits.register({ note: "a", cwd: process.cwd(), jobId: ok.id });
		waits.register({ note: "b", cwd: process.cwd(), jobId: bad.id });

		const events = await until(() => {
			// Both jobs have to be finished before the first evaluate(): it fires and
			// forgets whatever is ready, so evaluating while one job is still running
			// consumes that wait on its own and the two can never coalesce.
			if (store.check(ok.id)?.status === "running") return undefined;
			if (store.check(bad.id)?.status === "running") return undefined;
			const e = waits.evaluate();
			return e.length === 2 ? e : undefined;
		});
		const delivery = formatWake(events, store, process.cwd(), DEFAULT_CONFIG);
		expect(delivery.urgent).toBe(true);
		expect(delivery.content).toContain("2 wake conditions fired");
		expect(delivery.content).toContain("1. job good-");
		expect(delivery.content).toContain("2. job bad-");
	});
});
