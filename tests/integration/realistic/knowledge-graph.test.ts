import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { exploreGodotContext } from "../../../src/context/explore.js";
import { createGraphDatabase } from "../../../src/db/index.js";
import { getNode, listEdges, searchNodes } from "../../../src/db/queries.js";
import { indexGodotProject } from "../../../src/indexer/indexer.js";

const fixturesRoot = fileURLToPath(new URL("../../fixtures/godot", import.meta.url));
const tempRoots: string[] = [];

function indexedRealisticFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "gdgraph-realistic-"));
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

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("realistic Godot knowledge graph", () => {
  it("indexes project, scene composition, scripts, resources, autoloads, and input actions", () => {
    const graph = createGraphDatabase(indexedRealisticFixture());
    try {
      expect(getNode(graph, "project")).toEqual(
        expect.objectContaining({
          kind: "project",
          name: "RealisticFixture",
        }),
      );
      expect(getNode(graph, "autoload:FixtureState")).toEqual(
        expect.objectContaining({
          kind: "autoload",
          name: "FixtureState",
        }),
      );
      expect(getNode(graph, "input_action:jump")).toEqual(
        expect.objectContaining({ kind: "input_action" }),
      );
      expect(getNode(graph, "input_action:interact")).toEqual(
        expect.objectContaining({ kind: "input_action" }),
      );
      expect(getNode(graph, "script:res://scripts/actors/fixture_actor.gd")).toEqual(
        expect.objectContaining({
          kind: "script_class",
          name: "FixtureActor",
        }),
      );
      expect(getNode(graph, "script:res://scripts/controllers/main_controller.gd")).toEqual(
        expect.objectContaining({
          kind: "script_class",
          name: "MainController",
        }),
      );

      expect(listEdges(graph, { kind: "main_scene" })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "project",
            target: "scene:res://scenes/fixture_main.tscn",
            provenance: "resolver",
          }),
        ]),
      );
      expect(listEdges(graph, { kind: "attaches_script" })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "scene_node:res://scenes/fixture_main.tscn:Main",
            target: "script:res://scripts/controllers/main_controller.gd",
            provenance: "resolver",
          }),
          expect.objectContaining({
            source: "scene_node:res://scenes/fixture_actor.tscn:FixtureActor",
            target: "script:res://scripts/actors/fixture_actor.gd",
            provenance: "resolver",
          }),
        ]),
      );
      expect(listEdges(graph, { kind: "instantiates_scene" })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "scene_node:res://scenes/fixture_main.tscn:FixtureActor",
            target: "scene:res://scenes/fixture_actor.tscn",
            provenance: "resolver",
          }),
        ]),
      );
      expect(listEdges(graph, { kind: "preloads_resource" })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "script:res://scripts/actors/fixture_actor.gd",
            target: "resource:res://resources/fixture_stats.tres",
            provenance: "resolver",
          }),
        ]),
      );
    } finally {
      graph.close();
    }
  });

  it("resolves script relationships for autoloads, input actions, calls, and signals", () => {
    const graph = createGraphDatabase(indexedRealisticFixture());
    try {
      expect(listEdges(graph, { kind: "uses_autoload" })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "method:res://scripts/actors/fixture_actor.gd:_ready",
            target: "autoload:FixtureState",
            provenance: "resolver",
          }),
          expect.objectContaining({
            source: "method:res://scripts/controllers/main_controller.gd:_ready",
            target: "autoload:FixtureState",
            provenance: "resolver",
          }),
        ]),
      );
      expect(listEdges(graph, { kind: "uses_input_action" })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "method:res://scripts/actors/fixture_actor.gd:_physics_process",
            target: "input_action:interact",
            provenance: "resolver",
          }),
          expect.objectContaining({
            source: "method:res://scripts/actors/fixture_actor.gd:_physics_process",
            target: "input_action:jump",
            provenance: "resolver",
          }),
        ]),
      );
      expect(listEdges(graph, { kind: "emits_signal" })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "method:res://scripts/actors/fixture_actor.gd:apply_damage",
            target: "signal:res://scripts/actors/fixture_actor.gd:health_depleted",
          }),
          expect.objectContaining({
            source: "method:res://scripts/autoload/fixture_state.gd:advance_night",
            target: "signal:res://scripts/autoload/fixture_state.gd:night_changed",
          }),
        ]),
      );
      expect(listEdges(graph, { kind: "calls" })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "method:res://scripts/controllers/main_controller.gd:_ready",
            target: "method:res://scripts/autoload/fixture_state.gd:advance_night",
            provenance: "resolver",
          }),
        ]),
      );
    } finally {
      graph.close();
    }
  });

  it("returns correct query, scene, and context views", () => {
    const root = indexedRealisticFixture();
    const graph = createGraphDatabase(root);
    try {
      expect(searchNodes(graph, "FixtureActor").map((node) => node.id)).toContain(
        "script:res://scripts/actors/fixture_actor.gd",
      );

      expect(sceneNodeIds(graph, "res://scenes/fixture_main.tscn")).toEqual(
        expect.arrayContaining([
          "scene_node:res://scenes/fixture_main.tscn:Main",
          "scene_node:res://scenes/fixture_main.tscn:FixtureActor",
          "scene_node:res://scenes/fixture_main.tscn:UI",
          "scene_node:res://scenes/fixture_main.tscn:UI/HealthBar",
        ]),
      );

      const explore = exploreGodotContext(graph, {
        projectRoot: root,
        query: "FixtureActor",
        includeCode: false,
      });
      expect(explore.nodes.map((node) => node.id)).toEqual(
        expect.arrayContaining([
          "script:res://scripts/actors/fixture_actor.gd",
          "scene_node:res://scenes/fixture_actor.tscn:FixtureActor",
          "resource:res://resources/fixture_stats.tres",
        ]),
      );
      expect(explore.relationships).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            "scene_node:res://scenes/fixture_actor.tscn:FixtureActor attaches_script script:res://scripts/actors/fixture_actor.gd",
          ),
        ]),
      );

      const callEdges = listEdges(graph, {
        target: "method:res://scripts/autoload/fixture_state.gd:advance_night",
        kind: "calls",
      });
      expect(callEdges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "method:res://scripts/controllers/main_controller.gd:_ready",
          }),
        ]),
      );

      const editContext = exploreGodotContext(graph, {
        projectRoot: root,
        query: "change FixtureActor",
        includeCode: false,
      });
      expect(editContext.blastRadius?.checkFiles).toEqual(
        expect.arrayContaining([
          "res://scripts/actors/fixture_actor.gd",
          "res://scenes/fixture_actor.tscn",
        ]),
      );
    } finally {
      graph.close();
    }
  });
});

function sceneNodeIds(graph: ReturnType<typeof createGraphDatabase>, scenePath: string): string[] {
  return listEdges(graph, {
    source: `scene:${scenePath}`,
    kind: "contains",
  })
    .map((edge) => getNode(graph, edge.target))
    .filter((node) => node?.kind === "scene_node")
    .map((node) => node.id);
}
