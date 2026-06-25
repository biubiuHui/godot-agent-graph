import { describe, expect, it } from "vitest";

import { buildQueryPlan } from "../../../src/context/query-plan.js";
import { selectRankedSeeds } from "../../../src/context/ranked-selection.js";
import type { ContextCandidatePools } from "../../../src/context/candidate-pools.js";
import type { GraphSnapshot } from "../../../src/graph/traversal.js";
import type { EdgeKind, GraphNode, NodeKind } from "../../../src/types.js";

function makeNode(
  id: string,
  kind: NodeKind,
  name: string,
  filePath: string,
  overrides: Partial<GraphNode> = {},
): GraphNode {
  return {
    id,
    kind,
    name,
    qualifiedName: kind === "resource" ? filePath : name,
    filePath,
    addressKind: kind === "resource" ? "resource_main" : "indexed_symbol",
    ownerPath: filePath,
    readablePath: filePath,
    displayPath: filePath,
    referencePath: null,
    startLine: 1,
    endLine: 1,
    signature: kind,
    metadata: {},
    updatedAt: 1,
    ...overrides,
  };
}

function emptyPools(overrides: Partial<ContextCandidatePools> = {}): ContextCandidatePools {
  return {
    exactPath: [],
    resourcePath: [],
    resourceMetadata: [],
    symbolExact: [],
    symbolText: [],
    relationship: [],
    fallbackText: [],
    ...overrides,
  };
}

function snapshot(nodes: GraphNode[], edges: Array<{ source: string; target: string; kind?: EdgeKind }>): GraphSnapshot {
  return {
    nodes,
    edges: edges.map((edge, index) => ({
      id: index + 1,
      source: edge.source,
      target: edge.target,
      kind: edge.kind ?? "references_symbol",
      line: 1,
      column: 1,
      provenance: "resolver",
      metadata: {},
    })),
    unresolvedRefs: [],
  };
}

