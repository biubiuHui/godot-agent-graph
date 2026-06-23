import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

import { createGraphDatabase } from "../db/index.js";
import {
  clearGraph,
  countEdges,
  countNodes,
  countUnresolvedRefs,
  deleteFilesFromGraph,
  deleteResolverEdges,
  getProjectMetadata,
  insertEdge,
  insertUnresolvedRef,
  upsertFile,
  upsertNode,
  upsertProjectMetadata,
} from "../db/queries.js";
import { listIndexedFiles } from "../graph/queries.js";
import { extractGdscriptGraph } from "./extract-gdscript.js";
import { extractProjectGodotGraph } from "./extract-project.js";
import { extractGodotResourceGraph } from "./extract-resource.js";
import { scanGodotProject } from "./scan.js";
import { parseGdscript } from "../parsers/gdscript.js";
import { parseGodotResource } from "../parsers/godot-resource.js";
import { parseProjectGodot } from "../parsers/project-godot.js";
import { resolveGraph } from "../resolver/index.js";
import type { GraphEdge, GraphFile, GraphNode, UnresolvedRef } from "../types.js";

export interface IndexGodotProjectOk {
  ok: true;
  projectRoot: string;
  databasePath: string;
  fileCount: number;
  nodeCount: number;
  edgeCount: number;
  unresolvedRefCount: number;
  parseErrors: string[];
}

export interface IndexGodotProjectError {
  ok: false;
  projectRoot: string;
  reason: string;
  message: string;
}

export type IndexGodotProjectResult = IndexGodotProjectOk | IndexGodotProjectError;

