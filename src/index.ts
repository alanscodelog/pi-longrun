/**
 * pi-longrun -- background jobs and scheduled wakeups for pi.
 *
 * Goal: keep the model out of the loop while long work runs. Start jobs detached,
 * let the runtime watch them, and spend tokens only when something actually happened.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describeStatus, jobLine, registerJobTools } from "./tools.js";
import { JobStore } from "./jobs.js";
import { JobUi } from "./ui.js";

export default function (pi: ExtensionAPI) {
	const store = new JobStore();
	const ui = new JobUi(store);
	let sessionFile: string | undefined;
	let unsubscribe: (() => void) | undefined;

	registerJobTools(pi, store, () => sessionFile);

	pi.registerCommand("jobs", {
		description: "Show or hide the background job list",
		handler: async (_args, ctx: ExtensionContext) => {
			store.checkAll();
			const visible = ui.toggleWidget();
			if (!visible) return;
			const jobs = store.listFor(ctx.cwd);
			if (jobs.length === 0) ui.notify("No background jobs", "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		sessionFile = ctx.sessionManager.getSessionFile();
		ui.attach(ctx);

		// Jobs outlive pi. Anything that finished while we were gone is reconciled here.
		const finishedWhileAway = store.reconcile();
		if (finishedWhileAway.length > 0) {
			ui.notify(`${finishedWhileAway.length} background job(s) finished while pi was not running`, "info");
		}

		unsubscribe?.();
		unsubscribe = store.onTransition((job) => {
			ui.refresh();
			ui.notify(`${job.id}: ${describeStatus(job)}`, job.exitCode === 0 ? "info" : "warning");
		});

		if (store.running(ctx.cwd).length > 0) store.ensurePolling();
		ui.refresh();
	});

	pi.on("session_shutdown", async () => {
		// Idempotent teardown: the background jobs themselves are deliberately left alone.
		unsubscribe?.();
		unsubscribe = undefined;
		store.stopPolling();
		ui.detach();
	});
}

export { JobStore, jobLine };
