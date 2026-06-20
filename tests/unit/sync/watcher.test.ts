import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { withGraphLock } from "../../../src/sync/lock.js";
import {
  createPendingFileTracker,
  shouldIgnoreWatchPath,
} from "../../../src/sync/watcher.js";

const tempRoots: string[] = [];

function tempProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "gdgraph-watch-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("watcher helpers", () => {
  it("ignores graph, Godot cache, import cache, git, and generated output paths", () => {
    const root = tempProjectRoot();

    expect(shouldIgnoreWatchPath(root, join(root, ".gdgraph", "graph.db"))).toBe(true);
    expect(shouldIgnoreWatchPath(root, join(root, ".git", "index"))).toBe(true);
    expect(shouldIgnoreWatchPath(root, join(root, ".godot", "editor"))).toBe(true);
    expect(shouldIgnoreWatchPath(root, join(root, ".import", "texture.png.import"))).toBe(true);
    expect(shouldIgnoreWatchPath(root, join(root, "dist", "bundle.js"))).toBe(true);
    expect(shouldIgnoreWatchPath(root, join(root, "scripts", "fixture_actor.gd"))).toBe(false);
  });

  it("tracks pending source files and marks freshness stale until cleared", () => {
    const root = tempProjectRoot();
    const tracker = createPendingFileTracker();

    tracker.markPending(root, join(root, "scripts", "fixture_actor.gd"));
    tracker.markPending(root, "res://scenes/fixture_main.tscn");

    expect(tracker.getFreshness(root, { lastSyncAt: 123, watcher: "active" })).toEqual({
      indexFresh: false,
      pendingFiles: [
        { indexing: false, path: "res://scenes/fixture_main.tscn" },
        { indexing: false, path: "res://scripts/fixture_actor.gd" },
      ],
      watcher: "active",
      lastSyncAt: 123,
    });

    tracker.clearPending(root, "res://scripts/fixture_actor.gd");

    expect(tracker.pendingFiles(root)).toEqual([
      { indexing: false, path: "res://scenes/fixture_main.tscn" },
    ]);

    tracker.clearPending(root);

    expect(tracker.getFreshness(root, { watcher: "active" }).indexFresh).toBe(true);
  });

  it("prevents nested graph writes with a filesystem lock", () => {
    const root = tempProjectRoot();

    expect(() =>
      withGraphLock(root, () => {
        withGraphLock(root, () => "nested");
      }),
    ).toThrow(/already locked/);
  });
});
