import { cpSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createGraphDatabase } from "../../../src/db/index.js";
import { getNode, listEdges, searchNodes } from "../../../src/db/queries.js";
import { getSceneDetails } from "../../../src/graph/queries.js";
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
      const nodeNames = getSceneDetails(graph, "res://fixture_main.tscn").nodes.map((node) => node.name);
      expect(nodeNames).toContain("Hero");
      expect(nodeNames).not.toContain("FixtureActor");
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
        message: expect.stringContaining("temporarily locked"),
      }),
    );
  });
});
