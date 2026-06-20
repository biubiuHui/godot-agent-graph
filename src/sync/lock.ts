import { closeSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export function withGraphLock<T>(projectRoot: string, callback: () => T): T {
  const graphDir = join(projectRoot, ".gdgraph");
  mkdirSync(graphDir, { recursive: true });

  const lockPath = join(graphDir, "graph.lock");
  let fileDescriptor: number | null = null;

  try {
    fileDescriptor = openSync(lockPath, "wx");
  } catch (error) {
    if (isFileExistsError(error)) {
      throw new Error(`Graph database is already locked: ${lockPath}`);
    }
    throw error;
  }

  try {
    return callback();
  } finally {
    if (fileDescriptor !== null) {
      closeSync(fileDescriptor);
    }
    unlinkSync(lockPath);
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
