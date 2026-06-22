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
  it("returns project map and scene details from the indexed graph", () => {
    const root = indexedRealisticFixture();
    const projectMap = parseTextContent(callGodotMcpTool("godot_project_map", { projectPath: root }));

    expect(projectMap).toEqual(
      expect.objectContaining({
        ok: true,
        indexFresh: true,
        project: expect.objectContaining({
          name: "RealisticFixture",
          mainScene: "res://scenes/fixture_main.tscn",
        }),
        filesByKind: expect.arrayContaining([
          { kind: "gdscript", count: 3 },
          { kind: "scene", count: 2 },
        ]),
        scenes: expect.arrayContaining([
          expect.objectContaining({ id: "scene:res://scenes/fixture_main.tscn" }),
        ]),
        scripts: expect.arrayContaining([
          expect.objectContaining({ id: "script:res://scripts/actors/fixture_actor.gd" }),
        ]),
      }),
    );
    expect(projectMap).not.toHaveProperty("files");

    const scene = parseTextContent(
      callGodotMcpTool("godot_scene", {
        projectPath: root,
        scenePath: "res://scenes/fixture_main.tscn",
      }),
    );
    expect(scene).toEqual(
      expect.objectContaining({
        ok: true,
        paths: expect.objectContaining({
          p1: "res://scenes/fixture_main.tscn",
          p2: "res://scripts/controllers/main_controller.gd",
          p3: "res://scenes/fixture_actor.tscn",
        }),
        scene: expect.objectContaining({
          graphId: "scene:res://scenes/fixture_main.tscn",
          path: "p1",
        }),
        nodes: expect.arrayContaining([
          expect.objectContaining({
            graphId: "scene_node:res://scenes/fixture_main.tscn:Main",
            type: "Node2D",
            parentPath: null,
            scriptPath: "p2",
          }),
          expect.objectContaining({
            graphId: "scene_node:res://scenes/fixture_main.tscn:FixtureActor",
            instanceScenePath: "p3",
          }),
          expect.objectContaining({
            graphId: "scene_node:res://scenes/fixture_main.tscn:UI/HealthBar",
            parentPath: "UI",
          }),
        ]),
      }),
    );
    expect((scene.nodes as Array<Record<string, unknown>>)[0]).not.toHaveProperty("metadata");
    expect((scene.nodes as Array<Record<string, unknown>>)[0]).not.toHaveProperty("updatedAt");
  });

  it("returns agent-ready explore, callers, and impact context from real graph relationships", () => {
    const root = indexedRealisticFixture();

    expect(
      parseTextContent(
        callGodotMcpTool("godot_explore", {
          projectPath: root,
          query: "FixtureActor",
          includeCode: false,
        }),
      ),
    ).toEqual(
      expect.objectContaining({
        ok: true,
        context: expect.objectContaining({
          nodes: expect.arrayContaining([
            expect.objectContaining({ graphId: "script:res://scripts/actors/fixture_actor.gd" }),
            expect.objectContaining({ graphId: "scene_node:res://scenes/fixture_actor.tscn:FixtureActor" }),
            expect.objectContaining({ graphId: "resource:res://resources/fixture_stats.tres" }),
          ]),
          relationships: expect.arrayContaining([
            expect.objectContaining({ kind: "attaches_script" }),
          ]),
        }),
      }),
    );

    expect(
      parseTextContent(
        callGodotMcpTool("godot_callers", {
          projectPath: root,
          symbol: "advance_night",
          includeCode: false,
        }),
      ),
    ).toEqual(
      expect.objectContaining({
        ok: true,
        context: expect.objectContaining({
          relationships: expect.arrayContaining([
            expect.objectContaining({ kind: "calls" }),
          ]),
        }),
      }),
    );

    expect(
      parseTextContent(
        callGodotMcpTool("godot_impact", {
          projectPath: root,
          target: "res://scripts/actors/fixture_actor.gd",
        }),
      ),
    ).toEqual(
      expect.objectContaining({
        ok: true,
        affectedScenes: expect.arrayContaining([
          expect.objectContaining({ graphId: "scene:res://scenes/fixture_actor.tscn" }),
          expect.objectContaining({ graphId: "scene:res://scenes/fixture_main.tscn" }),
        ]),
        recommendedCheckFiles: expect.arrayContaining(["p1", "p2", "p3"]),
      }),
    );
  });
});
