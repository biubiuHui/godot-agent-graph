import { basename } from "node:path/posix";

import type {
  GdscriptCall,
  GdscriptInputActionRef,
  GdscriptNodeRef,
  GdscriptParseResult,
  GdscriptReferenceScope,
  GdscriptResourceRef,
  GdscriptSignalConnect,
  GdscriptSignalEmit,
} from "../parsers/gdscript.js";
import type { GraphEdge, GraphNode, UnresolvedRef } from "../types.js";

interface OwnedSymbol {
  name: string;
  ownerName: string | null;
  line: number;
}

const GODOT_ENGINE_BASE_CLASSES = new Set([
  "AcceptDialog",
  "Area2D",
  "Area3D",
  "AudioStreamPlayer",
  "AudioStreamPlayer2D",
  "AudioStreamPlayer3D",
  "Button",
  "Camera2D",
  "Camera3D",
  "CanvasItem",
  "CanvasLayer",
  "CharacterBody2D",
  "CharacterBody3D",
  "CheckBox",
  "CodeEdit",
  "CollisionObject2D",
  "CollisionObject3D",
  "ColorRect",
  "Control",
  "EditorPlugin",
  "FileDialog",
  "GridContainer",
  "HBoxContainer",
  "HTTPRequest",
  "HSlider",
  "HScrollBar",
  "ItemList",
  "Label",
  "Line2D",
  "MarginContainer",
  "MeshInstance3D",
  "NinePatchRect",
  "Node",
  "Node2D",
  "Node3D",
  "Object",
  "OptionButton",
  "Panel",
  "PanelContainer",
  "Popup",
  "PopupPanel",
  "ProgressBar",
  "Range",
  "RefCounted",
  "Resource",
  "RichTextLabel",
  "RigidBody2D",
  "RigidBody3D",
  "SceneTree",
  "ScrollContainer",
  "StaticBody2D",
  "StaticBody3D",
  "SubViewport",
  "SubViewportContainer",
  "TabContainer",
  "TextEdit",
  "TextureButton",
  "TextureRect",
  "Timer",
  "Tree",
  "VBoxContainer",
  "VSlider",
  "VScrollBar",
  "Window",
]);

export interface GdscriptGraphExtractionOptions {
  updatedAt: number;
}

export interface GdscriptGraphExtraction {
  nodes: GraphNode[];
  edges: GraphEdge[];
  unresolvedRefs: UnresolvedRef[];
}

export function extractGdscriptGraph(
  script: GdscriptParseResult,
  options: GdscriptGraphExtractionOptions,
): GdscriptGraphExtraction {
  const scriptId = scriptNodeId(script.filePath);
  const scriptName = script.className?.name ?? basename(script.filePath, ".gd");
  const nodes: GraphNode[] = [
    {
      id: scriptId,
      kind: "script_class",
      name: scriptName,
      qualifiedName: scriptName,
      filePath: script.filePath,
      startLine: script.className?.line ?? 1,
      endLine: null,
      signature: script.className ? `class_name ${script.className.name}` : null,
      metadata: {
        extendsName: script.extendsName,
      },
      updatedAt: options.updatedAt,
    },
  ];
  const edges: GraphEdge[] = [];
  const unresolvedRefs: UnresolvedRef[] = [];

  addSymbolNodes(script, options.updatedAt, nodes, edges);
  addUnresolvedRefs(script, scriptId, unresolvedRefs, duplicatedNames(script.methods));

  return {
    nodes,
    edges,
    unresolvedRefs,
  };
}

