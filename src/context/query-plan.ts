export type ContextStrategy = "resource-first" | "symbol-first" | "relationship" | "source-oriented" | "general";

export interface ContextQueryPlan {
  rawQuery: string;
  strategy: ContextStrategy;
  exactTerms: string[];
  resourcePathAnchors: string[];
  resourceDirectoryAnchors: string[];
  symbolTerms: string[];
  fieldTerms: string[];
  textTerms: string[];
}

export function buildQueryPlan(query: string): ContextQueryPlan {
  const resourcePathAnchors = extractResourcePathAnchors(query);
  const resourceDirectoryAnchors = extractResourceDirectoryAnchors(query, resourcePathAnchors);
  const identifierTerms = extractIdentifierTerms(query);
  const fieldTerms = identifierTerms.filter((term) => term.includes("_"));
  const symbolTerms = identifierTerms.filter((term) => /^[A-Z]/.test(term));
  const textTerms = extractNormalizedTextTerms(query);

  return {
    rawQuery: query,
    strategy: inferContextStrategy(query),
    exactTerms: uniqueStrings([...resourcePathAnchors, ...identifierTerms]),
    resourcePathAnchors,
    resourceDirectoryAnchors,
    symbolTerms,
    fieldTerms,
    textTerms,
  };
}

function inferContextStrategy(query: string): ContextStrategy {
  if (/\b(dependents?|dependencies|references?|refs?|callers?|callees?|impact)\b/i.test(query)) {
    return "relationship";
  }

  if (/\bres:\/\/[^\s"',)]+\.gd\b|\b(offset|source|snippet|window)\b/i.test(query)) {
    return "source-oriented";
  }

  if (
    /\bres:\/\/[^\s"',)]+\.(?:tres|res|tscn)\b|\.(?:tres|res|tscn)\b|\bresources?\b|\b(display_name|display_label|payload|weights?|metadata)\b/i
      .test(query)
  ) {
    return "resource-first";
  }

  if (/[A-Z][A-Za-z0-9_]*|[A-Z0-9_]{3,}|[a-z]+_[a-z0-9_]+/.test(query)) {
    return "symbol-first";
  }

  return "general";
}

function extractResourcePathAnchors(query: string): string[] {
  return uniqueStrings(query.match(/\bres:\/\/[^\s"',)]+\.(?:tres|res|tscn)\b/gi) ?? []);
}

function extractResourceDirectoryAnchors(query: string, resourcePathAnchors: string[]): string[] {
  const pathDirectories = resourcePathAnchors
    .map((path) => normalizePathFragment(path))
    .map(dirname)
    .filter((path) => path.length > 0);
  const queryDirectories = (query.match(/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+/g) ?? [])
    .map(normalizePathFragment)
    .map((path) => isResourceFilePath(path) ? dirname(path) : path)
    .filter((path) => path.length > 0);

  return uniqueStrings([...pathDirectories, ...queryDirectories]);
}

function extractIdentifierTerms(query: string): string[] {
  return uniqueStrings(query.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);
}

function extractNormalizedTextTerms(query: string): string[] {
  return uniqueStrings(
    query
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[^A-Za-z0-9]+/)
      .map(normalizeContextTerm)
      .filter((term): term is string => term !== null),
  );
}

function normalizeContextTerm(value: string): string | null {
  const term = value.toLowerCase();
  if (term.length < 3) {
    return null;
  }
  if (term.endsWith("ies") && term.length > 4) {
    return `${term.slice(0, -3)}y`;
  }
  if (term.endsWith("s") && term.length > 4) {
    return term.slice(0, -1);
  }
  return term;
}

function normalizePathFragment(value: string): string {
  return value
    .toLowerCase()
    .replace(/^res:\/\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : "";
}

function isResourceFilePath(path: string): boolean {
  return /\.(?:tres|res|tscn)$/i.test(path);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}
