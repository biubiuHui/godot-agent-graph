import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { createGraphDatabase } from "../db/index.js";
import { upsertProjectMetadata } from "../db/queries.js";
import { listIndexedFiles } from "../graph/queries.js";
import { indexGodotProject } from "../indexer/indexer.js";
import { scanGodotProject, type GodotProjectScanOk } from "../indexer/scan.js";
import { withGraphLock } from "./lock.js";

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
  lastSyncAt: number;
}

export interface SyncGodotProjectError {
  ok: false;
  projectRoot: string;
  reason: string;
  message: string;
}

export type SyncGodotProjectResult = SyncGodotProjectOk | SyncGodotProjectError;

interface CurrentFileHash {
  path: string;
  contentHash: string;
}

export function syncGodotProject(projectRoot: string): SyncGodotProjectResult {
  const scan = scanGodotProject(projectRoot);
  if (!scan.ok) {
    return {
      ok: false,
      projectRoot: scan.root,
      reason: scan.reason,
      message: scan.message,
    };
  }

  return withGraphLock(scan.root, () => syncScannedGodotProject(scan));
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

  const indexed = indexGodotProject(scan.root);
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
    lastSyncAt,
  };
}

function hashFile(absolutePath: string): string {
  return createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
}
