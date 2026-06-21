import { createRequire } from "node:module";

export interface GdscriptClassName {
  name: string;
  line: number;
}

export interface GdscriptInnerClass {
  name: string;
  line: number;
}

export interface GdscriptMethod {
  name: string;
  ownerName: string | null;
  static: boolean;
  line: number;
  signature: string;
}

export interface GdscriptProperty {
  name: string;
  ownerName: string | null;
  kind: "var" | "const";
  exported: boolean;
  line: number;
  signature: string;
}

export interface GdscriptSignal {
  name: string;
  ownerName: string | null;
  line: number;
}

export interface GdscriptResourceRef {
  kind: "load" | "preload";
  path: string;
  line: number;
  scope?: GdscriptReferenceScope | null;
}

export interface GdscriptCall {
  name: string;
  receiver: string | null;
  line: number;
  scope?: GdscriptReferenceScope | null;
}

export interface GdscriptSignalEmit {
  signalName: string;
  line: number;
  scope?: GdscriptReferenceScope | null;
}

export interface GdscriptSignalConnect {
  signalName: string;
  receiver: string | null;
  target: string | null;
  line: number;
  scope?: GdscriptReferenceScope | null;
}

export interface GdscriptNodeRef {
  kind: "dollar" | "get_node" | "root_get_node" | "unique";
  path: string;
  line: number;
  receiver?: string | null;
  scope?: GdscriptReferenceScope | null;
}

export interface GdscriptInputActionRef {
  name: string;
  line: number;
  scope?: GdscriptReferenceScope | null;
}

export interface GdscriptAutoloadCandidate {
  name: string;
  line: number;
  scope?: GdscriptReferenceScope | null;
}

export interface GdscriptReferenceScope {
  ownerName: string | null;
  methodName: string;
  methodLine: number;
}

export interface GdscriptParseError {
  line: number | null;
  message: string;
}

export interface GdscriptParseResult {
  filePath: string;
  className: GdscriptClassName | null;
  extendsName: string | null;
  innerClasses: GdscriptInnerClass[];
  methods: GdscriptMethod[];
  properties: GdscriptProperty[];
  signals: GdscriptSignal[];
  resourceRefs: GdscriptResourceRef[];
  calls: GdscriptCall[];
  signalEmits: GdscriptSignalEmit[];
  signalConnects: GdscriptSignalConnect[];
  nodeRefs: GdscriptNodeRef[];
  inputActions: GdscriptInputActionRef[];
  autoloadCandidates: GdscriptAutoloadCandidate[];
  errors: GdscriptParseError[];
}

type ParsedDeclaration =
  | { kind: "inner_class"; name: string }
  | { kind: "method"; name: string }
  | { kind: "other" }
  | null;

interface ClassScope {
  name: string;
  indent: number;
}

const require = createRequire(import.meta.url);
const Parser = require("tree-sitter") as new () => {
  setLanguage: (language: unknown) => void;
  parse: (
    contents: string | ((offset: number, position?: unknown) => string),
    oldTree?: unknown,
    options?: { bufferSize?: number },
  ) => { rootNode: { hasError: boolean } };
};
const GdscriptGrammar = require("tree-sitter-gdscript") as unknown;

