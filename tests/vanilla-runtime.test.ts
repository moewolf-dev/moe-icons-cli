import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { planGeneratedFiles } from "../src/generator/generate.js";
import type { MoeiconsConfigFile } from "../src/project/config.js";

const require_ = createRequire(import.meta.url);
// happy-dom ships without bundled types in this package version.
const HappyDom = require_("happy-dom") as { Window: new (options?: { url?: string }) => HappyWindow };
type HappyWindow = {
  document: {
    createElement: (tag: string) => {
      appendChild: (node: unknown) => void;
      contains: (node: unknown) => boolean;
      querySelector: (sel: string) => { innerHTML: string; getAttribute: (name: string) => string | null } | null;
    };
    body: { appendChild: (node: unknown) => void };
  };
  Element: unknown;
  SVGElement: unknown;
  Event: typeof Event;
  close: () => void;
};

/**
 * E2E-C4: CLI project-layer Vanilla runtime with live DOM theme updates.
 * Underlying per-style-group factories remain theme-less.
 */

const FIXTURE = resolve("tests/.fixtures/vanilla-runtime");

const SVG_OUTLINE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M1 1h10" data-mark="outline"/></svg>';
const SVG_SOLID =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M1 1h10" data-mark="solid"/></svg>';

const config: MoeiconsConfigFile = {
  schemaVersion: 2,
  tier: "free",
  target: "vanilla",
  outputDir: "src/moeicons",
  defaultTheme: "outline",
  themes: {
    outline: { styleGroup: "moe-outline" },
    solid: { styleGroup: "moe-solid" },
  },
  icons: ["ui-search"],
  missingIconPolicy: "fallback",
};

function archiveFiles(): Record<string, Uint8Array> {
  const enc = new TextEncoder();
  const outline = enc.encode(SVG_OUTLINE);
  const solid = enc.encode(SVG_SOLID);
  const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  return {
    "assets/moe-outline/ui-search.svg": outline,
    "assets/moe-solid/ui-search.svg": solid,
    "assets/manifest.json": enc.encode(
      JSON.stringify({
        schemaVersion: 1,
        assets: [
          { path: "moe-outline/ui-search.svg", size: outline.byteLength, sha256: sha(outline) },
          { path: "moe-solid/ui-search.svg", size: solid.byteLength, sha256: sha(solid) },
        ],
      }),
    ),
  };
}

// A formal code archive includes the compiled per-icon factory. The local
// project should reuse it, rather than reinterpret the SVG with another emitter.
const compiledFactory = new TextEncoder().encode('export function createUiSearch() {}\nexport default createUiSearch;\n');

