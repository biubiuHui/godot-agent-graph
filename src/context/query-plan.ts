export type ContextStrategy = "resource-first" | "symbol-first" | "relationship" | "source-oriented" | "general";

export interface ContextQueryPlan {
  rawQuery: string;
  strategy: ContextStrategy;
  exactTerms: string[];
  resourcePathAnchors: string[];
  resourceDirectoryAnchors: string[];
  resourceNameAnchors: string[];
  opaqueTerms: string[];
  allowFallbackText: boolean;
  symbolTerms: string[];
  fieldTerms: string[];
  textTerms: string[];
}

export function buildQueryPlan(query: string): ContextQueryPlan {
  const resourcePathAnchors = extractResourcePathAnchors(query);
  const resourceDirectoryAnchors = extractResourceDirectoryAnchors(query, resourcePathAnchors);
  const identifierTerms = extractIdentifierTerms(query);
  const strategy = inferContextStrategy(query);
  const resourceNameAnchors = extractResourceNameAnchors(identifierTerms);
  const opaqueTerms = extractOpaqueTerms(identifierTerms);
  const fieldTerms = identifierTerms.filter(isFieldTerm);
  const symbolTerms = identifierTerms.filter((term) => /^[A-Z]/.test(term));
  const textTerms = extractNormalizedTextTerms(query);

  return {
    rawQuery: query,
    strategy,
    exactTerms: uniqueStrings([...resourcePathAnchors, ...identifierTerms]),
    resourcePathAnchors,
    resourceDirectoryAnchors,
    resourceNameAnchors,
    opaqueTerms,
    allowFallbackText: shouldAllowFallbackText(strategy, opaqueTerms, resourceDirectoryAnchors),
    symbolTerms,
    fieldTerms,
    textTerms,
  };
}

const RESOURCE_FIELD_TERMS = new Set([
  "display_name",
  "display_label",
  "description",
  "payload_id",
  "base_weight",
  "weight_keys",
  "group_keys",
  "metadata",
  "resources",
]);

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

function extractResourceNameAnchors(identifierTerms: string[]): string[] {
  return uniqueStrings(identifierTerms.filter(isResourceNameAnchor));
}

function extractOpaqueTerms(identifierTerms: string[]): string[] {
  return uniqueStrings(
    identifierTerms.filter((term) =>
      isResourceNameAnchor(term) ||
      /^[A-Z0-9_]{4,}$/.test(term)
    ),
  );
}

function shouldAllowFallbackText(
  strategy: ContextStrategy,
  opaqueTerms: string[],
  resourceDirectoryAnchors: string[],
): boolean {
  if (opaqueTerms.length === 0) {
    return true;
  }
  return strategy === "resource-first" && resourceDirectoryAnchors.length > 0;
}

function isFieldTerm(term: string): boolean {
  return term.includes("_") || RESOURCE_FIELD_TERMS.has(term);
}

function isResourceNameAnchor(term: string): boolean {
  if (/^[A-Z]/.test(term) || RESOURCE_FIELD_TERMS.has(term)) {
    return false;
  }

  const underscoreCount = (term.match(/_/g) ?? []).length;
  return (/\d/.test(term) && underscoreCount >= 1) || underscoreCount >= 2;
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
