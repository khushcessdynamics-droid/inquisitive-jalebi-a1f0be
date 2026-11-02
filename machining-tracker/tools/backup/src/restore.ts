// Restores a verified backup into the configured Supabase project.
// Safety: typed confirmation, full verification first, automatic safety backup of the current data,
// single database transaction (all or nothing), row-count and relationship checks before COMMIT.
// Attachments are uploaded again; files that exist only in the project (newer than the backup) are kept.
import { basename } from "node:path";
import type { BackupConfig } from "./config.ts";
import { redact } from "./config.ts";
import { connect, copyIn, copyOut, type Db } from "./db.ts";
import { decryptFile, loadKey } from "./crypto.ts";
import { readArchive } from "./archive.ts";
import { verifyArchive } from "./verify.ts";
import { runBackup, type Logger } from "./backup.ts";
import { ensureBucket, uploadObject } from "./storage.ts";
import { columnList, qi, qualified, tableFile, type BackupManifest, type TableMeta } from "./manifest.ts";
import { EPHEMERAL_TABLES } from "./snapshot.ts";

/** Tables that are backed up but never overwritten by a restore. */
const NOT_RESTORED = new Set(["public.backup_runs"]);

/** Every table that (directly or indirectly) references the restored tables. They must be emptied too. */
async function dependentTables(db: Db, restored: string[]): Promise<Array<{ name: string; rows: number }>> {
  const r = await db.query<{ t: string }>(
    `with recursive kids(oid) as (
       select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname || '.' || c.relname = any($1::text[])
       union
       select con.conrelid from pg_constraint con join kids k on con.confrelid = k.oid where con.contype = 'f'
     )
     select distinct n.nspname || '.' || c.relname as t from kids k join pg_class c on c.oid = k.oid join pg_namespace n on n.oid = c.relnamespace`,
    [restored],
  );
  const out: Array<{ name: string; rows: number }> = [];
  for (const { t } of r.rows) {
    if (restored.includes(t)) continue;
    const [s, n] = t.split(".") as [string, string];
    const rows = Number((await db.query<{ n: string }>(`select count(*)::text as n from ${qi(s)}.${qi(n)}`)).rows[0]!.n);
    out.push({ name: t, rows });
  }
  return out;
}

export interface RestoreOptions {
  confirm: string;
  allowSchemaMismatch?: boolean;
  skipSafetyBackup?: boolean;
  log?: Logger;
}

export interface RestoreResult {
  ok: boolean;
  tables: number;
  rows: number;
  files: number;
  extraFilesKept: number;
  safetyBackup: string | null;
  error: string | null;
}

export function confirmationPhrase(cfg: Pick<BackupConfig, "projectLabel">): string {
  return `RESTORE ${cfg.projectLabel}`;
}

async function existingTables(db: Db, names: string[]): Promise<Set<string>> {
  const r = await db.query<{ t: string }>(
    "select n.nspname || '.' || c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r','p') and n.nspname || '.' || c.relname = any($1::text[])",
    [names],
  );
  return new Set(r.rows.map((x) => x.t));
}

async function checkColumns(db: Db, t: TableMeta): Promise<void> {
  const r = await db.query<{ c: string }>("select column_name as c from information_schema.columns where table_schema = $1 and table_name = $2", [t.schema, t.name]);
  const have = new Set(r.rows.map((x) => x.c));
  const missing = t.columns.filter((c) => !have.has(c.name)).map((c) => c.name);
  if (missing.length) throw new Error(`Table ${t.schema}.${t.name} in the project has no column(s) ${missing.join(", ")}. The database structure differs from the backup.`);
}

