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

function textContent(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.find((item) => item.type === "text")?.text ?? "";
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
          strategy: "symbol-first",
          completeness: expect.objectContaining({
            scope: "bounded_navigation",
            complete: false,
          }),
          paths: expect.objectContaining({
            p1: "res://scripts/actors/fixture_actor.gd",
          }),
          nodes: expect.arrayContaining([
            expect.objectContaining({ kind: "script_class", path: "p1" }),
            expect.objectContaining({ kind: "scene_node", path: expect.any(String) }),
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
    expect(JSON.stringify(context.context)).not.toContain("graphId");

    const nodeRead = callGodotMcpTool("godot_node", {
      projectPath: root,
      symbol: "advance_night",
      file: "res://scripts/autoload/fixture_state.gd",
      includeCode: false,
    });
    const nodeText = textContent(nodeRead);
    const nodePayload = parseTextContent(nodeRead);
    const nodePaths = nodePayload.paths as Record<string, string>;
    expect(Object.values(nodePaths).some((path) => path.includes("fixture_state.gd"))).toBe(true);
    expect(nodePayload).toEqual(
      expect.objectContaining({
        ok: true,
        target: expect.objectContaining({
          id: expect.stringMatching(/^n\d+$/),
          kind: "method",
          path: "p1",
        }),
        notes: expect.objectContaining({
          callers: expect.arrayContaining([
            expect.objectContaining({
              id: expect.stringMatching(/^n\d+$/),
              path: expect.any(String),
            }),
          ]),
        }),
      }),
    );
    expect(nodeText).not.toContain("filePath");
    expect(nodeText).not.toContain("graphId");
  });
});
