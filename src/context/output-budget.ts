import { estimatedChars, finalizeAgentOutput } from "./output-finalize.js";
import {
  relationshipEndpointIds,
  type AgentOutputView,
  type ViewNode,
  type ViewOmittedNodeCategory,
  type ViewRelationship,
} from "./output-view.js";

export interface OutputBudgetOptions {
  maxNodes: number;
  maxRelationships: number;
  maxSnippets: number;
  maxChars: number;
}

export function applyOutputBudget<T extends AgentOutputView>(
  view: T,
  options: OutputBudgetOptions,
): T {
  const budgeted = cloneView(view) as T;
  budgeted.budget.maxChars = options.maxChars;

  applyCountLimits(budgeted, options);
  budgeted.truncated = hasOmissions(budgeted);
  budgeted.budget.estimatedChars = estimateBudgetedView(budgeted);

  while (budgeted.budget.estimatedChars > options.maxChars) {
    if (budgeted.snippets.length > 0) {
      budgeted.snippets.pop();
      budgeted.omitted.snippets += 1;
    } else if (removeRelationship(budgeted, false)) {
      budgeted.omitted.relationships += 1;
    } else {
      const removedNode = removeUnprotectedTailNode(budgeted);
      if (!removedNode) {
        if (removeRelationship(budgeted, true)) {
          budgeted.omitted.relationships += 1;
        } else {
          const tailNode = budgeted.nodes.pop();
          if (!tailNode) {
            break;
          }
          addOmittedNodeSummary(budgeted, tailNode);
          budgeted.omitted.nodes += 1;
        }
      } else {
        addOmittedNodeSummary(budgeted, removedNode);
        budgeted.omitted.nodes += 1;
      }
    }
    budgeted.truncated = true;
    budgeted.budget.estimatedChars = estimateBudgetedView(budgeted);
  }

  budgeted.truncated = budgeted.truncated || hasOmissions(budgeted);
  return budgeted;
}

function applyCountLimits(view: AgentOutputView, options: OutputBudgetOptions): void {
  if (view.nodes.length > options.maxNodes) {
    const omittedNodes = view.nodes.slice(options.maxNodes);
    addOmittedNodesSummary(view, omittedNodes);
    view.omitted.nodes += omittedNodes.length;
    view.nodes = view.nodes.slice(0, options.maxNodes);
  }
  if (view.relationships.length > options.maxRelationships) {
    view.omitted.relationships += view.relationships.length - options.maxRelationships;
    view.relationships = view.relationships.slice(0, options.maxRelationships);
  }
  if (view.snippets.length > options.maxSnippets) {
    view.omitted.snippets += view.snippets.length - options.maxSnippets;
    view.snippets = view.snippets.slice(0, options.maxSnippets);
  }
}

function removeRelationship(view: AgentOutputView, allowProtected: boolean): boolean {
  for (let index = view.relationships.length - 1; index >= 0; index -= 1) {
    const relationship = view.relationships[index];
    if (!relationship || (relationship.protected && !allowProtected)) {
      continue;
    }
    view.relationships.splice(index, 1);
    return true;
  }
  return false;
}

function removeUnprotectedTailNode(view: AgentOutputView): ViewNode | null {
  const protectedNodeIds = protectedGraphIds(view);
  for (let index = view.nodes.length - 1; index >= 0; index -= 1) {
    const node = view.nodes[index];
    if (!node || protectedNodeIds.has(node.graphId)) {
      continue;
    }
    view.nodes.splice(index, 1);
    return node;
  }
  return null;
}

function protectedGraphIds(view: AgentOutputView): Set<string> {
  return new Set([
    ...view.entryPointIds,
    ...relationshipEndpointIds(view.relationships),
    ...relationshipEndpointIds(view.pathsBetween),
    ...(view.blastRadius?.entryPoints ?? []),
  ]);
}

function estimateBudgetedView(view: AgentOutputView): number {
  try {
    return estimatedChars(finalizeAgentOutput(view));
  } catch {
    return estimatedChars(view);
  }
}

function hasOmissions(view: AgentOutputView): boolean {
  return view.omitted.nodes > 0 ||
    view.omitted.relationships > 0 ||
    view.omitted.snippets > 0;
}

function cloneView(view: AgentOutputView): AgentOutputView {
  return {
    ...view,
    entryPointIds: [...view.entryPointIds],
    pathsBetween: cloneRelationships(view.pathsBetween),
    nodes: view.nodes.map((node) => ({ ...node })),
    relationships: cloneRelationships(view.relationships),
    snippets: view.snippets.map((snippet) => ({ ...snippet })),
    omitted: { ...view.omitted },
    omittedSummary: {
      nodes: { ...view.omittedSummary.nodes },
    },
    budget: { ...view.budget },
  };
}

function cloneRelationships(relationships: ViewRelationship[]): ViewRelationship[] {
  return relationships.map((relationship) => ({ ...relationship }));
}

function addOmittedNodesSummary(view: AgentOutputView, nodes: ViewNode[]): void {
  for (const node of nodes) {
    addOmittedNodeSummary(view, node);
  }
}

function addOmittedNodeSummary(view: AgentOutputView, node: ViewNode): void {
  const category = omittedNodeCategory(node);
  view.omittedSummary.nodes[category] = (view.omittedSummary.nodes[category] ?? 0) + 1;
}

function omittedNodeCategory(node: ViewNode): ViewOmittedNodeCategory {
  const path = [node.filePath, node.displayPath, node.ownerPath, node.readablePath]
    .filter((value): value is string => Boolean(value))
    .join(" ");
  if (/(^|\/)tests?\//i.test(path)) {
    return "test";
  }
  if (node.kind === "resource") {
    return "resource";
  }
  if (node.kind === "scene" || node.kind === "scene_node") {
    return "scene";
  }
  if (isScriptNodeKind(node.kind)) {
    return "script";
  }
  return "other";
}

function isScriptNodeKind(kind: string): boolean {
  return [
    "script_class",
    "inner_class",
    "method",
    "property",
    "signal",
    "autoload",
  ].includes(kind);
}
