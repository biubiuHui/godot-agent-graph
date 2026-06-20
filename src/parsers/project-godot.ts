export interface ProjectGodotAutoload {
  name: string;
  path: string;
  singleton: boolean;
  line: number;
}

export interface ProjectGodotInputAction {
  name: string;
  line: number;
}

export interface ProjectGodotParseError {
  line: number;
  message: string;
}

export interface ProjectGodotParseResult {
  filePath: string;
  projectName: string | null;
  mainScene: string | null;
  autoloads: ProjectGodotAutoload[];
  inputActions: ProjectGodotInputAction[];
  errors: ProjectGodotParseError[];
}

export function parseProjectGodot(
  contents: string,
  filePath: string,
): ProjectGodotParseResult {
  const result: ProjectGodotParseResult = {
    filePath,
    projectName: null,
    mainScene: null,
    autoloads: [],
    inputActions: [],
    errors: [],
  };

  let currentSection: string | null = null;
  let inputBlockDepth = 0;
  const lines = contents.split(/\r?\n/);

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const trimmed = line.trim();

    if (inputBlockDepth > 0) {
      inputBlockDepth += braceDelta(trimmed);
      return;
    }

    if (trimmed.length === 0 || trimmed.startsWith(";")) {
      return;
    }

    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1] ?? null;
      return;
    }

    const assignment = parseAssignment(trimmed);
    if (!assignment) {
      result.errors.push({
        line: lineNumber,
        message: "Expected key=value assignment",
      });
      return;
    }

    if (currentSection === "application") {
      parseApplicationAssignment(result, assignment.key, assignment.value);
    } else if (currentSection === "autoload") {
      result.autoloads.push(parseAutoload(assignment.key, assignment.value, lineNumber));
    } else if (currentSection === "input") {
      result.inputActions.push({
        name: assignment.key,
        line: lineNumber,
      });
    }

    inputBlockDepth = Math.max(0, braceDelta(assignment.value));
  });

  return result;
}

function parseApplicationAssignment(
  result: ProjectGodotParseResult,
  key: string,
  rawValue: string,
): void {
  const value = unwrapGodotString(rawValue);

  if (key === "config/name") {
    result.projectName = value;
  } else if (key === "run/main_scene") {
    result.mainScene = value;
  }
}

function parseAutoload(
  name: string,
  rawValue: string,
  line: number,
): ProjectGodotAutoload {
  const value = unwrapGodotString(rawValue);
  const singleton = value.startsWith("*");
  const path = singleton ? value.slice(1) : value;

  return {
    name,
    path,
    singleton,
    line,
  };
}

function parseAssignment(line: string): { key: string; value: string } | null {
  const separatorIndex = line.indexOf("=");
  if (separatorIndex === -1) {
    return null;
  }

  return {
    key: line.slice(0, separatorIndex).trim(),
    value: line.slice(separatorIndex + 1).trim(),
  };
}

function unwrapGodotString(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"');
  }

  return value;
}

function braceDelta(value: string): number {
  return count(value, "{") - count(value, "}");
}

function count(value: string, needle: string): number {
  return value.split(needle).length - 1;
}
