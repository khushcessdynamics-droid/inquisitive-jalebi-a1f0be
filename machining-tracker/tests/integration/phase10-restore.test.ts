// Phase 10, Example 11: back up a complete set of real business records (jobs, reassignment, commitment revisions,
// returns, inspections, invoice, payments with a reversal, quotations, WhatsApp log, reminders, weekly report,
// attachment), lose the whole database, restore it, and require everything the app shows to be identical.
// Also checks that the protections (append-only payments and history) and the numbering continue after the restore.
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { confirmationPhrase, encodeKey, generateKey, parseConfig, restoreBackup, runBackup, type BackupConfig } from "../../tools/backup/src/index.ts";
import { localEnv } from "../helpers/env";
import { PASSWORD, closeSql, createAuthUser, enrollAndVerifyMfa, resetLocalDatabase, signIn, sql, uniqueEmail, verifyMfa } from "../helpers/clients";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const env = localEnv();
const adminEmail = uniqueEmail("p10.admin");
const managerEmail = uniqueEmail("p10.mgr");
let admin: SupabaseClient;
let manager: SupabaseClient;
let adminMfa: { factorId: string; secret: string; lastCode: string };
let managerMfa: { factorId: string; secret: string; lastCode: string };
let cfg: BackupConfig;
let backupFile = "";
let before: Json = {};
const ids: Json = {};

function istDate(offset = 0): string {
  return new Date(Date.now() + 330 * 60_000 + offset * 86_400_000).toISOString().slice(0, 10);
}
async function ok<T>(p: PromiseLike<{ data: T; error: { message: string; code?: string } | null }>): Promise<NonNullable<T>> {
  const { data, error } = await p;
  if (error) throw new Error(`${error.code}: ${error.message}`);
  return data as NonNullable<T>;
}

/**
 * Compares content, not the order of rows that share the same sort value (e.g. reminders created in the same instant):
 * every list is sorted by its rows' full content before comparing.
 */
function normalized(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalized).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalized(x)]));
  return v;
}

/** Everything the app shows for these records, read through the API as Manager and Admin. */
async function appView(): Promise<Json> {
  const rows = async (c: SupabaseClient, view: string, order: string) => ok(c.from(view).select("*").order(order));
  return {
    register: await rows(manager, "job_register", "job_no"),
    assignments: await ok(manager.from("job_assignments").select("*").order("job_id").order("sequence_no")),
    commitmentHistory: await rows(manager, "commitment_history", "created_at"),
    returnLots: await rows(manager, "material_return_lots", "created_at"),
    inspections: await rows(manager, "quality_inspection_log", "created_at"),
    paymentAccounts: await rows(admin, "payment_accounts", "assignment_id"),
    paymentLedger: await rows(admin, "payment_ledger", "created_at"),
    statement: await ok(manager.rpc("vendor_statement", { p_vendor_id: ids.vendorA, p_from: null, p_to: null })),
    quotes: await ok(manager.rpc("quotation_comparison", { p_request_id: ids.request })),
    reliability: await ok(manager.rpc("vendor_reliability", { p: { fy: null } })),
    whatsapp: await rows(manager, "whatsapp_log", "created_at"),
    reminders: await ok(manager.from("reminders").select("*").order("created_at")),
    weekly: await ok(manager.rpc("get_weekly_report", { p_id: ids.report })),
    attachments: await ok(manager.from("attachments").select("*").order("uploaded_at")),
    vendors: await ok(manager.from("vendors").select("*").order("vendor_code")),
    dashboard: await ok(manager.rpc("dashboard_data", { p_fy: null })),
    history: await ok(admin.from("activity_log").select("*").order("id")),
  };
}

