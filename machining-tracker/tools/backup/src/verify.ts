// Verification = a real test restore, done in memory with PGlite (PostgreSQL compiled to WebAssembly; nothing to install):
//   1. decrypt + authenticate the archive (AES-GCM tag) and check every entry's SHA-256
//   2. recreate every table, load every row, compare row counts
//   3. add primary keys, unique and foreign keys (the database rejects duplicates and orphan references)
//   4. export every table again and require byte-identical output (proves nothing was lost or altered)
//   5. recompute business checks (e.g. number of active Admins) and compare with the values taken at backup time
//   6. check every attachment file against its checksum
// Only when all of this passes is a backup marked "verified".
import { PGlite } from "@electric-sql/pglite";
import { decryptFile, sha256 } from "./crypto.ts";
import { readArchive } from "./archive.ts";
import { INVARIANTS } from "./snapshot.ts";
import {
  FORMAT_VERSION,
  STABLE_OUTPUT_SETTINGS,
  columnList,
  objectFile,
  orderBy,
  qi,
  qualified,
  tableFile,
  type BackupManifest,
  type FilesManifest,
  type TableMeta,
} from "./manifest.ts";

export interface VerifyReport {
  ok: boolean;
  checkedAt: string;
  tables: number;
  rows: number;
  files: number;
  checks: string[];
  errors: string[];
  manifest: BackupManifest | null;
}

async function copyToText(db: PGlite, sql: string): Promise<Buffer> {
  const res = await db.query(sql);
  if (!res.blob) throw new Error("COPY TO returned no data");
  return Buffer.from(await res.blob.arrayBuffer());
}

