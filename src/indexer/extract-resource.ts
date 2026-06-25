import { basename } from "node:path/posix";

import type {
  GodotExtResource,
  GodotResourceParseResult,
  GodotResourceRef,
  GodotSceneNode,
} from "../parsers/godot-resource.js";
import type { EdgeKind, GraphEdge, GraphNode, JsonObject, UnresolvedRef } from "../types.js";

export interface GodotResourceGraphExtractionOptions {
  updatedAt: number;
}

export interface GodotResourceGraphExtraction {
  nodes: GraphNode[];
  edges: GraphEdge[];
  unresolvedRefs: UnresolvedRef[];
}

export function extractGodotResourceGraph(
  resource: GodotResourceParseResult,
  options: GodotResourceGraphExtractionOptions,
): GodotResourceGraphExtraction {
  if (resource.kind === "scene") {
    return extractSceneGraph(resource, options);
  }

  if (resource.kind === "resource") {
    return extractTresGraph(resource, options);
  }

  return {
    nodes: [],
    edges: [],
    unresolvedRefs: [],
  };
}

function extractSceneGraph(
  resource: GodotResourceParseResult,
  options: GodotResourceGraphExtractionOptions,
): GodotResourceGraphExtraction {
  const sceneId = sceneNodeId(resource.filePath);
  const extResources = new Map(resource.extResources.map((item) => [item.id, item]));
  const nodes: GraphNode[] = [
    {
      id: sceneId,
      kind: "scene",
      name: basename(resource.filePath),
      qualifiedName: resource.filePath,
      filePath: resource.filePath,
      ...indexedFileAddress(resource.filePath),
      startLine: resource.scene?.line ?? null,
      endLine: null,
      signature: null,
      metadata: {
        format: resource.scene?.format ?? null,
        uid: resource.scene?.uid ?? null,
      },
      updatedAt: options.updatedAt,
    },
  ];
  const edges: GraphEdge[] = [];
  const unresolvedRefs: UnresolvedRef[] = [];

  for (const extResource of resource.extResources) {
    nodes.push(extResourceNode(extResource, options.updatedAt));
    edges.push(edge(sceneId, resourceNodeId(extResource.path), "loads_resource"));
  }

  for (const subResource of resource.subResources) {
    nodes.push({
      id: subResourceNodeId(resource.filePath, subResource.id),
      kind: "resource",
      name: subResource.id,
      qualifiedName: `${resource.filePath}#${subResource.id}`,
      filePath: resource.filePath,
      ...subresourceAddress(resource.filePath),
      startLine: subResource.line,
      endLine: null,
      signature: subResource.type,
      metadata: {
        properties: subResource.properties,
        type: subResource.type,
      },
      updatedAt: options.updatedAt,
    });
  }

  for (const sceneNode of resource.nodes) {
    const nodeId = sceneTreeNodeId(resource.filePath, nodePath(sceneNode));
    nodes.push({
      id: nodeId,
      kind: "scene_node",
      name: sceneNode.name,
      qualifiedName: `${resource.filePath}:${nodePath(sceneNode)}`,
      filePath: resource.filePath,
      ...indexedSymbolAddress(resource.filePath),
      startLine: sceneNode.line,
      endLine: null,
      signature: sceneNode.type,
      metadata: {
        parent: sceneNode.parent,
        properties: sceneNode.properties,
        type: sceneNode.type,
      },
      updatedAt: options.updatedAt,
    });
    edges.push(edge(sceneId, nodeId, "contains"));

    const script = sceneNode.properties.script;
    if (isResourceRef(script)) {
      const target = targetResourceNodeId(resource.filePath, extResources, script);
      if (target) {
        edges.push(edge(nodeId, target, "attaches_script"));
      }
    }

    if (sceneNode.instance) {
      const target = targetResourceNodeId(resource.filePath, extResources, sceneNode.instance);
      if (target) {
        edges.push(edge(nodeId, target, "instantiates_scene"));
      }
    }
  }

  for (const connection of resource.connections) {
    unresolvedRefs.push({
      fromNodeId: sceneTreeNodeId(
        resource.filePath,
        connectionNodePath(resource.nodes, connection.from),
      ),
      referenceName: connection.method,
      referenceKind: "editor_signal_connection",
      filePath: resource.filePath,
      line: connection.line,
      column: null,
      candidates: [
        {
          signal: connection.signal,
          targetNodePath: connection.to,
        },
      ],
    });
  }

  return {
    nodes,
    edges,
    unresolvedRefs,
  };
}

