export type GodotResourceKind = "scene" | "resource" | "unknown";

export interface GodotResourceRef {
  kind: "ExtResource" | "SubResource";
  id: string;
}

export type GodotResourceValue = string | number | boolean | GodotResourceRef;

export interface GodotSceneHeader {
  loadSteps: number | null;
  format: number | null;
  uid: string | null;
  line: number;
}

export interface GodotResourceHeader {
  type: string | null;
  format: number | null;
  uid: string | null;
  line: number;
}

export interface GodotExtResource {
  id: string;
  type: string | null;
  path: string;
  line: number;
}

export interface GodotSubResource {
  id: string;
  type: string | null;
  properties: Record<string, GodotResourceValue>;
  line: number;
}

export interface GodotSceneNode {
  name: string;
  type: string | null;
  parent: string | null;
  instance: GodotResourceRef | null;
  properties: Record<string, GodotResourceValue>;
  line: number;
}

export interface GodotResourceConnection {
  signal: string;
  from: string;
  to: string;
  method: string;
  line: number;
}

export interface GodotResourceParseError {
  line: number;
  message: string;
}

interface LogicalLine {
  text: string;
  line: number;
}

export interface GodotResourceParseResult {
  filePath: string;
  kind: GodotResourceKind;
  scene: GodotSceneHeader | null;
  resource: GodotResourceHeader | null;
  extResources: GodotExtResource[];
  subResources: GodotSubResource[];
  nodes: GodotSceneNode[];
  connections: GodotResourceConnection[];
  resourceProperties: Record<string, GodotResourceValue>;
  errors: GodotResourceParseError[];
}

type ActiveSection =
  | { kind: "none" }
  | { kind: "node"; index: number }
  | { kind: "sub_resource"; index: number }
  | { kind: "resource" };

export function parseGodotResource(
  contents: string,
  filePath: string,
): GodotResourceParseResult {
  const result: GodotResourceParseResult = {
    filePath,
    kind: "unknown",
    scene: null,
    resource: null,
    extResources: [],
    subResources: [],
    nodes: [],
    connections: [],
    resourceProperties: {},
    errors: [],
  };
  let activeSection: ActiveSection = { kind: "none" };

  for (const logicalLine of collectLogicalLines(contents)) {
    const lineNumber = logicalLine.line;
    const trimmed = logicalLine.text.trim();
    if (trimmed.length === 0 || trimmed.startsWith(";")) {
      continue;
    }

    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      activeSection = parseSection(result, trimmed, lineNumber);
      continue;
    }

    const assignment = parseAssignment(trimmed);
    if (!assignment) {
      result.errors.push({
        line: lineNumber,
        message: "Expected key=value assignment",
      });
      continue;
    }

    const parsedValue = parseValue(assignment.value);
    if (activeSection.kind === "node") {
      result.nodes[activeSection.index].properties[assignment.key] = parsedValue;
    } else if (activeSection.kind === "sub_resource") {
      result.subResources[activeSection.index].properties[assignment.key] = parsedValue;
    } else if (activeSection.kind === "resource") {
      result.resourceProperties[assignment.key] = parsedValue;
    }
  }

  return result;
}

function collectLogicalLines(contents: string): LogicalLine[] {
  const logicalLines: LogicalLine[] = [];
  const physicalLines = contents.split(/\r?\n/);
  let pending: { line: number; parts: string[]; depth: number } | null = null;

  for (let index = 0; index < physicalLines.length; index += 1) {
    const line = physicalLines[index] ?? "";
    const lineNumber = index + 1;
    const trimmed = line.trim();
    if (pending) {
      pending.parts.push(trimmed);
      pending.depth += aggregateDepthDelta(trimmed);
      if (pending.depth <= 0) {
        logicalLines.push({
          line: pending.line,
          text: pending.parts.join("\n"),
        });
        pending = null;
      }
      continue;
    }

    const assignment = parseAssignment(trimmed);
    const depth = assignment ? aggregateDepthDelta(assignment.value) : 0;
    if (assignment && depth > 0) {
      pending = {
        line: lineNumber,
        parts: [trimmed],
        depth,
      };
      continue;
    }

    logicalLines.push({
      line: lineNumber,
      text: line,
    });
  }

  if (pending) {
    logicalLines.push({
      line: pending.line,
      text: pending.parts.join("\n"),
    });
  }

  return logicalLines;
}

function aggregateDepthDelta(value: string): number {
  let depth = 0;
  let inString = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '"' && value[index - 1] !== "\\") {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === "{" || char === "[" || char === "(") {
      depth += 1;
    } else if (char === "}" || char === "]" || char === ")") {
      depth -= 1;
    }
  }

  return depth;
}

