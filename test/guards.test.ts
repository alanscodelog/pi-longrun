import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { WaitBackoff, inspectBackgroundLaunch, inspectBashCommand, normalizeJobCommand } from "../src/guards.js";

const cfg = DEFAULT_CONFIG;
const guard = (command: string) => inspectBackgroundLaunch(command, cfg) ?? inspectBashCommand(command, cfg);

describe("bash guards", () => {
	it("blocks the poll patterns that make long jobs expensive", () => {
		const blocked = [
			"nohup ./train.sh > /tmp/train.log 2>&1 &",
			"./bench/fake-train.sh 40 3 > log 2>&1 &",
			"setsid python train.py &",
			"sleep 30; tail -n 5 /tmp/train.log",
			"sleep 20 && tail /tmp/train.log",
			"tail -f /tmp/train.log",
			"tail -n 100 -f /tmp/train.log",
			"while true; do sleep 5; tail -n 1 log; done",
			"until grep -q done log; do sleep 10; done",
			"sleep 300",
			"sleep 10m",
			"watch ls -la",
		];
		for (const command of blocked) {
			expect(guard(command), `expected to block: ${command}`).toBeDefined();
		}
	});

	it("leaves ordinary commands alone", () => {
		const allowed = [
			"ls -la",
			"python train.py --lr 1e-4",
			"npm test && npm run build",
			"git log --oneline | head -20",
			"echo a && echo b",
			"pytest -q 2>&1 | tail -40",
			"grep -rn 'eval_loss' src/",
			// A short settle before a health check is not a poll.
			"sleep 2 && curl -s localhost:3000/health",
			"sleep 5",
			// A workload that happens to pace itself is work, not a check.
			"for i in 1 2 3; do echo step=$i; sleep 1; done",
			`echo "tom & jerry"`,
			"make -j8 2>&1",
		];
		for (const command of allowed) {
			expect(guard(command), `expected to allow: ${command}`).toBeUndefined();
		}
	});

	it("names the replacement tool in every block reason", () => {
		for (const command of ["nohup x &", "sleep 60; tail log", "tail -f log", "sleep 300"]) {
			expect(guard(command)?.reason).toMatch(/bg_start|bg_wait/);
		}
	});

	it("respects configuration", () => {
		expect(inspectBashCommand("sleep 300", { ...cfg, guardBash: false })).toBeUndefined();
		expect(inspectBackgroundLaunch("nohup x &", { ...cfg, guardBackgroundLaunch: false })).toBeUndefined();
		expect(inspectBashCommand("sleep 90", { ...cfg, maxBareSleepSeconds: 120 })).toBeUndefined();
	});
});

describe("WaitBackoff", () => {
	it("escalates repeated short waits on the same job and resets on a real event", () => {
		const backoff = new WaitBackoff(() => cfg);
		expect(cfg.backoffFloorSeconds).toBe(60);
		expect(backoff.enforce(30, "train-1")).toEqual({ seconds: 60, escalated: true });
		expect(backoff.enforce(30, "train-1")).toEqual({ seconds: 120, escalated: true });
		expect(backoff.enforce(30, "train-1")).toEqual({ seconds: 240, escalated: true });

		backoff.reset();
		expect(backoff.enforce(30, "train-1")).toEqual({ seconds: 60, escalated: true });
	});

	it("does not shorten a longer request and starts over for a different job", () => {
		const backoff = new WaitBackoff(() => cfg);
		expect(backoff.enforce(3600, "a")).toEqual({ seconds: 3600, escalated: false });
		expect(backoff.enforce(30, "b")).toEqual({ seconds: 60, escalated: true });
	});
});

describe("normalizeJobCommand", () => {
	it("strips backgrounding and output redirects that bg_start already provides", () => {
		const result = normalizeJobCommand("nohup ./bench/fake-train.sh 20 2 > ./train.log 2>&1 &");
		expect(result.command).toBe("./bench/fake-train.sh 20 2");
		expect(result.notes).toHaveLength(3);
		expect(result.notes.join(" ")).toMatch(/nohup/);
		expect(result.notes.join(" ")).toMatch(/redirect/);
	});

	it("keeps deliberate redirects and ordinary commands untouched", () => {
		expect(normalizeJobCommand("python train.py --lr 1e-4")).toEqual({
			command: "python train.py --lr 1e-4",
			notes: [],
		});
		// /dev/null and stderr-only redirects are choices, not habits.
		expect(normalizeJobCommand("noisy-tool 2>/dev/null").command).toBe("noisy-tool 2>/dev/null");
		expect(normalizeJobCommand("cmd > /dev/null").command).toBe("cmd > /dev/null");
		// && must not be mistaken for a trailing background &
		expect(normalizeJobCommand("a && b").command).toBe("a && b");
	});
});
