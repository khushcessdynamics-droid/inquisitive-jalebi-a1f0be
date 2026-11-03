// Capacity and speed measurement for the running-cost estimate (docs/COSTS.md). LOCAL stack only; the database is reset before
// and after, so the measurement records never remain. Run with:  npm run test:capacity   (CAPACITY_JOBS=2000 by default)
// Each measured job goes through the normal API like a real one: created with a vendor and amount, a commitment revision on some,
// returned and inspected, invoiced and paid, WhatsApp opened on some. Times are from this machine; the free Supabase server
// (shared CPU, 0.5 GB memory) is slower, so they are indicative only.
import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { closeSql, createAuthUser, enrollAndVerifyMfa, resetLocalDatabase, signIn, sql, uniqueEmail } from "../helpers/clients";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const N = Number(process.env.CAPACITY_JOBS ?? 2000);
let admin: SupabaseClient;
let manager: SupabaseClient;
const result: Json = { jobs: N };

function istDate(offset = 0): string {
  return new Date(Date.now() + 330 * 60_000 + offset * 86_400_000).toISOString().slice(0, 10);
}
async function ok<T>(p: PromiseLike<{ data: T; error: { message: string; code?: string } | null }>): Promise<NonNullable<T>> {
  const { data, error } = await p;
  if (error) throw new Error(`${error.code}: ${error.message}`);
  return data as NonNullable<T>;
}
async function pool<T>(items: T[], size: number, fn: (x: T, i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]!, i);
    }
  }));
}
async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const runs: number[] = [];
  let out: T | undefined;
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    out = await fn();
    runs.push(performance.now() - t);
  }
  (result.timings ??= {})[label] = Math.round(Math.min(...runs));
  return out as T;
}
async function sizes() {
  const db = (await sql<{ b: string }>("select pg_database_size(current_database())::text as b"))[0]!.b;
  const tables = await sql<{ t: string; b: string }>(
    "select c.relname as t, pg_total_relation_size(c.oid)::text as b from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'",
  );
  return { db: Number(db), tables: Object.fromEntries(tables.map((r) => [r.t, Number(r.b)])) };
}

beforeAll(async () => {
  await resetLocalDatabase();
  const adminEmail = uniqueEmail("cap.admin");
  await createAuthUser(adminEmail, "Capacity Admin");
  await sql("select private.bootstrap_first_admin($1)", [adminEmail]);
  admin = await signIn(adminEmail);
  await enrollAndVerifyMfa(admin);
  const mEmail = uniqueEmail("cap.mgr");
  const id = await createAuthUser(mEmail, "Capacity Manager");
  await sql("update public.profiles set role_key = 'manager', is_active = true where id = $1", [id]);
  manager = await signIn(mEmail);
  await enrollAndVerifyMfa(manager);
}, 300_000);

afterAll(async () => {
  writeFileSync("capacity-result.json", JSON.stringify(result, null, 2));
  await resetLocalDatabase(); // remove every measurement record
  await closeSql();
}, 300_000);

