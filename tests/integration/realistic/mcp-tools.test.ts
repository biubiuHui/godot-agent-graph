import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { indexGodotProject } from "../../../src/indexer/indexer.js";
import { callGodotMcpTool } from "../../../src/mcp/tools.js";

const fixturesRoot = fileURLToPath(new URL("../../fixtures/godot", import.meta.url));
const tempRoots: string[] = [];

function indexedRealisticFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "gdgraph-realistic-mcp-"));
  tempRoots.push(root);
  cpSync(join(fixturesRoot, "realistic-game"), root, { recursive: true });
  const result = indexGodotProject(root);
  expect(result).toEqual(
    expect.objectContaining({
      ok: true,
      fileCount: 7,
      parseErrors: [],
    }),
  );
  return root;
}

function parseTextContent(result: { content: Array<{ type: string; text?: string }> }) {
  const text = result.content.find((item) => item.type === "text")?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("realistic Godot MCP knowledge graph tools", () => {
  it("returns status and sync metadata through final MCP tools", () => {
    const root = indexedRealisticFixture();

    expect(parseTextContent(callGodotMcpTool("godot_status", { projectPath: root }))).toEqual(
      expect.objectContaining({
        ok: true,
        initialized: true,
        indexFresh: true,
        fileCount: 7,
      }),
    );

    expect(parseTextContent(callGodotMcpTool("godot_sync", { projectPath: root }))).toEqual(
      expect.objectContaining({
        ok: true,
        indexFresh: true,
        fileCount: 7,
        addedCount: 0,
        modifiedCount: 0,
        deletedCount: 0,
      }),
    );
  });

  it("returns context and exact node reads through final MCP tools", () => {
    const root = indexedRealisticFixture();

    const context = parseTextContent(
      callGodotMcpTool("godot_context", {
        projectPath: root,
        query: "FixtureActor",
        includeCode: false,
      }),
    );
    expect(context).toEqual(
      expect.objectContaining({
        ok: true,
        context: expect.objectContaining({
          nodes: expect.arrayContaining([
            expect.objectContaining({ graphId: "script:res://scripts/actors/fixture_actor.gd" }),
            expect.objectContaining({ graphId: "scene_node:res://scenes/fixture_actor.tscn:FixtureActor" }),
          ]),
          relationships: expect.arrayContaining([
            expect.objectContaining({ kind: "attaches_script" }),
          ]),
        }),
        nextTools: expect.arrayContaining([
          expect.objectContaining({ tool: "godot_node" }),
        ]),
      }),
    );

    expect(
      parseTextContent(
        callGodotMcpTool("godot_node", {
          projectPath: root,
          symbol: "advance_night",
          file: "res://scripts/autoload/fixture_state.gd",
          includeCode: false,
        }),
      ),
    ).toEqual(
      expect.objectContaining({
        ok: true,
        target: expect.objectContaining({
          id: "method:res://scripts/autoload/fixture_state.gd:advance_night",
          kind: "method",
          filePath: "res://scripts/autoload/fixture_state.gd",
        }),
        notes: expect.objectContaining({
          callers: expect.arrayContaining([
            expect.objectContaining({
              id: "method:res://scripts/controllers/main_controller.gd:_ready",
            }),
          ]),
        }),
      }),
    );
  });
});
