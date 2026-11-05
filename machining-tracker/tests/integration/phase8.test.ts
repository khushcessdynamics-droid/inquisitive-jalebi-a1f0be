// Phase 8 through the real API (local Supabase): dashboard figures from real records (and only the records the
// user may see), the weekly management report for a fixed past week, scheduling, history and comparison.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { closeSql, createAuthUser, enrollAndVerifyMfa, resetLocalDatabase, signIn, sql, uniqueEmail, pauseScheduler } from "../helpers/clients";

let admin: SupabaseClient;
let manager: SupabaseClient;
let staff: SupabaseClient;
let staffId = "";
let cnc = "";
let grinding = "";
let vendorA = "";
let vendorB = "";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function istDate(offsetDays = 0): string {
  return new Date(Date.now() + 330 * 60_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
}
function add(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function fyOf(iso: string): string {
  const y = Number(iso.slice(0, 4));
  const s = Number(iso.slice(5, 7)) >= 4 ? y : y - 1;
  return `${s}-${String((s + 1) % 100).padStart(2, "0")}`;
}
async function user(email: string, role: "admin" | "manager" | "staff", name: string): Promise<{ client: SupabaseClient; id: string }> {
  const id = await createAuthUser(email, name);
  await sql("update public.profiles set role_key = $2, is_active = true, full_name = $3 where id = $1", [id, role, name]);
  const client = await signIn(email);
  if (role !== "staff") await enrollAndVerifyMfa(client);
  return { client, id };
}
async function ok<T>(p: PromiseLike<{ data: T; error: { message: string; code?: string } | null }>): Promise<NonNullable<T>> {
  const { data, error } = await p;
  if (error) throw new Error(`${error.code}: ${error.message}`);
  return data as NonNullable<T>;
}
async function job(part: string, vendor: string | null, given: string | null, due: string | null, qty: number | null, amount: number | null = null, category = cnc) {
  const j = (await ok(manager.rpc("create_job", {
    p: { part_label: part, qty_sent: qty, category_id: category,
         vendor: vendor ? { vendor_id: vendor, dispatched_on: given, commitment_date: due, amount } : null },
  }))) as Json;
  const a = vendor ? ((await ok(manager.from("job_assignments").select("id, version").eq("job_id", j.id).single())) as Json) : null;
  return { jobId: j.id as string, assignmentId: a?.id as string, version: a?.version as number };
}
async function returnAll(asg: string, on: string, accepted: number, rejected = 0) {
  return ok(manager.rpc("record_return", { p_assignment_id: asg, p: { returned_on: on, qty_received: accepted + rejected, inspection: { inspected_on: on, qty_accepted: accepted, qty_rejected: rejected } } }));
}

beforeAll(async () => {
  await resetLocalDatabase();
  await pauseScheduler(); // this file runs the scheduled functions itself at fixed times
  const adminEmail = uniqueEmail("p8.admin");
  await createAuthUser(adminEmail, "P8 Admin");
  await sql("select private.bootstrap_first_admin($1)", [adminEmail]);
  admin = await signIn(adminEmail);
  await enrollAndVerifyMfa(admin);
  manager = (await user(uniqueEmail("p8.mgr"), "manager", "Mona Manager")).client;
  const s = await user(uniqueEmail("p8.staff"), "staff", "Sanjay Staff");
  staff = s.client;
  staffId = s.id;
  const cats = Object.fromEntries((await sql<{ name: string; id: string }>("select name, id from public.work_categories")).map((r) => [r.name, r.id]));
  cnc = cats["CNC Turning"]!;
  grinding = cats["Grinding"]!;
  vendorA = ((await ok(manager.rpc("save_vendor", { p_vendor_id: null, p_expected_version: null, p: { name: "Alpha Turners" } }))) as Json).id;
  vendorB = ((await ok(manager.rpc("save_vendor", { p_vendor_id: null, p_expected_version: null, p: { name: "Beta Grinders" } }))) as Json).id;
}, 300_000);

afterAll(async () => {
  await closeSql();
});

// ---------------------------------------------------------------------------------------------------------------
describe("dashboard", () => {
  let j5 = { jobId: "", assignmentId: "", version: 0 };

  beforeAll(async () => {
    await job("D-1 / Due soon", vendorA, istDate(-1), istDate(2), 10);
    await job("D-2 / Overdue", vendorA, istDate(-10), istDate(-2), 10);
    await job("D-3 / Due today", vendorB, istDate(-3), istDate(0), 10, null, grinding);
    await job("D-4 / Draft", null, null, null, 5);
    j5 = await job("D-5 / Completed late", vendorB, istDate(-6), istDate(-2), 10, 5000, grinding);
    await returnAll(j5.assignmentId, istDate(-1), 9, 1);
    const j6 = await job("D-6 / Cancelled", vendorA, istDate(-4), istDate(3), 10);
    await ok(manager.rpc("cancel_assignment", { p_assignment_id: j6.assignmentId, p_expected_version: j6.version, p_cancelled_on: istDate(0),
      p_reason_code: "customer_cancelled", p_reason_text: "Order dropped", p_forward: null }));
    await ok(admin.rpc("add_vendor_payment", { p_assignment_id: j5.assignmentId, p: { kind: "payment", paid_on: istDate(0), amount: 3000, mode: "upi" } }));
  });

  it("KPIs come from the records (active, pending, overdue, due today, completed, money, quality)", async () => {
    const d = (await ok(manager.rpc("dashboard_data", { p_fy: null }))) as Json;
    const fy = fyOf(istDate(0));
    expect(d.fy).toBe(fy);
    const sameMonth = (iso: string) => iso.slice(0, 7) === istDate(0).slice(0, 7);
    const sameFy = (iso: string) => fyOf(iso) === fy;
    expect(d.kpis).toMatchObject({
      active: 3, // D-1, D-2, D-3 (not the draft, the completed or the cancelled job)
      pending: 4, // + the draft
      drafts: 1,
      overdue: 1,
      due_today: 1,
      completed_fy: sameFy(istDate(-1)) ? 1 : 0,
      completed_this_month: sameMonth(istDate(-1)) ? 1 : 0,
      new_fy: [istDate(-1), istDate(-10), istDate(-3), istDate(0), istDate(-6), istDate(-4)].filter(sameFy).length,
    });
    expect(d.money).toMatchObject({ spending_fy: 3000, outstanding: 2000, outstanding_accounts: 1 });
    expect(d.quality).toMatchObject({ inspected: 10, accepted: 9, rejected: 1, acceptance_pct: 90 });
    expect(d.on_time).toMatchObject({ on_time: 0, late: 1, no_commitment: 0 });
    expect(d.completion_split).toMatchObject({ completed: 1, cancelled: 1 });
    expect((d.vendors as Json[]).find((v) => v.vendor_name === "Alpha Turners")!.jobs).toBe(3);
    expect((d.categories as Json[]).map((c) => [c.category_name, c.jobs])).toEqual(expect.arrayContaining([["CNC Turning", 4], ["Grinding", 2]]));
    expect((d.tables.overdue as Json[]).map((r) => r.part_label)).toEqual(["D-2 / Overdue"]);
    expect((d.tables.pending_payments as Json[])[0]).toMatchObject({ part_label: "D-5 / Completed late", balance: 2000 });
    expect((d.tables.vendor_followups as Json[])[0]).toMatchObject({ vendor_name: "Alpha Turners", overdue_jobs: 1 });
    const month = (d.monthly as Json[]).find((m) => m.month === istDate(0).slice(0, 7))!;
    expect(month.spending).toBe(3000);
    expect(d.reliability).toMatchObject({ scored_vendors: 0, average: null }); // too few jobs: no score, not zero
  });

  it("every figure respects what the user may see; money only with payments.view", async () => {
    expect((await staff.rpc("dashboard_data", { p_fy: null })).error?.code).toBe("42501");
    await sql("insert into public.user_permission_overrides (user_id, permission_key, granted, reason) values ($1, 'reports.view', true, 'test')", [staffId]);
    const s = (await ok(staff.rpc("dashboard_data", { p_fy: null }))) as Json;
    expect(s.kpis).toMatchObject({ active: 0, pending: 0, overdue: 0 }); // Staff see only jobs assigned to / created by them
    expect(s.money).toBeNull();
    expect(s.reliability).toBeNull();
    expect((await manager.rpc("dashboard_data", { p_fy: "2026-28" })).error?.code).toBe("22023");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("weekly management report", () => {
  const S = "2025-06-02"; // Monday; the week is 02-Jun-2025 to 08-Jun-2025
  let reportId = "";

  beforeAll(async () => {
    const k1 = await job("W-1 / On time", vendorA, S, add(S, 3), 20, 1000);
    await returnAll(k1.assignmentId, add(S, 3), 20);
    const k2 = await job("W-2 / Cancelled", vendorA, add(S, 1), add(S, 2), null, null);
    await ok(manager.rpc("cancel_assignment", { p_assignment_id: k2.assignmentId, p_expected_version: k2.version, p_cancelled_on: add(S, 4),
      p_reason_code: "vendor_missed_commitment", p_reason_text: "Did not deliver", p_forward: null }));
    const k3 = await job("W-3 / Late", vendorB, add(S, 2), add(S, 4), 10, 2000, grinding);
    await returnAll(k3.assignmentId, add(S, 6), 8, 2);
    const k4 = await job("W-4 / Started before", vendorB, add(S, -3), add(S, 5), 5, null, grinding);
    await sql(`insert into public.commitment_revisions (assignment_id, job_id, vendor_id, revision_no, original_date, previous_date, new_date, changed_on, requested_by, reason)
               values ($1, $2, $3, 1, $4, $4, $5, $6, 'vendor', 'test')`, [k4.assignmentId, k4.jobId, vendorB, add(S, 5), add(S, 9), add(S, 2)]);
    await ok(admin.rpc("add_vendor_payment", { p_assignment_id: k1.assignmentId, p: { kind: "payment", paid_on: add(S, 5), amount: 600, mode: "cash" } }));
  });

  it("A-F from actual records; missing values are counted separately, not as zero", async () => {
    reportId = ((await ok(manager.rpc("generate_weekly_report", { p_start: S }))) as Json).id;
    const r = (await ok(manager.rpc("get_weekly_report", { p_id: reportId }))) as Json;
    expect(r.data.period).toEqual({ start: S, end: add(S, 6) });
    expect(r.data.jobs).toMatchObject({ new: 3, completed: 2, cancelled: 1 });
    expect(r.data.delivery).toMatchObject({ due: 3, completed_on_time: 1, completed_late: 1, completed_no_commitment: 0, avg_delay_days: 2 });
    expect(r.data.delivery.vendors_revised).toEqual([{ vendor_id: vendorB, vendor_name: "Beta Grinders", revisions: 1, by_vendor: 1 }]);
    expect(r.data.quality).toMatchObject({ qty_sent: 30, jobs_without_qty: 1, qty_returned: 30, inspected: 30, accepted: 28, rejected: 2, rework: 0, acceptance_pct: 93.3 });
    expect(r.financial).toMatchObject({ total_job_value: 3000, jobs_without_amount: 1, payments_made: 600 });
    expect(r.financial.spending_by_vendor).toEqual([{ vendor_id: vendorA, vendor_name: "Alpha Turners", paid: 600 }]);
    expect(r.data.previous.jobs).toMatchObject({ new: 1, completed: 0, cancelled: 0 }); // W-4 started the week before
    expect(r.data.previous.snapshot_from_report).toBeNull();
    expect(r.data.vendors.fy).toBe("2025-26");
  });

  it("is generated automatically on the configured weekday and time, once per week", async () => {
    const run = async (now: string) => (await sql<{ r: Json }>("select private.run_weekly_report($1::timestamptz) as r", [now]))[0]!.r;
    expect(await run("2025-06-10T09:00:00+05:30")).toMatchObject({ ran: false }); // Tuesday
    expect(await run("2025-06-09T07:30:00+05:30")).toMatchObject({ ran: false }); // Monday, before 08:00 IST
    expect(await run("2025-06-09T08:15:00+05:30")).toMatchObject({ ran: true, period_start: S });
    expect(await run("2025-06-09T11:00:00+05:30")).toMatchObject({ ran: false, reason: "This week's report already exists." });
    // the next week compares with this one, including the "as at report time" figures
    const next = ((await ok(manager.rpc("generate_weekly_report", { p_start: add(S, 7) }))) as Json).id;
    const r = (await ok(manager.rpc("get_weekly_report", { p_id: next }))) as Json;
    expect(r.data.previous.jobs).toMatchObject({ new: 3, completed: 2, cancelled: 1 });
    expect(r.data.previous.snapshot_from_report).not.toBeNull();
    const list = (await ok(manager.rpc("list_weekly_reports"))) as Json[];
    expect(list.map((x) => [x.period_start, x.kind])).toEqual([[add(S, 7), "manual"], [S, "scheduled"], [S, "manual"]].map((x) => x));
  });

  it("reports need reports.view; money needs payments.view; unfinished weeks are refused; history is permanent", async () => {
    await sql("delete from public.user_permission_overrides where user_id = $1", [staffId]);
    expect((await staff.rpc("get_weekly_report", { p_id: reportId })).error?.code).toBe("42501");
    await sql("insert into public.user_permission_overrides (user_id, permission_key, granted, reason) values ($1, 'reports.view', true, 'test')", [staffId]);
    const s = (await ok(staff.rpc("get_weekly_report", { p_id: reportId }))) as Json;
    expect(s.financial).toBeNull();
    expect(s.data.jobs.new).toBe(3);
    const thisWeek = await manager.rpc("generate_weekly_report", { p_start: istDate(-3) });
    expect(thisWeek.error?.message).toMatch(/already ended/);
    await expect(sql("delete from public.weekly_reports")).rejects.toThrow(/append-only/);
    expect((await staff.from("weekly_reports").select("id")).data ?? []).toEqual([]);
  });
});
