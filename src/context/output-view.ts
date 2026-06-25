import type {
  AgentBlastRadius,
  AgentContextCompleteness,
  AgentNodeSummary,
  ContextStrategy,
} from "./explore.js";
import type { SourceSnippet } from "./formatter.js";

export type AgentOutputKind = "context" | "node_read";

export interface ViewNode {
  graphId: string;
  kind: string;
  name: string;
  qualifiedName: string;
  filePath: string | null;
  addressKind: string;
  ownerPath: string | null;
  readablePath: string | null;
  displayPath: string | null;
  referencePath: string | null;
  selector: Record<string, string | null>;
  startLine: number | null;
  signature: string | null;
  priority: number;
  protected: boolean;
}

export interface ViewRelationship {
  source: string;
  kind: string;
  target: string;
  provenance: string;
  priority: number;
  protected: boolean;
}

export interface ViewSnippet {
  filePath: string;
  startLine: number;
  endLine: number;
  text: string;
  priority: number;
}

export interface ViewSource {
  filePath: string | null;
  startLine: number;
  endLine: number;
  text: string;
  missing?: boolean;
}

export interface ViewBudget {
  maxChars: number;
  estimatedChars: number;
}

export interface ViewOmittedCounts {
  nodes: number;
  relationships: number;
  snippets: number;
}

export type ViewOmittedNodeCategory = "resource" | "script" | "scene" | "test" | "other";

export interface ViewOmittedSummary {
  nodes: Partial<Record<ViewOmittedNodeCategory, number>>;
}

interface AgentOutputViewBase {
  kind: AgentOutputKind;
  query?: string;
  strategy?: ContextStrategy;
  completeness?: AgentContextCompleteness;
  entryPointIds: string[];
  pathsBetween: ViewRelationship[];
  blastRadius?: AgentBlastRadius;
  nodes: ViewNode[];
  relationships: ViewRelationship[];
  snippets: ViewSnippet[];
  source?: ViewSource;
  omitted: ViewOmittedCounts;
  omittedSummary: ViewOmittedSummary;
  truncated: boolean;
  budget: ViewBudget;
}

export interface ViewFileTarget {
  kind: "file";
  filePath: string;
  fileKind: string;
  nodeCount: number;
}

export interface ViewRelationshipNoteGroups {
  complete: boolean;
  callers: ViewNode[];
  callees: ViewNode[];
  dependents: ViewNode[];
  dependencies: ViewNode[];
  limit: number;
  omitted: {
    callers: number;
    callees: number;
    dependents: number;
    dependencies: number;
  };
}

export interface ContextOutputView extends AgentOutputViewBase {
  kind: "context";
}

export interface NodeReadOutputView extends AgentOutputViewBase {
  kind: "node_read";
  nodeRead: {
    target: ViewNode | ViewFileTarget;
    symbols: ViewNode[];
    notes?: ViewRelationshipNoteGroups;
    staleFilePaths: string[];
  };
}

export type AgentOutputView = ContextOutputView | NodeReadOutputView;

export interface ContextOutputViewInput {
  query: string;
  strategy?: ContextStrategy;
  completeness?: AgentContextCompleteness;
  entryPoints?: string[];
  pathsBetween?: string[];
  blastRadius?: AgentBlastRadius;
  nodes: AgentNodeSummary[];
  relationships: string[];
  snippets: SourceSnippet[];
  maxChars: number;
}