const CALL_EXCLUSIONS = new Set([
  "Array",
  "Callable",
  "Color",
  "Dictionary",
  "NodePath",
  "PackedByteArray",
  "PackedFloat32Array",
  "PackedFloat64Array",
  "PackedInt32Array",
  "PackedInt64Array",
  "PackedStringArray",
  "Rect2",
  "String",
  "StringName",
  "Vector2",
  "Vector2i",
  "Vector3",
  "Vector3i",
  "abs",
  "absf",
  "accept_event",
  "add_child",
  "add_theme_color_override",
  "add_theme_font_size_override",
  "add_theme_stylebox_override",
  "and",
  "append",
  "append_array",
  "assert_eq",
  "assert_equal",
  "assert_false",
  "assert_ne",
  "assert_not_null",
  "assert_null",
  "assert_true",
  "back",
  "begins_with",
  "bind",
  "bool",
  "call",
  "call_deferred",
  "can_instantiate",
  "ceil",
  "clear",
  "clampf",
  "clampi",
  "connect",
  "contains",
  "cos",
  "create_tween",
  "current_is_dir",
  "dir_exists_absolute",
  "disconnect",
  "distance_to",
  "duplicate",
  "emit",
  "emit_signal",
  "erase",
  "ends_with",
  "exists",
  "export_enum",
  "export_category",
  "export_color_no_alpha",
  "export_dir",
  "export_file",
  "export_flags",
  "export_global_dir",
  "export_global_file",
  "export_group",
  "export_multiline",
  "export_node_path",
  "export_range",
  "export_subgroup",
  "fail",
  "file_exists",
  "filter",
  "float",
  "floor",
  "force_drag",
  "free",
  "front",
  "get",
  "get_as_text",
  "get_base_dir",
  "get_center",
  "get_class",
  "get_combined_minimum_size",
  "get_children",
  "get_cmdline_user_args",
  "get_file_as_string",
  "get_global_rect",
  "get_main_loop",
  "get_method_list",
  "get_next",
  "get_parent",
  "get_property_list",
  "get_script",
  "get_script_method_list",
  "get_setting",
  "get_theme_constant",
  "get_theme_font_size",
  "get_theme_stylebox",
  "get_ticks_usec",
  "get_tree",
  "get_node",
  "get_node_or_null",
  "get_viewport",
  "get_viewport_rect",
  "globalize_path",
  "grab_focus",
  "gui_get_drag_data",
  "has",
  "has_method",
  "has_signal",
  "has_theme_font_size_override",
  "hex_encode",
  "if",
  "in",
  "insert",
  "int",
  "instantiate",
  "is_action_just_pressed",
  "is_action_just_released",
  "is_action_pressed",
  "is_action_released",
  "is_connected",
  "is_inside_tree",
  "is_empty",
  "is_instance_valid",
  "is_equal_approx",
  "is_valid_int",
  "is_valid",
  "is_visible_in_tree",
  "is_zero_approx",
  "join",
  "keys",
  "length",
  "list_dir_begin",
  "list_dir_end",
  "lightened",
  "make_dir_recursive_absolute",
  "map",
  "max",
  "maxf",
  "maxi",
  "min",
  "minf",
  "mini",
  "merge",
  "new",
  "normalized",
  "not",
  "ok",
  "or",
  "parallel",
  "parse_string",
  "path_join",
  "pick_random",
  "posmod",
  "pow",
  "print",
  "printerr",
  "push_error",
  "push_warning",
  "queue_free",
  "queue_redraw",
  "quit",
  "randomize",
  "range",
  "reduce",
  "remove_at",
  "remove_child",
  "replace",
  "return",
  "roundf",
  "roundi",
  "randf",
  "randf_range",
  "randi",
  "randi_range",
  "resize",
  "seed",
  "set",
  "set_border_width_all",
  "set_corner_radius_all",
  "set_drag_preview",
  "set_ease",
  "set_input_as_handled",
  "set_process",
  "set_shader_parameter",
  "set_trans",
  "size",
  "sin",
  "sort",
  "sort_custom",
  "slice",
  "split",
  "str",
  "store_line",
  "store_string",
  "stringify",
  "strip_edges",
  "substr",
  "super",
  "typeof",
  "tween_property",
  "tween_interval",
  "lerpf",
  "draw_arc",
  "draw_circle",
  "draw_line",
  "draw_rect",
  "to_utf8_buffer",
  "trim_prefix",
  "values",
  "for",
  "while",
  "match",
  "func",
  "preload",
  "load",
]);
const QUALIFIED_CALL_EXCLUSIONS = new Set([
  "DirAccess.open",
  "FileAccess.open",
]);
const RECEIVER_CALL_EXCLUSIONS = new Set([
  "dot",
  "find",
  "finish",
  "kill",
  "length_squared",
  "rotated",
  "update",
]);
const BUILTIN_SIGNAL_EMIT_EXCLUSIONS = new Set([
  "mouse_entered",
  "mouse_exited",
  "pressed",
]);
const TREE_SITTER_INPUT_CHUNK_SIZE = 4 * 1024;