beforeAll(async () => {
  await resetLocalDatabase();
  await createAuthUser(adminEmail, "Restore Admin");
  await sql("select private.bootstrap_first_admin($1)", [adminEmail]);
  admin = await signIn(adminEmail);
  adminMfa = await enrollAndVerifyMfa(admin);
  const mid = await createAuthUser(managerEmail, "Mona Manager");
  await sql("update public.profiles set role_key = 'manager', is_active = true, full_name = 'Mona Manager' where id = $1", [mid]);
  manager = await signIn(managerEmail);
  managerMfa = await enrollAndVerifyMfa(manager);
  const cnc = (await sql<{ id: string }>("select id from public.work_categories where name = 'CNC Turning'"))[0]!.id;
  const vendor = async (name: string, wa: string) =>
    ((await ok(manager.rpc("save_vendor", { p_vendor_id: null, p_expected_version: null, p: { name, wa_number: wa, category_ids: [cnc] } }))) as Json).id as string;
  ids.vendorA = await vendor("Shree Engineering", "9822012345");
  ids.vendorB = await vendor("Precision Works", "9822054321");
  ids.vendorC = await vendor("Kiran Precision", "9822099999");

  // Examples 1-5 on one job: late, revised commitment, 60 of 100 back, 55 accepted + 5 rejected, invoice and payments
  const j1 = (await ok(manager.rpc("create_job", {
    p: { part_label: "4711 / Drive Shaft", qty_sent: 100, category_id: cnc, vendor: { vendor_id: ids.vendorA, dispatched_on: istDate(-12), commitment_date: istDate(-6), amount: 45000 } },
  }))) as Json;
  ids.job1 = j1.id;
  const a1 = (await ok(manager.from("job_assignments").select("id, version").eq("job_id", j1.id).single())) as Json;
  ids.assignment1 = a1.id;
  await ok(manager.rpc("revise_commitment", { p_assignment_id: a1.id, p_expected_version: a1.version, p_new_date: istDate(-3), p_requested_by: "vendor", p_reason: "Machine breakdown" }));
  const ret = (await ok(manager.rpc("record_return", { p_assignment_id: a1.id, p: { returned_on: istDate(-2), qty_received: 60, challan_no: "DC-101" } }))) as Json;
  await ok(manager.rpc("record_inspection", { p_return_id: ret.return.id, p: { inspected_on: istDate(-1), qty_accepted: 55, qty_rejected: 5, inspector_name: "QC Ravi" } }));
  const v1 = (await ok(admin.from("job_assignments").select("version").eq("id", a1.id).single())) as Json;
  await ok(admin.rpc("record_vendor_invoice", { p_assignment_id: a1.id, p_expected_version: v1.version, p: { invoice_no: "SE/245", invoice_date: istDate(-1), amount: 50000 }, p_reason: "Extra facing" }));
  await ok(admin.rpc("add_vendor_payment", { p_assignment_id: a1.id, p: { kind: "advance", paid_on: istDate(-1), amount: 20000, mode: "bank_transfer", reference: "UTR123" } }));
  const wrong = (await ok(admin.rpc("add_vendor_payment", { p_assignment_id: a1.id, p: { kind: "payment", paid_on: istDate(0), amount: 5000, mode: "cash" } }))) as Json;
  await ok(admin.rpc("reverse_vendor_payment", { p_payment_id: wrong.id, p_reason: "Entered twice" }));
  await ok(admin.rpc("add_vendor_payment", { p_assignment_id: a1.id, p: { kind: "payment", paid_on: istDate(0), amount: 15000, mode: "upi", reference: "UTR456" } }));
  await ok(admin.rpc("add_payment_adjustment", { p_assignment_id: a1.id, p: { kind: "additional_charge", entry_date: istDate(0), amount: 2000, description: "Transport" } }));

  // Example 8: cancel Vendor A, forward to Vendor B
  const j2 = (await ok(manager.rpc("create_job", {
    p: { part_label: "5520 / Flange", qty_sent: 40, category_id: cnc, vendor: { vendor_id: ids.vendorA, dispatched_on: istDate(-8), commitment_date: istDate(-4), amount: 8000 } },
  }))) as Json;
  ids.job2 = j2.id;
  const a2 = (await ok(manager.from("job_assignments").select("id, version").eq("job_id", j2.id).single())) as Json;
  await ok(manager.rpc("cancel_assignment", {
    p_assignment_id: a2.id, p_expected_version: a2.version, p_cancelled_on: istDate(-1), p_reason_code: "vendor_missed_commitment", p_reason_text: "Missed date",
    p_forward: { vendor_id: ids.vendorB, dispatched_on: istDate(-1), commitment_date: istDate(3), amount: 9000 },
  }));
  // a draft job without quantity or commitment (missing values stay empty)
  ids.job3 = ((await ok(manager.rpc("create_job", { p: { part_label: "Draft bracket", category_id: cnc } }))) as Json).id;

  // Example 6: three quotations
  const req = (await ok(manager.rpc("save_quotation_request", { p_request_id: null, p_expected_version: null, p: { part_label: "6001 / Sleeve", category_id: cnc, qty: 50, required_by: istDate(20) } }))) as Json;
  ids.request = req.id;
  for (const [v, price, days] of [[ids.vendorA, 120, 6], [ids.vendorB, 150, 4], [ids.vendorC, 135, 5]] as const) {
    await ok(manager.rpc("save_quotation", { p_quotation_id: null, p_expected_version: null, p_request_id: req.id, p: { vendor_id: v, quote_date: istDate(0), basis: "per_part", price, delivery_days: days } }));
  }

  // communication, reminders, weekly report, attachment
  await ok(manager.rpc("log_whatsapp_message", { p_vendor_id: ids.vendorA, p_job_id: j1.id, p_template_key: "overdue", p_phone: "919822012345", p_body: "Dear Shree, job is late", p_confirm_duplicate: false }));
  await sql("select private.run_reminders(now(), true)");
  const monday = new Date(`${istDate(0)}T00:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7) - 7);
  ids.report = ((await ok(manager.rpc("generate_weekly_report", { p_start: monday.toISOString().slice(0, 10) }))) as Json).id;
  const path = `${j1.id}/${crypto.randomUUID()}__drawing.pdf`;
  expect((await manager.storage.from("job-files").upload(path, new Blob(["%PDF-1.4 drawing rev B"]), { contentType: "application/pdf" })).error).toBeNull();
  await ok(manager.rpc("register_attachment", { p_job_id: j1.id, p_storage_path: path, p_file_name: "drawing.pdf" }));
  ids.attachmentPath = path;

  const dataDir = await mkdtemp(join(tmpdir(), "cess-p10-restore-"));
  const key = generateKey();
  await mkdir(join(dataDir, "keys"), { recursive: true });
  await writeFile(join(dataDir, "keys", "backup.key"), encodeKey(key));
  cfg = parseConfig({ projectLabel: "local-test", supabaseUrl: env.apiUrl, databaseUrl: env.dbUrl, serviceKey: env.serviceRoleKey }, dataDir);
}, 300_000);

afterAll(async () => {
  await closeSql();
});

describe("Example 11: backup and restore of the complete business records", () => {
  it("the records show the expected figures before the backup", async () => {
    before = await appView();
    const acc = (before.paymentAccounts as Json[]).find((a) => a.assignment_id === ids.assignment1)!;
    expect(acc).toMatchObject({ job_amount: 50000, invoice_no: "SE/245", amount_paid: 35000, additional_charges: 2000, total_payable: 52000, balance: 17000, payment_status: "Partially Paid" });
    const r1 = (before.register as Json[]).find((r) => r.id === ids.job1)!;
    expect(r1).toMatchObject({ qty_sent: 100, qty_received: 60, qty_with_vendor: 40, revision_count: 1 });
    const r2 = (before.register as Json[]).find((r) => r.id === ids.job2)!;
    expect(r2.vendor_name).toBe("Precision Works");
    expect((before.assignments as Json[]).filter((a) => a.job_id === ids.job2).map((a) => a.state)).toEqual(["cancelled", "open"]);
    const r3 = (before.register as Json[]).find((r) => r.id === ids.job3)!;
    expect(r3.qty_sent).toBeNull();
    expect((before.history as Json[]).length).toBeGreaterThan(20);
  });

  it("the backup is verified, including the business checks", async () => {
    const r = await runBackup(cfg, "manual");
    expect(r.error).toBeNull();
    expect(r.ok).toBe(true);
    expect(r.sidecar?.status).toBe("verified");
    const checks = r.verification!.checks.join("\n");
    expect(checks).toMatch(/jobs=3\/0\/JOB-\d{4}-0003/);
    expect(checks).toMatch(/payments=4\/35000\.00\/PAY-\d{4}-0004/);
    expect(checks).toMatch(/inspections=55\/5\/0/);
    expect(checks).toMatch(/assignments_by_state=cancelled=1,open=2/);
    expect(checks).toMatch(/attachments=1\/22/);
    backupFile = r.file!;
  }, 300_000);

  it("after losing the whole database, the restore brings back exactly what the app showed", async () => {
    await resetLocalDatabase();
    expect((await sql<{ n: number }>("select count(*)::int as n from public.jobs"))[0]!.n).toBe(0);
    const r = await restoreBackup(cfg, backupFile, { confirm: confirmationPhrase(cfg) });
    expect(r.error).toBeNull();
    expect(r.ok).toBe(true);

    // everyone signs in again (sessions are not restored); passwords and authenticators still work
    admin = await signIn(adminEmail, PASSWORD);
    adminMfa.lastCode = await verifyMfa(admin, adminMfa.factorId, adminMfa.secret, adminMfa.lastCode);
    manager = await signIn(managerEmail, PASSWORD);
    managerMfa.lastCode = await verifyMfa(manager, managerMfa.factorId, managerMfa.secret, managerMfa.lastCode);

    const after = await appView();
    for (const k of Object.keys(before)) {
      if (k === "history") continue;
      expect(normalized(after[k]), k).toEqual(normalized(before[k]));
    }
    // the history is complete, followed by the restore entry
    const h = after.history as Json[];
    expect(h.slice(0, (before.history as Json[]).length)).toEqual(before.history);
    expect(h[h.length - 1]!.action).toBe("system.restored");
    // the attachment file itself is back
    const { data: file } = await manager.storage.from("job-files").download(ids.attachmentPath);
    expect(await file!.text()).toBe("%PDF-1.4 drawing rev B");
  }, 300_000);

  it("after the restore, payment history and the activity history still cannot be altered", async () => {
    await expect(sql("update public.vendor_payments set amount = 1")).rejects.toThrow();
    await expect(sql("delete from public.vendor_payments")).rejects.toThrow();
    await expect(sql("update public.activity_log set reason = 'changed'")).rejects.toThrow();
    await expect(sql("delete from public.commitment_revisions")).rejects.toThrow();
    const upd = await admin.from("vendor_payments").update({ amount: 1 }).eq("assignment_id", ids.assignment1).select("id");
    expect(upd.error ?? upd.data?.length === 0).toBeTruthy();
  });

  it("numbering continues after the restore (no duplicate job or payment numbers)", async () => {
    const cnc = (await sql<{ id: string }>("select id from public.work_categories where name = 'CNC Turning'"))[0]!.id;
    const j = (await ok(manager.rpc("create_job", { p: { part_label: "After restore", category_id: cnc } }))) as Json;
    expect(j.job_no).toMatch(/-0004$/);
    const p = (await ok(admin.rpc("add_vendor_payment", { p_assignment_id: ids.assignment1, p: { kind: "payment", paid_on: istDate(0), amount: 1000, mode: "cash" } }))) as Json;
    expect(p.payment_no).toMatch(/-0005$/);
    const acc = (await ok(admin.from("payment_accounts").select("*").eq("assignment_id", ids.assignment1).single())) as Json;
    expect(acc).toMatchObject({ amount_paid: 36000, balance: 16000 });
    const last = await sql<{ action: string }>("select action from public.activity_log order by id desc limit 1");
    expect(last[0]!.action).toBe("payment.added");
  });
});
