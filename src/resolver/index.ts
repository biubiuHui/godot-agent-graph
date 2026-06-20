import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { deleteUnresolvedRefs, insertEdge, listEdges, listNodes, listUnresolvedRefs } from "../db/queries.js";
import type { GraphDatabase } from "../db/index.js";
import type { EdgeKind, GraphEdge, GraphNode, UnresolvedRef } from "../types.js";
import { buildGodotPathIndexes, resourcePathFromNodeId } from "./godot-paths.js";
import { findUniqueMethodByName } from "./signals.js";
import { findSceneNodeByPath } from "./nodepaths.js";

export interface ResolveGraphResult {
  resolvedEdgeCount: number;
}

export function resolveGraph(graph: GraphDatabase): ResolveGraphResult {
  const nodes = listNodes(graph);
  const edges = listEdges(graph);
  const unresolvedRefs = listUnresolvedRefs(graph);
  const indexes = buildGodotPathIndexes(nodes);
  const edgeKeys = new Set(edges.map(edgeKey));
  const sourceCache = new Map<string, string[] | null>();
  const resolvedRefIds: number[] = [];
  let resolvedEdgeCount = 0;

  function addResolved(source: string, target: string, kind: EdgeKind, metadata: Record<string, unknown> = {}): boolean {
    if (!indexes.byId.has(source) || !indexes.byId.has(target)) {
      return false;
    }

    const candidate = resolverEdge(source, target, kind, metadata);
    const key = edgeKey(candidate);
    if (edgeKeys.has(key)) {
      return true;
    }

    try {
      insertEdge(graph, candidate);
    } catch (error) {
      throw new Error(
        `Failed to insert resolved edge ${candidate.source} ${candidate.kind} ${candidate.target}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    edgeKeys.add(key);
    resolvedEdgeCount += 1;
    return true;
  }

  resolveExistingResourceEdges(edges, indexes, addResolved);
  const resolvedResourceEdges = listEdges(graph);
  resolveUnresolvedRefs(unresolvedRefs, nodes, resolvedResourceEdges, indexes, graph.projectRoot, sourceCache, addResolved, (ref) => {
    if (ref.id !== undefined) {
      resolvedRefIds.push(ref.id);
    }
  });
  deleteUnresolvedRefs(graph, resolvedRefIds);

  return { resolvedEdgeCount };
}

function resolveExistingResourceEdges(
  edges: GraphEdge[],
  indexes: ReturnType<typeof buildGodotPathIndexes>,
  addResolved: (source: string, target: string, kind: EdgeKind, metadata?: Record<string, unknown>) => boolean,
): void {
  for (const edge of edges) {
    const targetPath = resourcePathFromNodeId(edge.target);
    if (!targetPath) {
      continue;
    }

    if (edge.kind === "attaches_script") {
      const script = indexes.scriptsByPath.get(targetPath);
      if (script) {
        addResolved(edge.source, script.id, "attaches_script", { via: edge.target });
      }
    } else if (edge.kind === "instantiates_scene") {
      const scene = indexes.scenesByPath.get(targetPath);
      if (scene) {
        addResolved(edge.source, scene.id, "instantiates_scene", { via: edge.target });
      }
    }
  }
}

function resolveUnresolvedRefs(
  unresolvedRefs: UnresolvedRef[],
  nodes: GraphNode[],
  edges: GraphEdge[],
  indexes: ReturnType<typeof buildGodotPathIndexes>,
  projectRoot: string,
  sourceCache: Map<string, string[] | null>,
  addResolved: (source: string, target: string, kind: EdgeKind, metadata?: Record<string, unknown>) => boolean,
  markResolved: (ref: UnresolvedRef) => void,
): void {
  for (const ref of unresolvedRefs) {
    let resolved = false;
    if (ref.referenceKind === "main_scene") {
      const scene = indexes.scenesByPath.get(ref.referenceName);
      if (scene) {
        resolved = addResolved(ref.fromNodeId, scene.id, "main_scene");
      }
    } else if (ref.referenceKind === "autoload_resource") {
      const target = indexes.scriptsByPath.get(ref.referenceName) ?? indexes.scenesByPath.get(ref.referenceName);
      if (target) {
        resolved = addResolved(ref.fromNodeId, target.id, "loads_resource");
      }
    } else if (ref.referenceKind === "preloads_resource" || ref.referenceKind === "loads_resource") {
      const target =
        indexes.resourcesByPath.get(ref.referenceName) ??
        indexes.scenesByPath.get(ref.referenceName) ??
        indexes.scriptsByPath.get(ref.referenceName);
      if (target) {
        resolved = addResolved(ref.fromNodeId, target.id, ref.referenceKind);
      }
    } else if (ref.referenceKind === "uses_input_action") {
      const target = indexes.inputActionsByName.get(ref.referenceName);
      if (target) {
        resolved = addResolved(ref.fromNodeId, target.id, "uses_input_action");
      }
    } else if (ref.referenceKind === "uses_autoload") {
      const target = indexes.autoloadsByName.get(ref.referenceName);
      if (target) {
        resolved = addResolved(ref.fromNodeId, target.id, "uses_autoload");
      }
    } else if (ref.referenceKind === "editor_signal_connection") {
      const target = findUniqueMethodByName(nodes, ref.referenceName);
      if (target) {
        resolved = addResolved(ref.fromNodeId, target.id, "connects_signal", { candidates: ref.candidates });
      }
    } else if (ref.referenceKind === "connects_signal") {
      const targetName = signalConnectTargetName(ref);
      const source = indexes.byId.get(ref.fromNodeId);
      const localTarget =
        targetName && source?.filePath
          ? uniqueNode(
              nodes.filter((node) =>
                node.kind === "method" &&
                node.name === targetName &&
                node.filePath === source.filePath,
              ),
            )
          : null;
      const target = localTarget ?? (targetName
        ? uniqueNode(nodes.filter((node) => node.kind === "method" && node.name === targetName))
        : null);
      if (target) {
        resolved = addResolved(ref.fromNodeId, target.id, "connects_signal", {
          signal: ref.referenceName,
          candidates: ref.candidates,
        });
      }
    } else if (ref.referenceKind === "emits_signal") {
      const source = indexes.byId.get(ref.fromNodeId);
      const target =
        source?.filePath
          ? nodes.find((node) =>
              node.kind === "signal" &&
              node.name === ref.referenceName &&
              node.filePath === source.filePath,
            )
          : null;
      const fallbackTarget =
        target ??
        uniqueNode(nodes.filter((node) => node.kind === "signal" && node.name === ref.referenceName));
      if (fallbackTarget) {
        resolved = addResolved(ref.fromNodeId, fallbackTarget.id, "emits_signal");
      }
    } else if (ref.referenceKind === "calls") {
      const source = indexes.byId.get(ref.fromNodeId);
      const staticTarget = staticCallTarget(ref, nodes, indexes);
      const typedInstanceTarget = typedInstanceCallTarget(ref, nodes, indexes, projectRoot, sourceCache);
      const localTarget = source?.filePath
        ? uniqueNode(
            nodes.filter((node) =>
              node.kind === "method" &&
              node.name === ref.referenceName &&
              node.filePath === source.filePath,
            ),
          )
        : null;
      const target = staticTarget ?? typedInstanceTarget ?? localTarget ?? uniqueNode(
        nodes.filter((node) => node.kind === "method" && node.name === ref.referenceName),
      );
      if (target) {
        resolved = addResolved(
          ref.fromNodeId,
          target.id,
          "calls",
          staticTarget || typedInstanceTarget ? { candidates: ref.candidates } : {},
        );
      }
    } else if (ref.referenceKind === "references_nodepath") {
      const autoloadName = autoloadNameFromNodePathRef(ref);
      const autoload = autoloadName ? indexes.autoloadsByName.get(autoloadName) : null;
      if (autoload) {
        resolved = addResolved(ref.fromNodeId, autoload.id, "uses_autoload", { via: "nodepath" });
      }

      const source = indexes.byId.get(ref.fromNodeId);
      if (source?.filePath) {
        const target =
          typedReceiverSceneNodeTarget(ref, nodes, edges, indexes, projectRoot, sourceCache) ??
          findSceneNodeByPath(nodes, source.filePath.replace(/\.gd$/, ".tscn"), ref.referenceName);
        if (target) {
          resolved = addResolved(ref.fromNodeId, target.id, "references_nodepath", { candidates: ref.candidates }) || resolved;
        }
      }
    } else if (ref.referenceKind === "extends") {
      const pathTarget = ref.referenceName.startsWith("res://")
        ? indexes.scriptsByPath.get(ref.referenceName)
        : null;
      if (pathTarget) {
        resolved = addResolved(ref.fromNodeId, pathTarget.id, "extends");
      } else {
        const candidates = indexes.byName.get(ref.referenceName)?.filter((node) => node.kind === "script_class") ?? [];
        if (candidates.length === 1 && candidates[0]) {
          resolved = addResolved(ref.fromNodeId, candidates[0].id, "extends");
        }
      }
    }

    if (resolved) {
      markResolved(ref);
    }
  }
}

function resolverEdge(
  source: string,
  target: string,
  kind: EdgeKind,
  metadata: Record<string, unknown>,
): GraphEdge {
  return {
    source,
    target,
    kind,
    line: null,
    column: null,
    provenance: "resolver",
    metadata,
  };
}

function edgeKey(edge: Pick<GraphEdge, "source" | "target" | "kind" | "provenance">): string {
  return `${edge.source}\0${edge.target}\0${edge.kind}\0${edge.provenance}`;
}

function uniqueNode(nodes: GraphNode[]): GraphNode | null {
  return nodes.length === 1 ? nodes[0] ?? null : null;
}

function autoloadNameFromNodePathRef(ref: UnresolvedRef): string | null {
  if (!ref.candidates.some((candidate) => candidate.kind === "root_get_node")) {
    return null;
  }

  if (ref.referenceName.startsWith("/root/")) {
    return ref.referenceName.slice("/root/".length).split("/")[0] ?? null;
  }

  return ref.referenceName.split("/")[0] ?? null;
}

function signalConnectTargetName(ref: UnresolvedRef): string | null {
  const target = ref.candidates.find((candidate) => typeof candidate.target === "string")?.target;
  return typeof target === "string" && target.length > 0 ? target : null;
}

function staticCallTarget(
  ref: UnresolvedRef,
  nodes: GraphNode[],
  indexes: ReturnType<typeof buildGodotPathIndexes>,
): GraphNode | null {
  const receiver = ref.candidates.find((candidate) => typeof candidate.receiver === "string")?.receiver;
  if (typeof receiver !== "string" || receiver.length === 0) {
    return null;
  }

  const scriptClass = uniqueNode(
    (indexes.byName.get(receiver) ?? []).filter((node) => node.kind === "script_class"),
  );
  if (!scriptClass?.filePath) {
    return null;
  }

  return uniqueNode(
    nodes.filter((node) =>
      node.kind === "method" &&
      node.name === ref.referenceName &&
      node.filePath === scriptClass.filePath &&
      node.metadata.static === true,
    ),
  );
}

function typedInstanceCallTarget(
  ref: UnresolvedRef,
  nodes: GraphNode[],
  indexes: ReturnType<typeof buildGodotPathIndexes>,
  projectRoot: string,
  sourceCache: Map<string, string[] | null>,
): GraphNode | null {
  const receiver = ref.candidates.find((candidate) => typeof candidate.receiver === "string")?.receiver;
  if (typeof receiver !== "string" || receiver.length === 0) {
    return null;
  }

  const receiverType = receiverTypeName(ref, receiver, nodes, projectRoot, sourceCache);
  if (!receiverType) {
    return null;
  }

  const scriptClass = uniqueNode(
    (indexes.byName.get(receiverType) ?? []).filter((node) => node.kind === "script_class"),
  );
  if (!scriptClass?.filePath) {
    return null;
  }

  return uniqueNode(
    nodes.filter((node) =>
      node.kind === "method" &&
      node.name === ref.referenceName &&
      node.filePath === scriptClass.filePath &&
      node.metadata.static !== true,
    ),
  );
}

function typedReceiverSceneNodeTarget(
  ref: UnresolvedRef,
  nodes: GraphNode[],
  edges: GraphEdge[],
  indexes: ReturnType<typeof buildGodotPathIndexes>,
  projectRoot: string,
  sourceCache: Map<string, string[] | null>,
): GraphNode | null {
  const receiver = ref.candidates.find((candidate) => typeof candidate.receiver === "string")?.receiver;
  if (typeof receiver !== "string" || receiver.length === 0) {
    return null;
  }

  const receiverType = receiverTypeName(ref, receiver, nodes, projectRoot, sourceCache);
  if (!receiverType) {
    return null;
  }

  const scriptClass = uniqueNode(
    (indexes.byName.get(receiverType) ?? []).filter((node) => node.kind === "script_class"),
  );
  if (!scriptClass) {
    return null;
  }

  const attachedSceneNode = uniqueNode(
    edges
      .filter((edge) => edge.kind === "attaches_script" && edge.target === scriptClass.id)
      .map((edge) => indexes.byId.get(edge.source))
      .filter((node): node is GraphNode => node !== undefined && node.kind === "scene_node"),
  );
  if (!attachedSceneNode?.filePath) {
    return null;
  }

  return findSceneNodeByPath(nodes, attachedSceneNode.filePath, ref.referenceName);
}

function receiverTypeName(
  ref: UnresolvedRef,
  receiver: string,
  nodes: GraphNode[],
  projectRoot: string,
  sourceCache: Map<string, string[] | null>,
): string | null {
  const receiverParts = receiver.split(".").filter((part) => part.length > 0);
  const rootReceiver = receiverParts[0] ?? receiver;
  let currentType = rootReceiverType(ref, rootReceiver, nodes, projectRoot, sourceCache);
  if (!currentType) {
    return null;
  }

  for (const propertyName of receiverParts.slice(1)) {
    currentType = propertyTypeOnClass(currentType, propertyName, nodes);
    if (!currentType) {
      return null;
    }
  }

  return currentType;
}

function rootReceiverType(
  ref: UnresolvedRef,
  receiver: string,
  nodes: GraphNode[],
  projectRoot: string,
  sourceCache: Map<string, string[] | null>,
): string | null {
  const containingMethod = containingMethodNode(ref, nodes);
  const parameterType = containingMethod?.signature
    ? declaredParameterType(containingMethod.signature, receiver)
    : null;
  return parameterType ??
    localVariableType(ref, receiver, nodes, projectRoot, sourceCache) ??
    directPropertyType(receiver, nodes);
}

function containingMethodNode(ref: UnresolvedRef, nodes: GraphNode[]): GraphNode | null {
  if (ref.line === null) {
    return null;
  }

  const methods = nodes
    .filter((node) =>
      node.kind === "method" &&
      node.filePath === ref.filePath &&
      node.startLine !== null &&
      node.startLine <= ref.line!,
    )
    .sort((left, right) => (right.startLine ?? 0) - (left.startLine ?? 0));

  return methods[0] ?? null;
}

function declaredParameterType(signature: string, parameterName: string): string | null {
  const match = signature.match(new RegExp(`(?:^|[,(])\\s*${escapeRegExp(parameterName)}\\s*:\\s*([A-Za-z_]\\w*)`));
  return projectTypeName(match?.[1] ?? null);
}

function declaredPropertyType(signature: string, propertyName: string): string | null {
  const match = signature.match(new RegExp(`\\b(?:var|const)\\s+${escapeRegExp(propertyName)}\\s*:\\s*([A-Za-z_]\\w*)`));
  return projectTypeName(match?.[1] ?? null);
}

function directPropertyType(propertyName: string, nodes: GraphNode[]): string | null {
  const property = uniqueNode(
    nodes.filter((node) =>
      node.kind === "property" &&
      node.name === propertyName &&
      node.signature !== null,
    ),
  );

  return property?.signature ? declaredPropertyType(property.signature, propertyName) : null;
}

function propertyTypeOnClass(className: string, propertyName: string, nodes: GraphNode[]): string | null {
  const property = uniqueNode(
    nodes.filter((node) =>
      node.kind === "property" &&
      node.name === propertyName &&
      node.qualifiedName === `${className}.${propertyName}` &&
      node.signature !== null,
    ),
  );

  return property?.signature ? declaredPropertyType(property.signature, propertyName) : null;
}

function localVariableType(
  ref: UnresolvedRef,
  variableName: string,
  nodes: GraphNode[],
  projectRoot: string,
  sourceCache: Map<string, string[] | null>,
): string | null {
  if (ref.line === null) {
    return null;
  }

  const containingMethod = containingMethodNode(ref, nodes);
  if (containingMethod?.startLine === null || containingMethod?.startLine === undefined) {
    return null;
  }

  const lines = sourceLines(ref.filePath, projectRoot, sourceCache);
  if (!lines) {
    return null;
  }

  for (let lineIndex = ref.line - 2; lineIndex >= containingMethod.startLine - 1; lineIndex -= 1) {
    const line = lines[lineIndex] ?? "";
    const explicitType = line.match(new RegExp(`\\bvar\\s+${escapeRegExp(variableName)}\\s*:\\s*([A-Za-z_]\\w*)`));
    const explicitTypeName = projectTypeName(explicitType?.[1] ?? null);
    if (explicitTypeName) {
      return explicitTypeName;
    }

    const constructorType = line.match(new RegExp(`\\bvar\\s+${escapeRegExp(variableName)}\\s*(?::=|=)\\s*([A-Za-z_]\\w*)\\.new\\s*\\(`));
    const constructorSourceName = constructorType?.[1] ?? null;
    const constructorTypeName = constructorSourceName
      ? localPreloadClassName(ref, constructorSourceName, nodes, projectRoot, sourceCache) ??
        projectTypeName(constructorSourceName)
      : null;
    if (constructorTypeName) {
      return constructorTypeName;
    }

    const castType = line.match(new RegExp(`\\bvar\\s+${escapeRegExp(variableName)}\\s*(?::=|=)\\s*.+\\s+as\\s+([A-Za-z_]\\w*)\\b`));
    const castTypeName = projectTypeName(castType?.[1] ?? null);
    if (castTypeName) {
      return castTypeName;
    }

    const callAssignment = line.match(new RegExp(`\\bvar\\s+${escapeRegExp(variableName)}\\s*(?::=|=)\\s*([A-Za-z_]\\w*)\\s*\\(`));
    const callReturnType = callAssignment?.[1]
      ? localFunctionReturnType(ref, callAssignment[1], nodes)
      : null;
    if (callReturnType) {
      return callReturnType;
    }

    const alias = line.match(new RegExp(`\\bvar\\s+${escapeRegExp(variableName)}\\s*(?::=|=)\\s*([A-Za-z_]\\w*(?:\\.[A-Za-z_]\\w*)*)\\b`));
    const aliasExpression = alias?.[1] ?? null;
    if (aliasExpression && aliasExpression !== variableName) {
      return receiverTypeName(ref, aliasExpression, nodes, projectRoot, sourceCache);
    }
  }

  return null;
}

function localPreloadClassName(
  ref: UnresolvedRef,
  constantName: string,
  nodes: GraphNode[],
  projectRoot: string,
  sourceCache: Map<string, string[] | null>,
): string | null {
  const lines = sourceLines(ref.filePath, projectRoot, sourceCache);
  if (!lines) {
    return null;
  }

  const preloadPattern = new RegExp(
    `\\bconst\\s+${escapeRegExp(constantName)}\\s*(?::=|=)\\s*preload\\(\\s*["']([^"']+\\.gd)["']\\s*\\)`,
  );
  for (const line of lines) {
    const path = line.match(preloadPattern)?.[1] ?? null;
    if (!path) {
      continue;
    }

    const scriptClass = uniqueNode(
      nodes.filter((node) =>
        node.kind === "script_class" &&
        node.filePath === path,
      ),
    );
    return scriptClass?.name ?? null;
  }

  return null;
}

function localFunctionReturnType(ref: UnresolvedRef, functionName: string, nodes: GraphNode[]): string | null {
  const method = uniqueNode(
    nodes.filter((node) =>
      node.kind === "method" &&
      node.name === functionName &&
      node.filePath === ref.filePath &&
      node.signature !== null,
    ),
  );

  return method?.signature ? declaredReturnType(method.signature) : null;
}

function declaredReturnType(signature: string): string | null {
  const match = signature.match(/->\s*([A-Za-z_]\w*)/);
  return projectTypeName(match?.[1] ?? null);
}

function sourceLines(
  filePath: string,
  projectRoot: string,
  sourceCache: Map<string, string[] | null>,
): string[] | null {
  if (sourceCache.has(filePath)) {
    return sourceCache.get(filePath) ?? null;
  }

  if (!filePath.startsWith("res://")) {
    sourceCache.set(filePath, null);
    return null;
  }

  const absolutePath = join(projectRoot, filePath.slice("res://".length));
  if (!existsSync(absolutePath)) {
    sourceCache.set(filePath, null);
    return null;
  }

  const lines = readFileSync(absolutePath, "utf8").split(/\r?\n/);
  sourceCache.set(filePath, lines);
  return lines;
}

function projectTypeName(typeName: string | null): string | null {
  return typeName !== null && typeName !== "Variant" ? typeName : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
