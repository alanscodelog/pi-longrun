import * as fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { JobStore, tmpStoreRoot } from "../src/jobs.js";

const roots: string[] = [];

function newStore(): JobStore {
	const root = tmpStoreRoot();
	roots.push(root);
	return new JobStore(root);
}

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

async function waitForExit(store: JobStore, id: string, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const job = store.check(id);
		if (job && job.status !== "running") return job;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`job ${id} did not finish within ${timeoutMs}ms`);
}

describe("JobStore", () => {
	it("starts a job, captures output and records the exit code", async () => {
		const store = newStore();
		const job = store.start({ command: "echo hello-longrun; echo second", cwd: process.cwd() });
		expect(job.status).toBe("running");
		expect(job.pid).toBeGreaterThan(0);

		const finished = await waitForExit(store, job.id);
		expect(finished.status).toBe("exited");
		expect(finished.exitCode).toBe(0);
		expect(finished.endedAt).toBeGreaterThanOrEqual(finished.startedAt);

		const slice = store.readLog(finished, { tail: 10 });
		expect(slice.lines).toEqual(["hello-longrun", "second"]);
	});

	it("records non-zero exit codes", async () => {
		const store = newStore();
		const job = store.start({ command: "echo boom >&2; exit 3", cwd: process.cwd() });
		const finished = await waitForExit(store, job.id);
		expect(finished.exitCode).toBe(3);
		expect(store.readLog(finished).lines).toEqual(["boom"]);
	});

	it("returns immediately for a long job and can kill its process group", async () => {
		const store = newStore();
		const started = Date.now();
		const job = store.start({ command: "sleep 60 & wait", cwd: process.cwd() });
		expect(Date.now() - started).toBeLessThan(2000);
		expect(store.running().map((j) => j.id)).toContain(job.id);

		expect(store.kill(job, "SIGTERM").ok).toBe(true);
		const finished = await waitForExit(store, job.id);
		expect(finished.status).not.toBe("running");
	});

	it("emits a transition exactly once per job", async () => {
		const store = newStore();
		const seen: string[] = [];
		store.onTransition((job) => seen.push(job.id));
		const job = store.start({ command: "true", cwd: process.cwd() });
		await waitForExit(store, job.id);
		store.checkAll();
		store.checkAll();
		expect(seen).toEqual([job.id]);
	});

	it("resolves jobs by id, name and prefix", async () => {
		const store = newStore();
		const job = store.start({ command: "true", cwd: process.cwd(), name: "trainer" });
		expect(store.resolve(job.id)?.id).toBe(job.id);
		expect(store.resolve("trainer")?.id).toBe(job.id);
		expect(store.resolve(job.id.slice(0, 5))?.id).toBe(job.id);
		expect(store.resolve("nope")).toBeUndefined();
		await waitForExit(store, job.id);
	});

	it("filters log lines with grep and tails them", async () => {
		const store = newStore();
		const job = store.start({ command: "for i in 1 2 3 4 5; do echo step=$i; done; echo done", cwd: process.cwd() });
		await waitForExit(store, job.id);
		const all = store.readLog(job, { tail: 100 });
		expect(all.lines).toHaveLength(6);
		const filtered = store.readLog(job, { tail: 2, grep: "^step=" });
		expect(filtered.lines).toEqual(["step=4", "step=5"]);
	});

	it("detects jobs that ended while nothing was watching", async () => {
		const store = newStore();
		const job = store.start({ command: "true", cwd: process.cwd() });
		await waitForExit(store, job.id);

		// Simulate a fresh pi process: new store over the same directory, record forced back to running.
		store.update(job.id, { status: "running", exitCode: undefined, endedAt: undefined });
		const fresh = new JobStore(store.root);
		const changed = fresh.reconcile();
		expect(changed.map((j) => j.id)).toContain(job.id);
		expect(fresh.resolve(job.id)?.exitCode).toBe(0);
		fresh.dispose();
	});
});

describe("JobStore failure handling", () => {
	it("rejects a bad cwd with an actionable message instead of crashing", () => {
		const store = newStore();
		expect(() => store.start({ command: "echo hi", cwd: "/definitely/not/a/real/dir" })).toThrow(/cwd does not exist/);
		// The model can pass a path with stray whitespace; it must not take down pi.
		expect(() => store.start({ command: "echo hi", cwd: `${process.cwd()}/. ` })).toThrow(/cwd does not exist/);
		expect(store.list()).toHaveLength(0);
	});

	it("survives a command that cannot be executed", async () => {
		const store = newStore();
		const job = store.start({ command: "this-command-does-not-exist-anywhere", cwd: process.cwd() });
		const finished = await waitForExit(store, job.id);
		// The shell starts fine and reports 127; the job is recorded, not crashed.
		expect(finished.exitCode).toBe(127);
	});
});