describe("ranked context seed selection", () => {
  it("selects resource files before topic ui and test symbols for broad resource queries", () => {
    const plan = buildQueryPlan(
      "FixtureItemData display_text rule_text resources/items fixture item amber cobalt quartz",
    );
    const resourceAlpha = makeNode(
      "resource:res://resources/items/fixture_item_alpha.tres",
      "resource",
      "fixture_item_alpha.tres",
      "res://resources/items/fixture_item_alpha.tres",
    );
    const resourceBeta = makeNode(
      "resource:res://resources/items/fixture_item_beta.tres",
      "resource",
      "fixture_item_beta.tres",
      "res://resources/items/fixture_item_beta.tres",
    );
    const resourceGamma = makeNode(
      "resource:res://resources/items/fixture_item_gamma.tres",
      "resource",
      "fixture_item_gamma.tres",
      "res://resources/items/fixture_item_gamma.tres",
    );
    const topicSymbol = makeNode(
      "property:res://topics/fixture_topic.gd:display_text",
      "property",
      "display_text",
      "res://topics/fixture_topic.gd",
    );
    const uiSymbol = makeNode(
      "property:res://ui/fixture_text_panel.gd:rule_text",
      "property",
      "rule_text",
      "res://ui/fixture_text_panel.gd",
    );
    const testSymbol = makeNode(
      "script:res://tests/fixture_resource_test.gd",
      "script_class",
      "FixtureResourceTest",
      "res://tests/fixture_resource_test.gd",
    );

    const selection = selectRankedSeeds(
      plan,
      emptyPools({
        resourcePath: [resourceAlpha, resourceBeta, resourceGamma],
        symbolText: [topicSymbol, uiSymbol, testSymbol],
      }),
      null,
    );

    expect(selection.strategy).toBe("resource-first");
    expect(selection.seeds.slice(0, 3).map((node) => node.filePath)).toEqual([
      "res://resources/items/fixture_item_alpha.tres",
      "res://resources/items/fixture_item_beta.tres",
      "res://resources/items/fixture_item_gamma.tres",
    ]);
    expect(selection.seeds.slice(0, 3).map((node) => node.filePath)).not.toEqual(
      expect.arrayContaining([
        "res://topics/fixture_topic.gd",
        "res://ui/fixture_text_panel.gd",
        "res://tests/fixture_resource_test.gd",
      ]),
    );
  });

  it("uses exact resource path candidates as a hard boundary when available", () => {
    const resourcePath = "res://resources/pools/fixture_pool_primary.tres";
    const plan = buildQueryPlan(`${resourcePath} payload_id base_weight FixturePoolEntryData`);
    const mainResource = makeNode(
      `resource:${resourcePath}`,
      "resource",
      "fixture_pool_primary.tres",
      resourcePath,
    );
    const entryResource = makeNode(
      `${resourcePath}#FixturePoolEntry_0`,
      "resource",
      "FixturePoolEntry_0",
      resourcePath,
      {
        addressKind: "resource_subresource",
        readablePath: null,
      },
    );
    const unrelatedResource = makeNode(
      "resource:res://resources/pools/fixture_pool_secondary.tres",
      "resource",
      "fixture_pool_secondary.tres",
      "res://resources/pools/fixture_pool_secondary.tres",
    );

    const selection = selectRankedSeeds(
      plan,
      emptyPools({
        exactPath: [mainResource, entryResource],
        resourcePath: [mainResource, entryResource, unrelatedResource],
        resourceMetadata: [unrelatedResource],
      }),
      null,
    );

    expect(selection.seeds.map((node) => node.id)).toEqual([
      `resource:${resourcePath}`,
      `${resourcePath}#FixturePoolEntry_0`,
    ]);
  });

  it("selects exact code symbols before resource metadata for symbol-first queries", () => {
    const plan = buildQueryPlan("FixtureActor apply_damage");
    const script = makeNode(
      "script:res://scripts/fixture_actor.gd",
      "script_class",
      "FixtureActor",
      "res://scripts/fixture_actor.gd",
    );
    const method = makeNode(
      "method:res://scripts/fixture_actor.gd:apply_damage",
      "method",
      "apply_damage",
      "res://scripts/fixture_actor.gd",
    );
    const metadataResource = makeNode(
      "resource:res://resources/fixture_actor_stats.tres",
      "resource",
      "fixture_actor_stats.tres",
      "res://resources/fixture_actor_stats.tres",
    );

    const selection = selectRankedSeeds(
      plan,
      emptyPools({
        symbolExact: [script, method],
        resourceMetadata: [metadataResource],
      }),
      null,
    );

    expect(selection.strategy).toBe("symbol-first");
    expect(selection.seeds.map((node) => node.id)).toEqual([
      "script:res://scripts/fixture_actor.gd",
      "method:res://scripts/fixture_actor.gd:apply_damage",
      "resource:res://resources/fixture_actor_stats.tres",
    ]);
  });

  it("keeps exact symbol queries from seeding broad text-only symbol matches", () => {
    const plan = buildQueryPlan("change target_method");
    const targetMethod = makeNode(
      "method:res://scripts/target_service.gd:target_method",
      "method",
      "target_method",
      "res://scripts/target_service.gd",
    );
    const unrelatedMethod = makeNode(
      "method:res://scripts/unrelated_service.gd:unrelated_method",
      "method",
      "unrelated_method",
      "res://scripts/unrelated_service.gd",
    );

    const selection = selectRankedSeeds(
      plan,
      emptyPools({
        symbolExact: [targetMethod],
        symbolText: [unrelatedMethod],
        fallbackText: [unrelatedMethod],
      }),
      null,
    );

    expect(selection.strategy).toBe("symbol-first");
    expect(selection.seeds.map((node) => node.id)).toEqual([
      "method:res://scripts/target_service.gd:target_method",
    ]);
  });

  it("selects relationship candidates with graph evidence before text-only candidates", () => {
    const plan = buildQueryPlan("dependents FixtureLimit references");
    const limit = makeNode(
      "property:res://scripts/fixture_limits.gd:FixtureLimit",
      "property",
      "FixtureLimit",
      "res://scripts/fixture_limits.gd",
    );
    const consumer = makeNode(
      "method:res://scripts/fixture_consumer.gd:read_limit",
      "method",
      "read_limit",
      "res://scripts/fixture_consumer.gd",
    );
    const textOnly = makeNode(
      "script:res://scripts/fixture_notes.gd",
      "script_class",
      "FixtureLimitNotes",
      "res://scripts/fixture_notes.gd",
    );

    const selection = selectRankedSeeds(
      plan,
      emptyPools({
        relationship: [textOnly, limit, consumer],
      }),
      snapshot([limit, consumer, textOnly], [
        {
          source: consumer.id,
          target: limit.id,
        },
      ]),
    );

    expect(selection.strategy).toBe("relationship");
    expect(selection.seeds.slice(0, 2).map((node) => node.id)).toEqual(
      expect.arrayContaining([limit.id, consumer.id]),
    );
    expect(selection.seeds.at(-1)?.id).toBe(textOnly.id);
  });

  it("selects exact readable source file candidates first for source-oriented queries", () => {
    const plan = buildQueryPlan("source res://scripts/fixture_actor.gd");
    const resource = makeNode(
      "resource:res://resources/fixture_actor.tres",
      "resource",
      "fixture_actor.tres",
      "res://resources/fixture_actor.tres",
    );
    const source = makeNode(
      "script:res://scripts/fixture_actor.gd",
      "script_class",
      "FixtureActor",
      "res://scripts/fixture_actor.gd",
    );

    const selection = selectRankedSeeds(
      plan,
      emptyPools({
        fallbackText: [resource, source],
      }),
      null,
    );

    expect(selection.strategy).toBe("source-oriented");
    expect(selection.seeds[0].id).toBe("script:res://scripts/fixture_actor.gd");
  });
});