export function parseGdscript(contents: string, filePath: string): GdscriptParseResult {
  const result: GdscriptParseResult = {
    filePath,
    className: null,
    extendsName: null,
    innerClasses: [],
    methods: [],
    properties: [],
    signals: [],
    resourceRefs: [],
    calls: [],
    signalEmits: [],
    signalConnects: [],
    nodeRefs: [],
    inputActions: [],
    autoloadCandidates: [],
    errors: [],
  };

  collectSyntaxErrors(contents, result);

  let currentFunctionIndent: number | null = null;
  let currentFunctionScope: GdscriptReferenceScope | null = null;
  let functionSignatureOpen = false;
  const classScopes: ClassScope[] = [];
  const callableAliases = new Map<string, string>();
  contents.split(/\r?\n/).forEach((line, index) => {
    const lineNumber = index + 1;
    const codeLine = stripInlineComment(line);
    const trimmed = codeLine.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      return;
    }

    const indent = indentationWidth(codeLine);
    if (currentFunctionIndent !== null && functionSignatureOpen) {
      if (trimmed.endsWith(":")) {
        functionSignatureOpen = false;
      }
      return;
    }

    if (currentFunctionIndent !== null && indent <= currentFunctionIndent) {
      currentFunctionIndent = null;
      currentFunctionScope = null;
    }

    while (classScopes.length > 0 && indent <= (classScopes.at(-1)?.indent ?? 0)) {
      classScopes.pop();
    }

    const insideFunctionBody = currentFunctionIndent !== null && indent > currentFunctionIndent;
    if (!insideFunctionBody) {
      parseIdentity(trimmed, lineNumber, result);
      const ownerName = classScopes.at(-1)?.name ?? null;
      const declaration = parseDeclaration(trimmed, lineNumber, result, ownerName);
      if (declaration?.kind === "inner_class") {
        classScopes.push({ name: declaration.name, indent });
      }
      if (declaration?.kind === "method") {
        currentFunctionIndent = indent;
        currentFunctionScope = {
          ownerName,
          methodName: declaration.name,
          methodLine: lineNumber,
        };
        functionSignatureOpen = !trimmed.endsWith(":");
        return;
      }
    }

    parseReferences(trimmed, lineNumber, result, callableAliases, currentFunctionScope);
  });

  result.signalEmits = filterBuiltinSignalEmits(result.signalEmits, result.signals);
  result.autoloadCandidates = uniqueByNameAndLine(result.autoloadCandidates);
  return result;
}

function collectSyntaxErrors(contents: string, result: GdscriptParseResult): void {
  const parser = new Parser();
  parser.setLanguage(GdscriptGrammar);
  const syntaxCheckContents = normalizeSyntaxCheckContents(contents);
  const tree = parser.parse((offset: number) =>
    syntaxCheckContents.slice(offset, offset + TREE_SITTER_INPUT_CHUNK_SIZE),
  );
  if (tree.rootNode.hasError) {
    result.errors.push({
      line: null,
      message: "tree-sitter reported syntax errors",
    });
  }
}

function normalizeSyntaxCheckContents(contents: string): string {
  return contents.replace(/\$%/g, "%");
}

function parseIdentity(
  line: string,
  lineNumber: number,
  result: GdscriptParseResult,
): void {
  const extendsMatch = line.match(/^extends\s+(.+)$/);
  if (extendsMatch) {
    result.extendsName = stripQuotes(extendsMatch[1]?.trim() ?? "");
    return;
  }

  const classNameMatch = line.match(/^class_name\s+([A-Za-z_]\w*)/);
  if (classNameMatch) {
    result.className = {
      name: classNameMatch[1] ?? "",
      line: lineNumber,
    };
  }
}

function parseDeclaration(
  line: string,
  lineNumber: number,
  result: GdscriptParseResult,
  ownerName: string | null,
): ParsedDeclaration {
  const innerClassMatch = line.match(/^class\s+([A-Za-z_]\w*)\s*:/);
  if (innerClassMatch) {
    const name = innerClassMatch[1] ?? "";
    result.innerClasses.push({
      name,
      line: lineNumber,
    });
    return { kind: "inner_class", name };
  }

  const methodMatch = line.match(/^(static\s+)?func\s+([A-Za-z_]\w*)\b/);
  if (methodMatch) {
    result.methods.push({
      name: methodMatch[2] ?? "",
      ownerName,
      static: Boolean(methodMatch[1]),
      line: lineNumber,
      signature: line,
    });
    return { kind: "method", name: methodMatch[2] ?? "" };
  }

  const propertyMatch = line.match(/^(@export\s+)?(var|const)\s+([A-Za-z_]\w*)\b/);
  if (propertyMatch) {
    result.properties.push({
      name: propertyMatch[3] ?? "",
      ownerName,
      kind: propertyMatch[2] as GdscriptProperty["kind"],
      exported: Boolean(propertyMatch[1]),
      line: lineNumber,
      signature: line,
    });
    return { kind: "other" };
  }

  const signalMatch = line.match(/^signal\s+([A-Za-z_]\w*)/);
  if (signalMatch) {
    result.signals.push({
      name: signalMatch[1] ?? "",
      ownerName,
      line: lineNumber,
    });
    return { kind: "other" };
  }

  return null;
}

