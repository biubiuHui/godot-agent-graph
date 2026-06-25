import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createGraphDatabase, type GraphDatabase } from "../../../src/db/index.js";
import {
  insertEdge,
  insertUnresolvedRef,
  listEdges,
  listUnresolvedRefs,
  upsertFile,
  upsertNode,
} from "../../../src/db/queries.js";
import { exploreGodotContext } from "../../../src/context/explore.js";
import { indexGodotProject } from "../../../src/indexer/indexer.js";
import type { EdgeKind, GraphFile, GraphNode, NodeKind } from "../../../src/types.js";

const fixturesRoot = fileURLToPath(new URL("../../fixtures/godot", import.meta.url));
const tempRoots: string[] = [];

function indexedFixture(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `gdgraph-context-${name}-`));
  tempRoots.push(root);
  cpSync(join(fixturesRoot, name), root, { recursive: true });
  const result = indexGodotProject(root);
  expect(result.ok).toBe(true);
  return root;
}

function createTempGraph(): GraphDatabase {
  const root = mkdtempSync(join(tmpdir(), "gdgraph-context-manual-"));
  tempRoots.push(root);
  return createGraphDatabase(root);
}

function addFile(graph: GraphDatabase, path: string, kind: GraphFile["kind"] = "gdscript"): GraphFile {
  const file: GraphFile = {
    path,
    kind,
    contentHash: path,
    size: 1,
    modifiedAt: 1,
    indexedAt: 1,
    nodeCount: 1,
    parseErrors: [],
  };
  upsertFile(graph, file);
  return file;
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
): GraphNode {
  const node: GraphNode = {
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
  };
  upsertNode(graph, node);
  return node;
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

describe("agent context queries", () => {
  it("returns selection facts without final output aliases", () => {
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

      const context = exploreGodotContext(graph, {
        projectRoot: "",
        query: "FixtureActor",
        includeCode: false,
      }) as unknown as Record<string, unknown>;

      expect(context).not.toHaveProperty("paths");
      expect(context).not.toHaveProperty("prefixes");
      expect(context).not.toHaveProperty("selectors");
      expect(context.nodes).toEqual([
        expect.not.objectContaining({
          path: expect.any(String),
        }),
      ]);
    } finally {
      graph.close();
    }
  });

  it("preserves exact entry point symbols in broad natural-language queries", () => {
    const graph = createTempGraph();
    try {
      function insertScriptClass(name: string, path: string): void {
        addFile(graph, path);
        addNode(graph, `script:${path}`, "script_class", name, name, path);
      }

      for (let index = 0; index < 14; index += 1) {
        insertScriptClass(`ModuleNoise${index}`, `res://scripts/module_noise_${index}.gd`);
      }
      insertScriptClass("ExactAlphaController", "res://scripts/exact_alpha_controller.gd");
      insertScriptClass("ExactBetaTimeline", "res://scripts/exact_beta_timeline.gd");
      insertScriptClass("ExactActionPanel", "res://scripts/exact_action_panel.gd");
      insertScriptClass("ExactMainScreen", "res://scripts/exact_main_screen.gd");

      const context = exploreGodotContext(graph, {
        projectRoot: "",
        query: "Module 6 broad fixture event flow ExactAlphaController ExactBetaTimeline ExactActionPanel ExactMainScreen",
        includeCode: false,
      });
      const entryPointNames = context.entryPoints
        .map((id) => context.nodes.find((node) => node.id === id)?.name)
        .filter(Boolean);

      expect(entryPointNames.slice(0, 4)).toEqual(
        expect.arrayContaining([
          "ExactAlphaController",
          "ExactBetaTimeline",
          "ExactActionPanel",
          "ExactMainScreen",
        ]),
      );
      const noiseIndex = entryPointNames.indexOf("ModuleNoise0");
      if (noiseIndex >= 0) {
        expect(entryPointNames.indexOf("ExactAlphaController")).toBeLessThan(noiseIndex);
      }
    } finally {
      graph.close();
    }
  });

  it("keeps long planning queries focused on dense domain matches instead of generic UI noise", () => {
    const graph = createTempGraph();
    try {
      function insertScriptClass(name: string, path: string): void {
        addFile(graph, path);
        addNode(graph, `script:${path}`, "script_class", name, name, path);
      }

      function insertProperty(name: string, owner: string, path: string): void {
        addNode(graph, `property:${path}:${name}`, "property", name, `${owner}.${name}`, path);
      }

      insertScriptClass("WaveConfig", "res://spawn_fixture/wave_config.gd");
      insertProperty("spawn_budget", "WaveConfig", "res://spawn_fixture/wave_config.gd");
      insertScriptClass("EnemySpawnRunner", "res://spawn_fixture/enemy_spawn_runner.gd");
      insertScriptClass("DamageFormula", "res://spawn_fixture/damage_formula.gd");
      insertScriptClass("EnemyArchetypeCatalog", "res://spawn_fixture/enemy_archetype_catalog.gd");

      insertScriptClass("FixtureHudSnapshotAdapter", "res://ui/fixture_hud_snapshot_adapter.gd");
      insertScriptClass("RecordBuilderPanel", "res://ui/record_builder_panel.gd");
      insertScriptClass("CurrentArchitecturePanel", "res://ui/current_architecture_panel.gd");
      insertScriptClass("ComponentResourcePanel", "res://ui/component_resource_panel.gd");

      const context = exploreGodotContext(graph, {
        projectRoot: "",
        query:
          "enemy spawn runner wave config spawn budget damage formula enemy archetype catalog spawn weights beginner advanced current architecture encounter tuning",
        includeCode: false,
      });
      const entryPointNames = context.entryPoints
        .map((id) => context.nodes.find((node) => node.id === id)?.name)
        .filter(Boolean);

      expect(entryPointNames.slice(0, 5)).toEqual(
        expect.arrayContaining([
          "WaveConfig",
          "spawn_budget",
          "EnemySpawnRunner",
          "DamageFormula",
          "EnemyArchetypeCatalog",
        ]),
      );
      expect(entryPointNames.slice(0, 5)).not.toEqual(
        expect.arrayContaining([
          "FixtureHudSnapshotAdapter",
          "RecordBuilderPanel",
          "CurrentArchitecturePanel",
          "ComponentResourcePanel",
        ]),
      );
    } finally {
      graph.close();
    }
  });

  it("prioritizes resource directory and metadata matches over ui and test noise", () => {
    const graph = createTempGraph();
    try {
      function insertResource(path: string, properties: Record<string, unknown>): void {
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
            type: "Resource",
          },
        );
      }

      function insertScriptClass(name: string, path: string): void {
        addFile(graph, path);
        addNode(graph, `script:${path}`, "script_class", name, name, path);
      }

      function insertProperty(name: string, owner: string, path: string): void {
        addNode(graph, `property:${path}:${name}`, "property", name, `${owner}.${name}`, path);
      }

      insertResource("res://resources/artifacts/artifact_001.tres", {
        display_label: "Crystal Ember",
        rules_text: "Cobalt lantern resonance",
      });
      insertResource("res://resources/artifacts/artifact_002.tres", {
        display_label: "River Quartz",
        rules_text: "Amber signal trail",
      });
      insertResource("res://resources/artifacts/artifact_003.tres", {
        display_label: "Demo Relic",
        rules_text: "Granite lantern effect",
      });

      insertScriptClass("ArtifactResource", "res://scripts/resources/artifact_resource.gd");
      insertProperty("display_label", "ArtifactResource", "res://scripts/resources/artifact_resource.gd");
      insertProperty("rules_text", "ArtifactResource", "res://scripts/resources/artifact_resource.gd");
      insertScriptClass("DemoArtifactEffectPanel", "res://ui/demo_artifact_effect_panel.gd");
      insertScriptClass("ArtifactTopicFixture", "res://topics/artifact_topic_fixture.gd");
      insertScriptClass("CrystalEmberCobaltLanternTest", "res://tests/crystal_ember_cobalt_lantern_test.gd");

      const context = exploreGodotContext(graph, {
        projectRoot: "",
        query:
          "ArtifactResource display_label rules_text resources/artifacts Demo artifact effect label crystal ember cobalt lantern granite relic",
        includeCode: false,
        maxFiles: 6,
      });

      expect(context.files.slice(0, 3)).toEqual(
        expect.arrayContaining([
          "res://resources/artifacts/artifact_001.tres",
          "res://resources/artifacts/artifact_002.tres",
          "res://resources/artifacts/artifact_003.tres",
        ]),
      );
      expect(context.files.slice(0, 6)).not.toEqual(
        expect.arrayContaining([
          "res://ui/demo_artifact_effect_panel.gd",
          "res://topics/artifact_topic_fixture.gd",
          "res://tests/crystal_ember_cobalt_lantern_test.gd",
        ]),
      );
    } finally {
      graph.close();
    }
  });

  it("keeps broad resource text queries focused on matching resource files", () => {
    const graph = createTempGraph();
    try {
      function insertResource(path: string, properties: Record<string, unknown>): void {
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

      function insertProperty(name: string, owner: string, path: string): void {
        addFile(graph, path);
        addNode(graph, `script:${path}`, "script_class", owner, owner, path);
        addNode(graph, `property:${path}:${name}`, "property", name, `${owner}.${name}`, path);
      }

      insertResource("res://resources/items/fixture_item_alpha.tres", {
        display_name: "Amber cobalt sample",
        description: "Quartz signal effect",
      });
      insertResource("res://resources/items/fixture_item_beta.tres", {
        display_name: "Silver basalt sample",
        description: "Copper resin effect",
      });
      insertResource("res://resources/items/fixture_item_gamma.tres", {
        display_name: "Blue mineral sample",
        description: "Granite fiber effect",
      });

      for (let index = 0; index < 8; index += 1) {
        insertProperty("display_text", `FixtureTopicData${index}`, `res://topics/fixture_topic_${index}.gd`);
        insertProperty("rule_text", `FixtureUiText${index}`, `res://ui/fixture_text_${index}.gd`);
      }
      addFile(graph, "res://tests/fixture_item_text_test.gd");
      addNode(
        graph,
        "script:res://tests/fixture_item_text_test.gd",
        "script_class",
        "FixtureItemTextTest",
        "FixtureItemTextTest",
        "res://tests/fixture_item_text_test.gd",
      );

      const context = exploreGodotContext(graph, {
        projectRoot: "",
        query:
          "FixtureItemResource display_text rule_text resources/items fixture item amber cobalt quartz silver basalt copper resin",
        includeCode: false,
        maxFiles: 6,
      });

      expect(context.strategy).toBe("resource-first");
      expect(context.files.slice(0, 3)).toEqual(
        expect.arrayContaining([
          "res://resources/items/fixture_item_alpha.tres",
          "res://resources/items/fixture_item_beta.tres",
          "res://resources/items/fixture_item_gamma.tres",
        ]),
      );
      expect(context.files.slice(0, 6)).not.toEqual(
        expect.arrayContaining([
          expect.stringContaining("res://topics/"),
          expect.stringContaining("res://ui/"),
          expect.stringContaining("res://tests/"),
        ]),
      );
    } finally {
      graph.close();
    }
  });

  it("keeps exact resource path queries anchored to that resource file", () => {
    const graph = createTempGraph();
    try {
      function insertPool(path: string, entryPrefix: string): void {
        addFile(graph, path, "resource");
        addNode(
          graph,
          `resource:${path}`,
          "resource",
          path.split("/").at(-1) ?? path,
          path,
          path,
          {
            properties: {
              entry_type: "FixturePoolEntryData",
            },
            type: "FixturePoolData",
          },
          {
            addressKind: "resource_main",
            ownerPath: path,
            readablePath: path,
            displayPath: path,
            referencePath: null,
          },
        );
        for (let index = 0; index < 3; index += 1) {
          const entryId = `resource:${path}#${entryPrefix}_${index}`;
          addNode(
            graph,
            entryId,
            "resource",
            `${entryPrefix}_${index}`,
            `${path}#${entryPrefix}_${index}`,
            path,
            {
              properties: {
                payload_id: `${entryPrefix}_payload_${index}`,
                base_weight: index + 1,
                weight_keys: ["fixture_weight"],
                group_keys: ["fixture_group"],
              },
              type: "FixturePoolEntryData",
            },
            {
              addressKind: "resource_subresource",
              ownerPath: path,
              readablePath: null,
              displayPath: path,
              referencePath: null,
            },
          );
          addEdge(graph, `resource:${path}`, "contains", entryId);
        }
      }

      const targetPath = "res://resources/pools/fixture_pool_primary.tres";
      const unrelatedPath = "res://resources/pools/fixture_pool_secondary.tres";
      insertPool(targetPath, "primary_entry");
      insertPool(unrelatedPath, "secondary_entry");

      const context = exploreGodotContext(graph, {
        projectRoot: "",
        query: `${targetPath} payload_id base_weight weight_keys group_keys FixturePoolEntryData`,
        includeCode: false,
        maxFiles: 6,
      });

      expect(context.strategy).toBe("resource-first");
      expect(context.files).toContain(targetPath);
      expect(context.files).not.toContain(unrelatedPath);
      expect(context.entryPoints.every((id) => !id.includes("fixture_pool_secondary"))).toBe(true);
    } finally {
      graph.close();
    }
  });

  it("uses resource-first strategy and keeps resource nodes ahead of weak ui noise", () => {
    const graph = createTempGraph();
    try {
      const resourcePath = "res://resources/fixture_profile.tres";
      addFile(graph, resourcePath, "resource");
      addNode(
        graph,
        `resource:${resourcePath}`,
        "resource",
        "fixture_profile.tres",
        resourcePath,
        resourcePath,
        {
          properties: {
            display_name: "Fixture Profile",
            weight: 12,
          },
          type: "Resource",
        },
        {
          addressKind: "resource_main",
          ownerPath: resourcePath,
          readablePath: resourcePath,
          displayPath: resourcePath,
          referencePath: null,
        },
      );
      addNode(
        graph,
        `resource:${resourcePath}#fixture_weight_curve`,
        "resource",
        "fixture_weight_curve",
        `${resourcePath}#fixture_weight_curve`,
        resourcePath,
        {
          properties: {
            display_name: "Fixture Weight Curve",
            weight: 4,
          },
        },
        {
          addressKind: "resource_subresource",
          ownerPath: resourcePath,
          readablePath: null,
          displayPath: resourcePath,
          referencePath: null,
        },
      );
      addFile(graph, "res://ui/fixture_profile_panel.gd");
      addNode(
        graph,
        "script:res://ui/fixture_profile_panel.gd",
        "script_class",
        "FixtureProfilePanel",
        "FixtureProfilePanel",
        "res://ui/fixture_profile_panel.gd",
      );
      addFile(graph, "res://tests/fixture_profile_test.gd");
      addNode(
        graph,
        "script:res://tests/fixture_profile_test.gd",
        "script_class",
        "FixtureProfileTest",
        "FixtureProfileTest",
        "res://tests/fixture_profile_test.gd",
      );

      const context = exploreGodotContext(graph, {
        projectRoot: "",
        query: "fixture_profile display_name weight resources fixture",
        includeCode: false,
      });
      const entryPointNames = context.entryPoints
        .map((id) => context.nodes.find((node) => node.id === id)?.name)
        .filter(Boolean);

      expect(context.strategy).toBe("resource-first");
      expect(context.completeness).toEqual(expect.objectContaining({
        scope: "bounded_navigation",
        complete: false,
      }));
      expect(entryPointNames.slice(0, 2)).toEqual(
        expect.arrayContaining(["fixture_profile.tres", "fixture_weight_curve"]),
      );
      expect(entryPointNames.slice(0, 2)).not.toEqual(
        expect.arrayContaining(["FixtureProfilePanel", "FixtureProfileTest"]),
      );
    } finally {
      graph.close();
    }
  });

  it("uses symbol-first strategy and ranks exact symbols ahead of unrelated resources", () => {
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
      addNode(
        graph,
        "signal:res://scripts/fixture_actor.gd:health_depleted",
        "signal",
        "health_depleted",
        "FixtureActor.health_depleted",
        "res://scripts/fixture_actor.gd",
      );
      addFile(graph, "res://resources/fixture_actor_stats.tres", "resource");
      addNode(
        graph,
        "resource:res://resources/fixture_actor_stats.tres",
        "resource",
        "fixture_actor_stats.tres",
        "res://resources/fixture_actor_stats.tres",
        "res://resources/fixture_actor_stats.tres",
        {
          properties: {
            display_name: "FixtureActor health resource",
            health_depleted: false,
          },
        },
        {
          addressKind: "resource_main",
          ownerPath: "res://resources/fixture_actor_stats.tres",
          readablePath: "res://resources/fixture_actor_stats.tres",
          displayPath: "res://resources/fixture_actor_stats.tres",
          referencePath: null,
        },
      );

      const context = exploreGodotContext(graph, {
        projectRoot: "",
        query: "FixtureActor apply_damage health_depleted",
        includeCode: false,
      });
      const entryPointIds = context.entryPoints.slice(0, 3);

      expect(context.strategy).toBe("symbol-first");
      expect(entryPointIds).toEqual(
        expect.arrayContaining([
          "script:res://scripts/fixture_actor.gd",
          "method:res://scripts/fixture_actor.gd:apply_damage",
          "signal:res://scripts/fixture_actor.gd:health_depleted",
        ]),
      );
      expect(entryPointIds).not.toContain("resource:res://resources/fixture_actor_stats.tres");
    } finally {
      graph.close();
    }
  });

  it("uses relationship strategy and surfaces exact dependent relationships", () => {
    const graph = createTempGraph();
    try {
      addFile(graph, "res://scripts/fixture_rules.gd");
      addFile(graph, "res://scripts/fixture_consumer.gd");
      addFile(graph, "res://scripts/unrelated_fixture_source.gd");
      addNode(
        graph,
        "property:res://scripts/fixture_rules.gd:FIXTURE_LIMIT",
        "property",
        "FIXTURE_LIMIT",
        "FixtureRules.FIXTURE_LIMIT",
        "res://scripts/fixture_rules.gd",
      );
      addNode(
        graph,
        "method:res://scripts/fixture_consumer.gd:apply_limit",
        "method",
        "apply_limit",
        "FixtureConsumer.apply_limit",
        "res://scripts/fixture_consumer.gd",
      );
      addNode(
        graph,
        "script:res://scripts/unrelated_fixture_source.gd",
        "script_class",
        "UnrelatedFixtureSource",
        "UnrelatedFixtureSource",
        "res://scripts/unrelated_fixture_source.gd",
        {
          note: "dependents references fixture limit source",
        },
      );
      addEdge(
        graph,
        "method:res://scripts/fixture_consumer.gd:apply_limit",
        "references_symbol",
        "property:res://scripts/fixture_rules.gd:FIXTURE_LIMIT",
      );

      const context = exploreGodotContext(graph, {
        projectRoot: "",
        query: "dependents FIXTURE_LIMIT references",
        includeCode: false,
      });

      expect(context.strategy).toBe("relationship");
      expect(context.completeness).toEqual(expect.objectContaining({
        scope: "relationship_summary",
        complete: false,
      }));
      expect(context.relationships).toContain(
        "method:res://scripts/fixture_consumer.gd:apply_limit references_symbol property:res://scripts/fixture_rules.gd:FIXTURE_LIMIT (resolver)",
      );
      expect(context.entryPoints.slice(0, 2)).toContain("property:res://scripts/fixture_rules.gd:FIXTURE_LIMIT");
      expect(context.snippets).toEqual([]);
    } finally {
      graph.close();
    }
  });

  it("uses source-oriented strategy for exact script path queries", () => {
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
      addFile(graph, "res://resources/fixture_actor.tres", "resource");
      addNode(
        graph,
        "resource:res://resources/fixture_actor.tres",
        "resource",
        "fixture_actor.tres",
        "res://resources/fixture_actor.tres",
        "res://resources/fixture_actor.tres",
        {},
        {
          addressKind: "resource_main",
          ownerPath: "res://resources/fixture_actor.tres",
          readablePath: "res://resources/fixture_actor.tres",
          displayPath: "res://resources/fixture_actor.tres",
          referencePath: null,
        },
      );

      const context = exploreGodotContext(graph, {
        projectRoot: "",
        query: "source res://scripts/fixture_actor.gd",
        includeCode: false,
      });

      expect(context.strategy).toBe("source-oriented");
      expect(context.completeness).toEqual(expect.objectContaining({
        scope: "source_window",
        complete: false,
      }));
      expect(context.entryPoints[0]).toBe("script:res://scripts/fixture_actor.gd");
    } finally {
      graph.close();
    }
  });

  it("uses general strategy for broad lowercase navigation queries", () => {
    const graph = createTempGraph();
    try {
      addFile(graph, "res://scripts/fixture_damage.gd");
      addNode(
        graph,
        "method:res://scripts/fixture_damage.gd:damage",
        "method",
        "damage",
        "FixtureDamage.damage",
        "res://scripts/fixture_damage.gd",
      );

      const context = exploreGodotContext(graph, {
        projectRoot: "",
        query: "damage",
        includeCode: false,
      });

      expect(context.strategy).toBe("general");
      expect(context.completeness).toEqual(expect.objectContaining({
        scope: "bounded_navigation",
        complete: false,
      }));
      expect(context.entryPoints).toContain("method:res://scripts/fixture_damage.gd:damage");
    } finally {
      graph.close();
    }
  });

  it("keeps exact code entry points when high-cardinality resource data also matches", () => {
    const graph = createTempGraph();
    try {
      function insertResourceObjective(path: string, index: number): void {
        const node = addNode(
          graph,
          `resource:${path}#Objective_${index}`,
          "resource",
          `Objective_${index}`,
          `${path}#Objective_${index}`,
          path,
          {
            objective_type: "board_count_at_least",
            target_family_ids: ["ember"],
            target_tag_ids: ["signal"],
            count_at_least: 2,
            composite_all: true,
            composite_any: false,
          },
        );
        addEdge(graph, `resource:${path}`, "contains", node.id);
      }

      addFile(graph, "res://resources/route_profile.tres", "resource");
      addNode(
        graph,
        "resource:res://resources/route_profile.tres",
        "resource",
        "route_profile.tres",
        "res://resources/route_profile.tres",
        "res://resources/route_profile.tres",
        {
          properties: {
            objective_type: "board_count_at_least",
            count_at_least: 2,
          },
        },
      );
      for (let index = 0; index < 18; index += 1) {
        insertResourceObjective("res://resources/route_profile.tres", index);
      }
      addFile(graph, "res://scripts/analysis/route_analyzer.gd");
      addNode(
        graph,
        "script:res://scripts/analysis/route_analyzer.gd",
        "script_class",
        "RouteAnalyzer",
        "RouteAnalyzer",
        "res://scripts/analysis/route_analyzer.gd",
      );
      addNode(
        graph,
        "property:res://scripts/analysis/route_analyzer.gd:active_route_signal",
        "property",
        "active_route_signal",
        "RouteAnalyzer.active_route_signal",
        "res://scripts/analysis/route_analyzer.gd",
      );

      const context = exploreGodotContext(graph, {
        projectRoot: "",
        query:
          "RouteObjectiveData objective_type target_family_ids target_tag_ids count_at_least composite_all composite_any RouteAnalyzer active_route_signal",
        includeCode: false,
        maxFiles: 6,
      });

      expect(context.files).toContain("res://scripts/analysis/route_analyzer.gd");
      expect(context.entryPoints).toEqual(
        expect.arrayContaining([
          "script:res://scripts/analysis/route_analyzer.gd",
          "property:res://scripts/analysis/route_analyzer.gd:active_route_signal",
        ]),
      );
      expect(context.nodes.filter((node) => node.filePath === "res://resources/route_profile.tres").length)
        .toBeLessThanOrEqual(2);
    } finally {
      graph.close();
    }
  });

  it("returns focused direct paths between entry points", () => {
    const graph = createTempGraph();
    try {
      addFile(graph, "res://scripts/screen_controller.gd");
      addFile(graph, "res://scripts/timeline_builder.gd");
      addNode(
        graph,
        "script:res://scripts/screen_controller.gd",
        "script_class",
        "ScreenController",
        "ScreenController",
        "res://scripts/screen_controller.gd",
      );
      addNode(
        graph,
        "script:res://scripts/timeline_builder.gd",
        "script_class",
        "TimelineBuilder",
        "TimelineBuilder",
        "res://scripts/timeline_builder.gd",
      );
      addNode(
        graph,
        "method:res://scripts/screen_controller.gd:_ready",
        "method",
        "_ready",
        "ScreenController._ready",
        "res://scripts/screen_controller.gd",
      );
      addEdge(
        graph,
        "script:res://scripts/screen_controller.gd",
        "calls",
        "script:res://scripts/timeline_builder.gd",
      );
      addEdge(
        graph,
        "script:res://scripts/screen_controller.gd",
        "contains",
        "method:res://scripts/screen_controller.gd:_ready",
      );

      const context = exploreGodotContext(graph, {
        projectRoot: "",
        query: "ScreenController TimelineBuilder flow",
        includeCode: false,
      });

      expect(context.pathsBetween).toEqual([
        "script:res://scripts/screen_controller.gd calls script:res://scripts/timeline_builder.gd (resolver)",
      ]);
      expect(context.pathsBetween).not.toEqual(
        expect.arrayContaining([expect.stringContaining(" contains ")]),
      );
    } finally {
      graph.close();
    }
  });

  it("keeps edit blast radius check files focused on direct relationships", () => {
    const graph = createTempGraph();
    try {
      addFile(graph, "res://scripts/target_service.gd");
      addFile(graph, "res://scripts/direct_panel.gd");
      addFile(graph, "res://scripts/unrelated_service.gd");
      addNode(
        graph,
        "script:res://scripts/target_service.gd",
        "script_class",
        "TargetService",
        "TargetService",
        "res://scripts/target_service.gd",
      );
      addNode(
        graph,
        "method:res://scripts/target_service.gd:target_method",
        "method",
        "target_method",
        "TargetService.target_method",
        "res://scripts/target_service.gd",
      );
      addNode(
        graph,
        "method:res://scripts/direct_panel.gd:call_target",
        "method",
        "call_target",
        "DirectPanel.call_target",
        "res://scripts/direct_panel.gd",
      );
      addNode(
        graph,
        "method:res://scripts/direct_panel.gd:unrelated_branch",
        "method",
        "unrelated_branch",
        "DirectPanel.unrelated_branch",
        "res://scripts/direct_panel.gd",
      );
      addNode(
        graph,
        "method:res://scripts/unrelated_service.gd:unrelated_method",
        "method",
        "unrelated_method",
        "UnrelatedService.unrelated_method",
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

      const context = exploreGodotContext(graph, {
        projectRoot: "",
        query: "change target_method",
        includeCode: false,
      });

      expect(context.blastRadius?.checkFiles).toEqual(
        expect.arrayContaining([
          "res://scripts/target_service.gd",
          "res://scripts/direct_panel.gd",
        ]),
      );
      expect(context.blastRadius?.checkFiles).not.toContain("res://scripts/unrelated_service.gd");
    } finally {
      graph.close();
    }
  });

  it("explores related Godot context with relationship explanations and bounded snippets", () => {
    const root = indexedFixture("minimal");
    const graph = createGraphDatabase(root);
    try {
      const context = exploreGodotContext(graph, {
        projectRoot: root,
        query: "FixtureActor",
        maxFiles: 1,
        includeCode: true,
      });

      expect(context.nodes.map((node) => node.id)).toEqual(
        expect.arrayContaining([
          "script:res://scripts/fixture_actor.gd",
          "scene_node:res://fixture_main.tscn:FixtureActor",
          "method:res://scripts/fixture_actor.gd:_ready",
        ]),
      );
      expect(context.nodes[0]).not.toHaveProperty("metadata");
      expect(context.nodes[0]).not.toHaveProperty("updatedAt");
      expect(context.relationships).toEqual(
        expect.arrayContaining([
          expect.stringContaining("scene_node:res://fixture_main.tscn:FixtureActor attaches_script script:res://scripts/fixture_actor.gd"),
        ]),
      );
      expect(context.relationships).not.toEqual(
        expect.arrayContaining([
          expect.stringContaining("scene_node:res://fixture_main.tscn:FixtureActor attaches_script resource:res://scripts/fixture_actor.gd"),
        ]),
      );
      expect(context.files).toEqual(["res://scripts/fixture_actor.gd"]);
      expect(context.snippets).toEqual([
        expect.objectContaining({
          filePath: "res://scripts/fixture_actor.gd",
          text: expect.stringContaining("class_name FixtureActor"),
        }),
      ]);
    } finally {
      graph.close();
    }
  });

  it("returns matching symbol details without code snippets when requested", () => {
    const root = indexedFixture("minimal");
    const graph = createGraphDatabase(root);
    try {
      const context = exploreGodotContext(graph, {
        projectRoot: root,
        query: "FixtureActor",
        includeCode: false,
      });

      expect(context.nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "script:res://scripts/fixture_actor.gd" }),
        expect.objectContaining({ id: "scene_node:res://fixture_main.tscn:FixtureActor" }),
      ]));
      expect(context.snippets).toEqual([]);
    } finally {
      graph.close();
    }
  });

  it("does not show resolved autoload root lookups as unresolved node paths", () => {
    const root = indexedFixture("autoload-input");
    const graph = createGraphDatabase(root);
    try {
      const context = exploreGodotContext(graph, {
        projectRoot: root,
        query: "FixtureState",
        includeCode: false,
      });

      expect(context.relationships).toEqual(
        expect.arrayContaining([
          expect.stringContaining("script:res://scripts/fixture_input.gd uses_autoload autoload:FixtureState"),
        ]),
      );
      expect(context.relationships).not.toEqual(
        expect.arrayContaining([
          expect.stringContaining("references_nodepath /root/FixtureState (unresolved)"),
        ]),
      );
      expect(context.relationships).not.toEqual(
        expect.arrayContaining([
          expect.stringContaining("references_nodepath FixtureState (unresolved)"),
        ]),
      );
    } finally {
      graph.close();
    }
  });

  it("returns resolved call relationships in general context", () => {
    const root = indexedFixture("signals");
    const graph = createGraphDatabase(root);
    try {
      const context = exploreGodotContext(graph, {
        projectRoot: root,
        query: "damage",
        includeCode: false,
      });
      expect(context.relationships).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            "method:res://scripts/signal_demo.gd:_on_start_button_pressed calls method:res://scripts/signal_demo.gd:damage",
          ),
        ]),
      );
      expect(context.relationships).not.toEqual(
        expect.arrayContaining([
          expect.stringContaining("calls method:res://scripts/signal_demo.gd:damage (unresolved-match)"),
        ]),
      );
    } finally {
      graph.close();
    }
  });

  it("returns signal relationships in general context", () => {
    const root = indexedFixture("signals");
    const graph = createGraphDatabase(root);
    try {
      const context = exploreGodotContext(graph, {
        projectRoot: root,
        query: "health_depleted",
        includeCode: false,
      });

      expect(context.relationships).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            "method:res://scripts/signal_demo.gd:_ready connects_signal signal:res://scripts/signal_demo.gd:health_depleted",
          ),
          expect.stringContaining(
            "method:res://scripts/signal_demo.gd:damage emits_signal signal:res://scripts/signal_demo.gd:health_depleted",
          ),
        ]),
      );
    } finally {
      graph.close();
    }
  });

  it("keeps unresolved caller matches ambiguous instead of linking them to every same-name method", () => {
    const graph = createTempGraph();
    try {
      addFile(graph, "res://scripts/a.gd");
      addFile(graph, "res://scripts/b.gd");
      addFile(graph, "res://scripts/caller.gd");
      addFile(graph, "res://scripts/resolved_caller.gd");
      addNode(graph, "script:res://scripts/a.gd", "script_class", "A", "A", "res://scripts/a.gd");
      addNode(graph, "script:res://scripts/b.gd", "script_class", "B", "B", "res://scripts/b.gd");
      addNode(
        graph,
        "script:res://scripts/caller.gd",
        "script_class",
        "Caller",
        "Caller",
        "res://scripts/caller.gd",
      );
      addNode(
        graph,
        "script:res://scripts/resolved_caller.gd",
        "script_class",
        "ResolvedCaller",
        "ResolvedCaller",
        "res://scripts/resolved_caller.gd",
      );
      addNode(
        graph,
        "method:res://scripts/a.gd:validate",
        "method",
        "validate",
        "A.validate",
        "res://scripts/a.gd",
      );
      addNode(
        graph,
        "method:res://scripts/b.gd:validate",
        "method",
        "validate",
        "B.validate",
        "res://scripts/b.gd",
      );
      addEdge(
        graph,
        "script:res://scripts/resolved_caller.gd",
        "calls",
        "method:res://scripts/a.gd:validate",
      );
      insertUnresolvedRef(graph, {
        fromNodeId: "script:res://scripts/caller.gd",
        referenceName: "validate",
        referenceKind: "calls",
        filePath: "res://scripts/caller.gd",
        line: 1,
        column: 1,
        candidates: [],
      });

      expect(listEdges(graph, { kind: "calls" })).toEqual([
        expect.objectContaining({
          source: "script:res://scripts/resolved_caller.gd",
          target: "method:res://scripts/a.gd:validate",
        }),
      ]);
      expect(listUnresolvedRefs(graph)).toEqual([
        expect.objectContaining({
          fromNodeId: "script:res://scripts/caller.gd",
          referenceName: "validate",
          referenceKind: "calls",
        }),
      ]);
      expect(exploreGodotContext(graph, {
        projectRoot: graph.projectRoot,
        query: "validate",
        includeCode: false,
      }).relationships).toEqual(
        expect.arrayContaining([
          "script:res://scripts/caller.gd calls validate (unresolved)",
        ]),
      );
    } finally {
      graph.close();
    }
  });

  it("shows resolved autoload receiver calls instead of unresolved caller matches", () => {
    const root = indexedFixture("minimal");
    writeFileSync(
      join(root, "project.godot"),
      `; Engine configuration file.

[application]

config/name="MinimalFixture"
run/main_scene="res://fixture_main.tscn"

[autoload]

FixtureFx="*res://scripts/fixture_fx.gd"
`,
    );
    writeFileSync(
      join(root, "scripts", "fixture_fx.gd"),
      `extends Node
class_name FixtureFxClass

func request_fixture_feedback() -> void:
\tpass
`,
    );
    writeFileSync(
      join(root, "scripts", "other_fx.gd"),
      `extends Node
class_name OtherFx

func request_fixture_feedback() -> void:
\tpass
`,
    );
    writeFileSync(
      join(root, "scripts", "autoload_caller.gd"),
      `extends Node
class_name AutoloadCaller

func _ready() -> void:
\tFixtureFx.request_fixture_feedback()
`,
    );
    const result = indexGodotProject(root);
    expect(result.ok).toBe(true);

    const graph = createGraphDatabase(root);
    try {
      expect(listEdges(graph, { kind: "calls" })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "method:res://scripts/autoload_caller.gd:_ready",
            target: "method:res://scripts/fixture_fx.gd:request_fixture_feedback",
            provenance: "resolver",
          }),
        ]),
      );
      expect(listUnresolvedRefs(graph)).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            fromNodeId: "method:res://scripts/autoload_caller.gd:_ready",
            referenceName: "request_fixture_feedback",
            referenceKind: "calls",
          }),
        ]),
      );
    } finally {
      graph.close();
    }
  });

  it("shows resolved typed collection entry calls instead of unresolved relationships", () => {
    const root = indexedFixture("minimal");
    writeFileSync(
      join(root, "scripts", "fixture_cell.gd"),
      `extends RefCounted
class_name FixtureCell

func play_fixture_feedback_animation() -> void:
\tpass
`,
    );
    writeFileSync(
      join(root, "scripts", "other_cell.gd"),
      `extends RefCounted
class_name OtherCell

func play_fixture_feedback_animation() -> void:
\tpass
`,
    );
    writeFileSync(
      join(root, "scripts", "fixture_panel.gd"),
      `extends Node
class_name FixturePanel

var cells: Array[FixtureCell] = []

func apply_fixture_state() -> void:
\tfor cell_view in cells:
\t\tcell_view.play_fixture_feedback_animation()
`,
    );
    const result = indexGodotProject(root);
    expect(result.ok).toBe(true);

    const graph = createGraphDatabase(root);
    try {
      const context = exploreGodotContext(graph, {
        projectRoot: root,
        query: "play_fixture_feedback_animation",
        includeCode: false,
      });

      expect(context.relationships).toContain(
        "method:res://scripts/fixture_panel.gd:apply_fixture_state calls method:res://scripts/fixture_cell.gd:play_fixture_feedback_animation (resolver)",
      );
      expect(context.relationships).not.toContain(
        "method:res://scripts/fixture_panel.gd:apply_fixture_state calls play_fixture_feedback_animation (unresolved)",
      );
    } finally {
      graph.close();
    }
  });

  it("shows signal declaration relationships for signal connection callers", () => {
    const root = indexedFixture("minimal");
    writeFileSync(
      join(root, "project.godot"),
      `; Engine configuration file.

[application]

config/name="MinimalFixture"
run/main_scene="res://fixture_main.tscn"

[autoload]

FixtureFx="*res://scripts/fixture_fx.gd"
`,
    );
    writeFileSync(
      join(root, "scripts", "fixture_fx.gd"),
      `extends Node
class_name FixtureFxClass

signal fixture_feedback_requested
`,
    );
    writeFileSync(
      join(root, "scripts", "signal_caller.gd"),
      `extends Node
class_name SignalCaller

func _connect_example_signal() -> void:
\tFixtureFx.fixture_feedback_requested.connect(_on_fixture_feedback_requested)

func _on_fixture_feedback_requested() -> void:
\tpass
`,
    );
    const result = indexGodotProject(root);
    expect(result.ok).toBe(true);

    const graph = createGraphDatabase(root);
    try {
      expect(listEdges(graph, { kind: "connects_signal" })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "method:res://scripts/signal_caller.gd:_connect_example_signal",
            target: "signal:res://scripts/fixture_fx.gd:fixture_feedback_requested",
            provenance: "resolver",
          }),
        ]),
      );
      expect(listUnresolvedRefs(graph)).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            fromNodeId: "method:res://scripts/signal_caller.gd:_connect_example_signal",
            referenceName: "fixture_feedback_requested",
            referenceKind: "connects_signal",
          }),
        ]),
      );
    } finally {
      graph.close();
    }
  });

  it("shows callers for class constant references", () => {
    const root = indexedFixture("minimal");
    writeFileSync(
      join(root, "scripts", "step_catalog.gd"),
      `extends Node
class_name StepCatalog

const FIXTURE_STEP_NAME := "fixture_step"
`,
    );
    writeFileSync(
      join(root, "scripts", "step_reader.gd"),
      `extends Node
class_name StepReader

func play() -> void:
\tif StepCatalog.FIXTURE_STEP_NAME == "fixture_step":
\t\tpass
`,
    );
    const result = indexGodotProject(root);
    expect(result.ok).toBe(true);

    const graph = createGraphDatabase(root);
    try {
      const context = exploreGodotContext(graph, {
        projectRoot: root,
        query: "FIXTURE_STEP_NAME",
        includeCode: false,
        maxFiles: 10,
      });

      expect(context.nodes.map((node) => node.id)).toContain(
        "property:res://scripts/step_catalog.gd:FIXTURE_STEP_NAME",
      );
      expect(context.files).toContain("res://scripts/step_catalog.gd");
      expect(context.files).toContain("res://scripts/step_reader.gd");
      expect(context.relationships).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            "method:res://scripts/step_reader.gd:play references_symbol property:res://scripts/step_catalog.gd:FIXTURE_STEP_NAME",
          ),
        ]),
      );
    } finally {
      graph.close();
    }
  });

  it("keeps ambiguous same-name symbol references unresolved", () => {
    const root = indexedFixture("minimal");
    writeFileSync(
      join(root, "scripts", "first_catalog.gd"),
      `extends Node
class_name FirstCatalog

const SHARED_VALUE := 1
`,
    );
    writeFileSync(
      join(root, "scripts", "second_catalog.gd"),
      `extends Node
class_name SecondCatalog

const SHARED_VALUE := 2
`,
    );
    writeFileSync(
      join(root, "scripts", "ambiguous_reader.gd"),
      `extends Node
class_name AmbiguousReader

func read_value() -> int:
\treturn SHARED_VALUE
`,
    );
    const result = indexGodotProject(root);
    expect(result.ok).toBe(true);

    const graph = createGraphDatabase(root);
    try {
      expect(listUnresolvedRefs(graph)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            fromNodeId: "method:res://scripts/ambiguous_reader.gd:read_value",
            referenceName: "SHARED_VALUE",
            referenceKind: "references_symbol",
          }),
        ]),
      );
      expect(listEdges(graph, { kind: "references_symbol" })).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "method:res://scripts/ambiguous_reader.gd:read_value",
            target: "property:res://scripts/first_catalog.gd:SHARED_VALUE",
          }),
        ]),
      );
      expect(listEdges(graph, { kind: "references_symbol" })).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "method:res://scripts/ambiguous_reader.gd:read_value",
            target: "property:res://scripts/second_catalog.gd:SHARED_VALUE",
          }),
        ]),
      );
    } finally {
      graph.close();
    }
  });

});
