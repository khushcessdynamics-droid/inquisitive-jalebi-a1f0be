// The Jobs Register works out quantities inside its own query (migration 20261103001000, for speed). This test keeps it
// identical to private.assignment_quantities(), the function the business rules use, across the awkward cases: no vendor yet,
// no quantity, partial returns, voided returns and inspections, rework, a cancelled and forwarded job, a closed job.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { closeSql, createAuthUser, enrollAndVerifyMfa, resetLocalDatabase, signIn, sql, uniqueEmail } from "../helpers/clients";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let manager: SupabaseClient;
let staff: SupabaseClient;

function istDate(offset = 0): string {
  return new Date(Date.now() + 330 * 60_000 + offset * 86_400_000).toISOString().slice(0, 10);
}
async function ok<T>(p: PromiseLike<{ data: T; error: { message: string; code?: string } | null }>): Promise<NonNullable<T>> {
  const { data, error } = await p;
  if (error) throw new Error(`${error.code}: ${error.message}`);
  return data as NonNullable<T>;
}

beforeAll(async () => {
  await resetLocalDatabase();
  const mEmail = uniqueEmail("rc.mgr");
  const mid = await createAuthUser(mEmail, "Register Manager");
  await sql("update public.profiles set role_key = 'manager', is_active = true where id = $1", [mid]);
  manager = await signIn(mEmail);
  await enrollAndVerifyMfa(manager);
  const sEmail = uniqueEmail("rc.staff");
  const sid = await createAuthUser(sEmail, "Register Staff");
  await sql("update public.profiles set role_key = 'staff', is_active = true where id = $1", [sid]);
  staff = await signIn(sEmail);

  const cnc = (await sql<{ id: string }>("select id from public.work_categories where name = 'CNC Turning'"))[0]!.id;
  const vendor = async (name: string) => ((await ok(manager.rpc("save_vendor", { p_vendor_id: null, p_expected_version: null, p: { name, category_ids: [cnc] } }))) as Json).id as string;
  const vA = await vendor("Consistency A");
  const vB = await vendor("Consistency B");
  const job = async (part: string, qty: number | null, withVendor = true, staffId: string | null = null) => {
    const j = (await ok(manager.rpc("create_job", {
      p: { part_label: part, qty_sent: qty, category_id: cnc, assigned_staff_id: staffId,
           ...(withVendor ? { vendor: { vendor_id: vA, dispatched_on: istDate(-10), commitment_date: istDate(-2), amount: 5000 } } : {}) },
    }))) as Json;
    const a = withVendor ? ((await ok(manager.from("job_assignments").select("id, version").eq("job_id", j.id).single())) as Json) : null;
    return { id: j.id as string, a };
  };
  await job("RC-draft / no vendor", 50, false);
  await job("RC-noqty / no quantity", null);
  const partial = await job("RC-partial / 60 of 100", 100, true, sid);
  const r1 = (await ok(manager.rpc("record_return", { p_assignment_id: partial.a!.id, p: { returned_on: istDate(-5), qty_received: 60 } }))) as Json;
  await ok(manager.rpc("record_inspection", { p_return_id: r1.return.id, p: { inspected_on: istDate(-4), qty_accepted: 50, qty_rejected: 4, qty_rework: 6 } }));
  const voided = await job("RC-voided / wrong return", 40);
  const wrong = (await ok(manager.rpc("record_return", { p_assignment_id: voided.a!.id, p: { returned_on: istDate(-5), qty_received: 30 } }))) as Json;
  const insp = (await ok(manager.rpc("record_inspection", { p_return_id: wrong.return.id, p: { inspected_on: istDate(-4), qty_accepted: 30 } }))) as Json;
  await ok(manager.rpc("void_inspection", { p_inspection_id: (insp.inspection ?? insp).id, p_reason: "Counted twice" }));
  await ok(manager.rpc("void_return", { p_return_id: wrong.return.id, p_reason: "Wrong job" }));
  await ok(manager.rpc("record_return", { p_assignment_id: voided.a!.id, p: { returned_on: istDate(-3), qty_received: 15 } }));
  const forwarded = await job("RC-forward / cancelled then B", 20);
  await ok(manager.rpc("record_return", { p_assignment_id: forwarded.a!.id, p: { returned_on: istDate(-6), qty_received: 5 } }));
  const fa = (await ok(manager.from("job_assignments").select("id, version").eq("id", forwarded.a!.id).single())) as Json;
  await ok(manager.rpc("cancel_assignment", {
    p_assignment_id: fa.id, p_expected_version: fa.version, p_cancelled_on: istDate(-1), p_reason_code: "vendor_missed_commitment", p_reason_text: "Late",
    p_forward: { vendor_id: vB, dispatched_on: istDate(-1), commitment_date: istDate(4), amount: 3000 },
  }));
  const done = await job("RC-complete / all back", 10);
  await ok(manager.rpc("record_return", { p_assignment_id: done.a!.id, p: { returned_on: istDate(-1), qty_received: 10, inspection: { inspected_on: istDate(-1), qty_accepted: 10 } } }));
}, 300_000);

afterAll(async () => {
  await closeSql();
});

describe("Jobs Register quantities", () => {
  it("equal the business-rule function for every job (Manager's view)", async () => {
    const rows = (await ok(manager.from("job_register").select("id, part_label, assignment_id, qty_received, qty_accepted, qty_rejected, qty_rework, qty_awaiting_inspection, qty_with_vendor"))) as Json[];
    expect(rows).toHaveLength(6);
    for (const r of rows) {
      const f = r.assignment_id
        ? (await sql<Json>("select received, accepted, rejected, rework, awaiting, with_vendor from private.assignment_quantities($1)", [r.assignment_id]))[0]!
        : { received: null, accepted: null, rejected: null, rework: null, awaiting: null, with_vendor: null };
      expect(
        { received: r.qty_received, accepted: r.qty_accepted, rejected: r.qty_rejected, rework: r.qty_rework, awaiting: r.qty_awaiting_inspection, with_vendor: r.qty_with_vendor },
        r.part_label,
      ).toEqual(f);
    }
    const byPart = Object.fromEntries(rows.map((r) => [r.part_label, r]));
    expect(byPart["RC-partial / 60 of 100"]).toMatchObject({ qty_received: 60, qty_accepted: 50, qty_rejected: 4, qty_rework: 6, qty_with_vendor: 46 });
    expect(byPart["RC-voided / wrong return"]).toMatchObject({ qty_received: 15, qty_accepted: 0, qty_awaiting_inspection: 15, qty_with_vendor: 25 });
    expect(byPart["RC-draft / no vendor"]!.qty_received).toBeNull();
    expect(byPart["RC-noqty / no quantity"]!.qty_with_vendor).toBeNull();
  });

  it("Staff see the same quantities on the jobs assigned to them", async () => {
    const mine = (await ok(staff.from("job_register").select("part_label, qty_received, qty_with_vendor, qty_rework"))) as Json[];
    expect(mine).toEqual([{ part_label: "RC-partial / 60 of 100", qty_received: 60, qty_with_vendor: 46, qty_rework: 6 }]);
  });
});