export async function verifyArchive(path: string, key: Buffer): Promise<VerifyReport> {
  const report: VerifyReport = { ok: false, checkedAt: new Date().toISOString(), tables: 0, rows: 0, files: 0, checks: [], errors: [], manifest: null };
  const db = new PGlite();
  try {
    await db.exec(STABLE_OUTPUT_SETTINGS.join(";\n") + ";");
    let manifest: BackupManifest | null = null;
    const pendingTables = new Map<string, TableMeta>();
    const fileHashes = new Map<string, { sha: string; size: number }>();
    let filesManifest: FilesManifest | null = null;

    await readArchive(decryptFile(path, key), async (name, data) => {
      if (!manifest) {
        if (name !== "manifest.json") throw new Error(`First entry must be manifest.json, found ${name}`);
        manifest = JSON.parse(data.toString("utf8")) as BackupManifest;
        if (manifest.format !== FORMAT_VERSION) throw new Error(`Unsupported backup format ${manifest.format}`);
        const schemas = new Set([...manifest.tables.map((t) => t.schema), ...manifest.enums.map((e) => e.schema)]);
        for (const s of schemas) await db.exec(`create schema if not exists ${qi(s)}`);
        for (const e of manifest.enums) {
          await db.exec(`create type ${qi(e.schema)}.${qi(e.name)} as enum (${e.labels.map((l) => `'${l.replace(/'/g, "''")}'`).join(", ")})`);
        }
        for (const t of manifest.tables) {
          const cols = t.columns.map((c) => {
            const type = c.enum ? `${qi(c.enum.schema)}.${qi(c.enum.name)}` : c.type;
            return `${qi(c.name)} ${type}${c.notNull ? " not null" : ""}`;
          });
          await db.exec(`create table ${qualified(t)} (${cols.join(", ")})`);
          pendingTables.set(tableFile(t), t);
        }
        report.checks.push(`Archive decrypted; manifest of ${manifest.tables.length} tables and ${manifest.storage.objects.length} files read`);
        return;
      }
      if (name.startsWith("db/")) {
        const t = pendingTables.get(name);
        if (!t) throw new Error(`Unexpected table file ${name}`);
        if (sha256(data) !== t.sha256) throw new Error(`Checksum mismatch in ${name}`);
        await db.query(`copy ${qualified(t)} (${columnList(t)}) from '/dev/blob' with (format csv, header true)`, [], { blob: new Blob([new Uint8Array(data)]) });
        const n = Number((await db.query<{ n: string }>(`select count(*)::text as n from ${qualified(t)}`)).rows[0]!.n);
        if (n !== t.rows) throw new Error(`Row count mismatch in ${t.schema}.${t.name}: ${n} restored, ${t.rows} expected`);
        pendingTables.delete(name);
        report.rows += n;
        return;
      }
      if (name.startsWith("files/")) {
        fileHashes.set(name, { sha: sha256(data), size: data.length });
        return;
      }
      if (name === "files-manifest.json") {
        filesManifest = JSON.parse(data.toString("utf8")) as FilesManifest;
        return;
      }
      throw new Error(`Unexpected archive entry ${name}`);
    });
    report.checks.push("Encryption authentication tag valid (file not altered)");

    const m = manifest as BackupManifest | null;
    if (!m) throw new Error("Archive is empty");
    report.manifest = m;
    if (pendingTables.size) throw new Error(`Missing table data: ${[...pendingTables.keys()].join(", ")}`);
    report.tables = m.tables.length;
    report.checks.push(`All ${m.tables.length} tables loaded into a test database; ${report.rows} rows, counts match`);

    // keys and relationships
    for (const t of m.tables) {
      if (t.primaryKey.length) await db.exec(`alter table ${qualified(t)} add primary key (${t.primaryKey.map(qi).join(", ")})`);
      for (const u of t.uniques) await db.exec(`alter table ${qualified(t)} add unique (${u.map(qi).join(", ")})`);
    }
    let fkCount = 0;
    for (const t of m.tables) {
      for (const fk of t.foreignKeys) {
        const ref = `${qi(fk.refSchema)}.${qi(fk.refTable)}`;
        const add = () =>
          db.exec(`alter table ${qualified(t)} add constraint ${qi(`v_${fk.name}`.slice(0, 60))} foreign key (${fk.columns.map(qi).join(", ")}) references ${ref} (${fk.refColumns.map(qi).join(", ")})`);
        try {
          await add();
        } catch (e) {
          if (!/no unique constraint/i.test(String((e as Error).message))) throw new Error(`Relationship check failed for ${t.schema}.${t.name} -> ${fk.refSchema}.${fk.refTable}: ${(e as Error).message}`);
          await db.exec(`alter table ${ref} add unique (${fk.refColumns.map(qi).join(", ")})`);
          await add();
        }
        fkCount++;
      }
    }
    report.checks.push(`Primary keys, unique keys and ${fkCount} relationships rebuilt: no duplicates, no orphan records`);

    // byte-identical round trip
    for (const t of m.tables) {
      const again = await copyToText(db, `copy (select ${t.columns.map((c) => `t.${qi(c.name)}`).join(", ")} from ${qualified(t)} t order by ${orderBy(t)}) to '/dev/blob' with (format csv, header true)`);
      if (sha256(again) !== t.sha256) throw new Error(`Round-trip difference in ${t.schema}.${t.name}`);
    }
    report.checks.push("Every table exported again from the test database is byte-identical to the backup");

    // business checks
    for (const [k, sql] of Object.entries(INVARIANTS)) {
      const expected = m.invariants[k] ?? null;
      if (expected === null) continue;
      const res = await db.query(sql);
      const actual = (Object.values(res.rows[0] ?? {})[0] as string | null | undefined) ?? null;
      if (actual !== expected) throw new Error(`Business check "${k}" differs: ${actual} restored, ${expected} at backup time`);
    }
    report.checks.push(`Business checks match: ${Object.entries(m.invariants).map(([k, v]) => `${k}=${v}`).join(", ")}`);

    // attachments
    const fm = filesManifest as FilesManifest | null;
    if (m.storage.objects.length) {
      if (!fm) throw new Error("Attachment checksum list missing");
      for (const o of fm.objects) {
        const got = fileHashes.get(objectFile(o));
        if (!got) throw new Error(`Attachment missing: ${o.bucket}/${o.name}`);
        if (got.sha !== o.sha256 || got.size !== o.size) throw new Error(`Attachment damaged: ${o.bucket}/${o.name}`);
      }
      if (fm.objects.length !== m.storage.objects.length) throw new Error("Attachment count does not match the manifest");
    }
    report.files = fileHashes.size;
    report.checks.push(`${report.files} attachment file(s) present with matching checksums`);
    report.ok = true;
  } catch (e) {
    report.errors.push(e instanceof Error ? e.message : String(e));
  } finally {
    await db.close();
  }
  return report;
}