async function orphanCheck(db: Db, tables: TableMeta[]): Promise<void> {
  const fks = await db.query<{ child: string; parent: string; cols: string[]; refcols: string[]; name: string }>(
    `select cn.nspname || '.' || cc.relname as child, pn.nspname || '.' || pc.relname as parent, con.conname as name,
            array(select a.attname from unnest(con.conkey) with ordinality k(n, o) join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.n order by k.o)::text[] as cols,
            array(select a.attname from unnest(con.confkey) with ordinality k(n, o) join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.n order by k.o)::text[] as refcols
       from pg_constraint con
       join pg_class cc on cc.oid = con.conrelid join pg_namespace cn on cn.oid = cc.relnamespace
       join pg_class pc on pc.oid = con.confrelid join pg_namespace pn on pn.oid = pc.relnamespace
      where con.contype = 'f' and cn.nspname || '.' || cc.relname = any($1::text[])`,
    [tables.map((t) => `${t.schema}.${t.name}`)],
  );
  for (const fk of fks.rows) {
    const [cs, ct] = fk.child.split(".") as [string, string];
    const [ps, pt] = fk.parent.split(".") as [string, string];
    const notNull = fk.cols.map((c) => `c.${qi(c)} is not null`).join(" and ");
    const join = fk.cols.map((c, i) => `p.${qi(fk.refcols[i]!)} = c.${qi(c)}`).join(" and ");
    const r = await db.query<{ n: string }>(
      `select count(*)::text as n from ${qi(cs)}.${qi(ct)} c where ${notNull} and not exists (select 1 from ${qi(ps)}.${qi(pt)} p where ${join})`,
    );
    if (r.rows[0]!.n !== "0") throw new Error(`Relationship ${fk.name}: ${r.rows[0]!.n} row(s) in ${fk.child} point to missing ${fk.parent} records.`);
  }
}

