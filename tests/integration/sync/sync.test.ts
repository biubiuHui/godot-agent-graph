import { cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createGraphDatabase } from "../../../src/db/index.js";
import { getFile, getNode, listEdges, searchNodes } from "../../../src/db/queries.js";
import { indexGodotProject } from "../../../src/indexer/indexer.js";
import { syncGodotProject } from "../../../src/sync/index.js";
import { withGraphLock } from "../../../src/sync/lock.js";

const fixturesRoot = fileURLToPath(new URL("../../fixtures/godot", import.meta.url));
const tempRoots: string[] = [];

function indexedFixture(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `gdgraph-sync-${name}-`));
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

describe("syncGodotProject", () => {
  it("indexes only changed files without rewriting unchanged file records", async () => {
    const root = indexedFixture("minimal");
    const graphBefore = createGraphDatabase(root);
    let sceneIndexedAt: number;
    try {
      const sceneFile = getFile(graphBefore, "res://fixture_main.tscn");
      expect(sceneFile).not.toBeNull();
      sceneIndexedAt = sceneFile?.indexedAt ?? 0;
    } finally {
      graphBefore.close();
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
    writeFileSync(
      join(root, "scripts", "fixture_actor.gd"),
      `extends CharacterBody2D
class_name FixtureActor

func _ready() -> void:
\tpass

func added_after_index() -> void:
\tpass
`,
    );

    const result = syncGodotProject(root);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.added).toEqual([]);
      expect(result.modified).toEqual(["res://scripts/fixture_actor.gd"]);
      expect(result.deleted).toEqual([]);
    }

    const graphAfter = createGraphDatabase(root);
    try {
      expect(getFile(graphAfter, "res://fixture_main.tscn")?.indexedAt).toBe(sceneIndexedAt);
      expect(getNode(graphAfter, "method:res://scripts/fixture_actor.gd:added_after_index")).toEqual(
        expect.objectContaining({ kind: "method" }),
      );
    } finally {
      graphAfter.close();
    }
  });

  it("detects an added GDScript file and indexes its script class", () => {
    const root = indexedFixture("minimal");
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(
      join(root, "scripts", "new_spell.gd"),
      "extends Node\nclass_name NewSpell\n\nfunc cast() -> void:\n\tpass\n",
    );

    const result = syncGodotProject(root);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.added).toEqual(["res://scripts/new_spell.gd"]);
      expect(result.modified).toEqual([]);
      expect(result.deleted).toEqual([]);
      expect(result.changeScope).toBe("graph_index");
      expect(result.parseErrorScope).toBe("gdgraph_static_parse");
      expect(result.compilerChecked).toBe(false);
      expect(result.message).toContain("graph index");
    }

    const graph = createGraphDatabase(root);
    try {
      expect(searchNodes(graph, "NewSpell").map((node) => node.id)).toContain(
        "script:res://scripts/new_spell.gd",
      );
    } finally {
      graph.close();
    }
  });

  it("detects a modified scene file and updates scene node query output", () => {
    const root = indexedFixture("minimal");
    writeFileSync(
      join(root, "fixture_main.tscn"),
      `[gd_scene load_steps=2 format=3 uid="uid://minimalmain"]

[ext_resource type="Script" path="res://scripts/fixture_actor.gd" id="1_fixture_actor"]

[node name="Main" type="Node2D"]

[node name="Hero" type="CharacterBody2D" parent="."]
script = ExtResource("1_fixture_actor")
`,
    );

    const result = syncGodotProject(root);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.modified).toEqual(["res://fixture_main.tscn"]);
    }

    const graph = createGraphDatabase(root);
    try {
      const nodeNames = listEdges(graph, {
        source: "scene:res://fixture_main.tscn",
        kind: "contains",
      })
        .map((edge) => getNode(graph, edge.target))
        .filter((node) => node?.kind === "scene_node")
        .map((node) => node.name);
      expect(nodeNames).toContain("Hero");
      expect(nodeNames).not.toContain("FixtureActor");
    } finally {
      graph.close();
    }
  });

  it("recomputes resolver edges from unchanged callers to modified targets", () => {
    const root = indexedFixture("minimal");
    writeFileSync(
      join(root, "scripts", "sync_factory.gd"),
      `extends RefCounted
class_name SyncFactory

static func create() -> Dictionary:
\treturn {}
`,
    );
    writeFileSync(
      join(root, "scripts", "sync_caller.gd"),
      `extends Node
class_name SyncCaller

func _ready() -> void:
\tSyncFactory.create()
`,
    );
    const initialIndex = indexGodotProject(root);
    expect(initialIndex.ok).toBe(true);

    writeFileSync(
      join(root, "scripts", "sync_factory.gd"),
      `extends RefCounted
class_name SyncFactory

static func create() -> Dictionary:
\treturn {"updated": true}
`,
    );

    const result = syncGodotProject(root);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.modified).toEqual(["res://scripts/sync_factory.gd"]);
    }

    const graph = createGraphDatabase(root);
    try {
      expect(listEdges(graph, { kind: "calls" })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "method:res://scripts/sync_caller.gd:_ready",
            target: "method:res://scripts/sync_factory.gd:create",
            provenance: "resolver",
          }),
        ]),
      );
    } finally {
      graph.close();
    }
  });

  it("detects a deleted file and removes its nodes and resolved edges", () => {
    const root = indexedFixture("minimal");
    unlinkSync(join(root, "scripts", "fixture_actor.gd"));

    const result = syncGodotProject(root);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.deleted).toEqual(["res://scripts/fixture_actor.gd"]);
    }

    const graph = createGraphDatabase(root);
    try {
      expect(getNode(graph, "script:res://scripts/fixture_actor.gd")).toBeNull();
      expect(
        listEdges(graph, {
          target: "script:res://scripts/fixture_actor.gd",
          kind: "attaches_script",
        }),
      ).toEqual([]);
    } finally {
      graph.close();
    }
  });

  it("treats a moved GDScript file as deleted old path and added new path", () => {
    const root = indexedFixture("minimal");
    mkdirSync(join(root, "moved"), { recursive: true });
    renameSync(
      join(root, "scripts", "fixture_actor.gd"),
      join(root, "moved", "fixture_actor.gd"),
    );

    const result = syncGodotProject(root);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.added).toEqual(["res://moved/fixture_actor.gd"]);
      expect(result.modified).toEqual([]);
      expect(result.deleted).toEqual(["res://scripts/fixture_actor.gd"]);
    }

    const graph = createGraphDatabase(root);
    try {
      expect(getNode(graph, "script:res://scripts/fixture_actor.gd")).toBeNull();
      expect(getNode(graph, "script:res://moved/fixture_actor.gd")).toEqual(
        expect.objectContaining({ kind: "script_class", name: "FixtureActor" }),
      );
      expect(searchNodes(graph, "FixtureActor").map((node) => node.id)).toContain(
        "script:res://moved/fixture_actor.gd",
      );
      expect(
        listEdges(graph, {
          target: "script:res://scripts/fixture_actor.gd",
          kind: "attaches_script",
        }),
      ).toEqual([]);
    } finally {
      graph.close();
    }
  });

  it("treats a moved scene file as deleted old path and added new path with main scene resolution", () => {
    const root = indexedFixture("minimal");
    mkdirSync(join(root, "scenes"), { recursive: true });
    renameSync(join(root, "fixture_main.tscn"), join(root, "scenes", "fixture_main.tscn"));
    writeFileSync(
      join(root, "project.godot"),
      `; Engine configuration file.

[application]

config/name="MinimalFixture"
run/main_scene="res://scenes/fixture_main.tscn"
`,
    );

    const result = syncGodotProject(root);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.added).toEqual(["res://scenes/fixture_main.tscn"]);
      expect(result.modified).toEqual(["res://project.godot"]);
      expect(result.deleted).toEqual(["res://fixture_main.tscn"]);
    }

    const graph = createGraphDatabase(root);
    try {
      expect(getNode(graph, "scene:res://fixture_main.tscn")).toBeNull();
      expect(getNode(graph, "scene:res://scenes/fixture_main.tscn")).toEqual(
        expect.objectContaining({ kind: "scene" }),
      );
      expect(listEdges(graph, { kind: "main_scene" })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            target: "scene:res://scenes/fixture_main.tscn",
            provenance: "resolver",
          }),
        ]),
      );
      expect(listEdges(graph, { kind: "main_scene" })).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            target: "scene:res://fixture_main.tscn",
          }),
        ]),
      );
    } finally {
      graph.close();
    }
  });

  it("returns a structured error when sync cannot acquire a live graph lock", () => {
    const root = indexedFixture("minimal");

    const result = withGraphLock(root, () =>
      syncGodotProject(root, {
        lockRetryMs: 10,
        lockRetryIntervalMs: 1,
      }),
    );

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        reason: "locked",
        retryAfterMs: expect.any(Number),
        lockKind: "graph_write",
        message: expect.stringContaining("temporarily locked"),
      }),
    );
  });
});
