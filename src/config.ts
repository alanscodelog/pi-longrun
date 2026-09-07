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
	/** Inject the long-running work section into the system prompt. */
	injectSystemPrompt: boolean;
}

export const DEFAULT_CONFIG: LongrunConfig = {
	guardBash: true,
	guardBackgroundLaunch: true,
	maxBareSleepSeconds: 60,
	maxCompoundSleepSeconds: 10,
	backoffFloorSeconds: 60,
	injectSystemPrompt: true,
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
