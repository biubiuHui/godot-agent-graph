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
      error: errorMessage(error),
      stack: errorStack(error),
    })}`,
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorStack(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : undefined;
}