export function contextToOutputView(input: ContextOutputViewInput): ContextOutputView {
  const entryPointIds = input.entryPoints ?? [];
  const entryPointSet = new Set(entryPointIds);
  const protectedNodeIds = new Set(entryPointIds);
  const relationships = input.relationships
    .map((relationship, index) => protectEntryPointRelationship(
      parseRelationshipToView(relationship, index, false),
      entryPointSet,
    ));
  const pathsBetween = (input.pathsBetween ?? [])
    .map((relationship, index) => parseRelationshipToView(relationship, index, true));

  for (const relationship of [...relationships, ...pathsBetween]) {
    for (const endpoint of relationshipEndpointIds([relationship])) {
      protectedNodeIds.add(endpoint);
    }
  }

  return {
    kind: "context",
    query: input.query,
    ...(input.strategy ? { strategy: input.strategy } : {}),
    ...(input.completeness ? { completeness: input.completeness } : {}),
    entryPointIds,
    pathsBetween,
    ...(input.blastRadius ? { blastRadius: input.blastRadius } : {}),
    nodes: input.nodes.map((node, index) => ({
      graphId: node.id,
      kind: node.kind,
      name: node.name,
      qualifiedName: node.qualifiedName,
      filePath: node.filePath,
      addressKind: node.addressKind,
      ownerPath: node.ownerPath,
      readablePath: node.readablePath,
      displayPath: node.displayPath,
      referencePath: node.referencePath,
      selector: node.selector,
      startLine: node.startLine,
      signature: node.signature,
      priority: protectedNodeIds.has(node.id) ? 0 : 50 + index,
      protected: protectedNodeIds.has(node.id),
    })),
    relationships,
    snippets: input.snippets.map((snippet, index) => ({
      filePath: snippet.filePath,
      startLine: snippet.startLine,
      endLine: snippet.endLine,
      text: snippet.text,
      priority: 80 + index,
    })),
    omitted: {
      nodes: 0,
      relationships: 0,
      snippets: 0,
    },
    omittedSummary: {
      nodes: {},
    },
    truncated: false,
    budget: {
      maxChars: input.maxChars,
      estimatedChars: 0,
    },
  };
}

export function nodeReadToOutputView(input: {
  target: ViewNode | ViewFileTarget;
  symbols?: ViewNode[];
  notes?: ViewRelationshipNoteGroups;
  source?: ViewSource;
  staleFilePaths: string[];
  maxChars: number;
}): NodeReadOutputView {
  return {
    kind: "node_read",
    entryPointIds: [],
    pathsBetween: [],
    nodes: [],
    relationships: [],
    snippets: [],
    ...(input.source ? { source: input.source } : {}),
    nodeRead: {
      target: input.target,
      symbols: input.symbols ?? [],
      ...(input.notes ? { notes: input.notes } : {}),
      staleFilePaths: input.staleFilePaths,
    },
    omitted: {
      nodes: 0,
      relationships: 0,
      snippets: 0,
    },
    omittedSummary: {
      nodes: {},
    },
    truncated: false,
    budget: {
      maxChars: input.maxChars,
      estimatedChars: 0,
    },
  };
}

function protectEntryPointRelationship(
  relationship: ViewRelationship,
  entryPointIds: Set<string>,
): ViewRelationship {
  const touchesEntryPoint = relationshipEndpointIds([relationship])
    .some((endpointId) => entryPointIds.has(endpointId));
  return touchesEntryPoint
    ? { ...relationship, protected: true, priority: Math.min(relationship.priority, 10) }
    : relationship;
}

export function parseRelationshipToView(
  relationship: string,
  priority: number,
  protectedRelationship: boolean,
): ViewRelationship {
  const match = relationship.match(/^(\S+) ([a-z_]+) (.+) \(([^)]+)\)$/);
  if (!match) {
    return {
      source: "",
      kind: "related",
      target: relationship,
      provenance: "text",
      priority,
      protected: protectedRelationship,
    };
  }

  return {
    source: match[1],
    kind: match[2],
    target: match[3],
    provenance: match[4],
    priority,
    protected: protectedRelationship,
  };
}

export function relationshipEndpointIds(relationships: ViewRelationship[]): string[] {
  return relationships.flatMap((relationship) => {
    if (!relationship.source) {
      return [];
    }
    const targetIsDirectUnresolvedPath =
      relationship.provenance === "unresolved" && relationship.target.startsWith("res://");
    return [
      relationship.source,
      ...(targetIsDirectUnresolvedPath ? [] : [relationship.target]),
    ];
  });
}
