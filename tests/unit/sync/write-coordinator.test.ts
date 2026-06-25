import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runSingleFlightWrite } from "../../../src/sync/write-coordinator.js";

const tempRoots: string[] = [];

function tempProjectRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `gdgraph-${prefix}-`));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("sync write coordinator", () => {
  it("returns the collision result for nested writes to the same root", () => {
    const root = tempProjectRoot("single-flight");

    const result = runSingleFlightWrite(
      root,
      () => runSingleFlightWrite(root, () => "inner", () => "same-root-collision"),
      () => "outer-collision",
    );

    expect(result).toBe("same-root-collision");
    expect(runSingleFlightWrite(root, () => "after", () => "collision")).toBe("after");
  });

  it("allows nested writes for different roots and clears active state after errors", () => {
    const firstRoot = tempProjectRoot("single-flight-first");
    const secondRoot = tempProjectRoot("single-flight-second");

    const nested = runSingleFlightWrite(
      firstRoot,
      () => runSingleFlightWrite(secondRoot, () => "different-root", () => "collision"),
      () => "outer-collision",
    );
    expect(nested).toBe("different-root");

    expect(() =>
      runSingleFlightWrite(firstRoot, () => {
        throw new Error("planned failure");
      }, () => "collision"),
    ).toThrow("planned failure");
    expect(runSingleFlightWrite(firstRoot, () => "after-error", () => "collision")).toBe("after-error");
  });
});
