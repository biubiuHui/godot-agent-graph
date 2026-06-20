import type { GraphDatabase } from "../db/index.js";
import {
  getNode,
  getProjectMetadata,
  listEdges,
  listNodes,
  listUnresolvedRefs,
  searchNodes,
} from "../db/queries.js";
import type { EdgeKind, FileKind, GraphEdge, GraphFile, GraphNode } from "../types.js";

interface FileRow {
  path: string;
  kind: GraphFile["kind"];
  content_hash: string;
  size: number;
  modified_at: number;
  indexed_at: number;
  node_count: number;
  parse_errors: string;
}

export interface ProjectOverview {
  fileCount: number;
  nodeCount: number;
  edgeCount: number;
  unresolvedRefCount: number;
  project: Record<string, unknown> | null;
}

export interface GraphEdgeFilter {
  source?: string;
  target?: string;
  kind?: EdgeKind;
}

export interface SceneDetails {
  scene: GraphNode | null;
  nodes: GraphNode[];
}

export interface SceneSummary {
  id: string;
  name: string;
  path: string;
}

export interface SceneNodeSummary {
  id: string;
  name: string;
  path: string;
  type: string | null;
  parentPath: string | null;
  scriptPath: string | null;
  instanceScenePath: string | null;
  line: number | null;
}

export interface SceneMap {
  scene: SceneSummary | null;
  nodes: SceneNodeSummary[];
}

export interface CountByKind<TKind extends string> {
  kind: TKind;
  count: number;
}

export interface UnresolvedRefCount {
  referenceKind: string;
  count: number;
}

export interface ResourceDirectorySummary {
  path: string;
  count: number;
}

export interface ParseErrorSummary {
  path: string;
  kind: FileKind;
  parseErrors: string[];
}

export interface NodeSummary {
  id: string;
  kind: GraphNode["kind"];
  name: string;
  qualifiedName: string;
  filePath: string | null;
}

export interface ProjectMap extends ProjectOverview {
  filesByKind: Array<CountByKind<FileKind>>;
  nodesByKind: Array<CountByKind<GraphNode["kind"]>>;
  edgesByKind: Array<CountByKind<EdgeKind>>;
  unresolvedRefsByKind: UnresolvedRefCount[];
  scenes: NodeSummary[];
  scripts: NodeSummary[];
  resourceDirectories: ResourceDirectorySummary[];
  parseErrors: ParseErrorSummary[];
}

const MAX_PROJECT_MAP_SCENES = 40;
const MAX_PROJECT_MAP_SCRIPTS = 40;
const MAX_PROJECT_MAP_RESOURCE_DIRECTORIES = 30;

export function getProjectOverview(graph: GraphDatabase): ProjectOverview {
  const metadata = getProjectMetadata(graph, "index");
  const value = metadata?.value ?? {};

  return {
    fileCount: getNumber(value, "fileCount"),
    nodeCount: getNumber(value, "nodeCount"),
    edgeCount: getNumber(value, "edgeCount"),
    unresolvedRefCount: getNumber(value, "unresolvedRefCount"),
    project: getObject(value, "project"),
  };
}

export function getProjectMap(graph: GraphDatabase): ProjectMap {
  const overview = getProjectOverview(graph);
  const files = listIndexedFiles(graph);
  const nodes = listNodes(graph);
  const edges = listEdges(graph);
  const unresolvedRefs = listUnresolvedRefs(graph);

  return {
    ...overview,
    filesByKind: countBy(files.map((file) => file.kind)),
    nodesByKind: countBy(nodes.map((node) => node.kind)),
    edgesByKind: countBy(edges.map((edge) => edge.kind)),
    unresolvedRefsByKind: countBy(unresolvedRefs.map((ref) => ref.referenceKind))
      .map(({ kind, count }) => ({ referenceKind: kind, count })),
    scenes: summarizeNodes(nodes, "scene", MAX_PROJECT_MAP_SCENES, overview.project?.mainScene),
    scripts: summarizeNodes(nodes, "script_class", MAX_PROJECT_MAP_SCRIPTS),
    resourceDirectories: summarizeResourceDirectories(files),
    parseErrors: files
      .filter((file) => file.parseErrors.length > 0)
      .map((file) => ({
        path: file.path,
        kind: file.kind,
        parseErrors: file.parseErrors,
      })),
  };
}

export function listIndexedFiles(graph: GraphDatabase): GraphFile[] {
  const rows = graph.sqlite
    .prepare("select * from files order by path")
    .all() as FileRow[];

  return rows.map((row) => ({
    path: row.path,
    kind: row.kind,
    contentHash: row.content_hash,
    size: row.size,
    modifiedAt: row.modified_at,
    indexedAt: row.indexed_at,
    nodeCount: row.node_count,
    parseErrors: JSON.parse(row.parse_errors) as string[],
  }));
}