export async function restoreBackup(cfg: BackupConfig, archivePath: string, opts: RestoreOptions): Promise<RestoreResult> {
  const log = opts.log ?? (() => {});
  const result: RestoreResult = { ok: false, tables: 0, rows: 0, files: 0, extraFilesKept: 0, safetyBackup: null, error: null };
  let db: Db | null = null;
  try {
    if (opts.confirm !== confirmationPhrase(cfg)) throw new Error(`Confirmation text does not match. Type exactly: ${confirmationPhrase(cfg)}`);
    const key = await loadKey(cfg.keyFile);

    log(`Verifying ${basename(archivePath)} before restoring...`);
    const report = await verifyArchive(archivePath, key);
    if (!report.ok || !report.manifest) throw new Error(`The backup did not pass verification: ${report.errors.join("; ")}`);
    const manifest: BackupManifest = report.manifest;
    log(`Backup verified: ${manifest.tables.length} tables, ${report.rows} rows, ${report.files} attachment(s), taken ${manifest.created_at}`);

    db = await connect(cfg);
    const target = (await db.query<{ v: string | null }>("select max(version) as v from supabase_migrations.schema_migrations").catch(() => ({ rows: [{ v: null }] }))).rows[0]?.v ?? null;
    if (target !== manifest.schema_version && !opts.allowSchemaMismatch) {
      throw new Error(
        `Database structure version differs (project: ${target ?? "unknown"}, backup: ${manifest.schema_version ?? "unknown"}). ` +
          "Apply the matching migrations (supabase db push) or use the application version that made the backup.",
      );
    }

    const people = Number((await db.query<{ n: string }>("select count(*)::text as n from public.profiles")).rows[0]!.n);
    if (people > 0 && !opts.skipSafetyBackup) {
      log("Taking a safety backup of the current data first...");
      const safety = await runBackup(cfg, "pre_restore", log);
      if (!safety.ok) throw new Error(`Safety backup failed, nothing was changed: ${safety.error}`);
      result.safetyBackup = safety.name;
    }

    const tables = manifest.tables.filter((t) => !NOT_RESTORED.has(`${t.schema}.${t.name}`));
    const byFile = new Map(tables.map((t) => [tableFile(t), t]));
    const restoredNames = tables.map((t) => `${t.schema}.${t.name}`);
    const present = await existingTables(db, restoredNames);
    for (const t of tables) {
      if (!present.has(`${t.schema}.${t.name}`)) throw new Error(`Table ${t.schema}.${t.name} does not exist in the project.`);
      await checkColumns(db, t);
    }
    const dependents = await dependentTables(db, restoredNames);
    const unexpected = dependents.filter((d) => !EPHEMERAL_TABLES.includes(d.name) && d.rows > 0);
    if (unexpected.length) {
      throw new Error(`These tables hold data linked to the restored records but are not in the backup: ${unexpected.map((d) => `${d.name} (${d.rows} rows)`).join(", ")}. Nothing was changed.`);
    }

    await db.query("BEGIN");
    await db.query("SET LOCAL statement_timeout = 0");
    await db.query("SET LOCAL lock_timeout = '30s'");
    await db.query("SET LOCAL session_replication_role = replica"); // no triggers while loading (history is restored as it was)
    const truncate = [...tables.map((t) => qualified(t)), ...dependents.map((d) => d.name.split(".").map(qi).join("."))];
    // The activity history is never rolled back: entries written after the backup are kept and re-added.
    const activity = tables.find((t) => t.schema === "public" && t.name === "activity_log");
    const backupMaxId = Number(manifest.invariants.activity_log_max_id ?? "NaN");
    let newerActivity: Buffer | null = null;
    let newerActivityRows = 0;
    if (activity && Number.isSafeInteger(backupMaxId)) {
      newerActivityRows = Number((await db.query<{ n: string }>("select count(*)::text as n from public.activity_log where id > $1", [backupMaxId])).rows[0]!.n);
      if (newerActivityRows > 0) {
        newerActivity = await copyOut(db, `COPY (SELECT ${columnList(activity)} FROM public.activity_log WHERE id > ${backupMaxId} ORDER BY id) TO STDOUT WITH (FORMAT csv, HEADER true)`);
      }
    }

    await db.query(`TRUNCATE TABLE ${truncate.join(", ")}`);
    log(`Cleared ${truncate.length} tables inside a transaction (nothing is permanent until the final check passes)`);

    await readArchive(decryptFile(archivePath, key), async (name, data) => {
      const t = byFile.get(name);
      if (!t) return;
      await copyIn(db!, `COPY ${qualified(t)} (${columnList(t)}) FROM STDIN WITH (FORMAT csv, HEADER true)`, data);
    });
    if (activity && newerActivity) {
      await copyIn(db, `COPY public.activity_log (${columnList(activity)}) FROM STDIN WITH (FORMAT csv, HEADER true)`, newerActivity);
      log(`Kept ${newerActivityRows} activity history entries recorded after the backup`);
    }

    for (const t of tables) {
      const n = Number((await db.query<{ n: string }>(`select count(*)::text as n from ${qualified(t)}`)).rows[0]!.n);
      const expected = t === activity ? t.rows + newerActivityRows : t.rows;
      if (n !== expected) throw new Error(`Row count after restore differs for ${t.schema}.${t.name}: ${n} vs ${expected}`);
      result.rows += n;
      for (const c of t.columns) {
        const seq = (await db.query<{ s: string | null }>("select pg_get_serial_sequence($1, $2) as s", [`${qi(t.schema)}.${qi(t.name)}`, c.name])).rows[0]?.s;
        if (seq) {
          await db.query(`select setval($1::regclass, coalesce((select max(${qi(c.name)}) from ${qualified(t)}), 1), (select max(${qi(c.name)}) from ${qualified(t)}) is not null)`, [seq]);
        }
      }
    }
    await orphanCheck(db, tables);
    await db.query("SET LOCAL session_replication_role = origin");
    await db.query(
      `insert into public.activity_log (source, action, module, entity_table, entity_id, new_value, reason)
       values ('sql', 'system.restored', 'system', 'backup', $1, $2, $3)`,
      [
        basename(archivePath),
        JSON.stringify({
          backup_created_at: manifest.created_at,
          kind: manifest.kind,
          tables: tables.length,
          rows: result.rows,
          safety_backup: result.safetyBackup,
          newer_activity_entries_kept: newerActivityRows,
        }),
        `Data restored from backup taken ${manifest.created_at}`,
      ],
    );
    await db.query("COMMIT");
    result.tables = tables.length;
    log(`Database restored: ${tables.length} tables, ${result.rows} rows. All users must sign in again.`);

    // attachments
    for (const b of manifest.storage.buckets) {
      const state = await ensureBucket(cfg, b);
      if (state === "created") log(`Re-created storage bucket ${b.id}`);
    }
    const objectByFile = new Map(manifest.storage.objects.map((o) => [`files/${o.bucket}/${o.name}`, o]));
    await readArchive(decryptFile(archivePath, key), async (name, data) => {
      const o = objectByFile.get(name);
      if (!o) return;
      await uploadObject(cfg, o.bucket, o.name, data, o.mimetype);
      result.files++;
    });
    const current = await db.query<{ k: string }>("select bucket_id || '/' || name as k from storage.objects where name is not null").catch(() => ({ rows: [] as Array<{ k: string }> }));
    const inBackup = new Set(manifest.storage.objects.map((o) => `${o.bucket}/${o.name}`));
    result.extraFilesKept = current.rows.filter((r) => !inBackup.has(r.k)).length;
    log(`Attachments restored: ${result.files}. Files newer than the backup that were kept: ${result.extraFilesKept}`);
    result.ok = true;
  } catch (e) {
    result.error = redact(e instanceof Error ? e.message : String(e), cfg);
    await db?.query("ROLLBACK").catch(() => undefined);
    log(`RESTORE FAILED (no database change was committed unless reported above): ${result.error}`);
  } finally {
    await db?.end().catch(() => undefined);
  }
  return result;
}
