// Backup / verify / restore against the LOCAL Supabase stack, including a full disaster recovery
// (database wiped and rebuilt from migrations, then everything restored from the backup).
import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  BackupIntegrityError,
  confirmationPhrase,
  encodeKey,
  generateKey,
  listBackups,
  parseConfig,
  restoreBackup,
  runBackup,
  verifyArchive,
  type BackupConfig,
} from "../../tools/backup/src/index.ts";
import { localEnv } from "../helpers/env";
import { PASSWORD, access, closeSql, createAuthUser, enrollAndVerifyMfa, resetLocalDatabase, serviceClient, signIn, sql, uniqueEmail, verifyMfa } from "../helpers/clients";

const env = localEnv();
const adminEmail = uniqueEmail("bk.admin");
const staffEmail = uniqueEmail("bk.staff");
const BUCKET = "test-attachments";
const drawing = randomBytes(300_000); // binary "DXF" file
const pdf = Buffer.from("%PDF-1.4 test quotation\n");
let cfg: BackupConfig;
let key: Buffer;
let admin: SupabaseClient;
let mfa: { factorId: string; secret: string; lastCode: string };
let staffId: string;
let firstBackup: string;

async function companyName(): Promise<string> {
  return (await sql<{ name: string }>("select value->>'name' as name from public.app_settings where key = 'company'"))[0]!.name;
}

beforeAll(async () => {
  await resetLocalDatabase();
  // users: Admin with MFA, Staff
  await createAuthUser(adminEmail, "Backup Admin");
  await sql("select private.bootstrap_first_admin($1)", [adminEmail]);
  admin = await signIn(adminEmail);
  mfa = await enrollAndVerifyMfa(admin);
  staffId = await createAuthUser(staffEmail, "Backup Staff");
  await sql("update public.profiles set is_active = true, full_name = 'Backup Staff' where id = $1", [staffId]);
  // a business change made through the app
  const row = (await admin.from("app_settings").select("*").eq("key", "company").single()).data as { version: number; value: Record<string, string> };
  expect((await admin.rpc("update_setting", { p_key: "company", p_value: { ...row.value, name: "CESS Dynamics Pvt Ltd" }, p_expected_version: row.version })).error).toBeNull();
  // attachments in private storage
  const svc = serviceClient();
  await svc.storage.createBucket(BUCKET, { public: false, fileSizeLimit: 50 * 1024 * 1024 });
  expect((await svc.storage.from(BUCKET).upload("jobs/JOB-2627-0001/drawing rev A.dxf", drawing, { contentType: "application/octet-stream" })).error).toBeNull();
  expect((await svc.storage.from(BUCKET).upload("quotes/quote.pdf", pdf, { contentType: "application/pdf" })).error).toBeNull();

  const dataDir = await mkdtemp(join(tmpdir(), "cess-backup-it-"));
  key = generateKey();
  await import("node:fs/promises").then((fs) => fs.mkdir(join(dataDir, "keys"), { recursive: true }));
  await writeFile(join(dataDir, "keys", "backup.key"), encodeKey(key));
  cfg = parseConfig(
    {
      projectLabel: "local-test",
      supabaseUrl: env.apiUrl,
      databaseUrl: env.dbUrl,
      serviceKey: env.serviceRoleKey,
      secondCopyDir: join(dataDir, "usb-copy"),
    },
    dataDir,
  );
}, 300_000);

afterAll(async () => {
  await closeSql();
});

describe("backup", () => {
  it("creates an encrypted backup and verifies it by a test restore", async () => {
    const r = await runBackup(cfg, "manual");
    expect(r.error).toBeNull();
    expect(r.ok).toBe(true);
    expect(r.sidecar?.status).toBe("verified");
    expect(r.sidecar?.files).toBe(2);
    expect(r.verification?.checks.join("\n")).toMatch(/byte-identical/);
    expect(r.verification?.checks.join("\n")).toMatch(/active_admins=1/);
    expect(r.secondCopy).not.toBeNull();
    firstBackup = r.file!;
    const raw = await readFile(firstBackup);
    expect(raw.includes(Buffer.from("CESS Dynamics"))).toBe(false); // encrypted
    const runs = await sql<{ status: string; archive_name: string }>("select status, archive_name from public.backup_runs order by started_at desc limit 1");
    expect(runs[0]).toMatchObject({ status: "verified", archive_name: `${r.name}.cbk` });
  });

  it("rejects a damaged backup and the wrong key", async () => {
    const bad = `${firstBackup}.damaged`;
    const bytes = await readFile(firstBackup);
    bytes[Math.floor(bytes.length / 2)] = bytes[Math.floor(bytes.length / 2)]! ^ 0xff;
    await writeFile(bad, bytes);
    const r1 = await verifyArchive(bad, key);
    expect(r1.ok).toBe(false);
    const r2 = await verifyArchive(firstBackup, generateKey());
    expect(r2.ok).toBe(false);
    expect(r2.errors[0]).toMatch(/different key/);
    expect(BackupIntegrityError).toBeDefined();
  });

  it("refuses to restore without the exact confirmation text and changes nothing", async () => {
    await sql("update public.app_settings set value = jsonb_set(value, '{name}', '\"Changed after backup\"') where key = 'company'");
    const r = await restoreBackup(cfg, firstBackup, { confirm: "yes" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Confirmation text/);
    expect(await companyName()).toBe("Changed after backup");
  });

  it("refuses a backup made with a different database structure", async () => {
    await sql("insert into supabase_migrations.schema_migrations (version, name) values ('29991231000000', 'future')");
    try {
      const r = await restoreBackup(cfg, firstBackup, { confirm: confirmationPhrase(cfg) });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/structure version differs/);
    } finally {
      await sql("delete from supabase_migrations.schema_migrations where version = '29991231000000'");
    }
  });
});