export function findNodeById(graph: GraphDatabase, id: string): GraphNode | null {
  return getNode(graph, id);
}

export function findEdges(
  graph: GraphDatabase,
  filter: GraphEdgeFilter = {},
): GraphEdge[] {
  return listEdges(graph, filter);
}

export function getSceneDetails(graph: GraphDatabase, scenePath: string): SceneDetails {
  const sceneId = `scene:${scenePath}`;
  const scene = getNode(graph, sceneId);
  const nodes = listEdges(graph, { source: sceneId, kind: "contains" })
    .map((edge) => getNode(graph, edge.target))
    .filter((node): node is GraphNode => node !== null && node.kind === "scene_node");

  return {
    scene,
    nodes,
  };
}

export function getSceneMap(graph: GraphDatabase, scenePath: string): SceneMap {
  const details = getSceneDetails(graph, scenePath);
  const nodesById = new Map(listNodes(graph).map((node) => [node.id, node]));
  const sceneNodeIds = new Set(details.nodes.map((node) => node.id));
  const sceneEdges = listEdges(graph).filter((edge) => sceneNodeIds.has(edge.source));

  return {
    scene: details.scene ? {
      id: details.scene.id,
      name: details.scene.name,
      path: details.scene.qualifiedName,
    } : null,
    nodes: details.nodes.map((node) => summarizeSceneNode(node, sceneEdges, nodesById)),
  };
}

export function findSymbols(graph: GraphDatabase, name: string): GraphNode[] {
  return searchNodes(graph, name);
}

function summarizeSceneNode(
  node: GraphNode,
  edges: GraphEdge[],
  nodesById: Map<string, GraphNode>,
): SceneNodeSummary {
  const metadata = node.metadata;
  const parent = typeof metadata.parent === "string" ? metadata.parent : null;
  const type = typeof metadata.type === "string" ? metadata.type : node.signature;
  const scriptPath = targetFilePath(node.id, "attaches_script", edges, nodesById);
  const instanceScenePath = targetFilePath(node.id, "instantiates_scene", edges, nodesById);

  return {
    id: node.id,
    name: node.name,
    path: sceneNodePath(node),
    type,
    parentPath: parent === "." ? null : parent,
    scriptPath,
    instanceScenePath,
    line: node.startLine,
  };
}

function targetFilePath(
  source: string,
  kind: EdgeKind,
  edges: GraphEdge[],
  nodesById: Map<string, GraphNode>,
): string | null {
  const edge = edges.find((candidate) => candidate.source === source && candidate.kind === kind);
  if (!edge) {
    return null;
  }

  const target = nodesById.get(edge.target);
  return target?.filePath ?? target?.qualifiedName ?? null;
}

function sceneNodePath(node: GraphNode): string {
  const marker = `${node.filePath}:`;
  return node.id.startsWith(`scene_node:${marker}`)
    ? node.id.slice(`scene_node:${marker}`.length)
    : node.name;
}

function countBy<TKind extends string>(values: TKind[]): Array<CountByKind<TKind>> {
  const counts = new Map<TKind, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((left, right) => left.kind.localeCompare(right.kind));
}

function summarizeNodes(
  nodes: GraphNode[],
  kind: GraphNode["kind"],
  limit: number,
  firstPath?: unknown,
): NodeSummary[] {
  return nodes
    .filter((node) => node.kind === kind)
    .sort((left, right) => {
      if (typeof firstPath === "string") {
        if (left.filePath === firstPath && right.filePath !== firstPath) {
          return -1;
        }
        if (right.filePath === firstPath && left.filePath !== firstPath) {
          return 1;
        }
      }

      return left.qualifiedName.localeCompare(right.qualifiedName);
    })
    .slice(0, limit)
    .map(summarizeNode);
}

function summarizeNode(node: GraphNode): NodeSummary {
  return {
    id: node.id,
    kind: node.kind,
    name: node.name,
    qualifiedName: node.qualifiedName,
    filePath: node.filePath,
  };
}

function summarizeResourceDirectories(files: GraphFile[]): ResourceDirectorySummary[] {
  return countBy(
    files
      .filter((file) => file.kind === "resource")
      .map((file) => parentResourcePath(file.path)),
  )
    .map(({ kind, count }) => ({ path: kind, count }))
    .sort((left, right) => right.count - left.count || left.path.localeCompare(right.path))
    .slice(0, MAX_PROJECT_MAP_RESOURCE_DIRECTORIES);
}

function parentResourcePath(path: string): string {
  const index = path.lastIndexOf("/");
  return index > "res://".length ? path.slice(0, index) : "res://";
}

function getNumber(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  return typeof field === "number" ? field : 0;
}

function getObject(value: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const field = value[key];
  return typeof field === "object" && field !== null && !Array.isArray(field)
    ? (field as Record<string, unknown>)
    : null;
}