function addSymbolNodes(
  script: GdscriptParseResult,
  updatedAt: number,
  nodes: GraphNode[],
  edges: GraphEdge[],
): void {
  const scriptId = scriptNodeId(script.filePath);
  const duplicateMethods = duplicatedNames(script.methods);
  const duplicateProperties = duplicatedNames(script.properties);
  const duplicateSignals = duplicatedNames(script.signals);

  for (const innerClass of [...script.innerClasses].sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const id = innerClassNodeId(script.filePath, innerClass.name);
    nodes.push({
      id,
      kind: "inner_class",
      name: innerClass.name,
      qualifiedName: `${scriptClassName(script)}.${innerClass.name}`,
      filePath: script.filePath,
      startLine: innerClass.line,
      endLine: null,
      signature: `class ${innerClass.name}:`,
      metadata: {},
      updatedAt,
    });
    edges.push(containsEdge(scriptId, id));
  }

  for (const method of [...script.methods].sort(compareOwnedSymbols)) {
    const duplicateLine = duplicateMethods.has(symbolKey(method)) ? method.line : null;
    const id = methodNodeId(
      script.filePath,
      method.ownerName,
      method.name,
      duplicateLine,
    );
    nodes.push({
      id,
      kind: "method",
      name: method.name,
      qualifiedName: symbolQualifiedName(script, method.ownerName, method.name, duplicateLine),
      filePath: script.filePath,
      startLine: method.line,
      endLine: null,
      signature: method.signature,
      metadata: {
        static: method.static,
      },
      updatedAt,
    });
    edges.push(containsEdge(symbolParentNodeId(script.filePath, method.ownerName), id));
  }

  for (const property of [...script.properties].sort(compareOwnedSymbols)) {
    const duplicateLine = duplicateProperties.has(symbolKey(property)) ? property.line : null;
    const id = propertyNodeId(
      script.filePath,
      property.ownerName,
      property.name,
      duplicateLine,
    );
    nodes.push({
      id,
      kind: "property",
      name: property.name,
      qualifiedName: symbolQualifiedName(script, property.ownerName, property.name, duplicateLine),
      filePath: script.filePath,
      startLine: property.line,
      endLine: null,
      signature: property.signature,
      metadata: {
        exported: property.exported,
        kind: property.kind,
      },
      updatedAt,
    });
    edges.push(containsEdge(symbolParentNodeId(script.filePath, property.ownerName), id));
  }

  for (const signal of [...script.signals].sort(compareOwnedSymbols)) {
    const duplicateLine = duplicateSignals.has(symbolKey(signal)) ? signal.line : null;
    const id = signalNodeId(
      script.filePath,
      signal.ownerName,
      signal.name,
      duplicateLine,
    );
    nodes.push({
      id,
      kind: "signal",
      name: signal.name,
      qualifiedName: symbolQualifiedName(script, signal.ownerName, signal.name, duplicateLine),
      filePath: script.filePath,
      startLine: signal.line,
      endLine: null,
      signature: `signal ${signal.name}`,
      metadata: {},
      updatedAt,
    });
    edges.push(containsEdge(symbolParentNodeId(script.filePath, signal.ownerName), id));
  }
}

function addUnresolvedRefs(
  script: GdscriptParseResult,
  scriptId: string,
  unresolvedRefs: UnresolvedRef[],
  duplicateMethods: Set<string>,
): void {
  if (script.extendsName && !GODOT_ENGINE_BASE_CLASSES.has(script.extendsName)) {
    unresolvedRefs.push(unresolved(script, scriptId, script.extendsName, "extends", null, []));
  }

  for (const resourceRef of script.resourceRefs) {
    unresolvedRefs.push(
      resourceUnresolved(
        script,
        sourceNodeId(script, scriptId, resourceRef.scope, duplicateMethods),
        resourceRef,
      ),
    );
  }

  for (const call of script.calls) {
    unresolvedRefs.push(
      callUnresolved(script, sourceNodeId(script, scriptId, call.scope, duplicateMethods), call),
    );
  }

  for (const signalEmit of script.signalEmits) {
    unresolvedRefs.push(
      signalEmitUnresolved(
        script,
        sourceNodeId(script, scriptId, signalEmit.scope, duplicateMethods),
        signalEmit,
      ),
    );
  }

  for (const signalConnect of script.signalConnects) {
    unresolvedRefs.push(
      signalConnectUnresolved(
        script,
        sourceNodeId(script, scriptId, signalConnect.scope, duplicateMethods),
        signalConnect,
      ),
    );
  }

  for (const nodeRef of script.nodeRefs) {
    unresolvedRefs.push(
      nodeRefUnresolved(
        script,
        sourceNodeId(script, scriptId, nodeRef.scope, duplicateMethods),
        nodeRef,
      ),
    );
  }

  for (const inputAction of script.inputActions) {
    unresolvedRefs.push(
      inputActionUnresolved(
        script,
        sourceNodeId(script, scriptId, inputAction.scope, duplicateMethods),
        inputAction,
      ),
    );
  }

  for (const autoload of script.autoloadCandidates) {
    unresolvedRefs.push(
      unresolved(
        script,
        sourceNodeId(script, scriptId, autoload.scope, duplicateMethods),
        autoload.name,
        "uses_autoload",
        autoload.line,
        [],
      ),
    );
  }
}

function resourceUnresolved(
  script: GdscriptParseResult,
  scriptId: string,
  ref: GdscriptResourceRef,
): UnresolvedRef {
  return unresolved(
    script,
    scriptId,
    ref.path,
    ref.kind === "preload" ? "preloads_resource" : "loads_resource",
    ref.line,
    [],
  );
}

function callUnresolved(
  script: GdscriptParseResult,
  fromNodeId: string,
  call: GdscriptCall,
): UnresolvedRef {
  return unresolved(
    script,
    fromNodeId,
    call.name,
    "calls",
    call.line,
    call.receiver ? [{ receiver: call.receiver }] : [],
  );
}

