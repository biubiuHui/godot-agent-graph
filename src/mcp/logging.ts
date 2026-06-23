export type McpLogWriter = (message: string) => void;

export function logMcpError(
  event: string,
  error: unknown,
  details: Record<string, unknown> = {},
  write: McpLogWriter = (message) => process.stderr.write(`${message}\n`),
): void {
  write(
    `[gdgraph:mcp] ${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      event,
      ...details,
      error: redactLocalPaths(errorMessage(error)),
    })}`,
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redactLocalPaths(value: string): string {
  return value
    .replace(/\/(?:Users|Volumes|private|var|tmp)\/[^\s"'{}[\],)]+/g, "[local-path]")
    .replace(/[A-Za-z]:\\[^\s"'{}[\],)]+/g, "[local-path]");
}
