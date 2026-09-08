import { describe, expect, it } from "bun:test";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import {
	decodeStreamedToolArgs,
	streamingStringKeysForTool,
} from "@oh-my-pi/pi-coding-agent/modes/controllers/tool-args-reveal";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { writeToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/write";
import type { TUI } from "@oh-my-pi/pi-tui";

const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");
const hasLine = (lines: readonly string[], n: number): boolean =>
	new RegExp(`\\bline ${n}\\b`).test(stripAnsi(lines.join("\n")));

describe("write streaming preview honors Ctrl+O expansion", () => {
	let initialized = false;

	async function makePendingWrite(lineCount: number) {
		if (!initialized) {
			await themeModule.initTheme();
			initialized = true;
		}
		const uiStub = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
		const content = Array.from({ length: lineCount }, (_, i) => `line ${i + 1}`).join("\n");
		// No updateResult() -> the call stays pending, exercising the streaming
		// `renderCall` path (formatStreamingContent), not the merged result render.
		return new ToolExecutionComponent("write", { file_path: "/tmp/foo.ts", content }, {}, undefined, uiStub);
	}

	async function getUiTheme() {
		if (!initialized) {
			await themeModule.initTheme();
			initialized = true;
		}
		const uiTheme = (await themeModule.getThemeByName("dark")) ?? (await themeModule.getThemeByName("light"));
		if (!uiTheme) {
			throw new Error("expected an initialized theme");
		}
		return uiTheme;
	}

	it("collapses a streaming write to a bounded tail and lifts the cap on expand", async () => {
		// 40 lines > WRITE_STREAMING_PREVIEW_LINES (12): the head must be hidden
		// while collapsed and the streaming edge (tail) kept visible.
		const comp = await makePendingWrite(40);

		const collapsed = comp.render(80);
		// Tail-anchored: the streaming edge (last lines) is visible...
		expect(hasLine(collapsed, 40)).toBe(true);
		// ...but the head is capped away with an "earlier lines" marker.
		expect(hasLine(collapsed, 1)).toBe(false);
		expect(stripAnsi(collapsed.join("\n"))).toContain("earlier line");

		comp.setExpanded(true);
		const expanded = comp.render(80);
		// Ctrl+O lifts the cap: the full file (head through tail) is shown,
		// and the "earlier lines" marker is gone.
		expect(hasLine(expanded, 1)).toBe(true);
		expect(hasLine(expanded, 40)).toBe(true);
		expect(stripAnsi(expanded.join("\n"))).not.toContain("earlier line");
		// Expanding must strictly grow the preview, not just reformat it.
		expect(expanded.length).toBeGreaterThan(collapsed.length);
	});

	it("does not cap a short streaming write that already fits the window", async () => {
		const comp = await makePendingWrite(4);
		const collapsed = comp.render(80);
		expect(hasLine(collapsed, 1)).toBe(true);
		expect(hasLine(collapsed, 4)).toBe(true);
		expect(stripAnsi(collapsed.join("\n"))).not.toContain("earlier line");
	});

	it("keeps completed code rows stable while the footer animates", async () => {
		const uiTheme = await getUiTheme();
		const options = { expanded: false, isPartial: true, spinnerFrame: 0 };

		const component = writeToolRenderer.renderCall(
			{ path: "/tmp/cache.ts", content: "const a = 1;\nconst b = 2;\n" },
			options,
			uiTheme,
		);
		if (!component) throw new Error("expected a rendered component for a non-xdev write path");

		const frame80 = component.render(80);
		const frame120 = component.render(120);

		// Frame animation tick (spinnerFrame 0 -> 1)
		options.spinnerFrame = 1;
		const frame120Tick = component.render(120);

		// Semantically locate the streaming status row rather than assuming a hardcoded bottom offset.
		const statusIndex = frame120.findIndex(line => stripAnsi(line).includes("… (streaming)"));
		expect(statusIndex).toBeGreaterThan(-1);

		// 1. All content rows above the streaming status row (code lines and gutters)
		// remain strictly byte-identical across animation frames.
		expect(frame120Tick.slice(0, statusIndex)).toEqual(frame120.slice(0, statusIndex));

		// 2. The streaming status line updates its animated spinner glyph while keeping its label:
		const statusTick = frame120Tick[statusIndex] ?? "";
		const statusOriginal = frame120[statusIndex] ?? "";
		expect(statusTick).not.toBe(statusOriginal);
		expect(stripAnsi(statusTick)).toContain("… (streaming)");
		expect(stripAnsi(statusOriginal)).toContain("… (streaming)");

		// 3. Width reframing (80 -> 120) preserves visible code lines:
		const text80 = stripAnsi(frame80.join("\n"));
		const text120 = stripAnsi(frame120.join("\n"));
		expect(text80).toContain("const a = 1;");
		expect(text80).toContain("const b = 2;");
		expect(text120).toContain("const a = 1;");
		expect(text120).toContain("const b = 2;");
	});

	it("restores discarded head rows after collapse, growth, and re-expansion", async () => {
		const uiTheme = await getUiTheme();
		const options = { expanded: false, isPartial: true, spinnerFrame: 0 };
		const lines = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`);
		for (const [expanded, count] of [
			[false, 40],
			[true, 40],
			[false, 40],
			[false, 80],
			[true, 80],
		] as const) {
			options.expanded = expanded;
			const component = writeToolRenderer.renderCall(
				{ path: "/tmp/growing.ts", content: lines.slice(0, count).join("\n") },
				options,
				uiTheme,
			);
			if (!component) throw new Error("expected a write preview");
			const rendered = component.render(120);
			for (let line = 1; line <= count; line++) {
				expect(hasLine(rendered, line)).toBe(expanded || line > count - 12);
			}
		}
	});

	it("coerces truthy non-string content for pending write previews", async () => {
		const uiTheme = await getUiTheme();
		const runtimeContent = ["object first\r\nobject second"];

		const component = writeToolRenderer.renderCall(
			{ path: "/tmp/runtime-content.ts", content: runtimeContent },
			{ expanded: true, isPartial: true, spinnerFrame: 0 },
			uiTheme,
		);
		if (!component) throw new Error("expected a rendered component for a non-xdev write path");

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("object first");
		expect(rendered).toContain("object second");
		expect(rendered).toMatch(/\b2 object second\b/);
		expect(rendered).not.toContain("\r");
	});

	it("coerces truthy non-string content for merged write results", async () => {
		const uiTheme = await getUiTheme();
		const runtimeContent = ["merged first\r\nmerged second"];

		const component = writeToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "Wrote /tmp/runtime-content.ts" }],
				details: { resolvedPath: "/tmp/runtime-content.ts" },
			},
			{ expanded: true, isPartial: false },
			uiTheme,
			{ path: "/tmp/runtime-content.ts", content: runtimeContent },
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("merged first");
		expect(rendered).toContain("merged second");
		expect(rendered).toContain("2 lines");
		expect(rendered).toMatch(/\b2 merged second\b/);
		expect(rendered).not.toContain("\r");
	});

	it("renders execution progress as a partial result without diagnostics", async () => {
		if (!initialized) {
			await themeModule.initTheme();
			initialized = true;
		}
		const uiTheme = (await themeModule.getThemeByName("dark")) ?? (await themeModule.getThemeByName("light"));
		if (!uiTheme) {
			throw new Error("expected an initialized theme");
		}

		const progressText = `Writing 12 bytes to tab\tpath/${"segment/".repeat(20)}UNTRUNCATED_TAIL_SENTINEL.ts...`;
		const component = writeToolRenderer.renderResult(
			{
				content: [{ type: "text", text: progressText }],
				details: {
					resolvedPath: "/tmp/progress.ts",
					diagnostics: {
						errored: true,
						summary: "1 error",
						messages: ["diagnostic sentinel"],
					},
				},
			},
			{ expanded: false, isPartial: true, spinnerFrame: 0 },
			uiTheme,
			{ path: "/tmp/progress.ts", content: "const x = 1;" },
		);

		const rendered = stripAnsi(component.render(100).join("\n"));
		expect(rendered).toContain("Writing 12 bytes to tab");
		expect(rendered).not.toContain("\t");
		expect(rendered).not.toContain("UNTRUNCATED_TAIL_SENTINEL");
		expect(rendered).not.toContain("diagnostic sentinel");
	});

	it("shows content grown past the last throttled parse when rebuilt mid-stream", async () => {
		// Regression: a transcript rebuild (theme change, settings, focus replay)
		// recreates the pending write component while args still stream. The
		// rebuild must decode display args from the raw partialJson buffer — the
		// provider-parsed arguments lag by up to a throttled parse window, and
		// spreading them alone froze the preview at the last full parse.
		if (!initialized) {
			await themeModule.initTheme();
			initialized = true;
		}
		const uiStub = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
		const staleContent = "line before throttle";
		// Provider parsed up to here…
		const seenByProvider = `{"path":"/tmp/foo.ts","content":"${staleContent}`;
		// …then the buffer grew, but not enough to re-trigger the 256-byte parse.
		const partialJson = `${seenByProvider}\\nGROWN_TAIL_SENTINEL`;
		const staleProviderArgs = { path: "/tmp/foo.ts", content: staleContent };

		const renderArgs = decodeStreamedToolArgs(partialJson, {
			rawInput: false,
			fullArgs: staleProviderArgs,
			streamingStringKeys: streamingStringKeysForTool("write", false),
		});
		// No updateResult() -> pending, exercising the streaming renderCall path
		// that reads args.content.
		const comp = new ToolExecutionComponent("write", renderArgs, {}, undefined, uiStub);

		const rendered = stripAnsi(comp.render(100).join("\n"));
		expect(rendered).toContain("GROWN_TAIL_SENTINEL");
	});
});
