import type { ProjectGodotParseResult } from "../parsers/project-godot.js";
import type { GraphEdge, GraphNode, UnresolvedRef } from "../types.js";

export interface ProjectGraphExtractionOptions {
  updatedAt: number;
}

export interface ProjectGraphExtraction {
  nodes: GraphNode[];
  edges: GraphEdge[];
  unresolvedRefs: UnresolvedRef[];
}

export function extractProjectGodotGraph(
  project: ProjectGodotParseResult,
  options: ProjectGraphExtractionOptions,
): ProjectGraphExtraction {
  const projectName = project.projectName ?? "Godot Project";
  const nodes: GraphNode[] = [
    {
      id: "project",
      kind: "project",
      name: projectName,
      qualifiedName: projectName,
      filePath: project.filePath,
      addressKind: "project_virtual",
      ownerPath: project.filePath,
      readablePath: project.filePath,
      displayPath: project.filePath,
      referencePath: null,
      startLine: null,
      endLine: null,
      signature: null,
      metadata: {
        mainScene: project.mainScene,
      },
      updatedAt: options.updatedAt,
    },
  ];
  const edges: GraphEdge[] = [];
  const unresolvedRefs: UnresolvedRef[] = [];

  if (project.mainScene) {
    unresolvedRefs.push({
      fromNodeId: "project",
      referenceName: project.mainScene,
      referenceKind: "main_scene",
      filePath: project.filePath,
      line: null,
      column: null,
      candidates: [],
    });
  }

  for (const autoload of [...project.autoloads].sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const nodeId = `autoload:${autoload.name}`;
    nodes.push({
      id: nodeId,
      kind: "autoload",
      name: autoload.name,
      qualifiedName: autoload.name,
      filePath: project.filePath,
      ...indexedSymbolAddress(project.filePath),
      startLine: autoload.line,
      endLine: autoload.line,
      signature: `${autoload.name}=${autoload.singleton ? "*" : ""}${autoload.path}`,
      metadata: {
        path: autoload.path,
        singleton: autoload.singleton,
      },
      updatedAt: options.updatedAt,
    });
    edges.push(containsEdge("project", nodeId));
    unresolvedRefs.push({
      fromNodeId: nodeId,
      referenceName: autoload.path,
      referenceKind: "autoload_resource",
      filePath: project.filePath,
      line: autoload.line,
      column: null,
      candidates: [],
    });
  }

  for (const inputAction of [...project.inputActions].sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const nodeId = `input_action:${inputAction.name}`;
    nodes.push({
      id: nodeId,
      kind: "input_action",
      name: inputAction.name,
      qualifiedName: inputAction.name,
      filePath: project.filePath,
      ...indexedSymbolAddress(project.filePath),
      startLine: inputAction.line,
      endLine: inputAction.line,
      signature: inputAction.name,
      metadata: {},
      updatedAt: options.updatedAt,
    });
    edges.push(containsEdge("project", nodeId));
  }

  return {
    nodes,
    edges,
    unresolvedRefs,
  };
}

function indexedSymbolAddress(
  filePath: string,
): Pick<GraphNode, "addressKind" | "ownerPath" | "readablePath" | "displayPath" | "referencePath"> {
  return {
    addressKind: "indexed_symbol",
    ownerPath: filePath,
    readablePath: filePath,
    displayPath: filePath,
    referencePath: null,
  };
}

function containsEdge(source: string, target: string): GraphEdge {
  return {
    source,
    target,
    kind: "contains",
    line: null,
    column: null,
    provenance: "resource-parser",
    metadata: {},
  };
}
