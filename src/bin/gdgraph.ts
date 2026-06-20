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

await createCliProgram({ version: packageMetadata.version }).parseAsync(process.argv);
