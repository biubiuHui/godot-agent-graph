import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

interface GraphLockMetadata {
  pid: number;
  startedAt: number;
}

export function withGraphLock<T>(projectRoot: string, callback: () => T): T {
  const graphDir = join(projectRoot, ".gdgraph");
  mkdirSync(graphDir, { recursive: true });

  const lockPath = join(graphDir, "graph.lock");
  const fileDescriptor = acquireGraphLock(lockPath);

  try {
    return callback();
  } finally {
    closeSync(fileDescriptor);
    unlinkIfExists(lockPath);
  }
}

function acquireGraphLock(lockPath: string): number {
  for (;;) {
    try {
      const fileDescriptor = openSync(lockPath, "wx");
      writeSync(fileDescriptor, JSON.stringify(currentLockMetadata()));
      return fileDescriptor;
    } catch (error) {
      if (!isFileExistsError(error)) {
        throw error;
      }

      if (!removeStaleLock(lockPath)) {
        throw new Error(`Graph database is already locked: ${lockPath}`);
      }
    }
  }
}

function currentLockMetadata(): GraphLockMetadata {
  return {
    pid: process.pid,
    startedAt: Date.now(),
  };
}

function removeStaleLock(lockPath: string): boolean {
  let rawLock: string;
  try {
    rawLock = readFileSync(lockPath, "utf8").trim();
  } catch (error) {
    return isFileNotFoundError(error);
  }

  if (rawLock.length === 0) {
    unlinkIfExists(lockPath);
    return true;
  }

  try {
    const metadata = JSON.parse(rawLock) as Partial<GraphLockMetadata>;
    if (!isLivePid(metadata.pid)) {
      unlinkIfExists(lockPath);
      return true;
    }
  } catch {
    unlinkIfExists(lockPath);
    return true;
  }

  return false;
}

function isLivePid(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNoSuchProcessError(error)) {
      return false;
    }
    return true;
  }
}

function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      throw error;
    }
  }
}

function isFileExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isNoSuchProcessError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ESRCH"
  );
}
