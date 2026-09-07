import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWakeRenderer } from "../src/ui.js";

/** Minimal stand-in for pi's Theme: the renderer only uses fg, bg and bold. */
const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as never;

function capture(): { renderer: (message: never, options: never, theme: never) => unknown } {
	let renderer: ((message: never, options: never, theme: never) => unknown) | undefined;
	const pi = {
		registerMessageRenderer: vi.fn((_type: string, fn: never) => {
			renderer = fn;
		}),
	} as unknown as ExtensionAPI;
	registerWakeRenderer(pi);
	if (!renderer) throw new Error("renderer was not registered");
	return { renderer };
}

describe("wake message renderer", () => {
	it("renders collapsed and expanded without throwing", () => {
		const { renderer } = capture();
		const message = {
			customType: "longrun-wake",
			content: "[longrun] wake at 2026-09-07 22:41:11\njob train-a3f1 exited after 2h with exit code 0",
			details: { summary: "train-a3f1 exited (exit 0)" },
		} as never;

		expect(renderer(message, { expanded: false } as never, theme)).toBeDefined();
		expect(renderer(message, { expanded: true } as never, theme)).toBeDefined();
	});

	it("still renders when details and content are missing", () => {
		const { renderer } = capture();
		expect(renderer({ customType: "longrun-wake" } as never, { expanded: false } as never, theme)).toBeDefined();
	});
});