function parseReferences(
  line: string,
  lineNumber: number,
  result: GdscriptParseResult,
  callableAliases: Map<string, string>,
  scope: GdscriptReferenceScope | null,
): void {
  collectCallableAliases(line, callableAliases);
  collectResourceRefs(line, lineNumber, result, scope);
  collectInputActions(line, lineNumber, result, scope);
  collectNodeRefs(line, lineNumber, result, scope);
  collectSignalUsage(line, lineNumber, result, callableAliases, scope);
  collectCalls(line, lineNumber, result, scope);
  collectAutoloadCandidates(line, lineNumber, result, scope);
}

function collectResourceRefs(
  line: string,
  lineNumber: number,
  result: GdscriptParseResult,
  scope: GdscriptReferenceScope | null,
): void {
  const stringMask = createStringMask(line);
  for (const match of line.matchAll(/\b(preload|load)\("([^"]+)"\)/g)) {
    if (isInString(stringMask, match.index ?? 0)) {
      continue;
    }
    result.resourceRefs.push({
      kind: match[1] as GdscriptResourceRef["kind"],
      path: match[2] ?? "",
      line: lineNumber,
      scope,
    });
  }
}

function collectInputActions(
  line: string,
  lineNumber: number,
  result: GdscriptParseResult,
  scope: GdscriptReferenceScope | null,
): void {
  const stringMask = createStringMask(line);
  for (const match of line.matchAll(/Input\.is_action_[A-Za-z_]+\("([^"]+)"\)/g)) {
    if (isInString(stringMask, match.index ?? 0)) {
      continue;
    }
    result.inputActions.push({
      name: match[1] ?? "",
      line: lineNumber,
      scope,
    });
  }
}

