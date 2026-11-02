// Reads a consistent snapshot of everything needed to rebuild the application data:
//   * every table in the public schema (except short-lived session_activity) - new business tables are included automatically
//   * Supabase Auth accounts: users, identities, MFA factors, auth audit log (password hashes and MFA secrets -> backups are encrypted)
//   * attachment files from Supabase Storage
import type { Db } from "./db.ts";
import { copyOut } from "./db.ts";
import { sha256 } from "./crypto.ts";
import {
  STABLE_OUTPUT_SETTINGS,
  copyOutSql,
  type BucketMeta,
  type ColumnMeta,
  type EnumMeta,
  type ForeignKeyMeta,
  type ObjectMeta,
  type TableMeta,
} from "./manifest.ts";

/**
 * Short-lived tables: never backed up, emptied on restore (everyone signs in again).
 * Every OTHER table in the auth schema is backed up, so new Supabase Auth tables (e.g. passkeys,
 * MFA recovery codes) are included automatically.
 */
export const EPHEMERAL_TABLES = [
  "public.session_activity",
  "auth.sessions",
  "auth.refresh_tokens",
  "auth.mfa_challenges",
  "auth.mfa_amr_claims",
  "auth.one_time_tokens",
  "auth.flow_state",
  "auth.webauthn_challenges",
  "auth.saml_relay_states",
];
/** Supabase-internal bookkeeping: belongs to the platform version, not to your data. */
export const INTERNAL_TABLES = ["auth.schema_migrations", "auth.instances"];

/** Business checks computed on the live data and again on the test-restored copy; results must match. */
export const INVARIANTS: Record<string, string> = {
  active_admins: "select count(*)::text from public.profiles where role_key = 'admin' and is_active",
  auth_users_without_profile: "select count(*)::text from auth.users u where not exists (select 1 from public.profiles p where p.id = u.id)",
  activity_log_max_id: "select coalesce(max(id), 0)::text from public.activity_log",
  settings_keys: "select string_agg(key, ',' order by key collate \"C\") from public.app_settings",
  verified_mfa_factors: "select count(*)::text from auth.mfa_factors where status::text = 'verified'",
};

export async function describeTables(db: Db): Promise<{ tables: Omit<TableMeta, "rows" | "sha256" | "bytes">[]; enums: EnumMeta[] }> {
  const rel = await db.query<{ oid: number; schema: string; name: string }>(
    `select c.oid::int as oid, n.nspname as schema, c.relname as name
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p')
        and n.nspname in ('public', 'auth')
        and n.nspname || '.' || c.relname <> all($1::text[])
      order by n.nspname, c.relname`,
    [[...EPHEMERAL_TABLES, ...INTERNAL_TABLES]],
  );
  const included = new Set(rel.rows.map((r) => `${r.schema}.${r.name}`));
  const enumTypes = new Map<string, EnumMeta>();
  const tables: Omit<TableMeta, "rows" | "sha256" | "bytes">[] = [];

  for (const r of rel.rows) {
    const cols = await db.query<{ name: string; type: string; not_null: boolean; typtype: string; tschema: string; tname: string; type_oid: number }>(
      `select a.attname as name,
              case when t.typtype = 'd' then format_type(t.typbasetype, t.typtypmod) else format_type(a.atttypid, a.atttypmod) end as type,
              a.attnotnull as not_null, t.typtype::text as typtype, tn.nspname as tschema, t.typname as tname, t.oid::int as type_oid
         from pg_attribute a
         join pg_type t on t.oid = a.atttypid
         join pg_namespace tn on tn.oid = t.typnamespace
        where a.attrelid = $1 and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
        order by a.attnum`,
      [r.oid],
    );
    const columns: ColumnMeta[] = [];
    for (const c of cols.rows) {
      let enumRef: ColumnMeta["enum"] = null;
      if (c.typtype === "e") {
        enumRef = { schema: c.tschema, name: c.tname };
        const key = `${c.tschema}.${c.tname}`;
        if (!enumTypes.has(key)) {
          const labels = await db.query<{ l: string }>("select enumlabel as l from pg_enum where enumtypid = $1 order by enumsortorder", [c.type_oid]);
          enumTypes.set(key, { schema: c.tschema, name: c.tname, labels: labels.rows.map((x) => x.l) });
        }
      }
      columns.push({ name: c.name, type: c.type, notNull: c.not_null, enum: enumRef });
    }
    const cons = await db.query<{ name: string; contype: string; cols: string[]; ref_schema: string | null; ref_table: string | null; ref_cols: string[] | null }>(
      `select con.conname as name, con.contype::text as contype,
              array(select a.attname from unnest(con.conkey) with ordinality k(attnum, ord)
                     join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum order by k.ord)::text[] as cols,
              rn.nspname as ref_schema, rc.relname as ref_table,
              case when con.contype = 'f' then
                array(select a.attname from unnest(con.confkey) with ordinality k(attnum, ord)
                       join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum order by k.ord)::text[] end as ref_cols
         from pg_constraint con
         left join pg_class rc on rc.oid = con.confrelid
         left join pg_namespace rn on rn.oid = rc.relnamespace
        where con.conrelid = $1 and con.contype in ('p', 'u', 'f')
        order by con.conname`,
      [r.oid],
    );
    const fks: ForeignKeyMeta[] = cons.rows
      .filter((c) => c.contype === "f" && included.has(`${c.ref_schema}.${c.ref_table}`))
      .map((c) => ({ name: c.name, columns: c.cols, refSchema: c.ref_schema!, refTable: c.ref_table!, refColumns: c.ref_cols! }));
    tables.push({
      schema: r.schema,
      name: r.name,
      columns,
      primaryKey: cons.rows.find((c) => c.contype === "p")?.cols ?? [],
      uniques: cons.rows.filter((c) => c.contype === "u").map((c) => c.cols),
      foreignKeys: fks,
    });
  }
  return { tables, enums: [...enumTypes.values()] };
}

