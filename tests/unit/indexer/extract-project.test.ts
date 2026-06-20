import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { extractProjectGodotGraph } from "../../../src/indexer/extract-project.js";
import { parseProjectGodot } from "../../../src/parsers/project-godot.js";

const fixturesRoot = fileURLToPath(new URL("../../fixtures/godot", import.meta.url));

function parseFixtureProject(name: string) {
  const contents = readFileSync(join(fixturesRoot, name, "project.godot"), "utf8");
  return parseProjectGodot(contents, "res://project.godot");
}

describe("extractProjectGodotGraph", () => {
  it("creates a project node and main scene unresolved ref", () => {
    const graph = extractProjectGodotGraph(parseFixtureProject("minimal"), {
      updatedAt: 1000,
    });

    expect(graph.nodes).toEqual([
      expect.objectContaining({
        id: "project",
        kind: "project",
        name: "MinimalFixture",
        qualifiedName: "MinimalFixture",
        filePath: "res://project.godot",
        metadata: { mainScene: "res://fixture_main.tscn" },
      }),
    ]);
    expect(graph.edges).toEqual([]);
    expect(graph.unresolvedRefs).toEqual([
      {
        fromNodeId: "project",
        referenceName: "res://fixture_main.tscn",
        referenceKind: "main_scene",
        filePath: "res://project.godot",
        line: null,
        column: null,
        candidates: [],
      },
    ]);
  });

  it("creates autoload and input action graph records", () => {
    const graph = extractProjectGodotGraph(parseFixtureProject("autoload-input"), {
      updatedAt: 2000,
    });

    expect(graph.nodes.map((node) => [node.id, node.kind, node.name])).toEqual([
      ["project", "project", "AutoloadInputFixture"],
      ["autoload:FixtureSaveService", "autoload", "FixtureSaveService"],
      ["autoload:FixtureState", "autoload", "FixtureState"],
      ["input_action:confirm", "input_action", "confirm"],
      ["input_action:move_left", "input_action", "move_left"],
    ]);
    expect(graph.edges.map((edge) => [edge.source, edge.target, edge.kind])).toEqual([
      ["project", "autoload:FixtureSaveService", "contains"],
      ["project", "autoload:FixtureState", "contains"],
      ["project", "input_action:confirm", "contains"],
      ["project", "input_action:move_left", "contains"],
    ]);
    expect(graph.unresolvedRefs).toEqual([
      {
        fromNodeId: "project",
        referenceName: "res://fixture_main.tscn",
        referenceKind: "main_scene",
        filePath: "res://project.godot",
        line: null,
        column: null,
        candidates: [],
      },
      {
        fromNodeId: "autoload:FixtureSaveService",
        referenceName: "res://scripts/fixture_save_service.gd",
        referenceKind: "autoload_resource",
        filePath: "res://project.godot",
        line: 9,
        column: null,
        candidates: [],
      },
      {
        fromNodeId: "autoload:FixtureState",
        referenceName: "res://scripts/fixture_state.gd",
        referenceKind: "autoload_resource",
        filePath: "res://project.godot",
        line: 8,
        column: null,
        candidates: [],
      },
    ]);
  });
});
