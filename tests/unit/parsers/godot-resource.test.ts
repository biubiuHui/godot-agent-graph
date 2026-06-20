import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseGodotResource } from "../../../src/parsers/godot-resource.js";

const fixturesRoot = fileURLToPath(new URL("../../fixtures/godot", import.meta.url));

function readFixture(relativePath: string): string {
  return readFileSync(join(fixturesRoot, relativePath), "utf8");
}

describe("parseGodotResource", () => {
  it("parses scene headers, ext resources, nodes, scripts, and instances", () => {
    const result = parseGodotResource(
      readFixture("scene-composition/scenes/fixture_main.tscn"),
      "res://scenes/fixture_main.tscn",
    );

    expect(result.kind).toBe("scene");
    expect(result.scene).toEqual({
      loadSteps: 3,
      format: 3,
      uid: "uid://compositionmain",
      line: 1,
    });
    expect(result.extResources).toEqual([
      {
        id: "1_fixture_actor_scene",
        type: "PackedScene",
        path: "res://scenes/fixture_actor.tscn",
        line: 3,
      },
      {
        id: "2_controller",
        type: "Script",
        path: "res://scripts/game_controller.gd",
        line: 4,
      },
    ]);
    expect(result.nodes).toEqual([
      {
        name: "Main",
        type: "Node2D",
        parent: null,
        instance: null,
        properties: {
          script: { kind: "ExtResource", id: "2_controller" },
        },
        line: 6,
      },
      {
        name: "FixtureActor",
        type: null,
        parent: ".",
        instance: { kind: "ExtResource", id: "1_fixture_actor_scene" },
        properties: {},
        line: 9,
      },
    ]);
    expect(result.errors).toEqual([]);
  });

  it("parses editor signal connections", () => {
    const result = parseGodotResource(
      readFixture("signals/fixture_main.tscn"),
      "res://fixture_main.tscn",
    );

    expect(result.connections).toEqual([
      {
        signal: "pressed",
        from: "StartButton",
        to: ".",
        method: "_on_start_button_pressed",
        line: 10,
      },
    ]);
  });

  it("parses tres resource headers and resource body assignments", () => {
    const result = parseGodotResource(
      readFixture("resources/resources/fixture_stats.tres"),
      "res://resources/fixture_stats.tres",
    );

    expect(result.kind).toBe("resource");
    expect(result.resource).toEqual({
      type: "Resource",
      format: 3,
      uid: "uid://playerstats",
      line: 1,
    });
    expect(result.resourceProperties).toEqual({
      resource_name: "FixtureStats",
      health: 10,
      speed: 120,
    });
    expect(result.errors).toEqual([]);
  });

  it("parses multiline dictionary and array resource assignments without noisy errors", () => {
    const result = parseGodotResource(
      `[gd_resource type="Resource" format=3]

[resource]
weights = {
"common": -5,
"rare": 2
}
items = [
"res://a.tres",
"res://b.tres"
]
`,
      "res://resources/profile.tres",
    );

    expect(result.resourceProperties).toEqual({
      weights: '{\n"common": -5,\n"rare": 2\n}',
      items: '[\n"res://a.tres",\n"res://b.tres"\n]',
    });
    expect(result.errors).toEqual([]);
  });
});
