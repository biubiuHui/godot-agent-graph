import { describe, expect, it } from "vitest";

import { createCliProgram } from "../../../src/cli/index.js";

describe("gdgraph version", () => {
  it("prints the configured package version", async () => {
    const output: string[] = [];
    const program = createCliProgram({
      version: "1.2.3",
      write: (text) => output.push(text),
    });

    await program.parseAsync(["node", "gdgraph", "version"]);

    expect(output.join("")).toBe("1.2.3\n");
  });
});