function extractTresGraph(
  resource: GodotResourceParseResult,
  options: GodotResourceGraphExtractionOptions,
): GodotResourceGraphExtraction {
  const resourceId = resourceNodeId(resource.filePath);
  const extResources = new Map(resource.extResources.map((item) => [item.id, item]));
  const nodes: GraphNode[] = [
    {
      id: resourceId,
      kind: "resource",
      name: basename(resource.filePath),
      qualifiedName: resource.filePath,
      filePath: resource.filePath,
      ...resourceMainAddress(resource.filePath),
      startLine: resource.resource?.line ?? null,
      endLine: null,
      signature: resource.resource?.type ?? null,
      metadata: {
        format: resource.resource?.format ?? null,
        properties: resource.resourceProperties,
        type: resource.resource?.type ?? null,
        uid: resource.resource?.uid ?? null,
      },
      updatedAt: options.updatedAt,
    },
  ];
  const edges: GraphEdge[] = [];

  for (const extResource of resource.extResources) {
    nodes.push(extResourceNode(extResource, options.updatedAt));
    edges.push(edge(resourceId, resourceNodeId(extResource.path), "loads_resource"));
  }

  addScriptAttachmentEdge(resourceId, resource.filePath, resource.resourceProperties, extResources, edges);

  for (const subResource of resource.subResources) {
    const subResourceId = subResourceNodeId(resource.filePath, subResource.id);
    nodes.push({
      id: subResourceId,
      kind: "resource",
      name: subResource.id,
      qualifiedName: `${resource.filePath}#${subResource.id}`,
      filePath: resource.filePath,
      ...subresourceAddress(resource.filePath),
      startLine: subResource.line,
      endLine: null,
      signature: subResource.type,
      metadata: {
        properties: subResource.properties,
        type: subResource.type,
      },
      updatedAt: options.updatedAt,
    });
    edges.push(edge(resourceId, subResourceId, "contains"));
    addScriptAttachmentEdge(subResourceId, resource.filePath, subResource.properties, extResources, edges);
  }

  return {
    nodes,
    edges,
    unresolvedRefs: [],
  };
}

function addScriptAttachmentEdge(
  sourceId: string,
  filePath: string,
  properties: Record<string, unknown>,
  extResources: Map<string, GodotExtResource>,
  edges: GraphEdge[],
): void {
  const script = properties.script;
  if (!isResourceRef(script)) {
    return;
  }

  const target = targetResourceNodeId(filePath, extResources, script);
  if (target) {
    edges.push(edge(sourceId, target, "attaches_script"));
  }
}

function extResourceNode(resource: GodotExtResource, updatedAt: number): GraphNode {
  return {
    id: resourceNodeId(resource.path),
    kind: "resource",
    name: basename(resource.path),
    qualifiedName: resource.path,
    filePath: resource.path,
    ...externalResourceAddress(resource.path),
    startLine: resource.line,
    endLine: null,
    signature: resource.type,
    metadata: {
      extResourceId: resource.id,
      type: resource.type,
    },
    updatedAt,
  };
}

function indexedFileAddress(
  filePath: string,
): Pick<GraphNode, "addressKind" | "ownerPath" | "readablePath" | "displayPath" | "referencePath"> {
  return {
    addressKind: "indexed_file",
    ownerPath: filePath,
    readablePath: filePath,
    displayPath: filePath,
    referencePath: null,
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

function resourceMainAddress(
  filePath: string,
): Pick<GraphNode, "addressKind" | "ownerPath" | "readablePath" | "displayPath" | "referencePath"> {
  return {
    addressKind: "resource_main",
    ownerPath: filePath,
    readablePath: filePath,
    displayPath: filePath,
    referencePath: null,
  };
}

function subresourceAddress(
  filePath: string,
): Pick<GraphNode, "addressKind" | "ownerPath" | "readablePath" | "displayPath" | "referencePath"> {
  return {
    addressKind: "resource_subresource",
    ownerPath: filePath,
    readablePath: null,
    displayPath: filePath,
    referencePath: null,
  };
}

function externalResourceAddress(
  filePath: string,
): Pick<GraphNode, "addressKind" | "ownerPath" | "readablePath" | "displayPath" | "referencePath"> {
  return {
    addressKind: "resource_external_ref",
    ownerPath: filePath,
    readablePath: filePath,
    displayPath: filePath,
    referencePath: filePath,
  };
}

function targetResourceNodeId(
  filePath: string,
  extResources: Map<string, GodotExtResource>,
  ref: GodotResourceRef,
): string | null {
  if (ref.kind === "ExtResource") {
    const extResource = extResources.get(ref.id);
    return extResource ? resourceNodeId(extResource.path) : null;
  }

  return subResourceNodeId(filePath, ref.id);
}

function edge(source: string, target: string, kind: EdgeKind): GraphEdge {
  return {
    source,
    target,
    kind,
    line: null,
    column: null,
    provenance: "resource-parser",
    metadata: {},
  };
}

function sceneNodeId(resPath: string): string {
  return `scene:${resPath}`;
}

function resourceNodeId(resPath: string): string {
  return `resource:${resPath}`;
}

function subResourceNodeId(resPath: string, id: string): string {
  return `resource:${resPath}#${id}`;
}

function sceneTreeNodeId(resPath: string, path: string): string {
  return `scene_node:${resPath}:${path}`;
}

function nodePath(node: GodotSceneNode): string {
  if (!node.parent || node.parent === ".") {
    return node.name;
  }

  return `${node.parent}/${node.name}`;
}

function connectionNodePath(nodes: GodotSceneNode[], path: string): string {
  if (path && path !== ".") {
    return path;
  }

  const rootNode = nodes.find((node) => !node.parent || node.parent === ".");
  return rootNode ? nodePath(rootNode) : path;
}

function isResourceRef(value: unknown): value is GodotResourceRef {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    "id" in value
  );
}
