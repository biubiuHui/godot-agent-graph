import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createGraphDatabase, type GraphDatabase } from "../../../src/db/index.js";
import {
  insertEdge,
  upsertFile,
  upsertNode,
} from "../../../src/db/queries.js";
import { getImpactContext } from "../../../src/graph/impact.js";
import { indexGodotProject } from "../../../src/indexer/indexer.js";
import type { EdgeKind, FileKind, GraphNode, NodeKind } from "../../../src/types.js";

const fixturesRoot = fileURLToPath(new URL("../../fixtures/godot", import.meta.url));
const tempRoots: string[] = [];

function indexedFixture(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `gdgraph-impact-${name}-`));
  tempRoots.push(root);
  cpSync(join(fixturesRoot, name), root, { recursive: true });
  const result = indexGodotProject(root);
  expect(result.ok).toBe(true);
  return root;
}

function createTempGraph(): GraphDatabase {
  const root = mkdtempSync(join(tmpdir(), "gdgraph-impact-manual-"));
  tempRoots.push(root);
  return createGraphDatabase(root);
}

function addFile(graph: GraphDatabase, path: string, kind: FileKind): void {
  upsertFile(graph, {
    path,
    kind,
    contentHash: path,
    size: 1,
    modifiedAt: 1,
    indexedAt: 1,
    nodeCount: 1,
    parseErrors: [],
  });
}

function addNode(
  graph: GraphDatabase,
  id: string,
  kind: NodeKind,
  name: string,
  filePath: string,
): void {
  const node: GraphNode = {
    id,
    kind,
    name,
    qualifiedName: filePath,
    filePath,
    startLine: 1,
    endLine: 1,
    signature: kind,
    metadata: {},
    updatedAt: 1,
  };
  upsertNode(graph, node);
}