describe(`capacity with ${N} complete jobs`, () => {
  it("creates the jobs through the API and measures the space used", async () => {
    const categories = (await sql<{ id: string }>("select id from public.work_categories order by name")).map((r) => r.id);
    const vendors: string[] = [];
    for (let v = 0; v < 12; v++) {
      vendors.push(((await ok(manager.rpc("save_vendor", { p_vendor_id: null, p_expected_version: null, p: { name: `Capacity Vendor ${v + 1}`, wa_number: `98220${String(10000 + v)}`, category_ids: [categories[v % categories.length]] } }))) as Json).id);
    }
    await sql("vacuum analyze");
    const before = await sizes();
    const started = performance.now();
    await pool(Array.from({ length: N }, (_, i) => i), 12, async (i) => {
      const age = 20 + (i % 340); // spread over the last year
      const qty = 20 + (i % 180);
      const job = (await ok(manager.rpc("create_job", {
        p: { part_label: `CAP-${i} / Part ${i % 97}`, qty_sent: qty, category_id: categories[i % categories.length], remarks: i % 3 ? "" : "Urgent, deliver in two lots",
             vendor: { vendor_id: vendors[i % vendors.length], dispatched_on: istDate(-age), commitment_date: istDate(-age + 7), amount: 1000 + (i % 50) * 250 } },
      }))) as Json;
      let a = (await ok(manager.from("job_assignments").select("id, version").eq("job_id", job.id).single())) as Json;
      if (i % 3 === 0) {
        await ok(manager.rpc("revise_commitment", { p_assignment_id: a.id, p_expected_version: a.version, p_new_date: istDate(-age + 10), p_requested_by: "vendor", p_reason: "Machine breakdown" }));
      }
      if (i % 2 === 0) {
        await ok(manager.rpc("log_whatsapp_message", { p_vendor_id: vendors[i % vendors.length], p_job_id: job.id, p_template_key: "status_followup", p_phone: "919822010000", p_body: `Status of ${job.job_no}?`, p_confirm_duplicate: true }));
      }
      const rejected = i % 10 === 0 ? 2 : 0;
      await ok(manager.rpc("record_return", { p_assignment_id: a.id, p: { returned_on: istDate(-age + 8), qty_received: qty, challan_no: `DC-${i}`, inspection: { inspected_on: istDate(-age + 8), qty_accepted: qty - rejected, qty_rejected: rejected } } }));
      a = (await ok(admin.from("job_assignments").select("id, version").eq("id", a.id).single())) as Json;
      await ok(admin.rpc("record_vendor_invoice", { p_assignment_id: a.id, p_expected_version: a.version, p: { invoice_no: `INV-${i}`, invoice_date: istDate(-age + 9), amount: 1000 + (i % 50) * 250 }, p_reason: null }));
      await ok(admin.rpc("add_vendor_payment", { p_assignment_id: a.id, p: { kind: "payment", paid_on: istDate(-age + 15), amount: 1000 + (i % 50) * 250, mode: "bank_transfer", reference: `UTR${i}` } }));
    });
    result.createSeconds = Math.round((performance.now() - started) / 1000);
    await sql("vacuum analyze");
    const after = await sizes();
    result.databaseBytesBefore = before.db;
    result.databaseBytesAfter = after.db;
    result.bytesPerJob = Math.round((after.db - before.db) / N);
    result.tableBytesPerJob = Object.fromEntries(
      Object.entries(after.tables)
        .map(([t, b]) => [t, Math.round((b - (before.tables[t] ?? 0)) / N)] as const)
        .filter(([, b]) => b > 50)
        .sort((x, y) => y[1] - x[1]),
    );
    result.activityRowsPerJob = Number((await sql<{ n: string }>("select (count(*)::numeric / $1)::numeric(6,1)::text as n from public.activity_log", [N]))[0]!.n);
    expect((await sql<{ n: number }>("select count(*)::int as n from public.jobs"))[0]!.n).toBe(N);
  }, 3_600_000);

  it("times the main screens with this much data", async () => {
    await timed("Jobs Register, first page of 50 with total count", () => ok(manager.from("job_register").select("*", { count: "exact" }).order("job_no", { ascending: false }).range(0, 49)));
    await timed("Jobs Register search by part", () => ok(manager.from("job_register").select("*").ilike("part_label", "%Part 42%").limit(50)));
    await timed("Excel export of every job", () => ok(manager.from("job_register").select("*").order("job_no").range(0, N)));
    await timed("Dashboard (all KPIs, charts and tables)", () => ok(manager.rpc("dashboard_data", { p_fy: null })));
    await timed("Vendor reliability ranking", () => ok(manager.rpc("vendor_reliability", { p: { fy: null } })));
    await timed("Payments by vendor", () => ok(manager.rpc("vendor_payment_summary", { p: {} })));
    const d = new Date(`${istDate(0)}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) - 28);
    await timed("Weekly report for a past week", () => ok(manager.rpc("generate_weekly_report", { p_start: d.toISOString().slice(0, 10) })));
    await timed("Activity History, newest 100", () => ok(admin.from("activity_log").select("*").order("id", { ascending: false }).limit(100)));
    expect(Object.keys(result.timings).length).toBe(8);
  }, 600_000);
});
