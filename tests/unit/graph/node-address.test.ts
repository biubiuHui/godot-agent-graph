import { describe, expect, it } from "vitest";

import {
  displayPathForNode,
  readablePathForNode,
  referencePathForNode,
  selectorForNode,
} from "../../../src/graph/node-address.js";
import type { GraphNode } from "../../../src/types.js";

function graphNode(overrides: Partial<GraphNode>): GraphNode {
  return {
    id: "script:res://scripts/fixture_actor.gd",
    kind: "script_class",
    name: "FixtureActor",
    qualifiedName: "FixtureActor",
    filePath: "res://scripts/fixture_actor.gd",
    addressKind: "indexed_symbol",
    ownerPath: "res://scripts/fixture_actor.gd",
    readablePath: "res://scripts/fixture_actor.gd",
    displayPath: "res://scripts/fixture_actor.gd",
    referencePath: null,
    startLine: 1,
    endLine: null,
    signature: "class_name FixtureActor",
    metadata: {},
    updatedAt: 1,
    ...overrides,
  };
}

describe("node address helpers", () => {
  it("reads indexed symbol paths from explicit address fields", () => {
    const node = graphNode({});

    expect(readablePathForNode(node)).toBe("res://scripts/fixture_actor.gd");
    expect(displayPathForNode(node)).toBe("res://scripts/fixture_actor.gd");
    expect(referencePathForNode(node)).toBeNull();
    expect(selectorForNode(node)).toEqual({
      id: "script:res://scripts/fixture_actor.gd",
      kind: "script_class",
      path: "res://scripts/fixture_actor.gd",
    });
  });

  it("keeps subresources displayable but not directly readable", () => {
    const node = graphNode({
      id: "resource:res://resources/fixture_profile.tres#ProfileSub",
      kind: "resource",
      name: "ProfileSub",
      qualifiedName: "res://resources/fixture_profile.tres#ProfileSub",
      addressKind: "resource_subresource",
      ownerPath: "res://resources/fixture_profile.tres",
      readablePath: null,
      displayPath: "res://resources/fixture_profile.tres",
      referencePath: null,
    });

    expect(readablePathForNode(node)).toBeNull();
    expect(displayPathForNode(node)).toBe("res://resources/fixture_profile.tres");
    expect(selectorForNode(node)).toEqual({
      id: "resource:res://resources/fixture_profile.tres#ProfileSub",
      kind: "resource",
      path: "res://resources/fixture_profile.tres",
    });
  });

  it("exposes missing references without making them readable", () => {
    const node = graphNode({
      id: "resource:res://missing/fixture_missing_data.tres",
      kind: "resource",
      name: "fixture_missing_data.tres",
      qualifiedName: "res://missing/fixture_missing_data.tres",
      filePath: null,
      addressKind: "resource_missing_ref",
      ownerPath: null,
      readablePath: null,
      displayPath: "res://missing/fixture_missing_data.tres",
      referencePath: "res://missing/fixture_missing_data.tres",
    });

    expect(readablePathForNode(node)).toBeNull();
    expect(displayPathForNode(node)).toBe("res://missing/fixture_missing_data.tres");
    expect(referencePathForNode(node)).toBe("res://missing/fixture_missing_data.tres");
  });

  it("does not invent paths for opaque nodes", () => {
    const node = graphNode({
      id: "opaque:fixture",
      filePath: null,
      addressKind: "opaque",
      ownerPath: null,
      readablePath: null,
      displayPath: null,
      referencePath: null,
    });

    expect(readablePathForNode(node)).toBeNull();
    expect(displayPathForNode(node)).toBeNull();
    expect(referencePathForNode(node)).toBeNull();
    expect(selectorForNode(node)).toEqual({ id: "opaque:fixture" });
  });
});
