import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createGraphDatabase } from "../../../src/db/index.js";
import {
  findEdges,
  findNodeById,
  getProjectOverview,
  listIndexedFiles,
} from "../../../src/graph/queries.js";
import { indexGodotProject } from "../../../src/indexer/indexer.js";
import { searchGraph } from "../../../src/search/index.js";

const fixturesRoot = fileURLToPath(new URL("../../fixtures/godot", import.meta.url));
const tempRoots: string[] = [];

function indexedFixture(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `gdgraph-query-${name}-`));
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

describe("graph query APIs", () => {
  it("returns project overview, files, nodes, edges, and FTS search results", () => {
    const root = indexedFixture("signals");
    const graph = createGraphDatabase(root);

    try {
      expect(getProjectOverview(graph)).toEqual(
        expect.objectContaining({
          fileCount: 3,
          nodeCount: expect.any(Number),
          edgeCount: expect.any(Number),
          unresolvedRefCount: expect.any(Number),
          project: expect.objectContaining({
            name: "SignalsFixture",
            mainScene: "res://fixture_main.tscn",
          }),
        }),
      );

      expect(listIndexedFiles(graph).map((file) => file.path)).toEqual([
        "res://fixture_main.tscn",
        "res://project.godot",
        "res://scripts/signal_demo.gd",
      ]);
      expect(findNodeById(graph, "signal:res://scripts/signal_demo.gd:health_depleted")).toEqual(
        expect.objectContaining({ kind: "signal" }),
      );
      expect(findEdges(graph, { kind: "contains" }).length).toBeGreaterThan(0);
      expect(searchGraph(graph, "health_depleted").map((node) => node.id)).toEqual(
        expect.arrayContaining(["signal:res://scripts/signal_demo.gd:health_depleted"]),
      );
    } finally {
      graph.close();
    }
  });
});