function signalEmitUnresolved(
  script: GdscriptParseResult,
  fromNodeId: string,
  signalEmit: GdscriptSignalEmit,
): UnresolvedRef {
  return unresolved(script, fromNodeId, signalEmit.signalName, "emits_signal", signalEmit.line, []);
}

function signalConnectUnresolved(
  script: GdscriptParseResult,
  fromNodeId: string,
  signalConnect: GdscriptSignalConnect,
): UnresolvedRef {
  return unresolved(script, fromNodeId, signalConnect.signalName, "connects_signal", signalConnect.line, [
    {
      target: signalConnect.target,
    },
  ]);
}

function nodeRefUnresolved(
  script: GdscriptParseResult,
  fromNodeId: string,
  nodeRef: GdscriptNodeRef,
): UnresolvedRef {
  return unresolved(script, fromNodeId, nodeRef.path, "references_nodepath", nodeRef.line, [
    {
      kind: nodeRef.kind,
      receiver: nodeRef.receiver,
    },
  ]);
}

function inputActionUnresolved(
  script: GdscriptParseResult,
  fromNodeId: string,
  inputAction: GdscriptInputActionRef,
): UnresolvedRef {
  return unresolved(script, fromNodeId, inputAction.name, "uses_input_action", inputAction.line, []);
}

function sourceNodeId(
  script: GdscriptParseResult,
  scriptId: string,
  scope: GdscriptReferenceScope | null | undefined,
  duplicateMethods: Set<string>,
): string {
  if (!scope) {
    return scriptId;
  }

  const duplicateLine = duplicateMethods.has(
    symbolKey({
      ownerName: scope.ownerName,
      name: scope.methodName,
      line: scope.methodLine,
    }),
  )
    ? scope.methodLine
    : null;
  return methodNodeId(script.filePath, scope.ownerName, scope.methodName, duplicateLine);
}

function unresolved(
  script: GdscriptParseResult,
  fromNodeId: string,
  referenceName: string,
  referenceKind: string,
  line: number | null,
  candidates: Record<string, unknown>[],
): UnresolvedRef {
  return {
    fromNodeId,
    referenceName,
    referenceKind,
    filePath: script.filePath,
    line,
    column: null,
    candidates,
  };
}

function containsEdge(source: string, target: string): GraphEdge {
  return {
    source,
    target,
    kind: "contains",
    line: null,
    column: null,
    provenance: "tree-sitter",
    metadata: {},
  };
}

function scriptClassName(script: GdscriptParseResult): string {
  return script.className?.name ?? basename(script.filePath, ".gd");
}

function symbolQualifiedName(
  script: GdscriptParseResult,
  ownerName: string | null,
  name: string,
  line: number | null,
): string {
  const baseName = [scriptClassName(script), ownerName, name].filter(Boolean).join(".");
  return line === null ? baseName : `${baseName}@${line}`;
}

function duplicatedNames(values: OwnedSymbol[]): Set<string> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = symbolKey(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return new Set(
    Array.from(counts.entries())
      .filter(([, count]) => count > 1)
      .map(([key]) => key),
  );
}

function scriptNodeId(resPath: string): string {
  return `script:${resPath}`;
}

function innerClassNodeId(resPath: string, name: string): string {
  return `inner_class:${resPath}:${name}`;
}

function methodNodeId(
  resPath: string,
  ownerName: string | null,
  name: string,
  line: number | null = null,
): string {
  return symbolNodeId("method", resPath, ownerName, name, line);
}

function propertyNodeId(
  resPath: string,
  ownerName: string | null,
  name: string,
  line: number | null = null,
): string {
  return symbolNodeId("property", resPath, ownerName, name, line);
}

function signalNodeId(
  resPath: string,
  ownerName: string | null,
  name: string,
  line: number | null = null,
): string {
  return symbolNodeId("signal", resPath, ownerName, name, line);
}

function symbolNodeId(
  kind: "method" | "property" | "signal",
  resPath: string,
  ownerName: string | null,
  name: string,
  line: number | null,
): string {
  const scopedName = [ownerName, name].filter(Boolean).join(".");
  return line === null
    ? `${kind}:${resPath}:${scopedName}`
    : `${kind}:${resPath}:${scopedName}@${line}`;
}

function symbolParentNodeId(resPath: string, ownerName: string | null): string {
  return ownerName === null ? scriptNodeId(resPath) : innerClassNodeId(resPath, ownerName);
}

function symbolKey(symbol: OwnedSymbol): string {
  return `${symbol.ownerName ?? ""}\0${symbol.name}`;
}

function compareOwnedSymbols(left: OwnedSymbol, right: OwnedSymbol): number {
  return (
    (left.ownerName ?? "").localeCompare(right.ownerName ?? "") ||
    left.name.localeCompare(right.name) ||
    left.line - right.line
  );
}
