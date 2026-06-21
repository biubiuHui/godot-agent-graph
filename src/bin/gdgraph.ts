#!/usr/bin/env node

import { readFileSync } from "node:fs";

import { createCliProgram } from "../cli/index.js";

interface PackageMetadata {
  version: string;
}

const packageJsonUrl = new URL("../../package.json", import.meta.url);
const packageMetadata = JSON.parse(
  readFileSync(packageJsonUrl, "utf8"),
) as PackageMetadata;

try {
  await createCliProgram({ version: packageMetadata.version }).parseAsync(process.argv);
} catch (error) {
  if (!isCommanderExit(error)) {
    throw error;
  }

  process.exitCode = error.exitCode;
}

function isCommanderExit(error: unknown): error is { exitCode: number; code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "exitCode" in error &&
    "code" in error &&
    typeof error.exitCode === "number" &&
    typeof error.code === "string" &&
    error.code.startsWith("commander.")
  );
}
