import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { createGraphDatabase } from "../db/index.js";
import { upsertProjectMetadata } from "../db/queries.js";
import { getProjectOverview, listIndexedFiles } from "../graph/queries.js";
import { indexGodotProjectIncremental } from "../indexer/indexer.js";
import { scanGodotProject, type GodotProjectScanOk } from "../indexer/scan.js";
import { GraphLockError, withGraphLock } from "./lock.js";

export interface SyncGodotProjectOk {
  ok: true;
  projectRoot: string;
  databasePath: string;
  added: string[];
  modified: string[];
  deleted: string[];
  fileCount: number;
  nodeCount: number;
  edgeCount: number;
  unresolvedRefCount: number;
  parseErrors: string[];
  parseErrorScope: "gdgraph_static_parse";
  compilerChecked: false;
  lastSyncAt: number;
  changeScope: "graph_index";
  message: string;
}

export interface SyncGodotProjectError {
  ok: false;
  projectRoot: string;
  reason: string;
  message: string;
  retryAfterMs?: number;
  lockKind?: "graph_write";
}

export type SyncGodotProjectResult = SyncGodotProjectOk | SyncGodotProjectError;

interface CurrentFileHash {
  path: string;
  contentHash: string;
}

interface SyncIndexSummary {
  ok: true;
  projectRoot: string;
  databasePath: string;
  fileCount: number;
  nodeCount: number;
  edgeCount: number;
  unresolvedRefCount: number;
  parseErrors: string[];
}

export interface SyncGodotProjectOptions {
  lockRetryMs?: number;
  lockRetryIntervalMs?: number;
}

const GRAPH_INDEX_DELTA_MESSAGE =
  "Synchronized graph index. Delta fields describe graph index changes, not Git status.";
const GRAPH_LOCK_RETRY_AFTER_MS = 1_000;

export function syncGodotProject(
  projectRoot: string,
  options: SyncGodotProjectOptions = {},
): SyncGodotProjectResult {
  const scan = scanGodotProject(projectRoot);
  if (!scan.ok) {
    return {
      ok: false,
      projectRoot: scan.root,
      reason: scan.reason,
      message: scan.message,
    };
  }

  try {
    return withGraphLock(scan.root, () => syncScannedGodotProject(scan), {
      retryMs: options.lockRetryMs,
      retryIntervalMs: options.lockRetryIntervalMs,
    });
  } catch (error) {
    if (error instanceof GraphLockError) {
      return {
        ok: false,
        projectRoot: scan.root,
        reason: "locked",
        retryAfterMs: GRAPH_LOCK_RETRY_AFTER_MS,
        lockKind: "graph_write",
        message: error.message,
      };
    }
    throw error;
  }
}

function syncScannedGodotProject(scan: GodotProjectScanOk): SyncGodotProjectResult {
  const graph = createGraphDatabase(scan.root);
  let previousFiles: Map<string, string>;
  try {
    previousFiles = new Map(
      listIndexedFiles(graph).map((file) => [file.path, file.contentHash] as const),
    );
  } finally {
    graph.close();
  }

  const currentFiles = new Map(
    scan.files.map((file): [string, CurrentFileHash] => [
      file.resPath,
      {
        path: file.resPath,
        contentHash: hashFile(file.absolutePath),
      },
    ]),
  );

  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];

  for (const [path, file] of currentFiles) {
    const previousHash = previousFiles.get(path);
    if (!previousHash) {
      added.push(path);
    } else if (previousHash !== file.contentHash) {
      modified.push(path);
    }
  }

  for (const path of previousFiles.keys()) {
    if (!currentFiles.has(path)) {
      deleted.push(path);
    }
  }

  const indexed = hasGraphChanges(added, modified, deleted)
    ? indexGodotProjectIncremental(scan.root, {
        changedAbsolutePaths: changedAbsolutePaths(scan, [...added, ...modified]),
        deletedPaths: deleted,
        currentResPaths: scan.files.map((file) => file.resPath),
      })
    : currentIndexSummary(scan.root);
  if (!indexed.ok) {
    return {
      ok: false,
      projectRoot: indexed.projectRoot,
      reason: indexed.reason,
      message: indexed.message,
    };
  }

  const lastSyncAt = Date.now();
  const refreshedGraph = createGraphDatabase(scan.root);
  try {
    upsertProjectMetadata(refreshedGraph, {
      key: "sync",
      value: {
        lastSyncAt,
        added,
        modified,
        deleted,
      },
      updatedAt: lastSyncAt,
    });
  } finally {
    refreshedGraph.close();
  }

  return {
    ok: true,
    projectRoot: scan.root,
    databasePath: indexed.databasePath,
    added: added.sort(),
    modified: modified.sort(),
    deleted: deleted.sort(),
    fileCount: indexed.fileCount,
    nodeCount: indexed.nodeCount,
    edgeCount: indexed.edgeCount,
    unresolvedRefCount: indexed.unresolvedRefCount,
    parseErrors: indexed.parseErrors,
    parseErrorScope: "gdgraph_static_parse",
    compilerChecked: false,
    lastSyncAt,
    changeScope: "graph_index",
    message: GRAPH_INDEX_DELTA_MESSAGE,
  };
}

function hasGraphChanges(added: string[], modified: string[], deleted: string[]): boolean {
  return added.length > 0 || modified.length > 0 || deleted.length > 0;
}

function changedAbsolutePaths(scan: GodotProjectScanOk, paths: string[]): string[] {
  const changed = new Set(paths);
  return scan.files
    .filter((file) => changed.has(file.resPath))
    .map((file) => file.absolutePath);
}

function currentIndexSummary(projectRoot: string): SyncIndexSummary {
  const graph = createGraphDatabase(projectRoot);
  try {
    const overview = getProjectOverview(graph);
    return {
      ok: true,
      projectRoot,
      databasePath: graph.databasePath,
      fileCount: overview.fileCount,
      nodeCount: overview.nodeCount,
      edgeCount: overview.edgeCount,
      unresolvedRefCount: overview.unresolvedRefCount,
      parseErrors: listIndexedFiles(graph).flatMap((file) =>
        file.parseErrors.map((error) => `${file.path}: ${error}`),
      ),
    };
  } finally {
    graph.close();
  }
}

function hashFile(absolutePath: string): string {
  return createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
}
