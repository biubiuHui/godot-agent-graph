import type { GraphDatabase } from "./index.js";
import type {
  EdgeKind,
  GraphEdge,
  GraphFile,
  GraphNode,
  JsonObject,
  ProjectMetadata,
  UnresolvedRef,
} from "../types.js";

interface FileRow {
  path: string;
  kind: GraphFile["kind"];
  content_hash: string;
  size: number;
  modified_at: number;
  indexed_at: number;
  node_count: number;
  parse_errors: string;
}

interface NodeRow {
  id: string;
  kind: GraphNode["kind"];
  name: string;
  qualified_name: string;
  file_path: string | null;
  start_line: number | null;
  end_line: number | null;
  signature: string | null;
  metadata: string;
  updated_at: number;
}

interface EdgeRow {
  id: number;
  source: string;
  target: string;
  kind: EdgeKind;
  line: number | null;
  column: number | null;
  provenance: string;
  metadata: string;
}

interface ProjectMetadataRow {
  key: string;
  value: string;
  updated_at: number;
}

interface UnresolvedRefRow {
  id: number;
  from_node_id: string;
  reference_name: string;
  reference_kind: string;
  file_path: string;
  line: number | null;
  column: number | null;
  candidates: string;
}

export function upsertFile(graph: GraphDatabase, file: GraphFile): void {
  graph.sqlite
    .prepare(
      `insert into files (
        path, kind, content_hash, size, modified_at, indexed_at, node_count, parse_errors
      ) values (
        @path, @kind, @contentHash, @size, @modifiedAt, @indexedAt, @nodeCount, @parseErrors
      )
      on conflict(path) do update set
        kind = excluded.kind,
        content_hash = excluded.content_hash,
        size = excluded.size,
        modified_at = excluded.modified_at,
        indexed_at = excluded.indexed_at,
        node_count = excluded.node_count,
        parse_errors = excluded.parse_errors`,
    )
    .run({
      ...file,
      parseErrors: stringifyJson(file.parseErrors),
    });
}

export function clearGraph(graph: GraphDatabase): void {
  graph.sqlite.exec(`
    delete from unresolved_refs;
    delete from edges;
    delete from nodes_fts;
    delete from nodes;
    delete from files;
    delete from project_metadata;
  `);
}

export function countNodes(graph: GraphDatabase): number {
  return countRows(graph, "nodes");
}

export function countEdges(graph: GraphDatabase): number {
  return countRows(graph, "edges");
}

export function countUnresolvedRefs(graph: GraphDatabase): number {
  return countRows(graph, "unresolved_refs");
}

export function getFile(graph: GraphDatabase, path: string): GraphFile | null {
  const row = graph.sqlite
    .prepare("select * from files where path = ?")
    .get(path) as FileRow | undefined;

  return row ? fileFromRow(row) : null;
}

function countRows(graph: GraphDatabase, tableName: string): number {
  const row = graph.sqlite.prepare(`select count(*) as count from ${tableName}`).get() as
    | { count: number }
    | undefined;
  return row?.count ?? 0;
}

export function upsertNode(graph: GraphDatabase, node: GraphNode): void {
  const transaction = graph.sqlite.transaction(() => {
    graph.sqlite
      .prepare(
        `insert into nodes (
          id, kind, name, qualified_name, file_path, start_line, end_line, signature, metadata, updated_at
        ) values (
          @id, @kind, @name, @qualifiedName, @filePath, @startLine, @endLine, @signature, @metadata, @updatedAt
        )
        on conflict(id) do update set
          kind = excluded.kind,
          name = excluded.name,
          qualified_name = excluded.qualified_name,
          file_path = excluded.file_path,
          start_line = excluded.start_line,
          end_line = excluded.end_line,
          signature = excluded.signature,
          metadata = excluded.metadata,
          updated_at = excluded.updated_at`,
      )
      .run({
        ...node,
        metadata: stringifyJson(node.metadata),
      });

    graph.sqlite.prepare("delete from nodes_fts where id = ?").run(node.id);
    graph.sqlite
      .prepare("insert into nodes_fts (id, name, qualified_name) values (?, ?, ?)")
      .run(node.id, node.name, node.qualifiedName);
  });

  transaction();
}

