import { appendFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createGraphDatabase } from "../../../src/db/index.js";
import {
  getProjectMetadata,
  getNode,
  listEdges,
  listUnresolvedRefs,
  searchNodes,
} from "../../../src/db/queries.js";
import { getProjectOverview } from "../../../src/graph/queries.js";
import { indexGodotProject } from "../../../src/indexer/indexer.js";

const fixturesRoot = fileURLToPath(new URL("../../fixtures/godot", import.meta.url));
const tempRoots: string[] = [];

function copyFixture(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `gdgraph-${name}-`));
  tempRoots.push(root);
  cpSync(join(fixturesRoot, name), root, { recursive: true });
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("indexGodotProject", () => {
  it("indexes all fixture projects without parse errors", () => {
    for (const fixture of [
      "minimal",
      "scene-composition",
      "signals",
      "autoload-input",
      "resources",
      "resource-addresses",
      "realistic-game",
    ]) {
      const result = indexGodotProject(copyFixture(fixture));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.parseErrors).toEqual([]);
        expect(result.fileCount).toBeGreaterThan(0);
        expect(result.nodeCount).toBeGreaterThan(0);
      }
    }
  });

  it("indexes a realistic multi-folder Godot project and resolves core relationships", () => {
    const root = copyFixture("realistic-game");
    const result = indexGodotProject(root);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.parseErrors).toEqual([]);

    const graph = createGraphDatabase(root);
    try {
      expect(getProjectOverview(graph).edgeCount).toBe(result.edgeCount);
      expect(getNode(graph, "script:res://scripts/actors/fixture_actor.gd")).toEqual(
        expect.objectContaining({ name: "FixtureActor" }),
      );
      expect(getNode(graph, "script:res://scripts/controllers/main_controller.gd")).toEqual(
        expect.objectContaining({ name: "MainController" }),
      );
      expect(listEdges(graph, { kind: "main_scene" })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            target: "scene:res://scenes/fixture_main.tscn",
            provenance: "resolver",
          }),
        ]),
      );
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
      expect(searchNodes(graph, "FixtureActor").map((node) => node.id)).toContain(
        "script:res://scripts/actors/fixture_actor.gd",
      );
    } finally {
      graph.close();
    }
  });

  it("writes core graph records for the minimal fixture", () => {
    const root = copyFixture("minimal");
    const result = indexGodotProject(root);
    expect(result.ok).toBe(true);

    const graph = createGraphDatabase(root);
    try {
      expect(getNode(graph, "project")).toEqual(expect.objectContaining({ kind: "project" }));
      expect(getNode(graph, "scene:res://fixture_main.tscn")).toEqual(
        expect.objectContaining({ kind: "scene" }),
      );
      expect(getNode(graph, "scene_node:res://fixture_main.tscn:FixtureActor")).toEqual(
        expect.objectContaining({ kind: "scene_node" }),
      );
      expect(getNode(graph, "script:res://scripts/fixture_actor.gd")).toEqual(
        expect.objectContaining({
          kind: "script_class",
          addressKind: "indexed_symbol",
          ownerPath: "res://scripts/fixture_actor.gd",
          readablePath: "res://scripts/fixture_actor.gd",
          displayPath: "res://scripts/fixture_actor.gd",
          referencePath: null,
        }),
      );
      expect(getNode(graph, "method:res://scripts/fixture_actor.gd:_ready")).toEqual(
        expect.objectContaining({ kind: "method" }),
      );
      expect(searchNodes(graph, "FixtureActor").map((node) => node.id)).toEqual(
        expect.arrayContaining(["script:res://scripts/fixture_actor.gd"]),
      );
    } finally {
      graph.close();
    }
  });

  it("stores index metadata as a project snapshot, not authoritative counts", () => {
    const root = copyFixture("minimal");
    const result = indexGodotProject(root);
    expect(result.ok).toBe(true);

    const graph = createGraphDatabase(root);
    try {
      const metadata = getProjectMetadata(graph, "index");
      expect(metadata?.value).toEqual({
        project: expect.objectContaining({
          name: "MinimalFixture",
          mainScene: "res://fixture_main.tscn",
        }),
      });
    } finally {
      graph.close();
    }
  });

  it("writes scene composition edges", () => {
    const root = copyFixture("scene-composition");
    indexGodotProject(root);

    const graph = createGraphDatabase(root);
    try {
      expect(listEdges(graph, { kind: "attaches_script" })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "scene_node:res://scenes/fixture_main.tscn:Main",
            target: "resource:res://scripts/game_controller.gd",
            provenance: "resource-parser",
          }),
          expect.objectContaining({
            source: "scene_node:res://scenes/fixture_main.tscn:Main",
            target: "script:res://scripts/game_controller.gd",
            provenance: "resolver",
          }),
          expect.objectContaining({
            source: "scene_node:res://scenes/fixture_actor.tscn:FixtureActor",
            target: "resource:res://scripts/fixture_actor.gd",
            provenance: "resource-parser",
          }),
          expect.objectContaining({
            source: "scene_node:res://scenes/fixture_actor.tscn:FixtureActor",
            target: "script:res://scripts/fixture_actor.gd",
            provenance: "resolver",
          }),
        ]),
      );
      expect(listEdges(graph, { kind: "instantiates_scene" })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "scene_node:res://scenes/fixture_main.tscn:FixtureActor",
            target: "resource:res://scenes/fixture_actor.tscn",
            provenance: "resource-parser",
          }),
          expect.objectContaining({
            source: "scene_node:res://scenes/fixture_main.tscn:FixtureActor",
            target: "scene:res://scenes/fixture_actor.tscn",
            provenance: "resolver",
          }),
        ]),
      );
    } finally {
      graph.close();
    }
  });

  it("keeps only unresolved signal and resource references after resolution", () => {
    const signalsRoot = copyFixture("signals");
    indexGodotProject(signalsRoot);
    const signalsGraph = createGraphDatabase(signalsRoot);
    try {
      expect(getNode(signalsGraph, "signal:res://scripts/signal_demo.gd:health_depleted")).toEqual(
        expect.objectContaining({ kind: "signal" }),
      );
      expect(listEdges(signalsGraph, { kind: "connects_signal" })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "scene_node:res://fixture_main.tscn:StartButton",
            target: "method:res://scripts/signal_demo.gd:_on_start_button_pressed",
            provenance: "resolver",
          }),
        ]),
      );
      expect(listUnresolvedRefs(signalsGraph)).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            referenceName: "_on_start_button_pressed",
            referenceKind: "editor_signal_connection",
          }),
        ]),
      );
    } finally {
      signalsGraph.close();
    }

    const resourcesRoot = copyFixture("resources");
    indexGodotProject(resourcesRoot);
    const resourcesGraph = createGraphDatabase(resourcesRoot);
    try {
      expect(getNode(resourcesGraph, "resource:res://resources/fixture_stats.tres")).toEqual(
        expect.objectContaining({ kind: "resource" }),
      );
      expect(listEdges(resourcesGraph, { kind: "preloads_resource" })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "script:res://scripts/resource_user.gd",
            target: "resource:res://resources/fixture_stats.tres",
            provenance: "resolver",
          }),
        ]),
      );
      expect(listEdges(resourcesGraph, { kind: "loads_resource" })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "method:res://scripts/resource_user.gd:load_runtime_stats",
            target: "resource:res://resources/fixture_stats.tres",
            provenance: "resolver",
          }),
        ]),
      );
      expect(listUnresolvedRefs(resourcesGraph)).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            referenceName: "res://resources/fixture_stats.tres",
          }),
        ]),
      );
    } finally {
      resourcesGraph.close();
    }
  });

  it("indexes resource address roles at construction time", () => {
    const root = copyFixture("resource-addresses");
    const result = indexGodotProject(root);
    expect(result.ok).toBe(true);

    const graph = createGraphDatabase(root);
    try {
      expect(getNode(graph, "resource:res://resources/fixture_profile.tres")).toEqual(
        expect.objectContaining({
          addressKind: "resource_main",
          filePath: "res://resources/fixture_profile.tres",
          readablePath: "res://resources/fixture_profile.tres",
          displayPath: "res://resources/fixture_profile.tres",
          referencePath: null,
        }),
      );
      expect(getNode(graph, "resource:res://scenes/fixture_main.tscn#SceneSub")).toEqual(
        expect.objectContaining({
          addressKind: "resource_subresource",
          ownerPath: "res://scenes/fixture_main.tscn",
          readablePath: null,
          displayPath: "res://scenes/fixture_main.tscn",
          referencePath: null,
        }),
      );

      const missingRef = getNode(graph, "resource:res://missing/fixture_missing_data.tres");
      expect(missingRef).toEqual(
        expect.objectContaining({
          addressKind: "resource_missing_ref",
          filePath: null,
          ownerPath: null,
          readablePath: null,
          displayPath: "res://missing/fixture_missing_data.tres",
          referencePath: "res://missing/fixture_missing_data.tres",
        }),
      );
      const oldMissingPathField = ["missing", "File", "Path"].join("");
      expect(missingRef?.metadata).not.toHaveProperty(oldMissingPathField);

      expect(getNode(graph, "resource:res://scripts/fixture_resource_data.gd")).toEqual(
        expect.objectContaining({
          addressKind: "resource_external_ref",
          referencePath: "res://scripts/fixture_resource_data.gd",
        }),
      );
      expect(listEdges(graph, { kind: "attaches_script" })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "resource:res://resources/fixture_profile.tres",
            target: "script:res://scripts/fixture_resource_data.gd",
            provenance: "resolver",
          }),
        ]),
      );
    } finally {
      graph.close();
    }
  });

  it("keeps only real project autoload names as autoload references", () => {
    const root = copyFixture("autoload-input");
    appendFileSync(
      join(root, "scripts", "fixture_input.gd"),
      "\nfunc _debug_result() -> void:\n\tActionResult.ok()\n",
    );

    indexGodotProject(root);
    const graph = createGraphDatabase(root);
    try {
      const autoloadEdges = listEdges(graph, { kind: "uses_autoload" })
        .map((edge) => [edge.source, edge.target])
        .sort();
      const nodePathRefs = listUnresolvedRefs(graph)
        .filter((ref) => ref.referenceKind === "references_nodepath")
        .map((ref) => ref.referenceName)
        .sort();

      expect(autoloadEdges).toEqual(
        expect.arrayContaining([
          ["method:res://scripts/fixture_input.gd:_process", "autoload:FixtureState"],
          ["method:res://scripts/fixture_input.gd:_process", "autoload:FixtureSaveService"],
        ]),
      );
      expect(autoloadEdges.map(([, target]) => target).sort()).toEqual(
        expect.arrayContaining(["autoload:FixtureState", "autoload:FixtureSaveService"]),
      );
      expect(autoloadEdges.map(([, target]) => target)).not.toContain("autoload:ActionResult");
      expect(listUnresolvedRefs(graph).filter((ref) => ref.referenceKind === "uses_autoload")).toEqual([]);
      expect(nodePathRefs).not.toEqual(expect.arrayContaining(["/root/FixtureState", "FixtureState"]));
    } finally {
      graph.close();
    }
  });
});
