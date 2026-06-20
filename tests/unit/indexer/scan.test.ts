import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { scanGodotProject } from "../../../src/indexer/scan.js";

const tempRoots: string[] = [];
const fixturesRoot = fileURLToPath(new URL("../../fixtures/godot", import.meta.url));

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "gdgraph-scan-"));
  tempRoots.push(root);
  return root;
}

function writeFixtureFile(root: string, relativePath: string, contents: string): void {
  const absolutePath = join(root, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents);
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("scanGodotProject", () => {
  it("scans the minimal fixture with deterministic Godot file metadata", () => {
    const result = scanGodotProject(join(fixturesRoot, "minimal"));

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.files.map((file) => [file.relativePath, file.resPath, file.kind])).toEqual([
      ["fixture_main.tscn", "res://fixture_main.tscn", "scene"],
      ["project.godot", "res://project.godot", "project"],
      ["scripts/fixture_actor.gd", "res://scripts/fixture_actor.gd", "gdscript"],
    ]);
  });

  it("ignores Godot caches, gdgraph state, import sidecars, VCS folders, and build output", () => {
    const root = createTempRoot();

    writeFixtureFile(root, "project.godot", "[application]\nconfig/name=\"IgnoreFixture\"\n");
    writeFixtureFile(root, "scripts/live.gd", "extends Node\n");
    writeFixtureFile(root, "levels/fixture_main.tscn", "[gd_scene format=3]\n[node name=\"Main\" type=\"Node\"]\n");
    writeFixtureFile(root, "resources/stats.tres", "[gd_resource type=\"Resource\" format=3]\n");
    writeFixtureFile(root, ".git/ignored.gd", "extends Node\n");
    writeFixtureFile(root, ".gdgraph/generated.gd", "extends Node\n");
    writeFixtureFile(root, ".godot/cache.gd", "extends Node\n");
    writeFixtureFile(root, ".import/cache.tscn", "[gd_scene format=3]\n");
    writeFixtureFile(root, "addons/example_plugin/plugin.gd", "extends EditorPlugin\n");
    writeFixtureFile(root, "demo/addons_sample.gd", "extends Node\n");
    writeFixtureFile(root, "dist/bundle.gd", "extends Node\n");
    writeFixtureFile(root, "assets/icon.png.import", "[remap]\n");

    const result = scanGodotProject(root);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.files.map((file) => file.relativePath)).toEqual([
      "levels/fixture_main.tscn",
      "project.godot",
      "resources/stats.tres",
      "scripts/live.gd",
    ]);
  });

  it("returns a clear status for non-Godot directories", () => {
    const root = createTempRoot();

    const result = scanGodotProject(root);

    expect(result).toEqual({
      ok: false,
      root,
      reason: "missing_project_godot",
      message: `No project.godot found in ${root}`,
    });
  });
});
