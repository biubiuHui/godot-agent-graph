import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { GraphDatabase } from "../db/index.js";
import { getProjectMetadata } from "../db/queries.js";
import { listIndexedFiles } from "../graph/queries.js";
import { scanGodotProject } from "../indexer/scan.js";
import {
  globalPendingFileTracker,
  type GraphFreshness,
  type PendingFile,
  type WatcherState,
} from "./watcher.js";

export function getGraphFreshness(
  projectRoot: string,
  graph: GraphDatabase,
  watcher: WatcherState = "disabled",
): GraphFreshness {
  const syncMetadata = getProjectMetadata(graph, "sync");
  const indexMetadata = getProjectMetadata(graph, "index");
  const timestamp = freshnessTimestamp(syncMetadata, indexMetadata);

  return globalPendingFileTracker.getFreshness(projectRoot, {
    watcher,
    lastSyncAt: timestamp.lastSyncAt,
    lastSyncAtSource: timestamp.source,
  });
}

export function getScanAwareGraphFreshness(
  projectRoot: string,
  graph: GraphDatabase,
  watcher: WatcherState = "disabled",
): GraphFreshness {
  const trackerFreshness = getGraphFreshness(projectRoot, graph, watcher);
  const scan = scanGodotProject(projectRoot);
  if (!scan.ok) {
    return trackerFreshness;
  }

  const previousFiles = new Map(
    listIndexedFiles(graph).map((file) => [file.path, file.contentHash] as const),
  );
  const currentFiles = new Map(
    scan.files.map((file) => [file.resPath, hashFile(file.absolutePath)] as const),
  );
  const scanPending: PendingFile[] = [];

  for (const [path, contentHash] of currentFiles) {
    const previousHash = previousFiles.get(path);
    if (!previousHash || previousHash !== contentHash) {
      scanPending.push({ path, indexing: false });
    }
  }

  for (const path of previousFiles.keys()) {
    if (!currentFiles.has(path)) {
      scanPending.push({ path, indexing: false });
    }
  }

  const pendingFiles = mergePendingFiles(trackerFreshness.pendingFiles, scanPending);
  return {
    ...trackerFreshness,
    indexFresh: pendingFiles.length === 0,
    pendingFiles,
  };
}

export function attachFreshness(
  payload: Record<string, unknown>,
  freshness: GraphFreshness,
): Record<string, unknown> {
  const staleFiles = freshness.pendingFiles.map((file) => file.path).sort();
  return {
    ...payload,
    ...freshness,
    ...(!freshness.indexFresh
      ? {
          stale: true,
          staleFileCount: staleFiles.length,
          staleFiles,
        }
      : {}),
    freshness,
  };
}

function getNumber(value: Record<string, unknown> | undefined, key: string): number | null {
  const field = value?.[key];
  return typeof field === "number" ? field : null;
}

function freshnessTimestamp(
  syncMetadata: ReturnType<typeof getProjectMetadata>,
  indexMetadata: ReturnType<typeof getProjectMetadata>,
): { lastSyncAt: number | null; source: GraphFreshness["lastSyncAtSource"] } {
  const syncValueTimestamp = getNumber(syncMetadata?.value, "lastSyncAt");
  if (syncValueTimestamp !== null) {
    return { lastSyncAt: syncValueTimestamp, source: "sync" };
  }

  if (syncMetadata?.updatedAt !== undefined) {
    return { lastSyncAt: syncMetadata.updatedAt, source: "sync" };
  }

  if (indexMetadata?.updatedAt !== undefined) {
    return { lastSyncAt: indexMetadata.updatedAt, source: "index" };
  }

  return { lastSyncAt: null, source: "unknown" };
}

function mergePendingFiles(left: PendingFile[], right: PendingFile[]): PendingFile[] {
  const byPath = new Map<string, PendingFile>();
  for (const file of [...left, ...right]) {
    byPath.set(file.path, file);
  }
  return Array.from(byPath.values()).sort((a, b) => a.path.localeCompare(b.path));
}

function hashFile(absolutePath: string): string {
  return createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
}
