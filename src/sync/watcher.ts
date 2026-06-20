import { readdirSync, watch, type FSWatcher } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export type WatcherState = "active" | "degraded" | "disabled";

export interface PendingFile {
  path: string;
  indexing: boolean;
}

export interface GraphFreshness {
  indexFresh: boolean;
  pendingFiles: PendingFile[];
  watcher: WatcherState;
  lastSyncAt: number | null;
}

export interface FreshnessOptions {
  watcher?: WatcherState;
  lastSyncAt?: number | null;
}

export interface PendingFileTracker {
  markPending(projectRoot: string, filePath: string): void;
  clearPending(projectRoot: string, filePath?: string): void;
  pendingFiles(projectRoot: string): PendingFile[];
  getFreshness(projectRoot: string, options?: FreshnessOptions): GraphFreshness;
}

export interface WatchGodotProjectOptions {
  debounceMs?: number;
  tracker?: PendingFileTracker;
  onSync?: () => void;
}

export interface GodotProjectWatcher {
  close(): void;
  tracker: PendingFileTracker;
  state: WatcherState;
}

const IGNORED_SEGMENTS = new Set([
  ".gdgraph",
  ".git",
  ".godot",
  ".import",
  "build",
  "dist",
  "node_modules",
]);

const IGNORED_FILE_SUFFIXES = [".import", ".uid"];

export const globalPendingFileTracker = createPendingFileTracker();

export function createPendingFileTracker(): PendingFileTracker {
  const pendingByRoot = new Map<string, Set<string>>();

  function pendingSet(projectRoot: string): Set<string> {
    const root = normalizeRoot(projectRoot);
    let pending = pendingByRoot.get(root);
    if (!pending) {
      pending = new Set();
      pendingByRoot.set(root, pending);
    }
    return pending;
  }

  return {
    markPending(projectRoot, filePath) {
      if (shouldIgnoreWatchPath(projectRoot, filePath)) {
        return;
      }
      pendingSet(projectRoot).add(toResPath(projectRoot, filePath));
    },

    clearPending(projectRoot, filePath) {
      if (filePath === undefined) {
        pendingSet(projectRoot).clear();
        return;
      }
      pendingSet(projectRoot).delete(toResPath(projectRoot, filePath));
    },

    pendingFiles(projectRoot) {
      return Array.from(pendingSet(projectRoot))
        .sort()
        .map((path) => ({ path, indexing: false }));
    },

    getFreshness(projectRoot, options = {}) {
      const pendingFiles = this.pendingFiles(projectRoot);
      return {
        indexFresh: pendingFiles.length === 0,
        pendingFiles,
        watcher: options.watcher ?? "disabled",
        lastSyncAt: options.lastSyncAt ?? null,
      };
    },
  };
}

export function shouldIgnoreWatchPath(projectRoot: string, filePath: string): boolean {
  const relativePath = relativeToRoot(projectRoot, filePath);
  if (relativePath.length === 0) {
    return false;
  }

  const segments = relativePath.split("/");
  if (segments.some((segment) => IGNORED_SEGMENTS.has(segment))) {
    return true;
  }

  return IGNORED_FILE_SUFFIXES.some((suffix) => relativePath.endsWith(suffix));
}

export function watchGodotProject(
  projectRoot: string,
  options: WatchGodotProjectOptions = {},
): GodotProjectWatcher {
  const root = normalizeRoot(projectRoot);
  const tracker = options.tracker ?? globalPendingFileTracker;
  const debounceMs = options.debounceMs ?? 250;
  const watchers: FSWatcher[] = [];
  let debounce: NodeJS.Timeout | null = null;
  let state: WatcherState = "active";

  const scheduleSync = (): void => {
    if (!options.onSync) {
      return;
    }
    if (debounce) {
      clearTimeout(debounce);
    }
    debounce = setTimeout(() => {
      debounce = null;
      options.onSync?.();
    }, debounceMs);
  };

  const watchDirectory = (directory: string): void => {
    const watcher = watch(directory, { recursive: process.platform !== "linux" }, (_event, fileName) => {
      const changedPath = fileName ? join(directory, fileName.toString()) : directory;
      if (shouldIgnoreWatchPath(root, changedPath)) {
        return;
      }
      tracker.markPending(root, changedPath);
      scheduleSync();
    });
    watcher.on("error", () => {
      state = "degraded";
    });
    watchers.push(watcher);
  };

  if (process.platform === "linux") {
    for (const directory of collectWatchDirectories(root)) {
      watchDirectory(directory);
    }
  } else {
    watchDirectory(root);
  }

  return {
    close() {
      if (debounce) {
        clearTimeout(debounce);
        debounce = null;
      }
      for (const watcher of watchers) {
        watcher.close();
      }
    },
    tracker,
    get state() {
      return state;
    },
  };
}

function collectWatchDirectories(root: string): string[] {
  const directories: string[] = [];

  function visit(directory: string): void {
    if (shouldIgnoreWatchPath(root, directory)) {
      return;
    }

    directories.push(directory);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        visit(join(directory, entry.name));
      }
    }
  }

  visit(root);
  return directories;
}

function toResPath(projectRoot: string, filePath: string): string {
  if (filePath.startsWith("res://")) {
    return filePath;
  }

  return `res://${relativeToRoot(projectRoot, filePath)}`;
}

function relativeToRoot(projectRoot: string, filePath: string): string {
  if (filePath.startsWith("res://")) {
    return filePath.replace(/^res:\/\//, "");
  }

  const root = normalizeRoot(projectRoot);
  const absolutePath = resolve(filePath);
  return relative(root, absolutePath).split(sep).join("/");
}

function normalizeRoot(projectRoot: string): string {
  return resolve(projectRoot);
}
