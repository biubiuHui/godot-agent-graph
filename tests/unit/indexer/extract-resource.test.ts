import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { extractGodotResourceGraph } from "../../../src/indexer/extract-resource.js";
import { parseGodotResource } from "../../../src/parsers/godot-resource.js";

const fixturesRoot = fileURLToPath(new URL("../../fixtures/godot", import.meta.url));

function parseFixture(relativePath: string, resPath: string) {
  return parseGodotResource(readFileSync(join(fixturesRoot, relativePath), "utf8"), resPath);
}

describe("extractGodotResourceGraph", () => {
  it("extracts scene nodes, ext resources, script attachments, and scene instances", () => {
    const graph = extractGodotResourceGraph(
      parseFixture("scene-composition/scenes/fixture_main.tscn", "res://scenes/fixture_main.tscn"),
      { updatedAt: 1000 },
    );

    expect(graph.nodes.map((node) => [node.id, node.kind, node.name])).toEqual([
      ["scene:res://scenes/fixture_main.tscn", "scene", "fixture_main.tscn"],
      ["resource:res://scenes/fixture_actor.tscn", "resource", "fixture_actor.tscn"],
      ["resource:res://scripts/game_controller.gd", "resource", "game_controller.gd"],
      ["scene_node:res://scenes/fixture_main.tscn:Main", "scene_node", "Main"],
      ["scene_node:res://scenes/fixture_main.tscn:FixtureActor", "scene_node", "FixtureActor"],
    ]);
    expect(graph.edges.map((edge) => [edge.source, edge.target, edge.kind])).toEqual([
      ["scene:res://scenes/fixture_main.tscn", "resource:res://scenes/fixture_actor.tscn", "loads_resource"],
      [
        "scene:res://scenes/fixture_main.tscn",
        "resource:res://scripts/game_controller.gd",
        "loads_resource",
      ],
      ["scene:res://scenes/fixture_main.tscn", "scene_node:res://scenes/fixture_main.tscn:Main", "contains"],
      [
        "scene_node:res://scenes/fixture_main.tscn:Main",
        "resource:res://scripts/game_controller.gd",
        "attaches_script",
      ],
      [
        "scene:res://scenes/fixture_main.tscn",
        "scene_node:res://scenes/fixture_main.tscn:FixtureActor",
        "contains",
      ],
      [
        "scene_node:res://scenes/fixture_main.tscn:FixtureActor",
        "resource:res://scenes/fixture_actor.tscn",
        "instantiates_scene",
      ],
    ]);
    expect(graph.unresolvedRefs).toEqual([]);
  });

  it("extracts editor signal connection unresolved refs", () => {
    const graph = extractGodotResourceGraph(
      parseFixture("signals/fixture_main.tscn", "res://fixture_main.tscn"),
      { updatedAt: 2000 },
    );

    expect(graph.unresolvedRefs).toEqual([
      {
        fromNodeId: "scene_node:res://fixture_main.tscn:StartButton",
        referenceName: "_on_start_button_pressed",
        referenceKind: "editor_signal_connection",
        filePath: "res://fixture_main.tscn",
        line: 10,
        column: null,
        candidates: [
          {
            signal: "pressed",
            targetNodePath: ".",
          },
        ],
      },
    ]);
  });

  it("anchors root editor signal connections to the scene root node", () => {
    const graph = extractGodotResourceGraph(
      parseGodotResource(
        `[gd_scene format=3]

[node name="InspectorItem" type="PanelContainer"]

[connection signal="focus_entered" from="." to="." method="_on_focus_entered"]
`,
        "res://addons/example_plugin/editor/inspector_item.tscn",
      ),
      { updatedAt: 2500 },
    );

    expect(graph.nodes.map((node) => node.id)).toContain(
      "scene_node:res://addons/example_plugin/editor/inspector_item.tscn:InspectorItem",
    );
    expect(graph.unresolvedRefs).toEqual([
      expect.objectContaining({
        fromNodeId:
          "scene_node:res://addons/example_plugin/editor/inspector_item.tscn:InspectorItem",
        referenceName: "_on_focus_entered",
        referenceKind: "editor_signal_connection",
      }),
    ]);
  });

  it("extracts a resource node from a tres file", () => {
    const graph = extractGodotResourceGraph(
      parseFixture("resources/resources/fixture_stats.tres", "res://resources/fixture_stats.tres"),
      { updatedAt: 3000 },
    );

    expect(graph.nodes).toEqual([
      expect.objectContaining({
        id: "resource:res://resources/fixture_stats.tres",
        kind: "resource",
        name: "fixture_stats.tres",
        qualifiedName: "res://resources/fixture_stats.tres",
        metadata: {
          format: 3,
          properties: {
            health: 10,
            resource_name: "FixtureStats",
            speed: 120,
          },
          type: "Resource",
          uid: "uid://playerstats",
        },
      }),
    ]);
    expect(graph.edges).toEqual([]);
    expect(graph.unresolvedRefs).toEqual([]);
  });

  it("extracts tres ext resources, sub resources, and script attachment edges", () => {
    const parsed = parseGodotResource(
      `[gd_resource type="Resource" format=3]

[ext_resource type="Script" path="res://scripts/rule_data.gd" id="1_rule"]
[ext_resource type="Script" path="res://scripts/condition_data.gd" id="2_condition"]

[sub_resource type="Resource" id="Condition"]
script = ExtResource("2_condition")
condition_type = "state_equals"

[resource]
script = ExtResource("1_rule")
conditions = Array[ExtResource("2_condition")]([SubResource("Condition")])
`,
      "res://resources/rules/demo_rule.tres",
    );

    const graph = extractGodotResourceGraph(parsed, { updatedAt: 4000 });

    expect(graph.nodes.map((node) => [node.id, node.kind, node.name])).toEqual([
      ["resource:res://resources/rules/demo_rule.tres", "resource", "demo_rule.tres"],
      ["resource:res://scripts/rule_data.gd", "resource", "rule_data.gd"],
      ["resource:res://scripts/condition_data.gd", "resource", "condition_data.gd"],
      ["resource:res://resources/rules/demo_rule.tres#Condition", "resource", "Condition"],
    ]);
    expect(graph.edges.map((edge) => [edge.source, edge.target, edge.kind])).toEqual([
      [
        "resource:res://resources/rules/demo_rule.tres",
        "resource:res://scripts/rule_data.gd",
        "loads_resource",
      ],
      [
        "resource:res://resources/rules/demo_rule.tres",
        "resource:res://scripts/condition_data.gd",
        "loads_resource",
      ],
      [
        "resource:res://resources/rules/demo_rule.tres",
        "resource:res://scripts/rule_data.gd",
        "attaches_script",
      ],
      [
        "resource:res://resources/rules/demo_rule.tres",
        "resource:res://resources/rules/demo_rule.tres#Condition",
        "contains",
      ],
      [
        "resource:res://resources/rules/demo_rule.tres#Condition",
        "resource:res://scripts/condition_data.gd",
        "attaches_script",
      ],
    ]);
    expect(graph.unresolvedRefs).toEqual([]);
  });
});