function addEdge(graph: GraphDatabase, source: string, kind: EdgeKind, target: string): void {
  insertEdge(graph, {
    source,
    target,
    kind,
    line: 1,
    column: 1,
    provenance: "resolver",
    metadata: {},
  });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("impact context", () => {
  it("returns affected scene and check files for a script path", () => {
    const graph = createGraphDatabase(indexedFixture("minimal"));
    try {
      const impact = getImpactContext(graph, "res://scripts/fixture_actor.gd");

      expect(impact.target).toEqual(expect.objectContaining({ id: "script:res://scripts/fixture_actor.gd" }));
      expect(impact.target).not.toHaveProperty("metadata");
      expect(impact.target).not.toHaveProperty("updatedAt");
      expect(impact.affectedScenes).toEqual([
        expect.objectContaining({ id: "scene:res://fixture_main.tscn" }),
      ]);
      expect(impact.affectedScenes[0]).not.toHaveProperty("metadata");
      expect(impact.affectedScenes[0]).not.toHaveProperty("updatedAt");
      expect(impact.affectedScripts.map((node) => node.id)).not.toContain(
        "script:res://scripts/fixture_actor.gd",
      );
      expect(impact.recommendedCheckFiles).toEqual(expect.arrayContaining([
        "res://fixture_main.tscn",
        "res://scripts/fixture_actor.gd",
      ]));
      expect(impact.relationships).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            "scene_node:res://fixture_main.tscn:FixtureActor attaches_script script:res://scripts/fixture_actor.gd",
          ),
        ]),
      );
      expect(impact.relationships).not.toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            "scene_node:res://fixture_main.tscn:FixtureActor attaches_script resource:res://scripts/fixture_actor.gd",
          ),
        ]),
      );
      expect(impact.relationships).not.toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            "scene:res://fixture_main.tscn loads_resource resource:res://scripts/fixture_actor.gd",
          ),
        ]),
      );
    } finally {
      graph.close();
    }
  });

  it("does not fan out from a resource target through its script class to peer resources", () => {
    const graph = createTempGraph();
    try {
      addFile(graph, "res://items/target.tres", "resource");
      addFile(graph, "res://items/peer.tres", "resource");
      addFile(graph, "res://scripts/fixture_item.gd", "gdscript");
      addNode(
        graph,
        "resource:res://items/target.tres",
        "resource",
        "target.tres",
        "res://items/target.tres",
      );
      addNode(
        graph,
        "resource:res://items/peer.tres",
        "resource",
        "peer.tres",
        "res://items/peer.tres",
      );
      addNode(
        graph,
        "script:res://scripts/fixture_item.gd",
        "script_class",
        "FixtureItem",
        "res://scripts/fixture_item.gd",
      );
      addEdge(
        graph,
        "resource:res://items/target.tres",
        "attaches_script",
        "script:res://scripts/fixture_item.gd",
      );
      addEdge(
        graph,
        "resource:res://items/peer.tres",
        "attaches_script",
        "script:res://scripts/fixture_item.gd",
      );

      const impact = getImpactContext(graph, "res://items/target.tres");

      expect(impact.relationships).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            "resource:res://items/target.tres attaches_script script:res://scripts/fixture_item.gd",
          ),
        ]),
      );
      expect(impact.relationships).not.toEqual(
        expect.arrayContaining([
          expect.stringContaining("resource:res://items/peer.tres attaches_script"),
        ]),
      );
      expect(impact.affectedResources.map((node) => node.id)).not.toContain(
        "resource:res://items/peer.tres",
      );
      expect(impact.affectedResources.map((node) => node.id)).not.toContain(
        "resource:res://items/target.tres",
      );
      expect(impact.recommendedCheckFiles).not.toContain("res://items/peer.tres");
    } finally {
      graph.close();
    }
  });

  it("does not fan out from a scene node target through its container scene resources", () => {
    const graph = createTempGraph();
    try {
      addFile(graph, "res://fixture_main.tscn", "scene");
      addFile(graph, "res://theme.tres", "resource");
      addNode(graph, "scene:res://fixture_main.tscn", "scene", "fixture_main.tscn", "res://fixture_main.tscn");
      addNode(graph, "scene_node:res://fixture_main.tscn:Panel", "scene_node", "Panel", "res://fixture_main.tscn");
      addNode(graph, "resource:res://theme.tres", "resource", "theme.tres", "res://theme.tres");
      addEdge(graph, "scene:res://fixture_main.tscn", "contains", "scene_node:res://fixture_main.tscn:Panel");
      addEdge(graph, "scene:res://fixture_main.tscn", "loads_resource", "resource:res://theme.tres");

      const impact = getImpactContext(graph, "scene_node:res://fixture_main.tscn:Panel");

      expect(impact.affectedScenes.map((node) => node.id)).toContain("scene:res://fixture_main.tscn");
      expect(impact.affectedResources.map((node) => node.id)).not.toContain("resource:res://theme.tres");
      expect(impact.relationships).not.toEqual(
        expect.arrayContaining([
          expect.stringContaining("scene:res://fixture_main.tscn loads_resource resource:res://theme.tres"),
        ]),
      );
    } finally {
      graph.close();
    }
  });

  it("returns signal-related relationships for a signal name", () => {
    const graph = createGraphDatabase(indexedFixture("signals"));
    try {
      const impact = getImpactContext(graph, "health_depleted");

      expect(impact.target).toEqual(
        expect.objectContaining({ id: "signal:res://scripts/signal_demo.gd:health_depleted" }),
      );
      expect(impact.relationships).toEqual(
        expect.arrayContaining([
          expect.stringContaining("emits_signal"),
          expect.stringContaining("connects_signal"),
        ]),
      );
      expect(impact.recommendedCheckFiles).toEqual(
        expect.arrayContaining(["res://scripts/signal_demo.gd", "res://fixture_main.tscn"]),
      );
    } finally {
      graph.close();
    }
  });

  it("omits unrelated second-hop branches from script impact", () => {
    const graph = createTempGraph();
    try {
      addFile(graph, "res://scripts/target_service.gd", "gdscript");
      addFile(graph, "res://scripts/direct_panel.gd", "gdscript");
      addFile(graph, "res://scripts/unrelated_service.gd", "gdscript");
      addNode(
        graph,
        "script:res://scripts/target_service.gd",
        "script_class",
        "TargetService",
        "res://scripts/target_service.gd",
      );
      addNode(
        graph,
        "method:res://scripts/target_service.gd:target_method",
        "method",
        "target_method",
        "res://scripts/target_service.gd",
      );
      addNode(
        graph,
        "script:res://scripts/direct_panel.gd",
        "script_class",
        "DirectPanel",
        "res://scripts/direct_panel.gd",
      );
      addNode(
        graph,
        "method:res://scripts/direct_panel.gd:call_target",
        "method",
        "call_target",
        "res://scripts/direct_panel.gd",
      );
      addNode(
        graph,
        "method:res://scripts/direct_panel.gd:unrelated_branch",
        "method",
        "unrelated_branch",
        "res://scripts/direct_panel.gd",
      );
      addNode(
        graph,
        "script:res://scripts/unrelated_service.gd",
        "script_class",
        "UnrelatedService",
        "res://scripts/unrelated_service.gd",
      );
      addNode(
        graph,
        "method:res://scripts/unrelated_service.gd:unrelated_method",
        "method",
        "unrelated_method",
        "res://scripts/unrelated_service.gd",
      );
      addEdge(
        graph,
        "script:res://scripts/target_service.gd",
        "contains",
        "method:res://scripts/target_service.gd:target_method",
      );
      addEdge(
        graph,
        "script:res://scripts/direct_panel.gd",
        "contains",
        "method:res://scripts/direct_panel.gd:call_target",
      );
      addEdge(
        graph,
        "script:res://scripts/direct_panel.gd",
        "contains",
        "method:res://scripts/direct_panel.gd:unrelated_branch",
      );
      addEdge(
        graph,
        "method:res://scripts/direct_panel.gd:call_target",
        "calls",
        "method:res://scripts/target_service.gd:target_method",
      );
      addEdge(
        graph,
        "method:res://scripts/direct_panel.gd:unrelated_branch",
        "calls",
        "method:res://scripts/unrelated_service.gd:unrelated_method",
      );
      addEdge(
        graph,
        "script:res://scripts/unrelated_service.gd",
        "contains",
        "method:res://scripts/unrelated_service.gd:unrelated_method",
      );

      const impact = getImpactContext(graph, "target_method");

      expect(impact.relationships).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            "method:res://scripts/direct_panel.gd:call_target calls method:res://scripts/target_service.gd:target_method",
          ),
        ]),
      );
      expect(impact.relationships).not.toEqual(
        expect.arrayContaining([
          expect.stringContaining("method:res://scripts/direct_panel.gd:unrelated_branch"),
        ]),
      );
      expect(impact.recommendedCheckFiles).toEqual(
        expect.arrayContaining([
          "res://scripts/target_service.gd",
          "res://scripts/direct_panel.gd",
        ]),
      );
      expect(impact.recommendedCheckFiles).not.toContain("res://scripts/unrelated_service.gd");
      expect(impact.omitted.relationships).toBeGreaterThan(0);
    } finally {
      graph.close();
    }
  });
});