interface CollectedGraph {
  files: GraphFile[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  unresolvedRefs: UnresolvedRef[];
  parseErrors: string[];
  projectMetadata: Record<string, unknown> | null;
}

export interface IncrementalIndexGodotProjectOptions {
  changedAbsolutePaths: string[];
  deletedPaths: string[];
  currentResPaths: string[];
}

export function indexGodotProject(projectRoot: string): IndexGodotProjectResult {
  const scan = scanGodotProject(projectRoot);
  if (!scan.ok) {
    return {
      ok: false,
      projectRoot: scan.root,
      reason: scan.reason,
      message: scan.message,
    };
  }

  const graph = createGraphDatabase(scan.root);
  try {
    const collected = collectGraph(scan.files.map((file) => file.absolutePath), scan.root);
    clearGraph(graph);

    for (const file of collected.files) {
      upsertFile(graph, file);
    }

    for (const node of collected.nodes) {
      upsertNode(graph, node);
    }

    for (const edge of uniqueEdges(collected.edges)) {
      insertEdge(graph, edge);
    }

    for (const unresolvedRef of uniqueUnresolvedRefs(collected.unresolvedRefs)) {
      insertUnresolvedRef(graph, unresolvedRef);
    }

    resolveGraph(graph);
    const nodeCount = countNodes(graph);
    const edgeCount = countEdges(graph);
    const unresolvedRefCount = countUnresolvedRefs(graph);
    upsertProjectMetadata(graph, {
      key: "index",
      value: {
        project: collected.projectMetadata,
      },
      updatedAt: Date.now(),
    });

    return {
      ok: true,
      projectRoot: scan.root,
      databasePath: graph.databasePath,
      fileCount: collected.files.length,
      nodeCount,
      edgeCount,
      unresolvedRefCount,
      parseErrors: collected.parseErrors,
    };
  } finally {
    graph.close();
  }
}

export function indexGodotProjectIncremental(
  projectRoot: string,
  options: IncrementalIndexGodotProjectOptions,
): IndexGodotProjectResult {
  const graph = createGraphDatabase(projectRoot);
  try {
    const existingProjectMetadata = getStoredProjectMetadata(graph);
    const collected = collectGraph(options.changedAbsolutePaths, projectRoot, {
      knownFilePaths: new Set(options.currentResPaths),
      projectMetadata: existingProjectMetadata,
    });

    const applyChanges = graph.sqlite.transaction(() => {
      deleteFilesFromGraph(graph, [
        ...options.deletedPaths,
        ...collected.files.map((file) => file.path),
      ]);

      for (const file of collected.files) {
        upsertFile(graph, file);
      }

      for (const node of collected.nodes) {
        upsertNode(graph, node);
      }

      for (const edge of uniqueEdges(collected.edges)) {
        insertEdge(graph, edge);
      }

      for (const unresolvedRef of uniqueUnresolvedRefs(collected.unresolvedRefs)) {
        insertUnresolvedRef(graph, unresolvedRef);
      }

      deleteResolverEdges(graph);
      resolveGraph(graph);

      if (collected.projectMetadata !== existingProjectMetadata) {
        upsertProjectMetadata(graph, {
          key: "index",
          value: {
            project: collected.projectMetadata,
          },
          updatedAt: Date.now(),
        });
      }
    });
    applyChanges();

    const indexedFiles = listIndexedFiles(graph);
    return {
      ok: true,
      projectRoot,
      databasePath: graph.databasePath,
      fileCount: indexedFiles.length,
      nodeCount: countNodes(graph),
      edgeCount: countEdges(graph),
      unresolvedRefCount: countUnresolvedRefs(graph),
      parseErrors: indexedParseErrors(indexedFiles),
    };
  } finally {
    graph.close();
  }
}

function getStoredProjectMetadata(graph: ReturnType<typeof createGraphDatabase>): Record<string, unknown> | null {
  const metadata = getProjectMetadata(graph, "index");
  const project = metadata?.value.project;
  return typeof project === "object" && project !== null && !Array.isArray(project)
    ? project as Record<string, unknown>
    : null;
}

function indexedParseErrors(files: GraphFile[]): string[] {
  return files.flatMap((file) => file.parseErrors.map((error) => `${file.path}: ${error}`));
}

interface CollectGraphOptions {
  knownFilePaths?: Set<string>;
  projectMetadata?: Record<string, unknown> | null;
}

function collectGraph(
  absolutePaths: string[],
  projectRoot: string,
  options: CollectGraphOptions = {},
): CollectedGraph {
  const collected: CollectedGraph = {
    files: [],
    nodes: [],
    edges: [],
    unresolvedRefs: [],
    parseErrors: [],
    projectMetadata: options.projectMetadata ?? null,
  };
  const updatedAt = Date.now();

  for (const absolutePath of absolutePaths) {
    const contents = readFileSync(absolutePath, "utf8");
    const resPath = toResPath(projectRoot, absolutePath);
    const fileKind = fileKindForPath(resPath);
    const fileParseErrors: string[] = [];
    const beforeNodeCount = collected.nodes.length;

    if (fileKind === "project") {
      const parsed = parseProjectGodot(contents, resPath);
      fileParseErrors.push(...formatErrors(parsed.errors));
      const extraction = extractProjectGodotGraph(parsed, { updatedAt });
      collected.nodes.push(...extraction.nodes);
      collected.edges.push(...extraction.edges);
      collected.unresolvedRefs.push(...extraction.unresolvedRefs);
      collected.projectMetadata = {
        name: parsed.projectName,
        mainScene: parsed.mainScene,
        autoloads: parsed.autoloads,
        inputActions: parsed.inputActions,
      };
    } else if (fileKind === "gdscript") {
      const parsed = parseGdscript(contents, resPath);
      fileParseErrors.push(...formatErrors(parsed.errors));
      const extraction = extractGdscriptGraph(parsed, { updatedAt });
      collected.nodes.push(...extraction.nodes);
      collected.edges.push(...extraction.edges);
      collected.unresolvedRefs.push(...extraction.unresolvedRefs);
    } else if (fileKind === "scene" || fileKind === "resource") {
      const parsed = parseGodotResource(contents, resPath);
      fileParseErrors.push(...formatErrors(parsed.errors));
      const extraction = extractGodotResourceGraph(parsed, { updatedAt });
      collected.nodes.push(...extraction.nodes);
      collected.edges.push(...extraction.edges);
      collected.unresolvedRefs.push(...extraction.unresolvedRefs);
    }

    collected.parseErrors.push(...fileParseErrors.map((error) => `${resPath}: ${error}`));
    collected.files.push(fileRecord(absolutePath, resPath, fileKind, contents, fileParseErrors, collected.nodes.length - beforeNodeCount));
  }

  detachMissingFileReferences(collected, options.knownFilePaths);
  filterAutoloadCandidateRefs(collected);
  recountFileNodes(collected);

  return collected;
}

function detachMissingFileReferences(collected: CollectedGraph, knownFilePaths?: Set<string>): void {
  const indexedFiles = knownFilePaths ?? new Set(collected.files.map((file) => file.path));

  collected.nodes = collected.nodes.map((node) => {
    if (node.filePath === null || indexedFiles.has(node.filePath)) {
      return node;
    }

    return {
      ...node,
      filePath: null,
      metadata: {
        ...node.metadata,
        missingFilePath: node.filePath,
      },
    };
  });
}

function filterAutoloadCandidateRefs(collected: CollectedGraph): void {
  const autoloads = collected.projectMetadata?.autoloads;
  if (!Array.isArray(autoloads)) {
    return;
  }

  const autoloadNames = new Set(
    autoloads
      .map((autoload) =>
        typeof autoload === "object" && autoload !== null && "name" in autoload
          ? autoload.name
          : null,
      )
      .filter((name): name is string => typeof name === "string"),
  );

  collected.unresolvedRefs = collected.unresolvedRefs.filter(
    (ref) =>
      (ref.referenceKind !== "uses_autoload" || autoloadNames.has(ref.referenceName)) &&
      !isAutoloadRootNodePathRef(ref, autoloadNames),
  );
}

function isAutoloadRootNodePathRef(ref: UnresolvedRef, autoloadNames: Set<string>): boolean {
  const autoloadName = autoloadNameFromRootNodePathRef(ref);
  return autoloadName !== null && autoloadNames.has(autoloadName);
}

function autoloadNameFromRootNodePathRef(ref: UnresolvedRef): string | null {
  if (
    ref.referenceKind !== "references_nodepath" ||
    !ref.candidates.some((candidate) => candidate.kind === "root_get_node")
  ) {
    return null;
  }

  if (ref.referenceName.startsWith("/root/")) {
    return ref.referenceName.slice("/root/".length).split("/")[0] ?? null;
  }

  return ref.referenceName.split("/")[0] ?? null;
}

function recountFileNodes(collected: CollectedGraph): void {
  const nodesByFile = new Map<string, Set<string>>();
  for (const node of collected.nodes) {
    if (!node.filePath) {
      continue;
    }

    let nodeIds = nodesByFile.get(node.filePath);
    if (!nodeIds) {
      nodeIds = new Set();
      nodesByFile.set(node.filePath, nodeIds);
    }
    nodeIds.add(node.id);
  }

  collected.files = collected.files.map((file) => ({
    ...file,
    nodeCount: nodesByFile.get(file.path)?.size ?? 0,
  }));
}

function uniqueEdges(edges: GraphEdge[]): GraphEdge[] {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const key = [
      edge.source,
      edge.target,
      edge.kind,
      edge.line ?? "",
      edge.column ?? "",
      edge.provenance,
      JSON.stringify(edge.metadata),
    ].join("\0");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function uniqueUnresolvedRefs(unresolvedRefs: UnresolvedRef[]): UnresolvedRef[] {
  const seen = new Set<string>();
  return unresolvedRefs.filter((ref) => {
    const key = [
      ref.fromNodeId,
      ref.referenceName,
      ref.referenceKind,
      ref.filePath,
      ref.line ?? "",
      ref.column ?? "",
      JSON.stringify(ref.candidates),
    ].join("\0");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function fileRecord(
  absolutePath: string,
  resPath: string,
  kind: GraphFile["kind"],
  contents: string,
  parseErrors: string[],
  nodeCount: number,
): GraphFile {
  const stats = statSync(absolutePath);

  return {
    path: resPath,
    kind,
    contentHash: createHash("sha256").update(contents).digest("hex"),
    size: stats.size,
    modifiedAt: Math.trunc(stats.mtimeMs),
    indexedAt: Date.now(),
    nodeCount,
    parseErrors,
  };
}

function fileKindForPath(resPath: string): GraphFile["kind"] {
  if (resPath === "res://project.godot") {
    return "project";
  }

  if (resPath.endsWith(".gd")) {
    return "gdscript";
  }

  if (resPath.endsWith(".tscn")) {
    return "scene";
  }

  return "resource";
}

function toResPath(projectRoot: string, absolutePath: string): string {
  const relativePath = absolutePath.slice(projectRoot.length + 1).split(/[\\/]/).join("/");
  return `res://${relativePath}`;
}

function formatErrors(errors: { line: number | null; message: string }[]): string[] {
  return errors.map((error) =>
    error.line === null ? error.message : `line ${error.line}: ${error.message}`,
  );
}
