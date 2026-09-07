import * as fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { JobStore, tmpStoreRoot } from "../src/jobs.js";
import { estimateProgress, extractMetrics, formatMetrics, formatProgress, summarizeJob } from "../src/metrics.js";

const cfg = DEFAULT_CONFIG;
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("extractMetrics", () => {
	it("keeps the last value of each key from a training log", () => {
		const lines = ["step=1/40 loss=1.8182", "step=2/40 loss=1.6667", "eval_loss: 0.1234", "training complete"];
		expect(formatMetrics(extractMetrics(lines, cfg))).toBe("step=2 loss=1.6667 eval_loss=0.1234");
	});

	it("handles scientific notation and negative values", () => {
		expect(formatMetrics(extractMetrics(["lr=1e-4 grad_norm=-0.5"], cfg))).toBe("lr=1e-4 grad_norm=-0.5");
	});

	it("ignores non-numeric values", () => {
		expect(extractMetrics(["status=running device=cuda"], cfg)).toEqual([]);
	});

	it("applies named patterns and lets them win over the generic scan", () => {
		const config = {
			...cfg,
			metricPatterns: [{ name: "ppl", pattern: "perplexity of ([\\d.]+)" }],
		};
		const metrics = extractMetrics(["perplexity of 12.5", "loss=0.3"], config);
		expect(formatMetrics(metrics)).toBe("ppl=12.5 loss=0.3");
	});

	it("caps the number of metrics and can be disabled", () => {
		const noisy = ["a=1 b=2 c=3 d=4 e=5 f=6"];
		expect(extractMetrics(noisy, { ...cfg, maxMetrics: 3 })).toHaveLength(3);
		expect(extractMetrics(noisy, { ...cfg, extractMetrics: false })).toEqual([]);
	});
});

describe("estimateProgress", () => {
	it("estimates the remaining time from the newest progress marker", () => {
		const progress = estimateProgress(["step=5/100 loss=1", "step=25/100 loss=0.5"], 60_000, cfg);
		expect(progress).toBeDefined();
		expect(progress?.current).toBe(25);
		expect(progress?.total).toBe(100);
		// A quarter done after a minute means about three more minutes.
		expect(progress?.etaMs).toBe(180_000);
		expect(formatProgress(progress!)).toBe("25/100 (25%, ETA ~3m)");
	});

	it("refuses markers that are not progress", () => {
		expect(estimateProgress(["2026/09/07 22:30 starting"], 1000, cfg)).toBeUndefined();
		expect(estimateProgress(["reading src/train.py"], 1000, cfg)).toBeUndefined();
		expect(estimateProgress(["step=41/40"], 1000, cfg)).toBeUndefined();
		expect(estimateProgress([], 1000, cfg)).toBeUndefined();
	});

	it("reports no ETA once the job is at 100%", () => {
		expect(estimateProgress(["step=40/40"], 1000, cfg)?.etaMs).toBe(0);
		expect(formatProgress(estimateProgress(["step=40/40"], 1000, cfg)!)).toBe("40/40 (100%)");
	});
});

describe("summarizeJob", () => {
	it("combines progress and metrics from a real job log", async () => {
		const root = tmpStoreRoot();
		roots.push(root);
		const store = new JobStore(root);
		const job = store.start({ command: "echo 'step=3/12 loss=0.75'", cwd: process.cwd() });
		await new Promise((r) => setTimeout(r, 300));
		store.check(job.id);
		expect(summarizeJob(store, job, cfg, job.startedAt + 60_000)).toMatch(/^3\/12 \(25%, ETA ~3m\), step=3 loss=0\.75$/);
	});
});
