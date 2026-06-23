import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createGraphDatabase } from "../../../src/db/index.js";
import { getNode, listEdges, searchNodes } from "../../../src/db/queries.js";
import { getProjectOverview, listIndexedFiles } from "../../../src/graph/queries.js";
import { indexGodotProject } from "../../../src/indexer/indexer.js";

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
  it("returns project overview and indexed files", () => {
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
      expect(getNode(graph, "signal:res://scripts/signal_demo.gd:health_depleted")).toEqual(
        expect.objectContaining({ kind: "signal" }),
      );
      expect(listEdges(graph, { kind: "contains" }).length).toBeGreaterThan(0);
      expect(searchNodes(graph, "health_depleted").map((node) => node.id)).toEqual(
        expect.arrayContaining(["signal:res://scripts/signal_demo.gd:health_depleted"]),
      );
    } finally {
      graph.close();
    }
  });
});
