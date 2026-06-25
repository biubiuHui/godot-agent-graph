import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SQLITE_BUSY_TIMEOUT_MS = 1_000;

export interface GraphDatabase {
  projectRoot: string;
  graphDir: string;
  databasePath: string;
  sqlite: Database.Database;
  close: () => void;
}

export function createGraphDatabase(projectRoot: string): GraphDatabase {
  const graphDir = join(projectRoot, ".gdgraph");
  const databasePath = join(graphDir, "graph.db");

  mkdirSync(graphDir, { recursive: true });

  const sqlite = new Database(databasePath);
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  sqlite.exec(loadSchemaSql());

  return {
    projectRoot,
    graphDir,
    databasePath,
    sqlite,
    close: () => sqlite.close(),
  };
}

function loadSchemaSql(): string {
  return readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
}
