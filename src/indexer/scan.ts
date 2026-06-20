import { readdirSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

import { detectGodotProject, type GodotProjectMissing } from "../project.js";
import type { FileKind } from "../types.js";

const IGNORED_DIRECTORIES = new Set([
  ".gdgraph",
  ".git",
  ".godot",
  ".import",
  "addons",
  "build",
  "demo",
  "dist",
  "node_modules",
]);

const INDEXABLE_EXTENSIONS: Record<string, FileKind> = {
  ".gd": "gdscript",
  ".tscn": "scene",
  ".tres": "resource",
};

export interface ScannedGodotFile {
  absolutePath: string;
  relativePath: string;
  resPath: string;
  kind: FileKind;
}

export interface GodotProjectScanOk {
  ok: true;
  root: string;
  projectFilePath: string;
  files: ScannedGodotFile[];
}

export type GodotProjectScanResult = GodotProjectScanOk | GodotProjectMissing;

export function scanGodotProject(projectRoot: string): GodotProjectScanResult {
  const detection = detectGodotProject(projectRoot);

  if (!detection.ok) {
    return detection;
  }

  const files: ScannedGodotFile[] = [];
  collectFiles(detection.root, detection.root, files);

  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  return {
    ok: true,
    root: detection.root,
    projectFilePath: detection.projectFilePath,
    files,
  };
}

function collectFiles(root: string, currentDirectory: string, files: ScannedGodotFile[]): void {
  const entries = readdirSync(currentDirectory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  );

  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }

    const absolutePath = join(currentDirectory, entry.name);

    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) {
        collectFiles(root, absolutePath, files);
      }
      continue;
    }

    if (!entry.isFile() || isIgnoredFile(entry.name)) {
      continue;
    }

    const kind = getFileKind(entry.name);
    if (!kind) {
      continue;
    }

    const relativePath = toPosixPath(relative(root, absolutePath));
    files.push({
      absolutePath,
      relativePath,
      resPath: `res://${relativePath}`,
      kind,
    });
  }
}

function getFileKind(fileName: string): FileKind | null {
  if (fileName === "project.godot") {
    return "project";
  }

  return INDEXABLE_EXTENSIONS[extname(fileName)] ?? null;
}

function isIgnoredFile(fileName: string): boolean {
  return fileName.endsWith(".import") || fileName.endsWith(".uid");
}

function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}
