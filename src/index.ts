/**
 * pi-longrun -- background jobs and scheduled wakeups for pi.
 *
 * Goal: keep the model out of the loop while long work runs. Start jobs detached,
 * let the runtime watch them, and spend tokens only when something actually happened.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, type LongrunConfig, loadConfig } from "./config.js";
import { buildSystemPromptSection, WaitBackoff, inspectBackgroundLaunch, inspectBashCommand } from "./guards.js";
import { JobStore } from "./jobs.js";
import { describeStatus, jobLine, registerTools } from "./tools.js";
import { JobUi } from "./ui.js";
import { WaitWatcher } from "./waits.js";
import { WakeNotifier } from "./wake.js";

/** Give the session a moment to settle before a wake can trigger a turn. */
const STARTUP_EVALUATION_DELAY_MS = 750;

export default function (pi: ExtensionAPI) {
	const store = new JobStore();
	const waits = new WaitWatcher(store, store.root);
	const ui = new JobUi(store, waits, () => config);
	let sessionFile: string | undefined;
	let cwd = process.cwd();
	let unsubscribe: (() => void) | undefined;
	let startupTimer: NodeJS.Timeout | undefined;
	let config: LongrunConfig = DEFAULT_CONFIG;
	const backoff = new WaitBackoff(() => config);

	const notifier = new WakeNotifier(pi, store, () => cwd, () => config, () => ui.refresh());

	registerTools(pi, { store, waits, backoff, getConfig: () => config, getSessionFile: () => sessionFile });

	pi.registerCommand("jobs", {
		description: "Show or hide the background job list",
		handler: async (_args, ctx: ExtensionContext) => {
			store.checkAll();
			const visible = ui.toggleWidget();
			if (visible && store.listFor(ctx.cwd).length === 0) ui.notify("No background jobs", "info");
		},
	});

	pi.registerCommand("wakes", {
		description: "List pending wake conditions, or clear them with /wakes clear",
		handler: async (args, _ctx: ExtensionContext) => {
			if (args.trim() === "clear") {
				const cleared = waits.cancelAll();
				ui.refresh();
				ui.notify(cleared > 0 ? `Cleared ${cleared} wake condition(s)` : "No wake conditions to clear", "info");
				return;
			}
			const pending = waits.list();
			ui.notify(
				pending.length === 0
					? "No pending wake conditions"
					: pending.map((w) => `${w.id}: ${w.note}`).join(" | "),
				"info",
			);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		sessionFile = ctx.sessionManager.getSessionFile();
		cwd = ctx.cwd;
		config = loadConfig(ctx.cwd);
		ui.attach(ctx);

		// Jobs outlive pi. Reconcile records against reality before anything else looks at them.
		const finishedWhileAway = store.reconcile();
		if (finishedWhileAway.length > 0) {
			ui.notify(`${finishedWhileAway.length} background job(s) finished while pi was not running`, "info");
		}

		unsubscribe?.();
		unsubscribe = store.onTransition((job) => {
			ui.refresh();
			ui.notify(`${job.id}: ${describeStatus(job)}`, job.exitCode === 0 ? "info" : "warning");
		});

		// Wake conditions are keyed to the session file, so resuming a session resumes its waits.
		const restored = waits.load(sessionFile);
		waits.start((events) => {
			// A real event means the model was waiting on something, not spinning.
			if (events.some((e) => e.reason.kind !== "timer")) backoff.reset();
			notifier.push(events);
		});
		if (restored.length > 0) {
			ui.notify(`Restored ${restored.length} pending wake condition(s)`, "info");
			clearTimeout(startupTimer);
			startupTimer = setTimeout(() => {
				// Anything that already fired while pi was down is delivered as a normal wake.
				notifier.push(waits.evaluate());
				notifier.flush();
			}, STARTUP_EVALUATION_DELAY_MS);
			startupTimer.unref?.();
		}

		if (store.running(ctx.cwd).length > 0) store.ensurePolling();
		ui.refresh();
	});

	// Block the two habits that turn a long job into a token sink.
	pi.on("tool_call", async (event, _ctx) => {
		if (!isToolCallEventType("bash", event)) return;
		const command = event.input.command;
		if (typeof command !== "string" || command.trim().length === 0) return;
		const verdict = inspectBackgroundLaunch(command, config) ?? inspectBashCommand(command, config);
		if (verdict) return { block: true, reason: verdict.reason };
	});

	// Keep running jobs and pending wake-ups in the system prompt so the model
	// never has to spend a tool call finding out what it is already waiting for.
	pi.on("before_agent_start", async (event, ctx) => {
		if (!config.injectSystemPrompt) return;
		const section = buildSystemPromptSection(store, waits, ctx.cwd, config);
		if (!section) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${section}` };
	});

	pi.on("session_shutdown", async () => {
		// Idempotent teardown. The background jobs themselves are deliberately left running.
		clearTimeout(startupTimer);
		startupTimer = undefined;
		unsubscribe?.();
		unsubscribe = undefined;
		notifier.dispose();
		waits.dispose();
		store.stopPolling();
		ui.detach();
	});
}

export { JobStore, jobLine };
