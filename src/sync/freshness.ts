import type { GraphDatabase } from "../db/index.js";
import { getProjectMetadata } from "../db/queries.js";
import {
  globalPendingFileTracker,
  type GraphFreshness,
  type WatcherState,
} from "./watcher.js";

export function getGraphFreshness(
  projectRoot: string,
  graph: GraphDatabase,
  watcher: WatcherState = "disabled",
): GraphFreshness {
  const syncMetadata = getProjectMetadata(graph, "sync");
  const indexMetadata = getProjectMetadata(graph, "index");
  const lastSyncAt =
    getNumber(syncMetadata?.value, "lastSyncAt") ??
    syncMetadata?.updatedAt ??
    indexMetadata?.updatedAt ??
    null;

  return globalPendingFileTracker.getFreshness(projectRoot, {
    watcher,
    lastSyncAt,
  });
}

export function attachFreshness(
  payload: Record<string, unknown>,
  freshness: GraphFreshness,
): Record<string, unknown> {
  return {
    ...payload,
    ...freshness,
    freshness,
  };
}

function getNumber(value: Record<string, unknown> | undefined, key: string): number | null {
  const field = value?.[key];
  return typeof field === "number" ? field : null;
}
