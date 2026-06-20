import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createGraphDatabase } from "../../../src/db/index.js";
import { getNode, listEdges, listUnresolvedRefs } from "../../../src/db/queries.js";
import { indexGodotProject } from "../../../src/indexer/indexer.js";

const fixturesRoot = fileURLToPath(new URL("../../fixtures/godot", import.meta.url));
const tempRoots: string[] = [];

function indexedFixture(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `gdgraph-resolver-${name}-`));
  tempRoots.push(root);
  cpSync(join(fixturesRoot, name), root, { recursive: true });
  const result = indexGodotProject(root);
  expect(result.ok).toBe(true);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("resolver", () => {
  it("resolves main scene and script attachments", () => {
    const graph = createGraphDatabase(indexedFixture("minimal"));
    try {
      expect(listEdges(graph, { kind: "main_scene" })).toEqual([
        expect.objectContaining({
          source: "project",
          target: "scene:res://fixture_main.tscn",
          provenance: "resolver",
        }),
      ]);
      expect(listEdges(graph, { kind: "attaches_script" })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "scene_node:res://fixture_main.tscn:FixtureActor",
            target: "script:res://scripts/fixture_actor.gd",
            provenance: "resolver",
          }),
        ]),
      );
    } finally {
      graph.close();
    }
  });

  it("resolves scene instances", () => {
    const graph = createGraphDatabase(indexedFixture("scene-composition"));
    try {
      expect(listEdges(graph, { kind: "instantiates_scene" })).toEqual(
        expect.arrayContaining([
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

  it("resolves get_node paths through typed scene receivers", () => {
    const root = indexedFixture("minimal");
    mkdirSync(join(root, "scenes"), { recursive: true });
    writeFileSync(
      join(root, "scripts", "fixture_main_screen.gd"),
      `extends Node
class_name FixtureScreenRoot
`,
    );
    writeFileSync(
      join(root, "scripts", "nodepath_caller.gd"),
      `extends Node
class_name NodePathCaller

func inspect(screen: FixtureScreenRoot) -> void:
\tscreen.get_node("RootLayout/CenterColumn/ContentPanel")
`,
    );
    writeFileSync(
      join(root, "fixture_main.tscn"),
      `[gd_scene load_steps=2 format=3 uid="uid://typednodepath"]

[ext_resource type="Script" path="res://scripts/fixture_main_screen.gd" id="1_screen"]

[node name="FixtureScreenRoot" type="Node"]
script = ExtResource("1_screen")

[node name="RootLayout" type="Node" parent="."]

[node name="CenterColumn" type="Node" parent="RootLayout"]

[node name="ContentPanel" type="Node" parent="RootLayout/CenterColumn"]
`,
    );
    const result = indexGodotProject(root);
    expect(result.ok).toBe(true);

    const graph = createGraphDatabase(root);
    try {
      expect(listEdges(graph, { kind: "references_nodepath" })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "method:res://scripts/nodepath_caller.gd:inspect",
            target: "scene_node:res://fixture_main.tscn:RootLayout/CenterColumn/ContentPanel",
            provenance: "resolver",
          }),
        ]),
      );
      expect(
        listUnresolvedRefs(graph).filter(
          (ref) =>
            ref.referenceKind === "references_nodepath" &&
            ref.referenceName === "RootLayout/CenterColumn/ContentPanel" &&
            ref.filePath === "res://scripts/nodepath_caller.gd",
        ),
      ).toEqual([]);
    } finally {
      graph.close();
    }
  });

  it("resolves autoload and input action references", () => {
    const graph = createGraphDatabase(indexedFixture("autoload-input"));
    try {
      expect(listEdges(graph, { kind: "uses_input_action" })).toEqual([
        expect.objectContaining({
          source: "method:res://scripts/fixture_input.gd:_process",
          target: "input_action:move_left",
          provenance: "resolver",
        }),
      ]);
      expect(listEdges(graph, { kind: "uses_autoload" })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "method:res://scripts/fixture_input.gd:_process",
            target: "autoload:FixtureState",
            provenance: "resolver",
          }),
          expect.objectContaining({
            source: "method:res://scripts/fixture_input.gd:_process",
            target: "autoload:FixtureSaveService",
            provenance: "resolver",
          }),
        ]),
      );
      expect(listEdges(graph, { kind: "loads_resource" })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "autoload:FixtureState",
            target: "script:res://scripts/fixture_state.gd",
            provenance: "resolver",
          }),
          expect.objectContaining({
            source: "autoload:FixtureSaveService",
            target: "script:res://scripts/fixture_save_service.gd",
            provenance: "resolver",
          }),
        ]),
      );
    } finally {
      graph.close();
    }
  });

  it("does not resolve root node lookups to autoloads when project.godot has no matching autoload", () => {
    const graph = createGraphDatabase(indexedFixture("root-node-not-autoload"));
    try {
      expect(getNode(graph, "scene_node:res://fixture_main.tscn:FixtureSaveService")).toEqual(
        expect.objectContaining({
          kind: "scene_node",
          name: "FixtureSaveService",
        }),
      );
      expect(getNode(graph, "autoload:FixtureSaveService")).toBeNull();
      expect(listEdges(graph, { kind: "uses_autoload" })).toEqual([]);
      expect(
        listUnresolvedRefs(graph)
          .filter((ref) => ref.referenceKind === "references_nodepath")
          .map((ref) => ref.referenceName)
          .sort(),
      ).toEqual(["/root/FixtureSaveService", "FixtureSaveService"]);
    } finally {
      graph.close();
    }
  });

  it("resolves load and preload resource paths", () => {
    const graph = createGraphDatabase(indexedFixture("resources"));
    try {
      expect(listEdges(graph, { kind: "preloads_resource" })).toEqual([
        expect.objectContaining({
          source: "script:res://scripts/resource_user.gd",
          target: "resource:res://resources/fixture_stats.tres",
          provenance: "resolver",
        }),
      ]);
      expect(listEdges(graph, { kind: "loads_resource" })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "method:res://scripts/resource_user.gd:load_runtime_stats",
            target: "resource:res://resources/fixture_stats.tres",
            provenance: "resolver",
          }),
        ]),
      );
    } finally {
      graph.close();
    }
  });

  it("resolves editor signal connections to uniquely named methods", () => {
    const graph = createGraphDatabase(indexedFixture("signals"));
    try {
      expect(listEdges(graph, { kind: "connects_signal" })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "scene_node:res://fixture_main.tscn:StartButton",
            target: "method:res://scripts/signal_demo.gd:_on_start_button_pressed",
            provenance: "resolver",
          }),
          expect.objectContaining({
            source: "method:res://scripts/signal_demo.gd:_ready",
            target: "method:res://scripts/signal_demo.gd:_on_health_depleted",
            provenance: "resolver",
          }),
        ]),
      );
    } finally {
      graph.close();
    }
  });

  it("resolves method calls to the same script before falling back to global uniqueness", () => {
    const root = indexedFixture("minimal");
    writeFileSync(
      join(root, "scripts", "fixture_actor.gd"),
      `extends CharacterBody2D
class_name FixtureActor

func _ready() -> void:
\tshared_helper()

func shared_helper() -> void:
\tpass
`,
    );
    writeFileSync(
      join(root, "scripts", "other.gd"),
      `extends Node
class_name Other

func shared_helper() -> void:
\tpass
`,
    );
    const result = indexGodotProject(root);
    expect(result.ok).toBe(true);

    const graph = createGraphDatabase(root);
    try {
      expect(listEdges(graph, { kind: "calls" })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "method:res://scripts/fixture_actor.gd:_ready",
            target: "method:res://scripts/fixture_actor.gd:shared_helper",
            provenance: "resolver",
          }),
        ]),
      );
    } finally {
      graph.close();
    }
  });

  it("resolves qualified static method calls by script class receiver", () => {
    const root = indexedFixture("minimal");
    writeFileSync(
      join(root, "scripts", "factory.gd"),
      `extends RefCounted
class_name Factory

static func create() -> Dictionary:
\treturn {}
`,
    );
    writeFileSync(
      join(root, "scripts", "other_factory.gd"),
      `extends RefCounted
class_name OtherFactory

static func create() -> Dictionary:
\treturn {}
`,
    );
    writeFileSync(
      join(root, "scripts", "caller.gd"),
      `extends Node
class_name Caller

func _ready() -> void:
\tFactory.create()
`,
    );
    const result = indexGodotProject(root);
    expect(result.ok).toBe(true);

    const graph = createGraphDatabase(root);
    try {
      expect(listEdges(graph, { kind: "calls" })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "method:res://scripts/caller.gd:_ready",
            target: "method:res://scripts/factory.gd:create",
            provenance: "resolver",
          }),
        ]),
      );
      expect(
        listUnresolvedRefs(graph).filter(
          (ref) =>
            ref.referenceKind === "calls" &&
            ref.referenceName === "create" &&
            ref.filePath === "res://scripts/caller.gd",
        ),
      ).toEqual([]);
    } finally {
      graph.close();
    }
  });

  it("resolves typed instance method calls from parameter and property receivers", () => {
    const root = indexedFixture("minimal");
    writeFileSync(
      join(root, "scripts", "fixture_grid.gd"),
      `extends RefCounted
class_name FixtureGrid

func get_item(position: Vector2i) -> Resource:
\treturn null
`,
    );
    writeFileSync(
      join(root, "scripts", "fixture_session.gd"),
      `extends RefCounted
class_name FixtureSession

var grid: FixtureGrid
`,
    );
    writeFileSync(
      join(root, "scripts", "fixture_repository.gd"),
      `extends RefCounted
class_name FixtureRepository

func get_item(id: String) -> Resource:
\treturn null
`,
    );
    writeFileSync(
      join(root, "scripts", "fixture_item.gd"),
      `extends Resource
class_name FixtureItem

func validate() -> PackedStringArray:
\treturn []
`,
    );
    writeFileSync(
      join(root, "scripts", "fixture_tag.gd"),
      `extends Resource
class_name FixtureTag

func validate() -> PackedStringArray:
\treturn []
`,
    );
    writeFileSync(
      join(root, "scripts", "fixture_snapshot.gd"),
      `extends RefCounted
class_name FixtureSnapshot
`,
    );
    writeFileSync(
      join(root, "scripts", "metric_widget.gd"),
      `extends Node
class_name MetricWidget

func apply_fixture(snapshot: FixtureSnapshot) -> void:
\tpass
`,
    );
    writeFileSync(
      join(root, "scripts", "other_panel.gd"),
      `extends Node
class_name OtherPanel

func apply_fixture(snapshot: FixtureSnapshot) -> void:
\tpass
`,
    );
    writeFileSync(
      join(root, "scripts", "caller.gd"),
      `extends Node
class_name Caller

const FixtureRepositoryScript := preload("res://scripts/fixture_repository.gd")

func inspect_direct(grid: FixtureGrid) -> void:
\tgrid.get_item(Vector2i.ZERO)

func inspect_nested(session: FixtureSession) -> void:
\tsession.grid.get_item(Vector2i.ZERO)

func inspect_local_alias(session: FixtureSession) -> void:
\tvar grid := session.grid
\tgrid.get_item(Vector2i.ZERO)

func inspect_local_type() -> void:
\tvar item: FixtureItem = FixtureItem.new()
\titem.validate()

func inspect_cast(snapshot: FixtureSnapshot) -> void:
\tvar metric_widget := make_panel() as MetricWidget
\tmetric_widget.apply_fixture(snapshot)

func inspect_helper_return(snapshot: FixtureSnapshot) -> void:
\tvar metric_widget := make_metric_widget()
\tmetric_widget.apply_fixture(snapshot)

func inspect_preload_constructor() -> void:
\tvar repository := FixtureRepositoryScript.new()
\trepository.get_item("item_id")

func make_panel() -> Node:
\treturn Node.new()

func make_metric_widget() -> MetricWidget:
\treturn MetricWidget.new()
`,
    );
    const result = indexGodotProject(root);
    expect(result.ok).toBe(true);

    const graph = createGraphDatabase(root);
    try {
      expect(listEdges(graph, { kind: "calls" })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "method:res://scripts/caller.gd:inspect_direct",
            target: "method:res://scripts/fixture_grid.gd:get_item",
            provenance: "resolver",
          }),
          expect.objectContaining({
            source: "method:res://scripts/caller.gd:inspect_local_type",
            target: "method:res://scripts/fixture_item.gd:validate",
            provenance: "resolver",
          }),
          expect.objectContaining({
            source: "method:res://scripts/caller.gd:inspect_cast",
            target: "method:res://scripts/metric_widget.gd:apply_fixture",
            provenance: "resolver",
          }),
          expect.objectContaining({
            source: "method:res://scripts/caller.gd:inspect_preload_constructor",
            target: "method:res://scripts/fixture_repository.gd:get_item",
            provenance: "resolver",
          }),
        ]),
      );
      expect(
        listUnresolvedRefs(graph).filter(
          (ref) =>
            ref.referenceKind === "calls" &&
            (
              ref.referenceName === "get_item" ||
              ref.referenceName === "validate" ||
              ref.referenceName === "apply_fixture"
            ) &&
            ref.filePath === "res://scripts/caller.gd",
        ),
      ).toEqual([]);
    } finally {
      graph.close();
    }
  });

  it("resolves path-based script inheritance", () => {
    const root = indexedFixture("minimal");
    writeFileSync(
      join(root, "scripts", "base.gd"),
      `extends RefCounted
class_name BaseScript

func shared() -> void:
\tpass
`,
    );
    writeFileSync(
      join(root, "scripts", "child.gd"),
      `extends "res://scripts/base.gd"
class_name ChildScript
`,
    );
    const result = indexGodotProject(root);
    expect(result.ok).toBe(true);

    const graph = createGraphDatabase(root);
    try {
      expect(listEdges(graph, { kind: "extends" })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "script:res://scripts/child.gd",
            target: "script:res://scripts/base.gd",
            provenance: "resolver",
          }),
        ]),
      );
      expect(
        listUnresolvedRefs(graph).filter(
          (ref) =>
            ref.referenceKind === "extends" &&
            ref.referenceName === "res://scripts/base.gd",
        ),
      ).toEqual([]);
    } finally {
      graph.close();
    }
  });
});