export function getNode(graph: GraphDatabase, id: string): GraphNode | null {
  const row = graph.sqlite
    .prepare("select * from nodes where id = ?")
    .get(id) as NodeRow | undefined;

  return row ? nodeFromRow(row) : null;
}

export function listNodes(graph: GraphDatabase): GraphNode[] {
  const rows = graph.sqlite.prepare("select * from nodes order by id").all() as NodeRow[];

  return rows.map(nodeFromRow);
}

export function searchNodes(graph: GraphDatabase, query: string, limit = 20): GraphNode[] {
  const trimmedQuery = query.trim();
  if (trimmedQuery.length === 0 || limit <= 0) {
    return [];
  }

  const rows: NodeRow[] = [];
  const rowLimit = limit * 2;
  const ftsQuery = queryToFtsMatch(trimmedQuery);
  if (ftsQuery) {
    rows.push(
      ...graph.sqlite
        .prepare(
          `select nodes.*
          from nodes_fts
          join nodes on nodes.id = nodes_fts.id
          where nodes_fts match @query
          order by rank, nodes.qualified_name
          limit @limit`,
        )
        .all({ query: ftsQuery, limit: rowLimit }) as NodeRow[],
    );
  }

  rows.push(
    ...graph.sqlite
      .prepare(
        `select *
        from nodes
        where id like @pattern escape '\\'
          or name like @pattern escape '\\'
          or qualified_name like @pattern escape '\\'
          or file_path like @pattern escape '\\'
        order by
          case
            when name = @query then 0
            when qualified_name = @query then 1
            when file_path = @query then 2
            when id = @query then 3
            else 10
          end,
          qualified_name
        limit @limit`,
      )
      .all({
        query: trimmedQuery,
        pattern: `%${escapeLike(trimmedQuery)}%`,
        limit: rowLimit,
      }) as NodeRow[],
  );

  return uniqueRowsById(rows)
    .filter((row) => !isSupersededScriptResourceSearchRow(graph, row))
    .slice(0, limit)
    .map(nodeFromRow);
}

function queryToFtsMatch(query: string): string {
  const tokens = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return tokens.map((token) => `"${token.replace(/"/g, "\"\"")}"`).join(" ");
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function uniqueRowsById(rows: NodeRow[]): NodeRow[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.id)) {
      return false;
    }

    seen.add(row.id);
    return true;
  });
}

function isSupersededScriptResourceSearchRow(graph: GraphDatabase, row: NodeRow): boolean {
  if (row.kind !== "resource" || !row.file_path?.endsWith(".gd")) {
    return false;
  }

  const script = graph.sqlite
    .prepare("select 1 from nodes where file_path = ? and kind = 'script_class' limit 1")
    .get(row.file_path);

  return script !== undefined;
}

export function insertEdge(graph: GraphDatabase, edge: GraphEdge): number {
  const result = graph.sqlite
    .prepare(
      `insert into edges (
        source, target, kind, line, column, provenance, metadata
      ) values (
        @source, @target, @kind, @line, @column, @provenance, @metadata
      )`,
    )
    .run({
      ...edge,
      metadata: stringifyJson(edge.metadata),
    });

  return Number(result.lastInsertRowid);
}

export interface EdgeFilter {
  source?: string;
  target?: string;
  kind?: EdgeKind;
}

export function listEdges(graph: GraphDatabase, filter: EdgeFilter = {}): GraphEdge[] {
  const where: string[] = [];
  const params: Record<string, string> = {};

  if (filter.source) {
    where.push("source = @source");
    params.source = filter.source;
  }

  if (filter.target) {
    where.push("target = @target");
    params.target = filter.target;
  }

  if (filter.kind) {
    where.push("kind = @kind");
    params.kind = filter.kind;
  }

  const sql = `select * from edges${where.length > 0 ? ` where ${where.join(" and ")}` : ""} order by id`;
  const rows = graph.sqlite.prepare(sql).all(params) as EdgeRow[];

  return rows.map(edgeFromRow);
}

