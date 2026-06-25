pragma foreign_keys = on;

create table if not exists files (
  path text primary key,
  kind text not null,
  content_hash text not null,
  size integer not null,
  modified_at integer not null,
  indexed_at integer not null,
  node_count integer not null default 0,
  parse_errors text not null default '[]'
);

create table if not exists nodes (
  id text primary key,
  kind text not null,
  name text not null,
  qualified_name text not null,
  file_path text,
  address_kind text not null default 'opaque',
  owner_path text,
  readable_path text,
  display_path text,
  reference_path text,
  start_line integer,
  end_line integer,
  signature text,
  metadata text not null default '{}',
  updated_at integer not null,
  foreign key (file_path) references files(path) on delete cascade
);

create index if not exists idx_nodes_kind on nodes(kind);
create index if not exists idx_nodes_file_path on nodes(file_path);
create index if not exists idx_nodes_qualified_name on nodes(qualified_name);

create table if not exists edges (
  id integer primary key autoincrement,
  source text not null,
  target text not null,
  kind text not null,
  line integer,
  column integer,
  provenance text not null,
  metadata text not null default '{}',
  foreign key (source) references nodes(id) on delete cascade,
  foreign key (target) references nodes(id) on delete cascade
);

create index if not exists idx_edges_source_kind on edges(source, kind);
create index if not exists idx_edges_target_kind on edges(target, kind);

create table if not exists unresolved_refs (
  id integer primary key autoincrement,
  from_node_id text not null,
  reference_name text not null,
  reference_kind text not null,
  file_path text not null,
  line integer,
  column integer,
  resolved integer not null default 0,
  candidates text not null default '[]',
  foreign key (from_node_id) references nodes(id) on delete cascade,
  foreign key (file_path) references files(path) on delete cascade
);

create index if not exists idx_unresolved_refs_from_node on unresolved_refs(from_node_id);
create index if not exists idx_unresolved_refs_file_path on unresolved_refs(file_path);

create table if not exists project_metadata (
  key text primary key,
  value text not null,
  updated_at integer not null
);

create virtual table if not exists nodes_fts using fts5(
  id unindexed,
  name,
  qualified_name,
  tokenize = 'unicode61'
);
