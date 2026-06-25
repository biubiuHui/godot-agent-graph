import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildQueryPlan } from "../../../src/context/query-plan.js";
import { collectCandidatePools } from "../../../src/context/candidate-pools.js";
import { createGraphDatabase, type GraphDatabase } from "../../../src/db/index.js";
import { upsertFile, upsertNode } from "../../../src/db/queries.js";
import type { GraphFile, GraphNode, NodeKind } from "../../../src/types.js";

const tempRoots: string[] = [];

function createTempGraph(): GraphDatabase {
  const root = mkdtempSync(join(tmpdir(), "gdgraph-candidate-pools-"));
  tempRoots.push(root);
  return createGraphDatabase(root);
}

function addFile(graph: GraphDatabase, path: string, kind: GraphFile["kind"] = "gdscript"): void {
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
  qualifiedName: string,
  filePath: string,
  metadata: GraphNode["metadata"] = {},
  overrides: Partial<GraphNode> = {},
): void {
  upsertNode(graph, {
    id,
    kind,
    name,
    qualifiedName,
    filePath,
    addressKind: "indexed_symbol",
    ownerPath: filePath,
    readablePath: filePath,
    displayPath: filePath,
    referencePath: null,
    startLine: 1,
    endLine: 1,
    signature: kind,
    metadata,
    updatedAt: 1,
    ...overrides,
  });
}

function addResource(graph: GraphDatabase, path: string, properties: Record<string, unknown>): void {
  addFile(graph, path, "resource");
  addNode(
    graph,
    `resource:${path}`,
    "resource",
    path.split("/").at(-1) ?? path,
    path,
    path,
    {
      properties,
      type: "FixtureItemData",
    },
    {
      addressKind: "resource_main",
      ownerPath: path,
      readablePath: path,
      displayPath: path,
      referencePath: null,
    },
  );
}

function addProperty(graph: GraphDatabase, path: string, owner: string, name: string): void {
  addFile(graph, path);
  addNode(graph, `script:${path}`, "script_class", owner, owner, path);
  addNode(graph, `property:${path}:${name}`, "property", name, `${owner}.${name}`, path);
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("context candidate pools", () => {
  it("recalls resource directory candidates separately from matching text symbols", () => {
    const graph = createTempGraph();
    try {
      addResource(graph, "res://resources/items/fixture_item_alpha.tres", {
        display_name: "Amber cobalt sample",
        description: "Quartz signal effect",
      });
      addResource(graph, "res://resources/items/fixture_item_beta.tres", {
        display_name: "Silver basalt sample",
        description: "Copper resin effect",
      });
      addProperty(graph, "res://topics/fixture_topic.gd", "FixtureTopicData", "display_text");
      addProperty(graph, "res://ui/fixture_text_panel.gd", "FixtureTextPanel", "rule_text");

      const plan = buildQueryPlan(
        "FixtureItemData display_text rule_text resources/items fixture item amber cobalt quartz",
      );
      const pools = collectCandidatePools(graph, plan);

      expect(pools.resourcePath.map((node) => node.filePath)).toEqual(
        expect.arrayContaining([
          "res://resources/items/fixture_item_alpha.tres",
          "res://resources/items/fixture_item_beta.tres",
        ]),
      );
      expect(pools.symbolText.map((node) => node.filePath)).toEqual(
        expect.arrayContaining([
          "res://topics/fixture_topic.gd",
          "res://ui/fixture_text_panel.gd",
        ]),
      );
    } finally {
      graph.close();
    }
  });

  it("recalls exact resource path candidates with same-file subresources", () => {
    const graph = createTempGraph();
    try {
      const resourcePath = "res://resources/pools/fixture_pool_primary.tres";
      addResource(graph, resourcePath, {
        entry_type: "FixturePoolEntryData",
      });
      addNode(
        graph,
        `${resourcePath}#FixturePoolEntry_0`,
        "resource",
        "FixturePoolEntry_0",
        `${resourcePath}#FixturePoolEntry_0`,
        resourcePath,
        {
          properties: {
            payload_id: "sample_payload",
            base_weight: 2,
          },
          type: "FixturePoolEntryData",
        },
        {
          addressKind: "resource_subresource",
          ownerPath: resourcePath,
          readablePath: null,
          displayPath: resourcePath,
          referencePath: null,
        },
      );
      addResource(graph, "res://resources/pools/fixture_pool_secondary.tres", {
        entry_type: "FixturePoolEntryData",
      });

      const plan = buildQueryPlan(
        `${resourcePath} payload_id base_weight FixturePoolEntryData`,
      );
      const pools = collectCandidatePools(graph, plan);

      expect(pools.exactPath.map((node) => node.id)).toEqual(
        expect.arrayContaining([
          `resource:${resourcePath}`,
          `${resourcePath}#FixturePoolEntry_0`,
        ]),
      );
      expect(pools.exactPath.map((node) => node.filePath)).not.toContain(
        "res://resources/pools/fixture_pool_secondary.tres",
      );
    } finally {
      graph.close();
    }
  });

  it("keeps resource-only pools empty for symbol queries without resource anchors", () => {
    const graph = createTempGraph();
    try {
      addFile(graph, "res://scripts/fixture_actor.gd");
      addNode(
        graph,
        "script:res://scripts/fixture_actor.gd",
        "script_class",
        "FixtureActor",
        "FixtureActor",
        "res://scripts/fixture_actor.gd",
      );
      addNode(
        graph,
        "method:res://scripts/fixture_actor.gd:apply_damage",
        "method",
        "apply_damage",
        "FixtureActor.apply_damage",
        "res://scripts/fixture_actor.gd",
      );
      addResource(graph, "res://resources/fixture_stats.tres", {
        display_name: "Sample Stats",
      });

      const plan = buildQueryPlan("FixtureActor apply_damage");
      const pools = collectCandidatePools(graph, plan);

      expect(plan.strategy).toBe("symbol-first");
      expect(pools.exactPath).toEqual([]);
      expect(pools.resourcePath).toEqual([]);
      expect(pools.resourceMetadata).toEqual([]);
      expect(pools.symbolExact.map((node) => node.id)).toEqual(
        expect.arrayContaining([
          "script:res://scripts/fixture_actor.gd",
          "method:res://scripts/fixture_actor.gd:apply_damage",
        ]),
      );
    } finally {
      graph.close();
    }
  });
});
