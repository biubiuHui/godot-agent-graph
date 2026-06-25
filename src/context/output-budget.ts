import { estimatedChars, finalizeAgentOutput } from "./output-finalize.js";
import {
  relationshipEndpointIds,
  type AgentOutputView,
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
    } else if (removeUnprotectedTailNode(budgeted)) {
      budgeted.omitted.nodes += 1;
    } else if (removeRelationship(budgeted, true)) {
      budgeted.omitted.relationships += 1;
    } else if (budgeted.nodes.length > 0) {
      budgeted.nodes.pop();
      budgeted.omitted.nodes += 1;
    } else {
      break;
    }
    budgeted.truncated = true;
    budgeted.budget.estimatedChars = estimateBudgetedView(budgeted);
  }

  budgeted.truncated = budgeted.truncated || hasOmissions(budgeted);
  return budgeted;
}

function applyCountLimits(view: AgentOutputView, options: OutputBudgetOptions): void {
  if (view.nodes.length > options.maxNodes) {
    view.omitted.nodes += view.nodes.length - options.maxNodes;
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

function removeUnprotectedTailNode(view: AgentOutputView): boolean {
  const protectedNodeIds = protectedGraphIds(view);
  for (let index = view.nodes.length - 1; index >= 0; index -= 1) {
    const node = view.nodes[index];
    if (!node || node.protected || protectedNodeIds.has(node.graphId)) {
      continue;
    }
    view.nodes.splice(index, 1);
    return true;
  }
  return false;
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
    budget: { ...view.budget },
  };
}

function cloneRelationships(relationships: ViewRelationship[]): ViewRelationship[] {
  return relationships.map((relationship) => ({ ...relationship }));
}
