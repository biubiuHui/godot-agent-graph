import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { indexGodotProject } from "../../../src/indexer/indexer.js";
import { getMcpInstructions } from "../../../src/mcp/instructions.js";
import { callGodotMcpTool, listGodotMcpTools } from "../../../src/mcp/tools.js";
import { globalPendingFileTracker } from "../../../src/sync/watcher.js";

const fixturesRoot = fileURLToPath(new URL("../../fixtures/godot", import.meta.url));
const tempRoots: string[] = [];

function copyFixture(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `gdgraph-mcp-${name}-`));
  tempRoots.push(root);
  cpSync(join(fixturesRoot, name), root, { recursive: true });
  return root;
}

function parseTextContent(result: { content: Array<{ type: string; text?: string }> }) {
  const text = result.content.find((item) => item.type === "text")?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    globalPendingFileTracker.clearPending(root);
    rmSync(root, { force: true, recursive: true });
  }
});

describe("MCP Godot tools", () => {
  it("provides graph-first agent instructions", () => {
    const instructions = getMcpInstructions();

    expect(instructions).toContain("godot_project_map");
    expect(instructions).toContain("godot_search");
    expect(instructions).toContain("godot_scene");
    expect(instructions).toContain("Do not start with broad grep");
    expect(instructions).toContain("indexFresh");
  });

  it("lists baseline tools", () => {
    expect(listGodotMcpTools().map((tool) => tool.name)).toEqual([
      "godot_status",
      "godot_project_map",
      "godot_sync",
      "godot_search",
      "godot_scene",
      "godot_explore",
      "godot_symbol",
      "godot_callers",
      "godot_callees",
      "godot_impact",
    ]);
  });

  it("syncs through MCP and reports freshness metadata", () => {
    const root = copyFixture("minimal");
    const indexResult = indexGodotProject(root);
    expect(indexResult.ok).toBe(true);

    writeFileSync(
      join(root, "scripts", "mcp_added.gd"),
      "extends Node\nclass_name McpAdded\n",
    );

    globalPendingFileTracker.markPending(root, "res://scripts/mcp_added.gd");

    expect(
      parseTextContent(callGodotMcpTool("godot_search", { projectPath: root, query: "FixtureActor" })),
    ).toEqual(
      expect.objectContaining({
        ok: true,
        indexFresh: false,
        pendingFiles: [{ indexing: false, path: "res://scripts/mcp_added.gd" }],
        freshness: expect.objectContaining({
          indexFresh: false,
          pendingFiles: [{ indexing: false, path: "res://scripts/mcp_added.gd" }],
        }),
      }),
    );

    const sync = parseTextContent(callGodotMcpTool("godot_sync", { projectPath: root }));
    expect(sync).toEqual(
      expect.objectContaining({
        ok: true,
        added: ["res://scripts/mcp_added.gd"],
        addedCount: 1,
        indexFresh: true,
        pendingFiles: [],
        freshness: expect.objectContaining({
          indexFresh: true,
          pendingFiles: [],
          lastSyncAt: expect.any(Number),
        }),
      }),
    );
  });

  it("returns friendly uninitialized status", () => {
    const root = mkdtempSync(join(tmpdir(), "gdgraph-mcp-empty-"));
    tempRoots.push(root);

    const response = parseTextContent(
      callGodotMcpTool("godot_status", { projectPath: root }),
    );

    expect(response).toEqual(
      expect.objectContaining({
        ok: false,
        initialized: false,
        indexFresh: false,
        projectRoot: root,
      }),
    );
  });

  it("queries an indexed fixture through project map, search, and scene tools", () => {
    const root = copyFixture("minimal");
    const indexResult = indexGodotProject(root);
    expect(indexResult.ok).toBe(true);

    expect(parseTextContent(callGodotMcpTool("godot_project_map", { projectPath: root }))).toEqual(
      expect.objectContaining({
        ok: true,
        indexFresh: true,
        project: expect.objectContaining({
          name: "MinimalFixture",
          mainScene: "res://fixture_main.tscn",
        }),
      }),
    );

    expect(
      parseTextContent(callGodotMcpTool("godot_search", { projectPath: root, query: "FixtureActor" })),
    ).toEqual(
      expect.objectContaining({
        ok: true,
        results: expect.arrayContaining([
          expect.objectContaining({
            id: "script:res://scripts/fixture_actor.gd",
            kind: "script_class",
          }),
        ]),
      }),
    );

    const pathSearch = parseTextContent(
      callGodotMcpTool("godot_search", { projectPath: root, query: "fixture_actor.gd" }),
    );
    expect(pathSearch).toEqual(
      expect.objectContaining({
        ok: true,
        results: expect.arrayContaining([
          expect.objectContaining({
            id: "script:res://scripts/fixture_actor.gd",
            kind: "script_class",
          }),
        ]),
      }),
    );
    expect((pathSearch.results as Array<{ id: string }>).map((node) => node.id)).not.toContain(
      "resource:res://scripts/fixture_actor.gd",
    );

    expect(
      parseTextContent(
        callGodotMcpTool("godot_scene", {
          projectPath: root,
          scenePath: "res://fixture_main.tscn",
        }),
      ),
    ).toEqual(
      expect.objectContaining({
        ok: true,
        scene: expect.objectContaining({ id: "scene:res://fixture_main.tscn" }),
        nodes: expect.arrayContaining([
          expect.objectContaining({ id: "scene_node:res://fixture_main.tscn:FixtureActor" }),
        ]),
      }),
    );
  });

  it("queries agent-first context tools", () => {
    const root = copyFixture("signals");
    const indexResult = indexGodotProject(root);
    expect(indexResult.ok).toBe(true);

    expect(
      parseTextContent(callGodotMcpTool("godot_explore", { projectPath: root, query: "SignalDemo" })),
    ).toEqual(
      expect.objectContaining({
        ok: true,
        nodes: expect.arrayContaining([
          expect.objectContaining({ id: "script:res://scripts/signal_demo.gd" }),
        ]),
        relationships: expect.any(Array),
      }),
    );

    expect(
      parseTextContent(callGodotMcpTool("godot_symbol", { projectPath: root, symbol: "health_depleted" })),
    ).toEqual(
      expect.objectContaining({
        ok: true,
        nodes: expect.arrayContaining([
          expect.objectContaining({ id: "signal:res://scripts/signal_demo.gd:health_depleted" }),
        ]),
      }),
    );

    expect(
      parseTextContent(callGodotMcpTool("godot_callers", { projectPath: root, symbol: "damage" })),
    ).toEqual(expect.objectContaining({ ok: true, relationships: expect.any(Array) }));

    expect(
      parseTextContent(callGodotMcpTool("godot_callees", { projectPath: root, symbol: "SignalDemo" })),
    ).toEqual(expect.objectContaining({ ok: true, nodes: expect.any(Array) }));

    expect(
      parseTextContent(callGodotMcpTool("godot_impact", { projectPath: root, target: "health_depleted" })),
    ).toEqual(
      expect.objectContaining({
        ok: true,
        recommendedCheckFiles: expect.arrayContaining(["res://scripts/signal_demo.gd"]),
      }),
    );
  });
});
