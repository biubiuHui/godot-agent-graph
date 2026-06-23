import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createGraphDatabase } from "../../../src/db/index.js";
import {
  deleteUnresolvedRefs,
  getFile,
  getNode,
  getProjectMetadata,
  insertEdge,
  insertUnresolvedRef,
  listEdges,
  listUnresolvedRefs,
  markUnresolvedRefsResolved,
  searchNodes,
  upsertFile,
  upsertNode,
  upsertProjectMetadata,
} from "../../../src/db/queries.js";
import type { GraphEdge, GraphFile, GraphNode, UnresolvedRef } from "../../../src/types.js";

const tempRoots: string[] = [];

function createTempProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "gdgraph-queries-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("graph storage queries", () => {
  it("stores and retrieves files, nodes, edges, metadata, unresolved refs, and FTS results", () => {
    const graph = createGraphDatabase(createTempProjectRoot());

    try {
      const file: GraphFile = {
        path: "res://scripts/fixture_actor.gd",
        kind: "gdscript",
        contentHash: "abc123",
        size: 42,
        modifiedAt: 1000,
        indexedAt: 2000,
        nodeCount: 2,
        parseErrors: [],
      };

      upsertFile(graph, file);
      expect(getFile(graph, file.path)).toEqual(file);

      const scriptNode: GraphNode = {
        id: "node:player",
        kind: "script_class",
        name: "FixtureActor",
        qualifiedName: "FixtureActor",
        filePath: file.path,
        startLine: 1,
        endLine: 20,
        signature: "class_name FixtureActor",
        metadata: { exported: true },
        updatedAt: 3000,
      };

      const methodNode: GraphNode = {
        id: "node:player:ready",
        kind: "method",
        name: "_ready",
        qualifiedName: "FixtureActor._ready",
        filePath: file.path,
        startLine: 5,
        endLine: 8,
        signature: "func _ready()",
        metadata: {},
        updatedAt: 3001,
      };

      const rawScriptResourceNode: GraphNode = {
        id: "resource:res://scripts/fixture_actor.gd",
        kind: "resource",
        name: "fixture_actor.gd",
        qualifiedName: "res://scripts/fixture_actor.gd",
        filePath: file.path,
        startLine: 1,
        endLine: null,
        signature: "Script",
        metadata: {},
        updatedAt: 3002,
      };

      upsertNode(graph, scriptNode);
      upsertNode(graph, methodNode);
      upsertNode(graph, rawScriptResourceNode);

      expect(getNode(graph, scriptNode.id)).toEqual(scriptNode);
      expect(searchNodes(graph, "FixtureActor")).toEqual([scriptNode, methodNode]);
      expect(searchNodes(graph, "fixture_actor.gd").map((node) => node.id)).toEqual([
        scriptNode.id,
        methodNode.id,
      ]);
      expect(searchNodes(graph, "res://scripts/fixture_actor.gd").map((node) => node.id)).toEqual([
        scriptNode.id,
        methodNode.id,
      ]);

      const fixtureStatsNode: GraphNode = {
        id: "resource:res://resources/fixture_stats.tres",
        kind: "resource",
        name: "fixture_stats.tres",
        qualifiedName: "res://resources/fixture_stats.tres",
        filePath: null,
        startLine: 1,
        endLine: null,
        signature: "Resource",
        metadata: {},
        updatedAt: 3003,
      };
      upsertNode(graph, fixtureStatsNode);

      expect(searchNodes(graph, "FixtureActor fixture_stats").map((node) => node.id)).toEqual([
        scriptNode.id,
        methodNode.id,
        fixtureStatsNode.id,
      ]);

      const edge: GraphEdge = {
        source: scriptNode.id,
        target: methodNode.id,
        kind: "contains",
        line: 5,
        column: 1,
        provenance: "tree-sitter",
        metadata: { reason: "method belongs to class" },
      };

      const edgeId = insertEdge(graph, edge);
      expect(listEdges(graph, { source: scriptNode.id })).toEqual([{ ...edge, id: edgeId }]);

      upsertProjectMetadata(graph, {
        key: "project",
        value: { name: "Fixture", mainScene: "res://fixture_main.tscn" },
        updatedAt: 4000,
      });

      expect(getProjectMetadata(graph, "project")).toEqual({
        key: "project",
        value: { name: "Fixture", mainScene: "res://fixture_main.tscn" },
        updatedAt: 4000,
      });

      const unresolvedRef: UnresolvedRef = {
        fromNodeId: methodNode.id,
        referenceName: "FixtureState",
        referenceKind: "autoload",
        filePath: file.path,
        line: 6,
        column: 3,
        candidates: [{ name: "FixtureState" }],
      };

      const unresolvedId = insertUnresolvedRef(graph, unresolvedRef);
      expect(listUnresolvedRefs(graph, { filePath: file.path })).toEqual([
        { ...unresolvedRef, id: unresolvedId },
      ]);

      deleteUnresolvedRefs(graph, [unresolvedId]);
      expect(listUnresolvedRefs(graph, { filePath: file.path })).toEqual([]);
    } finally {
      graph.close();
    }
  });

  it("finds resource nodes by metadata field names and string values", () => {
    const graph = createGraphDatabase(createTempProjectRoot());

    try {
      const file: GraphFile = {
        path: "res://resources/artifacts/artifact_001.tres",
        kind: "resource",
        contentHash: "artifact",
        size: 42,
        modifiedAt: 1000,
        indexedAt: 2000,
        nodeCount: 1,
        parseErrors: [],
      };
      upsertFile(graph, file);

      const resourceNode: GraphNode = {
        id: "resource:res://resources/artifacts/artifact_001.tres",
        kind: "resource",
        name: "artifact_001.tres",
        qualifiedName: "res://resources/artifacts/artifact_001.tres",
        filePath: file.path,
        startLine: 1,
        endLine: null,
        signature: "Resource",
        metadata: {
          properties: {
            display_label: "Crystal Ember",
            rules_text: "Cobalt lantern resonance",
          },
        },
        updatedAt: 3000,
      };
      upsertNode(graph, resourceNode);

      expect(searchNodes(graph, "cobalt lantern").map((node) => node.id)).toEqual([
        resourceNode.id,
      ]);
      expect(searchNodes(graph, "display_label").map((node) => node.id)).toEqual([
        resourceNode.id,
      ]);
    } finally {
      graph.close();
    }
  });

  it("hides resolved refs by default while retaining them for resolver passes", () => {
    const graph = createGraphDatabase(createTempProjectRoot());

    try {
      const file: GraphFile = {
        path: "res://scripts/reference_source.gd",
        kind: "gdscript",
        contentHash: "abc123",
        size: 42,
        modifiedAt: 1000,
        indexedAt: 2000,
        nodeCount: 1,
        parseErrors: [],
      };
      upsertFile(graph, file);

      const methodNode: GraphNode = {
        id: "method:res://scripts/reference_source.gd:_ready",
        kind: "method",
        name: "_ready",
        qualifiedName: "ReferenceSource._ready",
        filePath: file.path,
        startLine: 5,
        endLine: 8,
        signature: "func _ready()",
        metadata: {},
        updatedAt: 3001,
      };
      upsertNode(graph, methodNode);

      const ref: UnresolvedRef = {
        fromNodeId: methodNode.id,
        referenceName: "create",
        referenceKind: "calls",
        filePath: file.path,
        line: 6,
        column: 3,
        candidates: [{ receiver: "ReferenceTarget" }],
      };

      const refId = insertUnresolvedRef(graph, ref);
      markUnresolvedRefsResolved(graph, [refId]);

      expect(listUnresolvedRefs(graph)).toEqual([]);
      expect(listUnresolvedRefs(graph, { includeResolved: true })).toEqual([
        { ...ref, id: refId, resolved: true },
      ]);
    } finally {
      graph.close();
    }
  });

  it("preserves exact symbols in long natural-language queries", () => {
    const graph = createGraphDatabase(createTempProjectRoot());

    try {
      function insertScriptClass(name: string, path: string): void {
        upsertFile(graph, {
          path,
          kind: "gdscript",
          contentHash: path,
          size: 1,
          modifiedAt: 1,
          indexedAt: 1,
          nodeCount: 1,
          parseErrors: [],
        });
        upsertNode(graph, {
          id: `script:${path}`,
          kind: "script_class",
          name,
          qualifiedName: name,
          filePath: path,
          startLine: 1,
          endLine: null,
          signature: `class_name ${name}`,
          metadata: {},
          updatedAt: 1,
        });
      }

      for (let index = 0; index < 14; index += 1) {
        insertScriptClass(`ModuleNoise${index}`, `res://scripts/module_noise_${index}.gd`);
      }
      insertScriptClass("ExactAlphaController", "res://scripts/exact_alpha_controller.gd");
      insertScriptClass("ExactBetaTimeline", "res://scripts/exact_beta_timeline.gd");
      insertScriptClass("ExactActionPanel", "res://scripts/exact_action_panel.gd");
      insertScriptClass("ExactMainScreen", "res://scripts/exact_main_screen.gd");

      const results = searchNodes(
        graph,
        "Module 6 broad fixture event flow ExactAlphaController ExactBetaTimeline ExactActionPanel ExactMainScreen",
        10,
      );
      const resultNames = results.map((node) => node.name);
      const firstNoiseIndex = resultNames.findIndex((name) => name.startsWith("ModuleNoise"));

      expect(resultNames).toEqual(
        expect.arrayContaining([
          "ExactAlphaController",
          "ExactBetaTimeline",
          "ExactActionPanel",
          "ExactMainScreen",
        ]),
      );
      expect(firstNoiseIndex).toBeGreaterThanOrEqual(0);
      for (const exactName of [
        "ExactAlphaController",
        "ExactBetaTimeline",
        "ExactActionPanel",
        "ExactMainScreen",
      ]) {
        expect(resultNames.indexOf(exactName)).toBeLessThan(firstNoiseIndex);
      }
    } finally {
      graph.close();
    }
  });
});
