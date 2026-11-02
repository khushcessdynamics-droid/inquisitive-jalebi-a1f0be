// Runs one backup: snapshot -> encrypted archive -> verification (test restore) -> history -> second copy -> retention.
import { copyFile, link, mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import type { BackupConfig } from "./config.ts";
import { redact } from "./config.ts";
import { connect, type Db } from "./db.ts";
import { encryptToFile, keyId, loadKey, sha256, sha256File } from "./crypto.ts";
import { createArchiveWriter } from "./archive.ts";
import { readSnapshot } from "./snapshot.ts";
import { downloadObject } from "./storage.ts";
import { verifyArchive, type VerifyReport } from "./verify.ts";
import { planRetention, type BackupInfo } from "./retention.ts";
import { FORMAT_VERSION, TOOL_VERSION, objectFile, tableFile, type BackupManifest, type BackupSidecar, type FilesManifest } from "./manifest.ts";

export type BackupKind = BackupManifest["kind"];
export type Logger = (message: string) => void;

export interface BackupResult {
  ok: boolean;
  name: string;
  file: string | null;
  sidecar: BackupSidecar | null;
  verification: VerifyReport | null;
  error: string | null;
  secondCopy: string | null;
  removed: string[];
}

function stampIST(d: Date): string {
  const s = new Date(d.getTime() + 330 * 60_000).toISOString(); // 2026-11-02T17:30:05.123Z (IST clock)
  return `${s.slice(0, 10)}_${s.slice(11, 19).replace(/:/g, "")}`;
}

async function recordStart(db: Db, kind: BackupKind, machine: string): Promise<string> {
  const r = await db.query<{ id: string }>("insert into public.backup_runs (kind, status, machine_label) values ($1, 'running', $2) returning id", [kind, machine]);
  return r.rows[0]!.id;
}

async function recordEnd(db: Db, id: string, fields: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  await db.query(`update public.backup_runs set ${sets}, finished_at = coalesce(finished_at, now()) where id = $1`, [id, ...keys.map((k) => fields[k])]);
}

export async function listBackups(dir: string): Promise<BackupSidecar[]> {
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: BackupSidecar[] = [];
  for (const n of names.filter((x) => x.endsWith(".json"))) {
    try {
      out.push(JSON.parse(await readFile(join(dir, n), "utf8")) as BackupSidecar);
    } catch {
      /* ignore unrelated or damaged files */
    }
  }
  return out.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function applyRetention(dir: string, cfg: BackupConfig, log: Logger, dryRun = false): Promise<string[]> {
  const backups = await listBackups(dir);
  const infos: BackupInfo[] = backups.map((b) => ({ name: b.name, createdAt: b.created_at, status: b.status, kind: b.kind }));
  const plan = planRetention(infos, cfg.retention);
  const removed: string[] = [];
  for (const r of plan.remove) {
    log(`${dryRun ? "[dry run] would remove" : "Removing"} ${r.name} (${r.reason})`);
    if (dryRun) continue;
    for (const ext of [".cbk", ".json"]) await unlink(join(dir, `${r.name}${ext}`)).catch(() => undefined);
    removed.push(r.name);
  }
  return removed;
}

export async function runBackup(cfg: BackupConfig, kind: BackupKind, log: Logger = () => {}): Promise<BackupResult> {
  const started = new Date();
  const name = `cess-backup_${stampIST(started)}_${kind}`;
  const result: BackupResult = { ok: false, name, file: null, sidecar: null, verification: null, error: null, secondCopy: null, removed: [] };
  const key = await loadKey(cfg.keyFile);
  await mkdir(cfg.backupDir, { recursive: true });
  const finalPath = join(cfg.backupDir, `${name}.cbk`);
  const partialPath = `${finalPath}.partial`;
  let db: Db | null = null;
  let runId: string | null = null;

  try {
    db = await connect(cfg);
    runId = await recordStart(db, kind, cfg.machineLabel);
    log(`Backup ${name} started`);

    // 1. consistent snapshot of database + attachment list
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const snap = await readSnapshot(db);
    const manifest: BackupManifest = {
      format: FORMAT_VERSION,
      tool_version: TOOL_VERSION,
      created_at: started.toISOString(),
      kind,
      project_label: cfg.projectLabel,
      machine_label: cfg.machineLabel,
      schema_version: snap.schemaVersion,
      postgres_version: snap.postgresVersion,
      tables: snap.tables.map((t) => t.meta),
      enums: snap.enums,
      invariants: snap.invariants,
      storage: { buckets: snap.buckets, objects: snap.objects },
    };
    log(`Read ${snap.tables.length} tables (${snap.tables.reduce((n, t) => n + t.meta.rows, 0)} rows) and ${snap.objects.length} attachment(s)`);

    // 2. encrypted archive (written to .partial first)
    const writer = createArchiveWriter();
    const encrypting = encryptToFile(writer.output, partialPath, key);
    const filesManifest: FilesManifest = { objects: [] };
    try {
      await writer.add("manifest.json", Buffer.from(JSON.stringify(manifest, null, 1)));
      for (const t of snap.tables) await writer.add(tableFile(t.meta), t.csv);
      for (const o of snap.objects) {
        const data = await downloadObject(cfg, o.bucket, o.name);
        filesManifest.objects.push({ bucket: o.bucket, name: o.name, size: data.length, sha256: sha256(data) });
        await writer.add(objectFile(o), data);
      }
      await writer.add("files-manifest.json", Buffer.from(JSON.stringify(filesManifest)));
      writer.finish();
    } catch (e) {
      writer.output.destroy(e as Error);
      throw e;
    } finally {
      await encrypting.catch(() => undefined);
    }
    await encrypting;
    await db.query("COMMIT");

    // never overwrite: link fails if the final name already exists
    await link(partialPath, finalPath);
    await unlink(partialPath);
    result.file = finalPath;
    const size = (await stat(finalPath)).size;
    const fileSha = await sha256File(finalPath);
    log(`Encrypted archive written: ${finalPath} (${(size / 1024 / 1024).toFixed(2)} MB)`);

    // 3. verification by test restore
    const report = await verifyArchive(finalPath, key);
    result.verification = report;
    for (const c of report.checks) log(`  ok: ${c}`);
    for (const e of report.errors) log(`  FAILED: ${e}`);

    const sidecar: BackupSidecar = {
      name,
      file: `${name}.cbk`,
      created_at: started.toISOString(),
      kind,
      status: report.ok ? "verified" : "unverified",
      project_label: cfg.projectLabel,
      schema_version: manifest.schema_version,
      size_bytes: size,
      sha256: fileSha,
      key_id: keyId(key),
      tables: manifest.tables.length,
      rows: manifest.tables.reduce((n, t) => n + t.rows, 0),
      files: manifest.storage.objects.length,
      verification: { ok: report.ok, checked_at: report.checkedAt, checks: report.checks, errors: report.errors },
    };
    await writeFile(join(cfg.backupDir, `${name}.json`), JSON.stringify(sidecar, null, 2), { flag: "wx" });
    result.sidecar = sidecar;

    await recordEnd(db, runId, {
      status: report.ok ? "verified" : "unverified",
      verified_at: report.ok ? new Date().toISOString() : null,
      archive_name: `${name}.cbk`,
      size_bytes: size,
      sha256: fileSha,
      row_counts: Object.fromEntries(manifest.tables.map((t) => [`${t.schema}.${t.name}`, t.rows])),
      object_count: manifest.storage.objects.length,
      verification_details: { checks: report.checks, errors: report.errors },
      error: report.ok ? null : report.errors.join("; "),
    });
    if (!report.ok) throw new Error(`Verification failed: ${report.errors.join("; ")}`);

    // 4. optional second copy (USB / external drive / synced folder), checked after copying
    if (cfg.secondCopyDir) {
      try {
        await mkdir(cfg.secondCopyDir, { recursive: true });
        const copyPath = join(cfg.secondCopyDir, `${name}.cbk`);
        await copyFile(finalPath, copyPath, constants.COPYFILE_EXCL);
        if ((await sha256File(copyPath)) !== fileSha) throw new Error("copy checksum differs");
        await copyFile(join(cfg.backupDir, `${name}.json`), join(cfg.secondCopyDir, `${name}.json`), constants.COPYFILE_EXCL);
        result.secondCopy = copyPath;
        log(`Second copy written and checked: ${copyPath}`);
      } catch (e) {
        log(`WARNING: second copy failed: ${(e as Error).message}`);
      }
    }

    // 5. retention (only after a new verified backup exists)
    result.removed = await applyRetention(cfg.backupDir, cfg, log);
    if (cfg.secondCopyDir) result.removed.push(...(await applyRetention(cfg.secondCopyDir, cfg, log).catch(() => [])));
    result.ok = true;
    log(`Backup ${name} VERIFIED`);
  } catch (e) {
    const message = redact(e instanceof Error ? e.message : String(e), cfg);
    result.error = message;
    log(`Backup ${name} FAILED: ${message}`);
    await db?.query("ROLLBACK").catch(() => undefined);
    await unlink(partialPath).catch(() => undefined);
    if (db && runId) await recordEnd(db, runId, { status: result.verification ? "unverified" : "failed", error: message }).catch(() => undefined);
  } finally {
    await db?.end().catch(() => undefined);
  }
  return result;
}