function collectNodeRefs(
  line: string,
  lineNumber: number,
  result: GdscriptParseResult,
  scope: GdscriptReferenceScope | null,
): void {
  const stringMask = createStringMask(line);
  for (const match of line.matchAll(/\$([A-Za-z_][\w/]*)(?![\w/])/g)) {
    if (isInString(stringMask, match.index ?? 0)) {
      continue;
    }
    result.nodeRefs.push({
      kind: "dollar",
      path: match[1] ?? "",
      line: lineNumber,
      scope,
    });
  }

  for (const match of line.matchAll(/(?:^|[^.\w])get_node(?:_or_null)?\("(\/root\/[^"]+)"\)/g)) {
    if (isInString(stringMask, match.index ?? 0)) {
      continue;
    }
    result.nodeRefs.push({
      kind: "root_get_node",
      path: match[1] ?? "",
      line: lineNumber,
      scope,
    });
  }

  for (const match of line.matchAll(/\.root\.get_node(?:_or_null)?\("([^"]+)"\)/g)) {
    if (isInString(stringMask, match.index ?? 0)) {
      continue;
    }
    result.nodeRefs.push({
      kind: "root_get_node",
      path: match[1] ?? "",
      line: lineNumber,
      scope,
    });
  }

  for (const match of line.matchAll(/(?:\b([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\.)?get_node(?:_or_null)?\("([^"]+)"\)/g)) {
    const path = match[2] ?? "";
    if (isInString(stringMask, match.index ?? 0) || isRootNodeRef(result.nodeRefs, path, lineNumber)) {
      continue;
    }
    result.nodeRefs.push({
      kind: "get_node",
      path,
      line: lineNumber,
      receiver: match[1] ?? null,
      scope,
    });
  }

  for (const match of line.matchAll(/%([A-Za-z_]\w*)/g)) {
    if (isInString(stringMask, match.index ?? 0)) {
      continue;
    }
    result.nodeRefs.push({
      kind: "unique",
      path: match[1] ?? "",
      line: lineNumber,
      scope,
    });
  }
}

function collectCallableAliases(line: string, callableAliases: Map<string, string>): void {
  const stringMask = createStringMask(line);
  if (isInString(stringMask, 0)) {
    return;
  }

  const aliasMatch = line.match(/\b(?:var|const)\s+([A-Za-z_]\w*)\s*(?::=\s*|=\s*)Callable\([^,]+,\s*"([^"]+)"\)/);
  if (aliasMatch) {
    callableAliases.set(aliasMatch[1] ?? "", aliasMatch[2] ?? "");
  }
}

function collectSignalUsage(
  line: string,
  lineNumber: number,
  result: GdscriptParseResult,
  callableAliases: Map<string, string>,
  scope: GdscriptReferenceScope | null,
): void {
  const stringMask = createStringMask(line);
  const codeOnlyLine = maskStringLiterals(line, stringMask);
  for (const match of line.matchAll(/emit_signal\("([^"]+)"\)/g)) {
    if (isInString(stringMask, match.index ?? 0)) {
      continue;
    }
    result.signalEmits.push({
      signalName: match[1] ?? "",
      line: lineNumber,
      scope,
    });
  }

  for (const match of codeOnlyLine.matchAll(/(?:^|[^.\w])([A-Za-z_]\w*)\.emit\(/g)) {
    result.signalEmits.push({
      signalName: match[1] ?? "",
      line: lineNumber,
      scope,
    });
  }

  for (const match of codeOnlyLine.matchAll(/\b(?:(?<receiver>[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\.)?(?<signal>[A-Za-z_]\w*)\.connect\(/g)) {
    const start = match.index ?? 0;
    if (isInString(stringMask, start)) {
      continue;
    }
    const args = callArguments(line, start + match[0].length - 1);
    result.signalConnects.push({
      signalName: match.groups?.signal ?? "",
      receiver: match.groups?.receiver ?? null,
      target: cleanCallableTarget(args[0] ?? "", callableAliases),
      line: lineNumber,
      scope,
    });
  }

  for (const match of codeOnlyLine.matchAll(/(^|[^.\w])connect\(/g)) {
    const start = match.index ?? 0;
    if (isInString(stringMask, start)) {
      continue;
    }
    const args = callArguments(line, start + match[0].length - 1);
    const signalName = stripQuotes(args[0]?.trim() ?? "");
    if (!signalName) {
      continue;
    }
    result.signalConnects.push({
      signalName,
      receiver: null,
      target: cleanCallableTarget(args[1] ?? "", callableAliases),
      line: lineNumber,
      scope,
    });
  }
}

function isRootNodeRef(refs: GdscriptNodeRef[], path: string, lineNumber: number): boolean {
  return refs.some(
    (ref) => ref.kind === "root_get_node" && ref.path === path && ref.line === lineNumber,
  );
}

function filterBuiltinSignalEmits(
  emits: GdscriptSignalEmit[],
  signals: GdscriptSignal[],
): GdscriptSignalEmit[] {
  const localSignalNames = new Set(signals.map((signal) => signal.name));
  return emits.filter(
    (emit) =>
      localSignalNames.has(emit.signalName) ||
      !BUILTIN_SIGNAL_EMIT_EXCLUSIONS.has(emit.signalName),
  );
}

function collectCalls(
  line: string,
  lineNumber: number,
  result: GdscriptParseResult,
  scope: GdscriptReferenceScope | null,
): void {
  if (/^(static\s+)?func\s+/.test(line) || /^signal\s+/.test(line)) {
    return;
  }

  const codeOnlyLine = maskStringLiterals(line);
  for (const match of codeOnlyLine.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
    const name = match[1] ?? "";
    const nameStartIndex = match.index ?? 0;
    const receiver = callReceiver(codeOnlyLine, nameStartIndex);
    if (isMemberCall(codeOnlyLine, nameStartIndex) && receiver === null) {
      continue;
    }
    if (
      !CALL_EXCLUSIONS.has(name) &&
      !QUALIFIED_CALL_EXCLUSIONS.has(`${receiver}.${name}`) &&
      !(receiver !== null && RECEIVER_CALL_EXCLUSIONS.has(name))
    ) {
      result.calls.push({
        name,
        receiver,
        line: lineNumber,
        scope,
      });
    }
  }
}

function isMemberCall(line: string, nameStartIndex: number): boolean {
  return nameStartIndex >= 1 && line[nameStartIndex - 1] === ".";
}

function collectAutoloadCandidates(
  line: string,
  lineNumber: number,
  result: GdscriptParseResult,
  scope: GdscriptReferenceScope | null,
): void {
  const stringMask = createStringMask(line);
  const codeOnlyLine = maskStringLiterals(line, stringMask);
  for (const match of codeOnlyLine.matchAll(/(^|[^$%A-Za-z0-9_])([A-Z][A-Za-z0-9_]*)\./g)) {
    const name = match[2] ?? "";
    if (name !== "Input") {
      result.autoloadCandidates.push({
        name,
        line: lineNumber,
        scope,
      });
    }
  }

  for (const match of line.matchAll(/\bget_node(?:_or_null)?\("\/root\/([A-Za-z_]\w*)(?:\/[^"]*)?"\)/g)) {
    if (isInString(stringMask, match.index ?? 0)) {
      continue;
    }
    result.autoloadCandidates.push({
      name: match[1] ?? "",
      line: lineNumber,
    });
  }

  for (const match of line.matchAll(/\.root\.get_node(?:_or_null)?\("([A-Za-z_]\w*)"\)/g)) {
    if (isInString(stringMask, match.index ?? 0)) {
      continue;
    }
    result.autoloadCandidates.push({
      name: match[1] ?? "",
      line: lineNumber,
    });
  }
}

function cleanCallableTarget(value: string, callableAliases: Map<string, string>): string | null {
  const trimmed = value.trim().replace(/\.bind\(.*\)$/, "");
  if (trimmed.length === 0) {
    return null;
  }

  const aliasTarget = callableAliases.get(trimmed);
  if (aliasTarget) {
    return aliasTarget;
  }

  const callableMatch = trimmed.match(/Callable\([^,]+,\s*"([^"]+)"\)/);
  if (callableMatch) {
    return callableMatch[1] ?? null;
  }

  return stripQuotes(trimmed).replace(/^self\./, "");
}

function callArguments(line: string, openParenIndex: number): string[] {
  const stringMask = createStringMask(line);
  const args: string[] = [];
  let depth = 0;
  let argumentStart = openParenIndex + 1;

  for (let index = openParenIndex + 1; index < line.length; index += 1) {
    if (isInString(stringMask, index)) {
      continue;
    }

    const char = line[index];
    if (char === "(" || char === "[" || char === "{") {
      depth += 1;
    } else if (char === ")" || char === "]" || char === "}") {
      if (depth === 0) {
        args.push(line.slice(argumentStart, index).trim());
        return args;
      }
      depth -= 1;
    } else if (char === "," && depth === 0) {
      args.push(line.slice(argumentStart, index).trim());
      argumentStart = index + 1;
    }
  }

  return args;
}

function callReceiver(line: string, nameStartIndex: number): string | null {
  if (nameStartIndex < 2 || line[nameStartIndex - 1] !== ".") {
    return null;
  }

  let receiverStart = nameStartIndex - 2;
  while (receiverStart >= 0 && /[A-Za-z0-9_.]/.test(line[receiverStart] ?? "")) {
    receiverStart -= 1;
  }

  const receiver = line.slice(receiverStart + 1, nameStartIndex - 1);
  return receiver.length > 0 ? receiver : null;
}

function stripQuotes(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }

  return value;
}

function uniqueByNameAndLine<T extends { name: string; line: number }>(values: T[]): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.name}:${value.line}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function stripInlineComment(line: string): string {
  const stringMask = createStringMask(line);
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === "#" && !stringMask[index]) {
      return line.slice(0, index);
    }
  }

  return line;
}

function createStringMask(line: string): boolean[] {
  const mask = Array.from<boolean>({ length: line.length }).fill(false);
  let inString = false;
  let escaping = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (inString) {
      mask[index] = true;
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      mask[index] = true;
      inString = true;
    }
  }

  return mask;
}

function maskStringLiterals(line: string, stringMask = createStringMask(line)): string {
  let masked = "";
  for (let index = 0; index < line.length; index += 1) {
    masked += stringMask[index] ? " " : line[index];
  }
  return masked;
}

function isInString(stringMask: boolean[], index: number): boolean {
  return stringMask[index] ?? false;
}

function indentationWidth(line: string): number {
  const match = line.match(/^\s*/);
  return match?.[0].length ?? 0;
}
