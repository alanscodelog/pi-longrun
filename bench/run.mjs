#!/usr/bin/env node
/**
 * Drive pi over its RPC protocol and report what a run actually cost.
 *
 * pi in RPC mode stays alive between turns, which is exactly the condition
 * pi-longrun needs: a wake can arrive long after the first turn ended.
 *
 * Usage:
 *   node bench/run.mjs --label baseline --prompt-file bench/prompts/poll.txt --no-ext
 *   node bench/run.mjs --label longrun  --prompt-file bench/prompts/wake.txt
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";

const args = process.argv.slice(2);
function flag(name, fallback) {
	const i = args.indexOf(`--${name}`);
	if (i === -1) return fallback;
	const value = args[i + 1];
	return value === undefined || value.startsWith("--") ? true : value;
}

const label = String(flag("label", "run"));
const model = String(flag("model", "openai-codex/gpt-5.4-mini"));
const timeoutSec = Number(flag("timeout", 900));
const idleSec = Number(flag("idle", 0));
const sentinel = String(flag("sentinel", "BENCH_DONE"));
const extension = flag("no-ext", false) === false ? String(flag("ext", "./src/index.ts")) : undefined;
const promptFile = flag("prompt-file", undefined);
const prompt = promptFile ? fs.readFileSync(String(promptFile), "utf8") : String(flag("prompt", "Say hi"));
const eventLog = flag("event-log", undefined);

const piArgs = ["--mode", "rpc", "--model", model, "--no-session"];
if (extension) piArgs.push("-e", extension);
else piArgs.push("--no-extensions");

const started = Date.now();
const child = spawn("pi", piArgs, { stdio: ["pipe", "pipe", "pipe"] });

const stats = {
	label,
	model,
	extension: extension ?? null,
	agentRuns: 0,
	turns: 0,
	assistantMessages: 0,
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	toolCalls: {},
	errors: [],
};

const events = [];
let finished = false;
let lastActivity = Date.now();
let buffer = "";

function record(event) {
	events.push(event);
	lastActivity = Date.now();
	switch (event.type) {
		case "agent_start":
			stats.agentRuns++;
			break;
		case "turn_end":
			stats.turns++;
			break;
		case "tool_execution_start":
			stats.toolCalls[event.toolName] = (stats.toolCalls[event.toolName] ?? 0) + 1;
			break;
		case "extension_error":
			stats.errors.push(event.error ?? JSON.stringify(event));
			break;
		case "message_end": {
			const message = event.message;
			if (message?.role !== "assistant") break;
			stats.assistantMessages++;
			const usage = message.usage ?? {};
			stats.input += usage.input ?? 0;
			stats.output += usage.output ?? 0;
			stats.cacheRead += usage.cacheRead ?? 0;
			stats.cacheWrite += usage.cacheWrite ?? 0;
			stats.cost += usage.cost?.total ?? 0;
			const text = (message.content ?? [])
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			if (text.includes(sentinel)) finish("sentinel");
			break;
		}
	}
}

function finish(reason) {
	if (finished) return;
	finished = true;
	stats.stopReason = reason;
	stats.wallClockSec = Math.round((Date.now() - started) / 10) / 100;
	try {
		child.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
	} catch {}
	setTimeout(() => child.kill("SIGTERM"), 500).unref();
	setTimeout(() => {
		if (eventLog) fs.writeFileSync(String(eventLog), events.map((e) => JSON.stringify(e)).join("\n"));
		console.log(JSON.stringify(stats, null, 2));
		process.exit(0);
	}, 800).unref();
}

// Strict JSONL: split on \n only, per the RPC framing rules.
child.stdout.on("data", (chunk) => {
	buffer += chunk.toString("utf8");
	let index;
	while ((index = buffer.indexOf("\n")) !== -1) {
		const line = buffer.slice(0, index).replace(/\r$/, "");
		buffer = buffer.slice(index + 1);
		if (!line.trim()) continue;
		try {
			record(JSON.parse(line));
		} catch {
			/* non-JSON noise */
		}
	}
});

child.stderr.on("data", (chunk) => process.stderr.write(chunk));
child.on("exit", (code) => finish(`pi exited (${code})`));

child.stdin.write(`${JSON.stringify({ id: "p1", type: "prompt", message: prompt })}\n`);

setInterval(() => {
	if (finished) return;
	const elapsed = (Date.now() - started) / 1000;
	if (elapsed > timeoutSec) finish("timeout");
	else if (idleSec > 0 && (Date.now() - lastActivity) / 1000 > idleSec) finish("idle");
}, 1000);