export function upsertProjectMetadata(
  graph: GraphDatabase,
  metadata: ProjectMetadata,
): void {
  graph.sqlite
    .prepare(
      `insert into project_metadata (key, value, updated_at)
      values (@key, @value, @updatedAt)
      on conflict(key) do update set
        value = excluded.value,
        updated_at = excluded.updated_at`,
    )
    .run({
      key: metadata.key,
      value: stringifyJson(metadata.value),
      updatedAt: metadata.updatedAt,
    });
}

export function getProjectMetadata(
  graph: GraphDatabase,
  key: string,
): ProjectMetadata | null {
  const row = graph.sqlite
    .prepare("select * from project_metadata where key = ?")
    .get(key) as ProjectMetadataRow | undefined;

  return row ? projectMetadataFromRow(row) : null;
}

export function insertUnresolvedRef(graph: GraphDatabase, ref: UnresolvedRef): number {
  const result = graph.sqlite
    .prepare(
      `insert into unresolved_refs (
        from_node_id, reference_name, reference_kind, file_path, line, column, candidates
      ) values (
        @fromNodeId, @referenceName, @referenceKind, @filePath, @line, @column, @candidates
      )`,
    )
    .run({
      ...ref,
      candidates: stringifyJson(ref.candidates),
    });

  return Number(result.lastInsertRowid);
}

export function deleteUnresolvedRefs(graph: GraphDatabase, ids: number[]): void {
  if (ids.length === 0) {
    return;
  }

  const statement = graph.sqlite.prepare("delete from unresolved_refs where id = ?");
  const transaction = graph.sqlite.transaction((values: number[]) => {
    for (const id of values) {
      statement.run(id);
    }
  });

  transaction(ids);
}

export interface UnresolvedRefFilter {
  fromNodeId?: string;
  filePath?: string;
}

export function listUnresolvedRefs(
  graph: GraphDatabase,
  filter: UnresolvedRefFilter = {},
): UnresolvedRef[] {
  const where: string[] = [];
  const params: Record<string, string> = {};

  if (filter.fromNodeId) {
    where.push("from_node_id = @fromNodeId");
    params.fromNodeId = filter.fromNodeId;
  }

  if (filter.filePath) {
    where.push("file_path = @filePath");
    params.filePath = filter.filePath;
  }

  const sql = `select * from unresolved_refs${
    where.length > 0 ? ` where ${where.join(" and ")}` : ""
  } order by id`;
  const rows = graph.sqlite.prepare(sql).all(params) as UnresolvedRefRow[];

  return rows.map(unresolvedRefFromRow);
}

function fileFromRow(row: FileRow): GraphFile {
  return {
    path: row.path,
    kind: row.kind,
    contentHash: row.content_hash,
    size: row.size,
    modifiedAt: row.modified_at,
    indexedAt: row.indexed_at,
    nodeCount: row.node_count,
    parseErrors: parseJson<string[]>(row.parse_errors),
  };
}

function nodeFromRow(row: NodeRow): GraphNode {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    qualifiedName: row.qualified_name,
    filePath: row.file_path,
    startLine: row.start_line,
    endLine: row.end_line,
    signature: row.signature,
    metadata: parseJson<JsonObject>(row.metadata),
    updatedAt: row.updated_at,
  };
}

function edgeFromRow(row: EdgeRow): GraphEdge {
  return {
    id: row.id,
    source: row.source,
    target: row.target,
    kind: row.kind,
    line: row.line,
    column: row.column,
    provenance: row.provenance,
    metadata: parseJson<JsonObject>(row.metadata),
  };
}

function projectMetadataFromRow(row: ProjectMetadataRow): ProjectMetadata {
  return {
    key: row.key,
    value: parseJson<JsonObject>(row.value),
    updatedAt: row.updated_at,
  };
}

function unresolvedRefFromRow(row: UnresolvedRefRow): UnresolvedRef {
  return {
    id: row.id,
    fromNodeId: row.from_node_id,
    referenceName: row.reference_name,
    referenceKind: row.reference_kind,
    filePath: row.file_path,
    line: row.line,
    column: row.column,
    candidates: parseJson<JsonObject[]>(row.candidates),
  };
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}
