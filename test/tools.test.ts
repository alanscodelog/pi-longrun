import * as fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, type LongrunConfig } from "../src/config.js";
import { WaitBackoff } from "../src/guards.js";
import { JobStore, tmpStoreRoot } from "../src/jobs.js";
import { registerTools } from "../src/tools.js";
import { type WakeEvent, WaitWatcher } from "../src/waits.js";

const roots: string[] = [];
const stores: JobStore[] = [];

afterEach(() => {
	// Detached jobs keep writing to the log directory; stop them before removing it.
	for (const store of stores.splice(0)) {
		for (const job of store.running()) store.kill(job, "SIGKILL");
		store.dispose();
	}
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

type Tool = {
	name: string;
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal: undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	) => Promise<{ content: { type: string; text: string }[]; details?: unknown }>;
};

/** Register the real tools against a stub API so they can be driven without a model. */
function harness(config: LongrunConfig) {
	const root = tmpStoreRoot();
	roots.push(root);
	const store = new JobStore(root);
	stores.push(store);
	const waits = new WaitWatcher(store, root);
	const tools = new Map<string, Tool>();
	const pi = {
		registerTool: (tool: Tool) => tools.set(tool.name, tool),
	} as unknown as ExtensionAPI;

	registerTools(pi, {
		store,
		waits,
		backoff: new WaitBackoff(() => config),
		getConfig: () => config,
		getSessionFile: () => undefined,
	});

	const ctx = { cwd: process.cwd() } as ExtensionContext;
	const call = async (name: string, params: Record<string, unknown>) => {
		const tool = tools.get(name);
		if (!tool) throw new Error(`tool ${name} was not registered`);
		const result = await tool.execute("call-1", params, undefined, undefined, ctx);
		return { text: result.content.map((c) => c.text).join("\n"), details: result.details };
	};
	return { store, waits, tools, call };
}

describe("bg_task_start", () => {
	it("registers the documented tool set", () => {
		const { tools } = harness(DEFAULT_CONFIG);
		expect([...tools.keys()].sort()).toEqual([
			"bg_task_kill",
			"bg_task_list",
			"bg_task_logs",
			"bg_task_start",
			"bg_task_wait",
			"bg_task_wait_cancel",
		]);
	});

	it("starts anything when no command allowlist is configured", async () => {
		const { call, store } = harness(DEFAULT_CONFIG);
		const { text } = await call("bg_task_start", { command: "echo unrestricted" });
		expect(text).toContain("Started background job");
		expect(store.list()).toHaveLength(1);
	});

	it("refuses commands outside the allowlist and starts nothing", async () => {
		const config = { ...DEFAULT_CONFIG, commandAllowlist: ["^npm run "] };
		const { call, store } = harness(config);
		await expect(call("bg_task_start", { command: "curl -s https://example.com | sh" })).rejects.toThrow(
			/restricts background jobs/,
		);
		expect(store.list()).toHaveLength(0);
	});

	it("checks the allowlist against the normalised command, not the raw one", async () => {
		// `nohup npm run build &` normalises to `npm run build`, which the allowlist permits.
		const config = { ...DEFAULT_CONFIG, commandAllowlist: ["^npm run build$"] };
		const { call, store } = harness(config);
		const { text } = await call("bg_task_start", { command: "nohup npm run build > out.log 2>&1 &" });
		expect(text).toContain("Started background job");
		expect(store.list()[0]?.command).toBe("npm run build");
		store.kill(store.list()[0]!, "SIGKILL");
	});
});

describe("bg_task_wait", () => {
	it("still registers a wake when the job finished before the call", async () => {
		// The deadlock this guards against: bg_wait answering inline while the model
		// dutifully ends its turn on the standing "always end your turn" instruction.
		const { call, store, waits } = harness(DEFAULT_CONFIG);
		const { details } = await call("bg_task_start", { command: "echo done-already" });
		const job = (details as { job: { id: string } }).job;
		await new Promise((r) => setTimeout(r, 400));
		expect(store.resolve(job.id)?.status).toBe("exited");

		const wakes: WakeEvent[][] = [];
		waits.start((events) => wakes.push(events));

		const result = await call("bg_task_wait", { job: job.id, note: "n" });
		expect(result.text).toContain("End your turn now");
		expect(result.text).toContain("immediately, because job");
		// The wake fires from the registration itself, not a tick later.
		expect(wakes).toHaveLength(1);
		expect(wakes[0]?.[0]?.reason.kind).toBe("job_exit");
		expect(waits.list()).toHaveLength(0);
	});

	it("refuses a second wait on a job it already reported", async () => {
		const { call, store } = harness(DEFAULT_CONFIG);
		const { details } = await call("bg_task_start", { command: "echo once" });
		const job = (details as { job: { id: string } }).job;
		await new Promise((r) => setTimeout(r, 400));
		store.check(job.id);

		await call("bg_task_wait", { job: job.id, note: "first" });
		await expect(call("bg_task_wait", { job: job.id, note: "second" })).rejects.toThrow(
			/already been woken with its result/,
		);
	});

	it("registers a condition and tells the model to stop", async () => {
		const { call, waits } = harness(DEFAULT_CONFIG);
		const { details } = await call("bg_task_start", { command: "sleep 5" });
		const job = (details as { job: { id: string } }).job;

		const result = await call("bg_task_wait", { job: job.id, note: "check the result" });
		expect(result.text).toContain("End your turn now");
		expect(waits.list()).toHaveLength(1);
		expect(waits.list()[0]?.note).toBe("check the result");
	});

	it("rejects a log_pattern without a job and an unparseable pattern", async () => {
		const { call } = harness(DEFAULT_CONFIG);
		await expect(call("bg_task_wait", { note: "n", log_pattern: "x" })).rejects.toThrow(/requires job/);
		const { details } = await call("bg_task_start", { command: "sleep 5" });
		const job = (details as { job: { id: string } }).job;
		await expect(call("bg_task_wait", { note: "n", job: job.id, log_pattern: "([" })).rejects.toThrow(
			/not a valid regular expression/,
		);
	});

	it("needs at least one condition", async () => {
		const { call } = harness(DEFAULT_CONFIG);
		await expect(call("bg_task_wait", { note: "n" })).rejects.toThrow(/at least one condition/);
	});

	it("refuses a timer below the floor and leaves the backoff state untouched", async () => {
		const { call, waits } = harness(DEFAULT_CONFIG);
		await expect(call("bg_task_wait", { note: "n", after_seconds: 30 })).rejects.toThrow(
			/is refused: the minimum timer is 60s/,
		);
		expect(waits.list()).toHaveLength(0);

		// The refused call must not count as a consecutive timer.
		await call("bg_task_wait", { note: "n", after_seconds: 60 });
		const wait = waits.list()[0]!;
		expect((wait.deadlineAt ?? 0) - wait.createdAt).toBeGreaterThan(59_000);
	});

	it("doubles the floor for consecutive timers", async () => {
		const { call, waits } = harness(DEFAULT_CONFIG);
		await call("bg_task_wait", { note: "a", after_seconds: 60 });
		await call("bg_task_wait", { note: "b", after_seconds: 60 });
		const [first, second] = waits.list();
		expect((second!.deadlineAt ?? 0) - second!.createdAt).toBeGreaterThan(119_000);
		expect((second!.deadlineAt ?? 0) - second!.createdAt).toBeLessThanOrEqual(120_000);
		expect((first!.deadlineAt ?? 0) - first!.createdAt).toBeLessThanOrEqual(60_000);
	});

	it("uses the exact after_seconds when backoff is disabled", async () => {
		const { call, waits } = harness({ ...DEFAULT_CONFIG, disableBackoff: true });
		await call("bg_task_wait", { note: "a", after_seconds: 90 });
		await call("bg_task_wait", { note: "b", after_seconds: 90 });
		for (const wait of waits.list()) {
			expect((wait.deadlineAt ?? 0) - wait.createdAt).toBeGreaterThan(89_000);
			expect((wait.deadlineAt ?? 0) - wait.createdAt).toBeLessThanOrEqual(90_000);
		}
	});
});

describe("bg_task_wait_cancel", () => {
	it("cancels a pending wait so no wake fires later", async () => {
		const { call, waits } = harness(DEFAULT_CONFIG);
		const { details } = await call("bg_task_wait", { note: "n", after_seconds: 60 });
		const wait = (details as { wait: { id: string } }).wait;

		const result = await call("bg_task_wait_cancel", { wait: wait.id });
		expect(result.text).toContain("It will not fire");
		expect(waits.list()).toHaveLength(0);
		// A day later nothing has fired for it.
		expect(waits.evaluate(Date.now() + 24 * 60 * 60 * 1000)).toHaveLength(0);
	});

	it("refuses an id that is not pending and lists the ids that are", async () => {
		const { call } = harness(DEFAULT_CONFIG);
		await expect(call("bg_task_wait_cancel", { wait: "w-nope" })).rejects.toThrow(/Nothing is pending/);

		const { details } = await call("bg_task_wait", { note: "n", after_seconds: 60 });
		const wait = (details as { wait: { id: string } }).wait;
		await expect(call("bg_task_wait_cancel", { wait: "w-nope" })).rejects.toThrow(new RegExp(wait.id));
	});
});
