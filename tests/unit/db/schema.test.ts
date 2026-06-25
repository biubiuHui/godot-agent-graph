import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createGraphDatabase } from "../../../src/db/index.js";

const tempRoots: string[] = [];

function createTempProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "gdgraph-schema-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("createGraphDatabase", () => {
  it("creates the graph database and core schema tables", () => {
    const root = createTempProjectRoot();
    const graph = createGraphDatabase(root);

    try {
      expect(existsSync(graph.databasePath)).toBe(true);

      const tables = graph.sqlite
        .prepare(
          "select name from sqlite_master where type in ('table', 'virtual') order by name",
        )
        .all()
        .map((row) => (row as { name: string }).name);

      expect(tables).toEqual(
        expect.arrayContaining([
          "edges",
          "files",
          "nodes",
          "nodes_fts",
          "project_metadata",
          "unresolved_refs",
        ]),
      );
      const oldMigrationTableName = ["schema", "migrations"].join("_");
      expect(tables).not.toContain(oldMigrationTableName);

      const nodeColumns = graph.sqlite
        .pragma("table_info(nodes)")
        .map((row) => (row as { name: string }).name);
      expect(nodeColumns).toEqual(
        expect.arrayContaining([
          "address_kind",
          "owner_path",
          "readable_path",
          "display_path",
          "reference_path",
        ]),
      );

      const unresolvedRefColumns = graph.sqlite
        .pragma("table_info(unresolved_refs)")
        .map((row) => (row as { name: string }).name);
      expect(unresolvedRefColumns).toContain("resolved");
    } finally {
      graph.close();
    }
  });
});