describe("restore into the same project", () => {
  it("brings back data, accounts and attachments; takes a safety backup; keeps newer files", async () => {
    const svc = serviceClient();
    // damage after the backup
    await sql("update public.profiles set is_active = false where id = $1", [staffId]);
    await sql("insert into public.work_categories (name) values ('Added after backup')");
    await svc.storage.from(BUCKET).remove(["jobs/JOB-2627-0001/drawing rev A.dxf"]);
    await svc.storage.from(BUCKET).upload("later/new.pdf", pdf, { contentType: "application/pdf" });
    const logBefore = (await sql<{ n: number }>("select max(id)::int as n from public.activity_log"))[0]!.n;

    const r = await restoreBackup(cfg, firstBackup, { confirm: confirmationPhrase(cfg) });
    expect(r.error).toBeNull();
    expect(r.ok).toBe(true);
    expect(r.safetyBackup).toMatch(/pre_restore/);
    expect(r.files).toBe(2);
    expect(r.extraFilesKept).toBe(1);

    expect(await companyName()).toBe("CESS Dynamics Pvt Ltd");
    expect((await sql<{ a: boolean }>("select is_active as a from public.profiles where id = $1", [staffId]))[0]!.a).toBe(true);
    expect((await sql("select 1 from public.work_categories where name = 'Added after backup'")).length).toBe(0);
    const { data: file } = await svc.storage.from(BUCKET).download("jobs/JOB-2627-0001/drawing rev A.dxf");
    expect(Buffer.from(await file!.arrayBuffer()).equals(drawing)).toBe(true);

    const restored = await sql<{ action: string; id: number }>("select action, id from public.activity_log order by id desc limit 1");
    expect(restored[0]!.action).toBe("system.restored");
    expect(Number(restored[0]!.id)).toBeGreaterThan(logBefore); // history is never rolled back
    // the entries describing the changes made after the backup are still in the history
    const kept = await sql("select 1 from public.activity_log where action = 'work_categories.created' and new_value->>'name' = 'Added after backup'");
    expect(kept.length).toBe(1);

    // everyone is signed out; the same password and authenticator still work
    expect((await access(admin)).status).toBe("session_expired");
    admin = await signIn(adminEmail, PASSWORD);
    mfa.lastCode = await verifyMfa(admin, mfa.factorId, mfa.secret, mfa.lastCode);
    expect((await access(admin)).status).toBe("ok");

    const safety = (await listBackups(cfg.backupDir)).find((b) => b.kind === "pre_restore");
    expect(safety?.status).toBe("verified");
  });
});

describe("disaster recovery: complete loss of the database", () => {
  it("rebuilds everything from the backup into an empty project", async () => {
    // keep a copy of the backup as if it came from the USB drive
    const fromUsb = join(cfg.dataDir, "from-usb.cbk");
    await copyFile(firstBackup, fromUsb);

    await resetLocalDatabase(); // all users, data and storage metadata are gone
    expect((await sql<{ n: number }>("select count(*)::int as n from auth.users"))[0]!.n).toBe(0);

    const r = await restoreBackup(cfg, fromUsb, { confirm: confirmationPhrase(cfg) });
    expect(r.error).toBeNull();
    expect(r.ok).toBe(true);
    expect(r.safetyBackup).toBeNull(); // nothing to protect in an empty project

    expect(await companyName()).toBe("CESS Dynamics Pvt Ltd");
    const again = await signIn(adminEmail, PASSWORD);
    await verifyMfa(again, mfa.factorId, mfa.secret, mfa.lastCode);
    const a = await access(again);
    expect(a.status).toBe("ok");
    expect(a.role_key).toBe("admin");
    const svc = serviceClient();
    const { data: file } = await svc.storage.from(BUCKET).download("quotes/quote.pdf");
    expect(Buffer.from(await file!.arrayBuffer()).equals(pdf)).toBe(true);
    // the history from before the disaster is back, plus the restore entry
    const actions = (await sql<{ action: string }>("select action from public.activity_log order by id")).map((x) => x.action);
    expect(actions).toContain("user.bootstrap_admin");
    expect(actions[actions.length - 1]).toBe("system.restored");
  }, 300_000);
});
