// Phase 5 business rules through the real API (local Supabase): commitment revision history (Example 2),
// six-factor reliability score with sample sizes (Example 7) and vendor cost comparison (Example 6).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { closeSql, createAuthUser, enrollAndVerifyMfa, resetLocalDatabase, signIn, sql, uniqueEmail } from "../helpers/clients";

let admin: SupabaseClient;
let manager: SupabaseClient;
let staff: SupabaseClient;
let cnc = "";
const vendor: Record<string, string> = {};

function istDate(offsetDays = 0): string {
  return new Date(Date.now() + 330 * 60_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
}
function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function user(email: string, role: "admin" | "manager" | "staff", name: string): Promise<SupabaseClient> {
  const id = await createAuthUser(email, name);
  await sql("update public.profiles set role_key = $2, is_active = true, full_name = $3 where id = $1", [id, role, name]);
  const client = await signIn(email);
  if (role !== "staff") await enrollAndVerifyMfa(client);
  return client;
}

async function ok<T>(p: PromiseLike<{ data: T; error: { message: string; code?: string } | null }>): Promise<NonNullable<T>> {
  const { data, error } = await p;
  if (error) throw new Error(`${error.code}: ${error.message}`);
  return data as NonNullable<T>;
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function addVendor(name: string): Promise<string> {
  const v = (await ok(manager.rpc("save_vendor", { p_vendor_id: null, p_expected_version: null, p: { name, category_ids: [cnc] } }))) as Json;
  vendor[name] = v.id as string;
  return v.id as string;
}

async function setSetting(key: string, change: (v: Json) => Json) {
  const row = (await ok(admin.from("app_settings").select("*").eq("key", key).single())) as Json;
  return admin.rpc("update_setting", { p_key: key, p_value: change(structuredClone(row.value)), p_expected_version: row.version });
}

beforeAll(async () => {
  await resetLocalDatabase();
  const adminEmail = uniqueEmail("p5.admin");
  await createAuthUser(adminEmail, "P5 Admin");
  await sql("select private.bootstrap_first_admin($1)", [adminEmail]);
  admin = await signIn(adminEmail);
  await enrollAndVerifyMfa(admin);
  manager = await user(uniqueEmail("p5.mgr"), "manager", "Mona Manager");
  staff = await user(uniqueEmail("p5.staff"), "staff", "Sanjay Staff");
  cnc = (await sql<{ id: string }>("select id from public.work_categories where name = 'CNC Turning'"))[0]!.id;
}, 300_000);

afterAll(async () => {
  await closeSql();
});

// ---------------------------------------------------------------------------------------------------------------
describe("Example 2: commitment revision history", () => {
  let jobId = "";
  let assignment = { id: "", version: 0 };

  it("original 05-Nov, revised to 08-Nov: both dates are kept and the change is recorded", async () => {
    const v = await addVendor("Shree Engineering");
    const job = (await ok(manager.rpc("create_job", {
      p: { part_label: "4711 / Drive Shaft", qty_sent: 100, category_id: cnc,
           vendor: { vendor_id: v, dispatched_on: "2026-11-01", commitment_date: "2026-11-05", amount: 12500 } },
    }))) as Json;
    jobId = job.id as string;
    const a = (await ok(manager.from("job_assignments").select("id, version").eq("job_id", jobId).single())) as Json;
    assignment = { id: a.id as string, version: a.version as number };

    const res = (await ok(manager.rpc("revise_commitment", {
      p_assignment_id: assignment.id, p_expected_version: assignment.version, p_new_date: "2026-11-08",
      p_requested_by: "vendor", p_reason: "Vendor: CNC machine breakdown",
    }))) as Json;
    assignment.version = res.assignment.version as number;
    expect(res.assignment.original_commitment_date).toBe("2026-11-05");
    expect(res.assignment.current_commitment_date).toBe("2026-11-08");
    expect(res.revision).toMatchObject({
      revision_no: 1, original_date: "2026-11-05", previous_date: "2026-11-05", new_date: "2026-11-08",
      changed_on: istDate(0), requested_by: "vendor", reason: "Vendor: CNC machine breakdown",
    });

    const reg = (await ok(manager.from("job_register").select("*").eq("id", jobId).single())) as Json;
    expect(reg.original_commitment_date).toBe("2026-11-05");
    expect(reg.current_commitment_date).toBe("2026-11-08");
    expect(reg.revision_count).toBe(1);
  });

  it("every further revision is a new numbered entry; previous dates are never overwritten", async () => {
    const res = (await ok(manager.rpc("revise_commitment", {
      p_assignment_id: assignment.id, p_expected_version: assignment.version, p_new_date: "2026-11-10",
      p_requested_by: "cess", p_reason: "Drawing revision sent late by CESS",
    }))) as Json;
    assignment.version = res.assignment.version as number;
    const history = (await ok(manager.from("commitment_history").select("*").eq("job_id", jobId).order("revision_no"))) as Json[];
    expect(history.map((h) => [h.revision_no, h.original_date, h.previous_date, h.new_date, h.requested_by, h.days_from_original])).toEqual([
      [1, "2026-11-05", "2026-11-05", "2026-11-08", "vendor", 3],
      [2, "2026-11-05", "2026-11-08", "2026-11-10", "cess", 5],
    ]);
    expect(history[0]!.changed_by_name).toBe("Mona Manager");
    const activity = (await ok(manager.rpc("job_activity", { p_job_id: jobId }))) as Json[];
    const revised = activity.filter((e) => e.action === "job.commitment_revised");
    expect(revised).toHaveLength(2);
    expect(revised[0]!.previous_value).toEqual({ current_commitment_date: "2026-11-05" });
    expect(revised[0]!.new_value).toEqual({ current_commitment_date: "2026-11-08" });
    expect(revised[0]!.reason).toBe("Vendor: CNC machine breakdown (requested by vendor)");
  });

  it("invalid revisions are rejected with clear messages", async () => {
    const base = { p_assignment_id: assignment.id, p_expected_version: assignment.version, p_requested_by: "vendor", p_reason: "test" };
    const same = await manager.rpc("revise_commitment", { ...base, p_new_date: "2026-11-10" });
    expect(same.error?.message).toMatch(/same as the current/);
    const early = await manager.rpc("revise_commitment", { ...base, p_new_date: "2026-10-30" });
    expect(early.error?.message).toMatch(/before the date given/);
    const noReason = await manager.rpc("revise_commitment", { ...base, p_new_date: "2026-11-12", p_reason: " " });
    expect(noReason.error?.code).toBe("22023");
    const who = await manager.rpc("revise_commitment", { ...base, p_new_date: "2026-11-12", p_requested_by: "someone" });
    expect(who.error?.message).toMatch(/vendor or CESS/);
    const stale = await manager.rpc("revise_commitment", { ...base, p_expected_version: assignment.version - 1, p_new_date: "2026-11-12" });
    expect(stale.error?.code).toBe("PT409");
  });

  it("Staff cannot revise; nobody can rewrite or delete history, not even the database owner", async () => {
    const s = await staff.rpc("revise_commitment", {
      p_assignment_id: assignment.id, p_expected_version: assignment.version, p_new_date: "2026-11-12", p_requested_by: "vendor", p_reason: "x y z",
    });
    expect(s.error?.code).toBe("42501");
    await expect(sql("update public.commitment_revisions set new_date = '2026-11-06' where job_id = $1", [jobId])).rejects.toThrow(/append-only/);
    await expect(sql("delete from public.commitment_revisions where job_id = $1", [jobId])).rejects.toThrow(/append-only/);
    await expect(sql("update public.job_assignments set current_commitment_date = '2026-11-20' where id = $1", [assignment.id])).rejects.toThrow(/commitment revision/);
    await expect(sql("update public.job_assignments set original_commitment_date = '2026-11-20' where id = $1", [assignment.id])).rejects.toThrow(/never be changed/);
    const direct = await manager.from("commitment_revisions").insert({
      assignment_id: assignment.id, job_id: jobId, vendor_id: vendor["Shree Engineering"], revision_no: 9,
      original_date: "2026-11-05", previous_date: "2026-11-10", new_date: "2026-11-30", changed_on: istDate(0), requested_by: "cess", reason: "sneaky",
    });
    expect(direct.error).not.toBeNull();
  });

  it("a job without a recorded commitment cannot be revised (the first date becomes the original)", async () => {
    const job = (await ok(manager.rpc("create_job", {
      p: { part_label: "P-55 / Bush", category_id: cnc, vendor: { vendor_id: vendor["Shree Engineering"], dispatched_on: istDate(0) } },
    }))) as Json;
    const a = (await ok(manager.from("job_assignments").select("id, version").eq("job_id", job.id).single())) as Json;
    const res = await manager.rpc("revise_commitment", {
      p_assignment_id: a.id, p_expected_version: a.version, p_new_date: istDate(5), p_requested_by: "vendor", p_reason: "no date yet",
    });
    expect(res.error?.message).toMatch(/No committed date is recorded yet/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("Example 7: vendor reliability score from eligible records only, with sample sizes", () => {
  const D = "2026-08-01";
  let relA = "";
  let relB = "";

  async function assignment(job: string, vendorId: string, a: { commit?: string | null; current?: string | null; state: string; completed?: string; cancelled?: string; code?: string; dispatched?: string }) {
    const jobId = (await sql<{ id: string }>("insert into public.jobs (job_no, part_label, category_id) values ($1, $2, $3) returning id", [job, `${job} / Part`, cnc]))[0]!.id;
    const commit = a.commit === undefined ? addDays(a.dispatched ?? D, 4) : a.commit;
    const id = (await sql<{ id: string }>(
      `insert into public.job_assignments (job_id, sequence_no, vendor_id, dispatched_on, original_commitment_date, current_commitment_date,
         state, completed_on, cancelled_on, cancel_reason_code, cancel_reason_text)
       values ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
      [jobId, vendorId, a.dispatched ?? D, commit, a.current === undefined ? commit : a.current, a.state, a.completed ?? null,
       a.cancelled ?? null, a.code ?? null, a.code ? "recorded in test" : null],
    ))[0]!.id;
    return { jobId, id };
  }
  async function revision(asg: { jobId: string; id: string }, vendorId: string, no: number, prev: string, next: string, by: "vendor" | "cess") {
    await sql(
      `insert into public.commitment_revisions (assignment_id, job_id, vendor_id, revision_no, original_date, previous_date, new_date, changed_on, requested_by, reason)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'test history')`,
      [asg.id, asg.jobId, vendorId, no, addDays(D, 4), prev, next, D, by],
    );
  }

  beforeAll(async () => {
    relA = await addVendor("Reliable A");
    relB = await addVendor("Newcomer B");
    // Vendor A: 6 completed (2 late by 4 and 6 days), 1 vendor-caused cancellation, 1 customer cancellation, 1 open overdue
    for (const [n, days] of [[1, 4], [2, 3], [3, 4], [4, 4]] as const) {
      await assignment(`REL-A${n}`, relA, { state: "completed", completed: addDays(D, days) });
    }
    const late1 = await assignment("REL-A5", relA, { state: "completed", completed: addDays(D, 8), current: addDays(D, 7) });
    await revision(late1, relA, 1, addDays(D, 4), addDays(D, 6), "vendor");
    await revision(late1, relA, 2, addDays(D, 6), addDays(D, 7), "vendor");
    const late2 = await assignment("REL-A6", relA, { state: "completed", completed: addDays(D, 10), current: addDays(D, 9) });
    await revision(late2, relA, 1, addDays(D, 4), addDays(D, 5), "vendor");
    await revision(late2, relA, 2, addDays(D, 5), addDays(D, 9), "cess"); // CESS-requested: not held against the vendor
    await assignment("REL-A7", relA, { state: "cancelled", cancelled: addDays(D, 6), code: "vendor_missed_commitment" });
    await assignment("REL-A8", relA, { state: "cancelled", cancelled: addDays(D, 1), code: "customer_cancelled" });
    await assignment("REL-A9", relA, { state: "open", dispatched: "2026-10-01" });
    // Vendor B: only 3 completed jobs (one without a committed date)
    await assignment("REL-B1", relB, { state: "completed", completed: addDays(D, 2), commit: addDays(D, 3) });
    await assignment("REL-B2", relB, { state: "completed", completed: addDays(D, 2), commit: addDays(D, 3) });
    await assignment("REL-B3", relB, { state: "completed", completed: addDays(D, 5), commit: null });
  });

  it("calculates every factor from eligible jobs only and renormalises the missing quality factor", async () => {
    const res = (await ok(manager.rpc("vendor_reliability", { p: { fy: "2026-27", category_id: cnc } }))) as Json;
    const a = (res.rows as Json[]).find((r) => r.vendor_id === relA)!;
    const f = Object.fromEntries((a.factors as Json[]).map((x) => [x.key, x]));
    // category median days (CNC Turning, 9 completed jobs, 2 vendors): 2,2,3,4,4,4,5,8,10 -> 4
    expect(f.on_time).toMatchObject({ score: 66.7, jobs: 6, used: true, weight: 30 });           // 4 of 6 on/before original date
    expect(f.delay).toMatchObject({ score: 64.3, jobs: 6, used: true });                          // avg 5 days late, cap 14
    expect(f.stability).toMatchObject({ score: 75, jobs: 6, used: true });                        // 3 vendor revisions / 6 jobs / 2
    expect(f.completion_time).toMatchObject({ score: 72.7, jobs: 6, used: true });               // 24 expected / 33 taken
    expect(f.vendor_cancellation).toMatchObject({ score: 85.7, jobs: 7, used: true });           // 1 of 7
    expect(f.quality).toMatchObject({ score: null, jobs: 0, used: false, weight: 25 });
    // (30*66.667 + 15*64.286 + 10*75 + 10*72.727 + 10*85.714) / 75 = 70.6
    expect(a.score).toBe(70.6);
    expect(a.label).toBe("Good");
    expect(a.status).toBe("scored");
    expect(a.rank).toBe(1);
    expect(a.eligible_jobs).toBe(7);
    expect(a.weight_used).toBe(75);
    expect(a.factors_used).toBe(5);
    expect(a.counts).toMatchObject({ completed: 6, vendor_cancelled: 1, other_cancelled: 1, open: 1, overdue_now: 1, on_time: 4, late: 2 });
    expect(a.measures).toMatchObject({
      on_time_pct: 66.7, avg_delay_when_late: 5, avg_delay_when_late_vs_latest: 1, total_delay_days: 10,
      revisions: 4, revisions_vendor: 3, revised_jobs: 2, max_revisions_one_job: 2, frequent_reviser: true, overdue_now_pct: 100,
    });
    expect(a.cancel_reasons).toEqual([
      { code: "vendor_missed_commitment", label: "Vendor failed to meet delivery commitment", vendor_caused: true, count: 1 },
      { code: "customer_cancelled", label: "Customer cancelled the requirement", vendor_caused: false, count: 1 },
    ]);
  });

  it("shows no score when the sample is too small, but still shows the sample size", async () => {
    const res = (await ok(manager.rpc("vendor_reliability", { p: { fy: "2026-27" } }))) as Json;
    const b = (res.rows as Json[]).find((r) => r.vendor_id === relB)!;
    expect(b).toMatchObject({ score: null, label: null, status: "insufficient_jobs", eligible_jobs: 3, min_eligible_jobs: 5, rank: null });
    expect(b.counts.completed_no_commitment).toBe(1);
    const onTime = (b.factors as Json[]).find((x) => x.key === "on_time")!;
    expect(onTime.jobs).toBe(2); // the job without a committed date is left out of on-time
  });

  it("lists every job with its bucket and the factors it was used in (transparency)", async () => {
    const jobs = (await ok(manager.rpc("vendor_reliability_jobs", { p_vendor_id: relA, p: { fy: "2026-27" } }))) as Json[];
    const byNo = Object.fromEntries(jobs.map((j) => [j.job_no, j]));
    expect(byNo["REL-A1"]!.used_in).toEqual(["on_time", "delay", "stability", "completion_time", "vendor_cancellation"]);
    expect(byNo["REL-A7"]!).toMatchObject({ bucket: "vendor_cancelled", used_in: ["vendor_cancellation"] });
    expect(byNo["REL-A8"]!).toMatchObject({ bucket: "other_cancelled", used_in: [], excluded_because: "Cancelled for a reason not caused by the vendor" });
    expect(byNo["REL-A9"]!).toMatchObject({ bucket: "open", used_in: [], overdue_now: true });
    expect(byNo["REL-A5"]!).toMatchObject({ late_days: 4, late_days_current: 1, revisions: 2, vendor_revisions: 2 });
  });

  it("filters by financial year and category", async () => {
    const other = (await ok(manager.rpc("vendor_reliability", { p: { fy: "2025-26" } }))) as Json;
    expect((other.rows as Json[]).some((r) => r.vendor_id === relA)).toBe(false);
    const grinding = (await sql<{ id: string }>("select id from public.work_categories where name = 'Grinding'"))[0]!.id;
    const g = (await ok(manager.rpc("vendor_reliability", { p: { category_id: grinding } }))) as Json;
    expect(g.rows).toEqual([]);
    const bad = await manager.rpc("vendor_reliability", { p: { fy: "2026-28" } });
    expect(bad.error?.code).toBe("22023");
  });

  it("uses the weights and minimum sample from Settings", async () => {
    expect((await setSetting("reliability", (v) => ({ ...v, min_eligible_jobs: 3 }))).error).toBeNull();
    let res = (await ok(manager.rpc("vendor_reliability", { p: { fy: "2026-27" } }))) as Json;
    const b = (res.rows as Json[]).find((r) => r.vendor_id === relB)!;
    expect(b).toMatchObject({ status: "scored", score: 100, label: "Excellent", rank: 1 });
    const weights = { on_time: 50, quality: 0, delay: 20, stability: 10, completion_time: 10, vendor_cancellation: 10 };
    expect((await setSetting("reliability", (v) => ({ ...v, weights }))).error).toBeNull();
    res = (await ok(manager.rpc("vendor_reliability", { p: { fy: "2026-27" } }))) as Json;
    const a = (res.rows as Json[]).find((r) => r.vendor_id === relA)!;
    // (50*66.667 + 20*64.286 + 10*75 + 10*72.727 + 10*85.714) / 100
    expect(a.score).toBe(69.5);
    expect(a.label).toBe("Average");
    expect(a.weight_used).toBe(100);
    const bad = await setSetting("reliability", (v) => ({ ...v, weights: { ...weights, on_time: 55 } }));
    expect(bad.error?.message).toMatch(/exactly 100/);
    // restore the approved Option 1 weights and the default minimum sample for the rest of the tests
    expect((await setSetting("reliability", (v) => ({ ...v, min_eligible_jobs: 5, weights: { on_time: 30, quality: 25, delay: 15, stability: 10, completion_time: 10, vendor_cancellation: 10 } }))).error).toBeNull();
  });

  it("Staff cannot see reliability scores (server-side check)", async () => {
    const res = await staff.rpc("vendor_reliability", { p: {} });
    expect(res.error?.code).toBe("42501");
    const jobs = await staff.rpc("vendor_reliability_jobs", { p_vendor_id: relA, p: {} });
    expect(jobs.error?.code).toBe("42501");
    const internal = await manager.rpc("reliability_scores", {});
    expect(internal.error).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("Example 6: vendor cost comparison", () => {
  let request: Json = {};
  const quote: Record<string, Json> = {};

  async function comparison(id: string): Promise<Json> {
    return (await ok(manager.rpc("quotation_comparison", { p_request_id: id }))) as Json;
  }

  it("three vendors quote different prices: lowest, highest, average and % difference", async () => {
    for (const n of ["Alpha Turners", "Beta CNC", "Gamma Machining"]) await addVendor(n);
    request = (await ok(manager.rpc("save_quotation_request", {
      p_request_id: null, p_expected_version: null, p: { part_label: "4711 / Drive Shaft", category_id: cnc, qty: 100, required_by: istDate(30) },
    }))) as Json;
    expect(request.request_no).toMatch(/^QR-\d{4}-0001$/);
    const add = async (name: string, basis: string, price: number, days: number | null) => {
      quote[name] = (await ok(manager.rpc("save_quotation", {
        p_quotation_id: null, p_expected_version: null, p_request_id: request.id,
        p: { vendor_id: vendor[name], quote_date: istDate(0), basis, price, delivery_days: days },
      }))) as Json;
    };
    await add("Alpha Turners", "total", 10000, 10);
    await add("Beta CNC", "per_part", 120, 5);
    await add("Gamma Machining", "total", 15500, 7);

    const c = await comparison(request.id as string);
    expect(c.stats).toMatchObject({ count: 3, lowest: 10000, highest: 15500, average: 12500, spread: 5500, spread_pct: 55,
                                    lowest_per_part: 100, highest_per_part: 155, average_per_part: 125 });
    const rows = (c.quotes as Json[]).map((q) => [q.vendor_name, q.total, q.per_part, q.diff_vs_lowest, q.diff_vs_lowest_pct, q.diff_vs_average_pct]);
    expect(rows).toEqual([
      ["Alpha Turners", 10000, 100, 0, 0, -20],
      ["Beta CNC", 12000, 120, 2000, 20, -4],
      ["Gamma Machining", 15500, 155, 5500, 55, 24],
    ]);
  });

  it("does not recommend the cheapest blindly; leaves out factors not known for every vendor", async () => {
    const c = await comparison(request.id as string);
    const rec = c.recommendation as Json;
    expect(rec.available).toBe(true);
    expect(rec.quotation_id).toBe(quote["Beta CNC"]!.id); // 12,000 in 5 days beats 10,000 in 10 days
    expect(rec.weights_used).toEqual({ price: 69.2, reliability: 0, delivery: 30.8 });
    expect(rec.left_out[0]).toMatch(/Reliability: no score yet for Alpha Turners, Beta CNC, Gamma Machining/);
    const alpha = (c.quotes as Json[]).find((q) => q.vendor_name === "Alpha Turners")!;
    expect(alpha).toMatchObject({ is_lowest: true, price_score: 100, delivery_score: 50, value_score: 84.6 });
  });

  it("uses reliability when every quoted vendor has a score", async () => {
    expect((await setSetting("reliability", (v) => ({ ...v, min_eligible_jobs: 3 }))).error).toBeNull();
    const r2 = (await ok(manager.rpc("save_quotation_request", {
      p_request_id: null, p_expected_version: null, p: { part_label: "8800 / Flange", category_id: cnc, qty: 50 },
    }))) as Json;
    for (const [name, price] of [["Reliable A", 9000], ["Newcomer B", 10000]] as const) {
      await ok(manager.rpc("save_quotation", {
        p_quotation_id: null, p_expected_version: null, p_request_id: r2.id,
        p: { vendor_id: vendor[name], quote_date: istDate(0), basis: "total", price, delivery_days: 7 },
      }));
    }
    const c = await comparison(r2.id as string);
    const byName = Object.fromEntries((c.quotes as Json[]).map((q) => [q.vendor_name, q]));
    expect(byName["Reliable A"]!.reliability).toMatchObject({ score: 70.6, label: "Good", basis: "category" });
    expect(byName["Newcomer B"]!.reliability).toMatchObject({ score: 100, label: "Excellent" });
    expect(c.recommendation.weights_used).toEqual({ price: 45, reliability: 35, delivery: 20 });
    expect(c.recommendation.left_out).toEqual([]);
    // A: (45*100 + 35*70.6 + 20*100)/100 = 89.7 ; B: (45*90 + 35*100 + 20*100)/100 = 95.5 -> B, although 1,000 dearer
    expect(byName["Reliable A"]!.value_score).toBe(89.7);
    expect(byName["Newcomer B"]!.value_score).toBe(95.5);
    expect(c.recommendation.quotation_id).toBe(byName["Newcomer B"]!.id);
    expect((await setSetting("reliability", (v) => ({ ...v, min_eligible_jobs: 5 }))).error).toBeNull();
  });

  it("one live quote per vendor; withdrawing needs a reason and keeps the record", async () => {
    const dup = await manager.rpc("save_quotation", {
      p_quotation_id: null, p_expected_version: null, p_request_id: request.id,
      p: { vendor_id: vendor["Gamma Machining"], quote_date: istDate(0), basis: "total", price: 15000 },
    });
    expect(dup.error?.message).toMatch(/already has a quotation/);
    const noReason = await manager.rpc("withdraw_quotation", { p_quotation_id: quote["Gamma Machining"]!.id, p_expected_version: quote["Gamma Machining"]!.version, p_reason: "" });
    expect(noReason.error?.code).toBe("22023");
    await ok(manager.rpc("withdraw_quotation", { p_quotation_id: quote["Gamma Machining"]!.id, p_expected_version: quote["Gamma Machining"]!.version, p_reason: "Vendor revised the offer" }));
    quote["Gamma Machining"] = (await ok(manager.rpc("save_quotation", {
      p_quotation_id: null, p_expected_version: null, p_request_id: request.id,
      p: { vendor_id: vendor["Gamma Machining"], quote_date: istDate(0), basis: "per_part", price: 140, delivery_days: 7, remarks: "Revised offer" },
    }))) as Json;
    const c = await comparison(request.id as string);
    expect(c.stats).toMatchObject({ count: 3, highest: 14000 });
    expect((c.withdrawn as Json[]).map((w) => w.withdrawn_reason)).toEqual(["Vendor revised the offer"]);
    const rows = await sql<{ n: string }>("select count(*)::text as n from public.vendor_quotations where request_id = $1", [request.id]);
    expect(rows[0]!.n).toBe("4");
  });

  it("the person chooses: a different vendor from the recommendation needs a reason", async () => {
    const r = (await ok(manager.from("quotation_requests").select("version").eq("id", request.id).single())) as Json;
    const noReason = await manager.rpc("select_quotation", { p_request_id: request.id, p_expected_version: r.version, p_quotation_id: quote["Alpha Turners"]!.id, p_reason: "" });
    expect(noReason.error?.message).toMatch(/give the reason/);
    const chosen = (await ok(manager.rpc("select_quotation", {
      p_request_id: request.id, p_expected_version: r.version, p_quotation_id: quote["Alpha Turners"]!.id, p_reason: "Lowest price; delivery date is not urgent",
    }))) as Json;
    expect(chosen).toMatchObject({ status: "decided", selected_quotation_id: quote["Alpha Turners"]!.id, recommended_quotation_id: quote["Beta CNC"]!.id });
    request = chosen;
    // nothing was assigned automatically
    const jobs = await sql<{ n: string }>("select count(*)::text as n from public.jobs where part_label = '4711 / Drive Shaft'");
    expect(jobs[0]!.n).toBe("1"); // only the job created in Example 2
    const locked = await manager.rpc("save_quotation", {
      p_quotation_id: quote["Beta CNC"]!.id, p_expected_version: quote["Beta CNC"]!.version, p_request_id: null,
      p: { vendor_id: vendor["Beta CNC"], quote_date: istDate(0), basis: "per_part", price: 90 },
    });
    expect(locked.error?.message).toMatch(/only while the request is open/);
  });

  it("creates the job for the chosen vendor only after confirmation, with the quoted amount", async () => {
    const res = (await ok(manager.rpc("create_job_from_quotation", {
      p_request_id: request.id, p_expected_version: request.version,
      p: { dispatched_on: istDate(0), commitment_date: istDate(10) },
    }))) as Json;
    const reg = (await ok(manager.from("job_register").select("*").eq("id", res.id).single())) as Json;
    expect(reg).toMatchObject({ part_label: "4711 / Drive Shaft", vendor_name: "Alpha Turners", qty_sent: 100, amount: 10000,
                                original_commitment_date: istDate(10), status: "Sent to Vendor" });
    expect(res.request).toMatchObject({ status: "job_created", job_id: res.id });
    const activity = (await ok(manager.rpc("job_activity", { p_job_id: res.id }))) as Json[];
    expect(activity.map((e) => e.action)).toEqual(expect.arrayContaining(["job.created", "job.sent_to_vendor", "quotation.job_created"]));
    const again = await manager.rpc("create_job_from_quotation", { p_request_id: request.id, p_expected_version: res.request.version, p: { dispatched_on: istDate(0) } });
    expect(again.error?.message).toMatch(/Select the vendor first/);
  });

  it("price history shows what was paid and quoted for the part, per vendor", async () => {
    const h = (await ok(manager.rpc("price_history", { p_query: "4711", p_category_id: null }))) as Json;
    expect((h.jobs as Json[]).map((j) => [j.vendor_name, j.amount, j.per_part])).toEqual(
      expect.arrayContaining([["Alpha Turners", 10000, 100], ["Shree Engineering", 12500, 125]]),
    );
    expect((h.quotes as Json[]).filter((q) => q.selected).map((q) => q.vendor_name)).toEqual(["Alpha Turners"]);
    const c = await comparison(request.id as string);
    expect((c.history.part as Json[]).length).toBe(2);
  });

  it("recommendation weights are editable but never price-only", async () => {
    const bad = await setSetting("cost_comparison", (v) => ({ ...v, weights: { price: 100, reliability: 0, delivery: 0 } }));
    expect(bad.error?.message).toMatch(/price alone/);
    const good = await setSetting("cost_comparison", (v) => ({ ...v, weights: { price: 50, reliability: 30, delivery: 20 } }));
    expect(good.error).toBeNull();
  });

  it("Staff cannot see or change quotations (server-side check)", async () => {
    expect((await staff.rpc("quotation_comparison", { p_request_id: request.id })).error?.code).toBe("42501");
    expect((await staff.rpc("quotation_requests_list", { p_status: null })).error?.code).toBe("42501");
    expect((await staff.rpc("price_history", { p_query: "4711", p_category_id: null })).error?.code).toBe("42501");
    const create = await staff.rpc("save_quotation_request", { p_request_id: null, p_expected_version: null, p: { part_label: "X", category_id: cnc, qty: 1 } });
    expect(create.error?.code).toBe("42501");
    const { data } = await staff.from("vendor_quotations").select("id");
    expect(data).toEqual([]);
    const write = await manager.from("vendor_quotations").update({ price: 1 }).eq("id", quote["Alpha Turners"]!.id).select();
    expect(write.error ?? write.data).toBeTruthy();
    const unchanged = await sql<{ price: string }>("select price::text from public.vendor_quotations where id = $1", [quote["Alpha Turners"]!.id]);
    expect(unchanged[0]!.price).toBe("10000.00");
  });
});