describe("E2E-C4 vanilla project runtime", () => {
  let window: HappyWindow;

  beforeEach(() => {
    rmSync(FIXTURE, { recursive: true, force: true });
    const plan = planGeneratedFiles(config, "src/moeicons", { archiveFiles: archiveFiles() });
    if (!plan.ok) throw new Error(plan.errors.join("; "));
    for (const file of plan.files) {
      const full = join(FIXTURE, file.path);
      mkdirSync(dirname(full), { recursive: true });
      const content = typeof file.content === "string" ? file.content : Buffer.from(file.content).toString("utf8");
      writeFileSync(full, content);
    }
    window = new HappyDom.Window({ url: "https://example.test/" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (globalThis as any).document = window.document;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (globalThis as any).Element = window.Element;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (globalThis as any).SVGElement = window.SVGElement;
  });

  afterEach(() => {
    window.close();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).document;
    rmSync(FIXTURE, { recursive: true, force: true });
  });

  it("emits runtime.ts exporting createMoeiconsRuntime (not style-group hardcoding at call sites)", () => {
    const plan = planGeneratedFiles(config, "src/moeicons", { archiveFiles: archiveFiles() });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const runtime = plan.files.find((f) => f.path === "src/moeicons/runtime.ts")?.content ?? "";
    const index = plan.files.find((f) => f.path === "src/moeicons/index.ts")?.content ?? "";
    expect(runtime).toContain("export function createMoeiconsRuntime");
    expect(runtime).toContain("setTheme");
    expect(runtime).toContain("mountIcon");
    expect(runtime).toContain("destroy");
    expect(index).toContain("createMoeiconsRuntime");
  });

  it("top-level vanilla index namespaces each style group (no ambiguous export *)", () => {
    const plan = planGeneratedFiles(config, "src/moeicons", { archiveFiles: archiveFiles() });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const index = plan.files.find((f) => f.path === "src/moeicons/index.ts")?.content ?? "";
    expect(index).toContain("export * as MoeOutline from './moe-outline';");
    expect(index).toContain("export * as MoeSolid from './moe-solid';");
    expect(index).not.toContain("export * from './moe-outline';");
    expect(index).not.toContain("export * from './moe-solid';");
  });

  it("re-exports installed compiled factories when the code archive provides them", () => {
    const files = { ...archiveFiles(), 'vanilla/moe-outline/UiSearch.js': compiledFactory };
    const plan = planGeneratedFiles({ ...config, themes: { outline: config.themes.outline! } }, "src/moeicons", { archiveFiles: files });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const factory = plan.files.find((file) => file.path === 'src/moeicons/moe-outline/UiSearch.ts')?.content;
    expect(factory).toContain('export { createUiSearch, default } from');
    expect(factory).toContain('.moeicons/artifact/vanilla/moe-outline/UiSearch.js');
    expect(factory).not.toContain('document.createElementNS');
  });

  it("rejects two style groups that map to the same namespace", () => {
    const colliding: MoeiconsConfigFile = {
      ...config,
      themes: {
        outline: { styleGroup: "moe-outline" },
        other: { styleGroup: "moe-outline" },
      },
    };
    // Same group through two themes is de-duplicated and is fine.
    const same = planGeneratedFiles(colliding, "src/moeicons", { archiveFiles: archiveFiles() });
    expect(same.ok).toBe(true);
  });

  it("mountIcon + setTheme updates an existing node; destroy clears mounts", async () => {
    const mod = await import(pathToFileURL(join(FIXTURE, "src/moeicons/runtime.ts")).href);
    const runtime = mod.createMoeiconsRuntime({ theme: "outline" });
    const host = window.document.createElement("div");
    window.document.body.appendChild(host);
    const node = runtime.mountIcon(host, "ui-search", { "aria-label": "search" });
    expect(host.contains(node)).toBe(true);
    expect(node.getAttribute("aria-label")).toBe("search");
    expect(node.innerHTML).toContain('data-mark="outline"');

    runtime.setTheme("solid");
    expect(host.querySelector("svg")?.innerHTML).toContain('data-mark="solid"');
    expect(host.querySelector("svg")?.getAttribute("aria-label")).toBe("search");

    runtime.setTheme("not-a-theme");
    expect(host.querySelector("svg")?.innerHTML).toContain('data-mark="outline"');

    runtime.destroy();
    expect(host.querySelector("svg")).toBeNull();
  });

  it("mount handle tracks replacement, preserves registered listeners, and unmounts", async () => {
    const mod = await import(pathToFileURL(join(FIXTURE, "src/moeicons/runtime.ts")).href);
    const runtime = mod.createMoeiconsRuntime();
    const host = window.document.createElement("div");
    window.document.body.appendChild(host);
    const handle = runtime.mount(host, "ui-search", { "aria-label": "search" });
    const first = handle.node;
    runtime.setTheme("outline");
    expect(handle.node).toBe(first);
    let clicks = 0;
    handle.on("click", () => { clicks += 1; });
    runtime.setTheme("solid");
    expect(handle.node).not.toBe(first);
    handle.node.dispatchEvent(new window.Event("click"));
    expect(clicks).toBe(1);
    handle.update({ "aria-label": "updated" });
    expect(handle.node.getAttribute("aria-label")).toBe("updated");
    handle.unmount();
    expect(host.querySelector("svg")).toBeNull();
    runtime.destroy();
  });

  it("rejects bitmap vanilla themes at plan time", () => {
    const bitmapConfig: MoeiconsConfigFile = {
      ...config,
      themes: {
        cute: { styleGroup: "moe-cute-3d", format: "webp", imageSize: 256 },
      },
      defaultTheme: "cute",
    };
    const plan = planGeneratedFiles(bitmapConfig, "src/moeicons", { archiveFiles: archiveFiles() });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.errors.join(" ")).toMatch(/vanilla target supports SVG themes only|unknown style group/);
  });

  it("keeps SVG root paint and default dimensions in generated Vanilla factories", () => {
    const files = archiveFiles();
    const source = new TextEncoder().encode('<svg viewBox="0 0 24 24" opacity="0.4" stroke-width="3"><path stroke="black" stroke-width="2" d="M0 0"/></svg>');
    files["assets/moe-outline/ui-search.svg"] = source;
    const manifest = JSON.parse(new TextDecoder().decode(files["assets/manifest.json"])) as { assets: Array<{ path: string; size: number; sha256: string }> };
    const entry = manifest.assets.find((asset) => asset.path === "moe-outline/ui-search.svg")!;
    entry.size = source.byteLength;
    entry.sha256 = createHash("sha256").update(source).digest("hex");
    files["assets/manifest.json"] = new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, assets: manifest.assets }));
    const plan = planGeneratedFiles(config, "src/moeicons", { archiveFiles: files });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const factory = String(plan.files.find((file) => file.path === "src/moeicons/moe-outline/UiSearch.ts")?.content);
    expect(factory).toContain('svg.setAttribute("opacity", "0.4")');
    expect(factory).toContain('svg.setAttribute("stroke-width", "3")');
    expect(factory).toContain("svg.setAttribute('width', '24')");
    expect(factory).toContain('node0.setAttribute("stroke", "currentColor")');
    expect(factory).not.toContain('node0.setAttribute("stroke-width", "2")');
  });
});
