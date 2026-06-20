import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface SourceSnippet {
  filePath: string;
  startLine: number;
  endLine: number;
  text: string;
}

export function collectFilePaths(
  nodes: Array<{ filePath: string | null }>,
  maxFiles: number,
): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.filePath && !paths.includes(node.filePath)) {
      paths.push(node.filePath);
    }
    if (paths.length >= maxFiles) {
      break;
    }
  }

  return paths;
}

export function sourceSnippetsForFiles(
  projectRoot: string,
  filePaths: string[],
  options: { includeCode: boolean; maxLinesPerFile?: number },
): SourceSnippet[] {
  if (!options.includeCode) {
    return [];
  }

  const maxLines = options.maxLinesPerFile ?? 20;
  return filePaths.flatMap((filePath) => {
    const absolutePath = resPathToAbsolute(projectRoot, filePath);
    if (!existsSync(absolutePath)) {
      return [];
    }

    const lines = readFileSync(absolutePath, "utf8").split(/\r?\n/).slice(0, maxLines);
    return [
      {
        filePath,
        startLine: 1,
        endLine: lines.length,
        text: lines.join("\n"),
      },
    ];
  });
}

function resPathToAbsolute(projectRoot: string, filePath: string): string {
  return join(projectRoot, filePath.replace(/^res:\/\//, ""));
}
