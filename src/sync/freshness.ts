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
  return attachStatusFreshness(payload, freshness);
}

export function attachStatusFreshness(
  payload: Record<string, unknown>,
  freshness: GraphFreshness,
): Record<string, unknown> {
  const staleFiles = freshness.pendingFiles.map((file) => file.path).sort();
  const payloadHasStaleFiles = Object.prototype.hasOwnProperty.call(payload, "staleFiles");
  return {
    ...payload,
    ...freshness,
    pendingFileCount: freshness.pendingFiles.length,
    ...(!freshness.indexFresh
      ? {
          stale: true,
          staleFileCount: staleFiles.length,
          ...(payloadHasStaleFiles ? {} : { staleFiles }),
        }
      : {}),
  };
}

export function attachGraphQueryFreshness(
  payload: Record<string, unknown>,
  freshness: GraphFreshness,
): Record<string, unknown> {
  const stalePaths = freshness.pendingFiles.map((file) => file.path).sort();
  const compactStaleFiles = compactStaleFileRefs(payload, stalePaths);
  return {
    ...payload,
    indexFresh: freshness.indexFresh,
    pendingFileCount: freshness.pendingFiles.length,
    watcher: freshness.watcher,
    lastSyncAt: freshness.lastSyncAt,
    lastSyncAtSource: freshness.lastSyncAtSource,
    ...(!freshness.indexFresh
      ? {
          stale: true,
          staleFileCount: stalePaths.length,
          ...(compactStaleFiles.length > 0 ? { staleFiles: compactStaleFiles } : {}),
          ...(stalePaths.length > compactStaleFiles.length
            ? { staleFilesOmitted: stalePaths.length - compactStaleFiles.length }
            : {}),
        }
      : {}),
  };
}

function compactStaleFileRefs(payload: Record<string, unknown>, stalePaths: string[]): string[] {
  const pathToRef = payloadPathRefs(payload);
  return stalePaths
    .map((path) => pathToRef.get(path))
    .filter((ref): ref is string => Boolean(ref));
}

function payloadPathRefs(payload: Record<string, unknown>): Map<string, string> {
  const refs = new Map<string, string>();
  collectPathRefs(payload, refs);
  return refs;
}

function collectPathRefs(value: unknown, refs: Map<string, string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectPathRefs(item, refs);
    }
    return;
  }

  if (typeof value !== "object" || value === null) {
    return;
  }

  const record = value as Record<string, unknown>;
  const paths = record.paths;
  if (typeof paths === "object" && paths !== null && !Array.isArray(paths)) {
    const prefixes = typeof record.prefixes === "object" && record.prefixes !== null && !Array.isArray(record.prefixes)
      ? record.prefixes as Record<string, unknown>
      : {};
    for (const [ref, path] of Object.entries(paths as Record<string, unknown>)) {
      if (typeof path === "string") {
        const expandedPath = expandPathRef(path, prefixes);
        if (expandedPath.startsWith("res://")) {
          refs.set(expandedPath, ref);
        }
      }
    }
  }

  for (const item of Object.values(record)) {
    collectPathRefs(item, refs);
  }
}

function expandPathRef(path: string, prefixes: Record<string, unknown>): string {
  if (path.startsWith("res://")) {
    return path;
  }

  const [prefixRef, ...rest] = path.split("/");
  const prefix = prefixes[prefixRef];
  return typeof prefix === "string" && rest.length > 0
    ? `${prefix}${rest.join("/")}`
    : path;
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
