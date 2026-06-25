import type { AgentBlastRadius, AgentNodeSummary } from "./explore.js";
import type { SourceSnippet } from "./formatter.js";
import { applyOutputBudget } from "./output-budget.js";
import {
  createAgentPathRefs,
  finalizeAgentOutput,
  type AgentFormattedBlastRadius,
  type AgentFormattedContext,
  type AgentFormattedNode,
  type AgentFormattedRelationship,
  type AgentFormattedSelector,
  type AgentFormattedSnippet,
  type AgentPathRefs,
} from "./output-finalize.js";
import { contextToOutputView } from "./output-view.js";

export type {
  AgentFormattedBlastRadius,
  AgentFormattedContext,
  AgentFormattedNode,
  AgentFormattedRelationship,
  AgentFormattedSelector,
  AgentFormattedSnippet,
  AgentPathRefs,
};

export { createAgentPathRefs };

export interface AgentContextInput {
  query: string;
  entryPoints?: string[];
  pathsBetween?: string[];
  blastRadius?: AgentBlastRadius;
  nodes: AgentNodeSummary[];
  relationships: string[];
  files: string[];
  snippets: SourceSnippet[];
}

export interface AgentOutputOptions {
  maxNodes?: number;
  maxRelationships?: number;
  maxSnippets?: number;
  maxChars?: number;
}

const DEFAULT_MAX_NODES = 40;
const DEFAULT_MAX_RELATIONSHIPS = 40;
const DEFAULT_MAX_SNIPPETS = 6;
const DEFAULT_MAX_CHARS = 8_000;

export function formatAgentContext(
  context: AgentContextInput,
  options: AgentOutputOptions = {},
): AgentFormattedContext {
  const limits = {
    maxNodes: options.maxNodes ?? DEFAULT_MAX_NODES,
    maxRelationships: options.maxRelationships ?? DEFAULT_MAX_RELATIONSHIPS,
    maxSnippets: options.maxSnippets ?? DEFAULT_MAX_SNIPPETS,
    maxChars: options.maxChars ?? DEFAULT_MAX_CHARS,
  };
  const view = contextToOutputView({
    query: context.query,
    entryPoints: context.entryPoints,
    pathsBetween: context.pathsBetween,
    blastRadius: context.blastRadius,
    nodes: context.nodes,
    relationships: context.relationships,
    snippets: context.snippets,
    maxChars: limits.maxChars,
  });

  return finalizeAgentOutput(applyOutputBudget(view, limits));
}
