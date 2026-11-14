/** Optional per-project configuration, read from .pi/longrun.json (project) or ~/.pi/agent/longrun.json. */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface LongrunConfig {
	/** Block bash commands that are really a polling loop. */
	guardBash: boolean;
	/** Block manual background launches (nohup, trailing &) in favour of bg_start. */
	guardBackgroundLaunch: boolean;
	/** A bare `sleep N` at or above this many seconds is blocked. */
	maxBareSleepSeconds: number;
	/** A `sleep N` combined with another command is blocked at or above this many seconds. */
	maxCompoundSleepSeconds: number;
	/**
	 * Floor for a timer-only bg_wait, doubled on each consecutive short wait for the
	 * same job. Claude Code clamps its equivalent to at least 60s for the same reason:
	 * waking early only re-reads the context without learning anything new.
	 */
	backoffFloorSeconds: number;
	/** Keep backoffFloorSeconds as a floor, but stop doubling it on repeated timers. */
	disableBackoff: boolean;
	/** Inject the long-running work section into the system prompt. */
	injectSystemPrompt: boolean;
	/** Pull numeric key=value pairs out of log tails and put them in wake notifications. */
	extractMetrics: boolean;
	/** Named extraction rules for logs that are not key=value. The first capture group is the value. */
	metricPatterns: { name: string; pattern: string }[];
	/** Maximum metrics shown at once, so a chatty log cannot flood a notification. */
	maxMetrics: number;
	/** Two capture groups, current and total, used to estimate progress and ETA. */
	progressPattern: string;
	/** bash commands matching these regexes are rejected with a pointer to bg_start. */
	autoBackgroundPatterns: string[];
	/**
	 * When non-empty, bg_start only runs commands matching one of these regexes.
	 * Set this when an auto-approval extension (pi-automode) has bg_start on its
	 * allowlist, so the exemption covers a known set of commands rather than an
	 * unrestricted shell.
	 */
	commandAllowlist: string[];
	/** Warn once per session when pi-automode is active and no command allowlist is set. */
	automodeHint: boolean;
}

export const DEFAULT_CONFIG: LongrunConfig = {
	guardBash: true,
	guardBackgroundLaunch: true,
	maxBareSleepSeconds: 60,
	maxCompoundSleepSeconds: 10,
	backoffFloorSeconds: 60,
	disableBackoff: false,
	injectSystemPrompt: true,
	extractMetrics: true,
	metricPatterns: [],
	maxMetrics: 10,
	progressPattern: "\\b(\\d+)\\s*/\\s*(\\d+)\\b",
	autoBackgroundPatterns: [],
	commandAllowlist: [],
	automodeHint: true,
};

function readJson(file: string): Partial<LongrunConfig> | undefined {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as Partial<LongrunConfig>;
	} catch {
		return undefined;
	}
}

/** Project config wins over user config, which wins over defaults. */
export function loadConfig(cwd: string): LongrunConfig {
	const user = readJson(path.join(getAgentDir(), "longrun.json"));
	const project = readJson(path.join(cwd, ".pi", "longrun.json"));
	return { ...DEFAULT_CONFIG, ...user, ...project };
}