export interface SnapshotResult {
  tables: Array<{ meta: TableMeta; csv: Buffer }>;
  enums: EnumMeta[];
  invariants: Record<string, string | null>;
  schemaVersion: string | null;
  postgresVersion: string;
  buckets: BucketMeta[];
  objects: ObjectMeta[];
}

/** Must be called inside a REPEATABLE READ transaction so all tables come from the same moment. */
export async function readSnapshot(db: Db): Promise<SnapshotResult> {
  for (const s of STABLE_OUTPUT_SETTINGS) await db.query(s.replace(/^SET /, "SET LOCAL "));
  const { tables, enums } = await describeTables(db);
  const out: SnapshotResult["tables"] = [];
  for (const t of tables) {
    const count = await db.query<{ n: string }>(`select count(*)::text as n from "${t.schema}"."${t.name}"`);
    const csv = await copyOut(db, copyOutSql({ ...t, rows: 0, sha256: "", bytes: 0 }));
    out.push({ meta: { ...t, rows: Number(count.rows[0]!.n), sha256: sha256(csv), bytes: csv.length }, csv });
  }
  const invariants: Record<string, string | null> = {};
  for (const [k, sql] of Object.entries(INVARIANTS)) {
    await db.query("SAVEPOINT inv");
    try {
      const res = await db.query(sql);
      invariants[k] = ((Object.values(res.rows[0] ?? {})[0] as string | null | undefined) ?? null);
      await db.query("RELEASE SAVEPOINT inv");
    } catch {
      await db.query("ROLLBACK TO SAVEPOINT inv");
      invariants[k] = null;
    }
  }
  let schemaVersion: string | null = null;
  await db.query("SAVEPOINT sv");
  try {
    schemaVersion = (await db.query<{ v: string | null }>("select max(version) as v from supabase_migrations.schema_migrations")).rows[0]?.v ?? null;
    await db.query("RELEASE SAVEPOINT sv");
  } catch {
    await db.query("ROLLBACK TO SAVEPOINT sv");
  }
  const postgresVersion = (await db.query<{ v: string }>("select current_setting('server_version') as v")).rows[0]!.v;

  let buckets: BucketMeta[] = [];
  let objects: ObjectMeta[] = [];
  await db.query("SAVEPOINT st");
  try {
    buckets = (
      await db.query<BucketMeta>(
        "select id, name, public, file_size_limit::bigint::float8 as file_size_limit, allowed_mime_types from storage.buckets order by id collate \"C\"",
      )
    ).rows.map((b) => ({ ...b, file_size_limit: b.file_size_limit === null ? null : Number(b.file_size_limit) }));
    objects = (
      await db.query<{ bucket: string; name: string; size: string | null; mimetype: string | null }>(
        "select bucket_id as bucket, name, metadata->>'size' as size, metadata->>'mimetype' as mimetype from storage.objects where name is not null order by bucket_id collate \"C\", name collate \"C\"",
      )
    ).rows.map((o) => ({ bucket: o.bucket, name: o.name, size: Number(o.size ?? 0), mimetype: o.mimetype }));
    await db.query("RELEASE SAVEPOINT st");
  } catch {
    await db.query("ROLLBACK TO SAVEPOINT st");
  }
  return { tables: out, enums, invariants, schemaVersion, postgresVersion, buckets, objects };
}
