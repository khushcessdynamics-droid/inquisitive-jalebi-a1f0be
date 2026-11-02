export const FORMAT_VERSION = 1;
export const TOOL_VERSION = "0.1.0";

export interface ColumnMeta {
  name: string;
  type: string; // format_type(); domains are resolved to their base type
  notNull: boolean;
  enum: { schema: string; name: string } | null;
}

export interface ForeignKeyMeta {
  name: string;
  columns: string[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
}

export interface TableMeta {
  schema: string;
  name: string;
  columns: ColumnMeta[];
  primaryKey: string[];
  uniques: string[][];
  foreignKeys: ForeignKeyMeta[];
  rows: number;
  sha256: string;
  bytes: number;
}

export interface EnumMeta {
  schema: string;
  name: string;
  labels: string[];
}

export interface BucketMeta {
  id: string;
  name: string;
  public: boolean;
  file_size_limit: number | null;
  allowed_mime_types: string[] | null;
}

export interface ObjectMeta {
  bucket: string;
  name: string;
  size: number;
  mimetype: string | null;
}

export interface BackupManifest {
  format: number;
  tool_version: string;
  created_at: string;
  kind: "scheduled" | "manual" | "pre_restore" | "pre_migration";
  project_label: string;
  machine_label: string;
  schema_version: string | null;
  postgres_version: string;
  tables: TableMeta[];
  enums: EnumMeta[];
  invariants: Record<string, string | null>;
  storage: { buckets: BucketMeta[]; objects: ObjectMeta[] };
}

/** Written as the last archive entry: checksums of the attachment files. */
export interface FilesManifest {
  objects: Array<{ bucket: string; name: string; size: number; sha256: string }>;
}

/** Non-secret summary stored next to each backup file (<name>.json). */
export interface BackupSidecar {
  name: string;
  file: string;
  created_at: string;
  kind: BackupManifest["kind"];
  status: "verified" | "unverified" | "failed";
  project_label: string;
  schema_version: string | null;
  size_bytes: number;
  sha256: string;
  key_id: string;
  tables: number;
  rows: number;
  files: number;
  verification: { ok: boolean; checked_at: string; checks: string[]; errors: string[] } | null;
}

export function tableFile(t: { schema: string; name: string }): string {
  return `db/${t.schema}.${t.name}.csv`;
}

export function objectFile(o: { bucket: string; name: string }): string {
  return `files/${o.bucket}/${o.name}`;
}

export function qi(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

export function qualified(t: { schema: string; name: string }): string {
  return `${qi(t.schema)}.${qi(t.name)}`;
}

/** Deterministic row order, independent of database collation: primary key as text in "C" order. */
export function orderBy(t: TableMeta, alias = "t"): string {
  if (t.primaryKey.length) return t.primaryKey.map((c) => `(${alias}.${qi(c)})::text COLLATE "C"`).join(", ");
  return `(${alias}.*)::text COLLATE "C"`;
}

export function columnList(t: TableMeta): string {
  return t.columns.map((c) => qi(c.name)).join(", ");
}

export function copyOutSql(t: TableMeta): string {
  return `COPY (SELECT ${t.columns.map((c) => `t.${qi(c.name)}`).join(", ")} FROM ${qualified(t)} t ORDER BY ${orderBy(t)}) TO STDOUT WITH (FORMAT csv, HEADER true)`;
}

/** Session settings that make COPY output identical across PostgreSQL servers. */
export const STABLE_OUTPUT_SETTINGS = [
  "SET TimeZone = 'UTC'",
  "SET DateStyle = 'ISO, MDY'",
  "SET IntervalStyle = 'postgres'",
  "SET extra_float_digits = 1",
  "SET bytea_output = 'hex'",
];