function parseSection(
  result: GodotResourceParseResult,
  sectionText: string,
  line: number,
): ActiveSection {
  const tokens = tokenizeSection(sectionText.slice(1, -1).trim());
  const sectionKind = tokens.shift();
  const attrs = parseSectionAttributes(tokens);

  if (sectionKind === "gd_scene") {
    result.kind = "scene";
    result.scene = {
      loadSteps: getNumberAttr(attrs, "load_steps"),
      format: getNumberAttr(attrs, "format"),
      uid: getStringAttr(attrs, "uid"),
      line,
    };
    return { kind: "none" };
  }

  if (sectionKind === "gd_resource") {
    result.kind = "resource";
    result.resource = {
      type: getStringAttr(attrs, "type"),
      format: getNumberAttr(attrs, "format"),
      uid: getStringAttr(attrs, "uid"),
      line,
    };
    return { kind: "none" };
  }

  if (sectionKind === "ext_resource") {
    const id = getStringAttr(attrs, "id");
    const path = getStringAttr(attrs, "path");
    if (id && path) {
      result.extResources.push({
        id,
        type: getStringAttr(attrs, "type"),
        path,
        line,
      });
    } else {
      result.errors.push({
        line,
        message: "ext_resource requires id and path",
      });
    }
    return { kind: "none" };
  }

  if (sectionKind === "sub_resource") {
    const id = getStringAttr(attrs, "id");
    if (!id) {
      result.errors.push({
        line,
        message: "sub_resource requires id",
      });
      return { kind: "none" };
    }

    const index =
      result.subResources.push({
        id,
        type: getStringAttr(attrs, "type"),
        properties: {},
        line,
      }) - 1;
    return { kind: "sub_resource", index };
  }

  if (sectionKind === "node") {
    const name = getStringAttr(attrs, "name");
    if (!name) {
      result.errors.push({
        line,
        message: "node requires name",
      });
      return { kind: "none" };
    }

    const index =
      result.nodes.push({
        name,
        type: getStringAttr(attrs, "type"),
        parent: getStringAttr(attrs, "parent"),
        instance: getResourceRefAttr(attrs, "instance"),
        properties: {},
        line,
      }) - 1;
    return { kind: "node", index };
  }

  if (sectionKind === "connection") {
    const signal = getStringAttr(attrs, "signal");
    const from = getStringAttr(attrs, "from");
    const to = getStringAttr(attrs, "to");
    const method = getStringAttr(attrs, "method");
    if (signal && from && to && method) {
      result.connections.push({
        signal,
        from,
        to,
        method,
        line,
      });
    } else {
      result.errors.push({
        line,
        message: "connection requires signal, from, to, and method",
      });
    }
    return { kind: "none" };
  }

  if (sectionKind === "resource") {
    return { kind: "resource" };
  }

  return { kind: "none" };
}

function tokenizeSection(value: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inString = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '"' && value[index - 1] !== "\\") {
      inString = !inString;
    }

    if (char === " " && !inString) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function parseSectionAttributes(tokens: string[]): Record<string, GodotResourceValue> {
  const attrs: Record<string, GodotResourceValue> = {};

  for (const token of tokens) {
    const assignment = parseAssignment(token);
    if (assignment) {
      attrs[assignment.key] = parseValue(assignment.value);
    }
  }

  return attrs;
}

function parseAssignment(value: string): { key: string; value: string } | null {
  const separatorIndex = value.indexOf("=");
  if (separatorIndex === -1) {
    return null;
  }

  return {
    key: value.slice(0, separatorIndex).trim(),
    value: value.slice(separatorIndex + 1).trim(),
  };
}

function parseValue(value: string): GodotResourceValue {
  const resourceRef = parseResourceRef(value);
  if (resourceRef) {
    return resourceRef;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  if (isQuotedString(value)) {
    return unwrapQuotedString(value);
  }

  const numberValue = Number(value);
  if (value.length > 0 && Number.isFinite(numberValue)) {
    return numberValue;
  }

  return value;
}

function parseResourceRef(value: string): GodotResourceRef | null {
  const match = value.match(/^(ExtResource|SubResource)\("([^"]+)"\)$/);
  if (!match) {
    return null;
  }

  return {
    kind: match[1] as GodotResourceRef["kind"],
    id: match[2] ?? "",
  };
}

function isQuotedString(value: string): boolean {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"');
}

function unwrapQuotedString(value: string): string {
  return value.slice(1, -1).replace(/\\"/g, '"');
}

function getStringAttr(
  attrs: Record<string, GodotResourceValue>,
  key: string,
): string | null {
  const value = attrs[key];
  return typeof value === "string" ? value : null;
}

function getNumberAttr(
  attrs: Record<string, GodotResourceValue>,
  key: string,
): number | null {
  const value = attrs[key];
  return typeof value === "number" ? value : null;
}

function getResourceRefAttr(
  attrs: Record<string, GodotResourceValue>,
  key: string,
): GodotResourceRef | null {
  const value = attrs[key];
  return isResourceRef(value) ? value : null;
}

function isResourceRef(value: GodotResourceValue | undefined): value is GodotResourceRef {
  return typeof value === "object" && value !== null && "kind" in value && "id" in value;
}
