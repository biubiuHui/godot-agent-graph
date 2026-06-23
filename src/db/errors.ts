export function isSqliteLockError(error: unknown): boolean {
  const code = errorCode(error);
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return /database is (?:busy|locked)|SQLITE_BUSY|SQLITE_LOCKED/i.test(message);
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }

  const code = error.code;
  return typeof code === "string" ? code : null;
}
