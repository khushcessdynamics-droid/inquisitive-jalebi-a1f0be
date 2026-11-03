// Phase 6 business rules through the real API (local Supabase): partial returns (Example 3), quality inspection
// (Example 4), completion rules, voiding and reopening, vendor payments (Example 5) and payment permissions (Example 10).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { closeSql, createAuthUser, enrollAndVerifyMfa, resetLocalDatabase, signIn, sql, uniqueEmail } from "../helpers/clients";

let admin: SupabaseClient;
let manager: SupabaseClient;
let staff: SupabaseClient;
let cnc = "";
let vendorId = "";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function istDate(offsetDays = 0): string {
  return new Date(Date.now() + 330 * 60_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
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

async function newJob(part: string, qty: number | null, opts: { dispatched?: string; commit?: string; amount?: number } = {}) {
  const job = (await ok(manager.rpc("create_job", {
    p: { part_label: part, qty_sent: qty, category_id: cnc,
         vendor: { vendor_id: vendorId, dispatched_on: opts.dispatched ?? istDate(-10), commitment_date: opts.commit ?? istDate(5), amount: opts.amount ?? null } },
  }))) as Json;
  const a = (await ok(manager.from("job_assignments").select("id, version").eq("job_id", job.id).single())) as Json;
  return { jobId: job.id as string, assignmentId: a.id as string };
}
async function reg(jobId: string) {
  return (await ok(manager.from("job_register").select("*").eq("id", jobId).single())) as Json;
}
async function lots(jobId: string) {
  return (await ok(manager.from("material_return_lots").select("*").eq("job_id", jobId).order("return_no"))) as Json[];
}

beforeAll(async () => {
  await resetLocalDatabase();
  const adminEmail = uniqueEmail("p6.admin");
  await createAuthUser(adminEmail, "P6 Admin");
  await sql("select private.bootstrap_first_admin($1)", [adminEmail]);
  admin = await signIn(adminEmail);
  await enrollAndVerifyMfa(admin);
  manager = await user(uniqueEmail("p6.mgr"), "manager", "Mona Manager");
  staff = await user(uniqueEmail("p6.staff"), "staff", "Sanjay Staff");
  cnc = (await sql<{ id: string }>("select id from public.work_categories where name = 'CNC Turning'"))[0]!.id;
  vendorId = ((await ok(manager.rpc("save_vendor", { p_vendor_id: null, p_expected_version: null, p: { name: "Shree Engineering", category_ids: [cnc] } }))) as Json).id;
}, 300_000);

afterAll(async () => {
  await closeSql();
});

// ---------------------------------------------------------------------------------------------------------------
describe("Examples 3 and 4: partial return and quality inspection", () => {
  let job = { jobId: "", assignmentId: "" };
  let firstReturn = "";

  it("100 sent, 60 returned: 40 still with the vendor; not completed while awaiting inspection", async () => {
    job = await newJob("4711 / Drive Shaft", 100);
    const res = (await ok(manager.rpc("record_return", { p_assignment_id: job.assignmentId, p: { returned_on: istDate(-3), qty_received: 60, challan_no: "DC-101" } }))) as Json;
    firstReturn = res.return.id as string;
    expect(res.completed).toBe(false);
    expect(res.quantities).toMatchObject({ qty_sent: 100, received: 60, with_vendor: 40, awaiting: 60, accepted: 0 });
    const r = await reg(job.jobId);
    expect(r).toMatchObject({ qty_received: 60, qty_with_vendor: 40, qty_awaiting_inspection: 60, status: "Quality Inspection Pending", closed_at: null });
    expect((await lots(job.jobId))[0]).toMatchObject({ return_no: 1, qty_received: 60, qty_uninspected: 60, quality_status: "Inspection Pending", challan_no: "DC-101" });
  });

  it("55 accepted and 5 rejected are kept separately; the job is Partially Returned", async () => {
    const res = (await ok(manager.rpc("record_inspection", { p_return_id: firstReturn, p: { inspected_on: istDate(-2), qty_accepted: 55, qty_rejected: 5, inspector_name: "QC Ravi", remarks: "5 pcs undersize" } }))) as Json;
    expect(res.completed).toBe(false);
    expect(res.quantities).toMatchObject({ received: 60, accepted: 55, rejected: 5, rework: 0, awaiting: 0, with_vendor: 40 });
    const q = (await ok(manager.from("assignment_quantities").select("*").eq("assignment_id", job.assignmentId).single())) as Json;
    expect(q).toMatchObject({ accepted: 55, rejected: 5, acceptance_pct: 91.7, rejection_pct: 8.3 });
    expect((await lots(job.jobId))[0]).toMatchObject({ qty_accepted: 55, qty_rejected: 5, qty_uninspected: 0, quality_status: "Partially Accepted" });
    expect((await reg(job.jobId)).status).toBe("Partially Returned");
    const log = (await ok(manager.from("quality_inspection_log").select("*").eq("job_id", job.jobId))) as Json[];
    expect(log[0]).toMatchObject({ inspector_name: "QC Ravi", qty_inspected: 60, quality_status: "Partially Accepted", recorded_by_name: "Mona Manager" });
  });

  it("cannot receive more than is with the vendor, or inspect more than was returned", async () => {
    const over = await manager.rpc("record_return", { p_assignment_id: job.assignmentId, p: { returned_on: istDate(0), qty_received: 41 } });
    expect(over.error?.message).toMatch(/Only 40 pieces are with the vendor/);
    const future = await manager.rpc("record_return", { p_assignment_id: job.assignmentId, p: { returned_on: istDate(1), qty_received: 5 } });
    expect(future.error?.message).toMatch(/between the date given to the vendor and today/);
    const insp = await manager.rpc("record_inspection", { p_return_id: firstReturn, p: { inspected_on: istDate(0), qty_accepted: 1 } });
    expect(insp.error?.message).toMatch(/Only 0 pieces of this return/);
  });

  it("rework goes back to the vendor; the job completes only when every piece is back and inspected", async () => {
    const r2 = (await ok(manager.rpc("record_return", {
      p_assignment_id: job.assignmentId,
      p: { returned_on: istDate(-1), qty_received: 40, inspection: { inspected_on: istDate(-1), qty_accepted: 35, qty_rework: 5 } },
    }))) as Json;
    expect(r2.completed).toBe(false);
    expect(r2.quantities).toMatchObject({ received: 100, rework: 5, with_vendor: 5, awaiting: 0 });
    expect((await reg(job.jobId)).status).toBe("Partially Returned");
    const r3 = (await ok(manager.rpc("record_return", { p_assignment_id: job.assignmentId, p: { returned_on: istDate(0), qty_received: 5, remarks: "after rework" } }))) as Json;
    expect(r3.completed).toBe(false);
    expect((await reg(job.jobId)).status).toBe("Quality Inspection Pending"); // returned date entered, still not Completed
    const done = (await ok(manager.rpc("record_inspection", { p_return_id: r3.return.id, p: { inspected_on: istDate(0), qty_accepted: 5 } }))) as Json;
    expect(done.completed).toBe(true);
    const r = await reg(job.jobId);
    expect(r).toMatchObject({ status: "Completed", return_date: istDate(0), qty_accepted: 95, qty_rejected: 5, qty_with_vendor: 0 });
    expect(r.closed_reason).toBe("All 100 pieces returned and inspected: 95 accepted, 5 rejected.");
    const activity = (await ok(manager.rpc("job_activity", { p_job_id: job.jobId }))) as Json[];
    expect(activity.map((e) => e.action)).toEqual(expect.arrayContaining(["job.material_returned", "job.inspected", "job.vendor_work_completed", "job.completed"]));
  });

  it("the quality factor of the reliability score now uses inspected pieces (accepted / inspected)", async () => {
    const res = (await ok(manager.rpc("vendor_reliability", { p: {} }))) as Json;
    const row = (res.rows as Json[]).find((x) => x.vendor_id === vendorId)!;
    const quality = (row.factors as Json[]).find((f) => f.key === "quality")!;
    expect(quality).toMatchObject({ used: true, jobs: 1, score: 90.5 }); // 95 accepted of 105 inspected (rework counts as not accepted)
    expect(row.measures).toMatchObject({ quality_acceptance_pct: 90.5, rework_rejection_pct: 9.5, pieces_inspected: 105 });
  });

  it("history cannot be edited or deleted, not even by the database owner; a closed job needs Reopen", async () => {
    await expect(sql("update public.material_returns set qty_received = 70 where id = $1", [firstReturn])).rejects.toThrow(/cannot be edited/);
    await expect(sql("delete from public.quality_inspections where return_id = $1", [firstReturn])).rejects.toThrow(/not allowed/);
    const late = await manager.rpc("record_return", { p_assignment_id: job.assignmentId, p: { returned_on: istDate(0), qty_received: 1 } });
    expect(late.error?.message).toMatch(/not open/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("voiding, closing with a reason, reopening, unknown quantity, permissions", () => {
  it("a wrong return is voided with a reason (inspections first) and stays in the history", async () => {
    const job = await newJob("P-200 / Pin", 20);
    const r = (await ok(manager.rpc("record_return", { p_assignment_id: job.assignmentId, p: { returned_on: istDate(0), qty_received: 20, inspection: { inspected_on: istDate(0), qty_accepted: 19, qty_rejected: 1 } } }))) as Json;
    expect(r.completed).toBe(true); // 19 accepted + 1 rejected = 20: decided
    const reopen = (await ok(manager.rpc("reopen_job", { p_job_id: job.jobId, p_expected_version: (await reg(job.jobId)).version, p_reason: "Return was entered on the wrong job" }))) as Json;
    expect(reopen.closed_at).toBeNull();
    const blocked = await manager.rpc("void_return", { p_return_id: r.return.id, p_reason: "wrong job" });
    expect(blocked.error?.message).toMatch(/Void the inspections of this return first/);
    await ok(manager.rpc("void_inspection", { p_inspection_id: r.inspection.id, p_reason: "wrong job" }));
    await ok(manager.rpc("void_return", { p_return_id: r.return.id, p_reason: "wrong job" }));
    const reg2 = await reg(job.jobId);
    expect(reg2).toMatchObject({ qty_received: 0, qty_with_vendor: 20, closed_at: null });
    expect(reg2.status).not.toBe("Completed");
    const l = await lots(job.jobId);
    expect(l[0]).toMatchObject({ quality_status: "Voided", void_reason: "wrong job" });
    const activity = (await ok(manager.rpc("job_activity", { p_job_id: job.jobId }))) as Json[];
    expect(activity.map((e) => e.action)).toEqual(expect.arrayContaining(["job.reopened", "job.inspection_voided", "job.return_voided"]));
  });

  it("an authorised user closes a job that will not complete by itself, with a reason", async () => {
    const job = await newJob("P-300 / Bush", 50);
    await ok(manager.rpc("record_return", { p_assignment_id: job.assignmentId, p: { returned_on: istDate(-1), qty_received: 30 } }));
    let v = (await reg(job.jobId)).version as number;
    const early = await manager.rpc("close_job", { p_job_id: job.jobId, p_expected_version: v, p_reason: "Remaining 20 not required" });
    expect(early.error?.message).toMatch(/still awaiting inspection/);
    const lot = (await lots(job.jobId))[0]!;
    await ok(manager.rpc("record_inspection", { p_return_id: lot.id, p: { inspected_on: istDate(0), qty_accepted: 30 } }));
    const staffClose = await staff.rpc("close_job", { p_job_id: job.jobId, p_expected_version: v, p_reason: "x y z" });
    expect(staffClose.error?.code).toBe("42501");
    v = (await reg(job.jobId)).version as number;
    await ok(manager.rpc("close_job", { p_job_id: job.jobId, p_expected_version: v, p_reason: "Customer reduced the order to 30 pcs" }));
    expect(await reg(job.jobId)).toMatchObject({ status: "Completed", closed_reason: "Customer reduced the order to 30 pcs", return_date: istDate(-1), qty_with_vendor: 20 });
  });

  it("without a known quantity a job never completes by itself", async () => {
    const job = await newJob("P-400 / Washer", null);
    const r = (await ok(manager.rpc("record_return", { p_assignment_id: job.assignmentId, p: { returned_on: istDate(0), qty_received: 10, inspection: { inspected_on: istDate(0), qty_accepted: 10 } } }))) as Json;
    expect(r.completed).toBe(false);
    expect(await reg(job.jobId)).toMatchObject({ status: "Partially Returned", qty_with_vendor: null, qty_received: 10 });
    // the quantity can be filled in later, but never below what is already back
    const tooSmall = await manager.rpc("update_assignment", { p_assignment_id: job.assignmentId, p_expected_version: ((await ok(manager.from("job_assignments").select("version").eq("id", job.assignmentId).single())) as Json).version, p: { qty_sent: 5 } });
    expect(tooSmall.error?.message).toMatch(/cannot be less than the 10 pieces already returned/);
  });

  it("Staff cannot record returns or inspections by default (server-side check)", async () => {
    const job = await newJob("P-500 / Collar", 10);
    const r = await staff.rpc("record_return", { p_assignment_id: job.assignmentId, p: { returned_on: istDate(0), qty_received: 1 } });
    expect(r.error?.code).toBe("42501");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("Example 5 and Example 10: vendor payments", () => {
  let job = { jobId: "", assignmentId: "" };
  const paymentIds: string[] = [];

  async function account(client: SupabaseClient = manager) {
    return (await ok(client.from("payment_accounts").select("*").eq("assignment_id", job.assignmentId).maybeSingle())) as Json | null;
  }
  async function version() {
    return ((await ok(admin.from("job_assignments").select("version").eq("id", job.assignmentId).single())) as Json).version as number;
  }

  it("invoice ₹50,000; payments ₹20,000 + ₹15,000; balance ₹15,000", async () => {
    job = await newJob("7001 / Housing", 10, { amount: 48000 });
    await ok(admin.rpc("record_vendor_invoice", {
      p_assignment_id: job.assignmentId, p_expected_version: await version(),
      p: { invoice_no: "SE/245", invoice_date: istDate(0), amount: 50000 }, p_reason: "Invoice includes extra facing operation",
    }));
    expect(await account()).toMatchObject({ job_amount: 50000, invoice_no: "SE/245", total_payable: 50000, amount_paid: 0, balance: 50000, payment_status: "Unpaid" });
    const p1 = (await ok(admin.rpc("add_vendor_payment", { p_assignment_id: job.assignmentId, p: { kind: "advance", paid_on: istDate(-2), amount: 20000, mode: "bank_transfer", reference: "UTR123" } }))) as Json;
    expect(p1.payment_no).toMatch(/^PAY-\d{4}-0001$/);
    expect(await account()).toMatchObject({ advance_paid: 20000, amount_paid: 20000, balance: 30000, payment_status: "Advance Paid" });
    const p2 = (await ok(admin.rpc("add_vendor_payment", { p_assignment_id: job.assignmentId, p: { kind: "payment", paid_on: istDate(0), amount: 15000, mode: "upi" } }))) as Json;
    paymentIds.push(p1.id, p2.id);
    expect(await account()).toMatchObject({ total_payable: 50000, amount_paid: 35000, balance: 15000, payment_status: "Partially Paid", payment_count: 2 });
  });

  it("Total payable = job amount + additional charges − discount; overpayment is refused", async () => {
    await ok(admin.rpc("add_payment_adjustment", { p_assignment_id: job.assignmentId, p: { kind: "additional_charge", entry_date: istDate(0), amount: 2000, description: "Transport" } }));
    await ok(admin.rpc("add_payment_adjustment", { p_assignment_id: job.assignmentId, p: { kind: "discount", entry_date: istDate(0), amount: 1000, description: "Late delivery discount" } }));
    expect(await account()).toMatchObject({ additional_charges: 2000, discount: 1000, total_payable: 51000, balance: 16000 });
    const over = await admin.rpc("add_vendor_payment", { p_assignment_id: job.assignmentId, p: { kind: "payment", paid_on: istDate(0), amount: 16000.5, mode: "cash" } });
    expect(over.error?.message).toMatch(/more than the balance of 16000/);
    const bigDiscount = await admin.rpc("add_payment_adjustment", { p_assignment_id: job.assignmentId, p: { kind: "discount", entry_date: istDate(0), amount: 17000, description: "too much" } });
    expect(bigDiscount.error?.message).toMatch(/less than what is already paid/);
  });

  it("a payment is never edited or deleted: a reversal with a reason is added instead", async () => {
    const rev = (await ok(admin.rpc("reverse_vendor_payment", { p_payment_id: paymentIds[1], p_reason: "Paid against the wrong invoice" }))) as Json;
    expect(rev).toMatchObject({ amount: -15000, reversal_of: paymentIds[1] });
    expect(await account()).toMatchObject({ amount_paid: 20000, balance: 31000, payment_status: "Advance Paid", payment_count: 1 });
    const twice = await admin.rpc("reverse_vendor_payment", { p_payment_id: paymentIds[1], p_reason: "again" });
    expect(twice.error?.message).toMatch(/already reversed/);
    await expect(sql("update public.vendor_payments set amount = 1 where id = $1", [paymentIds[0]])).rejects.toThrow(/append-only/);
    await expect(sql("delete from public.vendor_payments where id = $1", [paymentIds[0]])).rejects.toThrow(/append-only/);
    const ledger = (await ok(manager.from("payment_ledger").select("*").eq("assignment_id", job.assignmentId).eq("entry_type", "payment"))) as Json[];
    expect(ledger.find((l) => l.id === paymentIds[1])!.reversed).toBe(true);
  });

  it("paying the balance makes it Fully Paid", async () => {
    await ok(admin.rpc("add_vendor_payment", { p_assignment_id: job.assignmentId, p: { kind: "payment", paid_on: istDate(0), amount: 31000, mode: "cheque", reference: "CHQ 004512" } }));
    expect(await account()).toMatchObject({ amount_paid: 51000, balance: 0, payment_status: "Fully Paid" });
  });

  it("Managers can view payments but not add, reverse or change amounts; Staff see nothing", async () => {
    expect(await account(manager)).not.toBeNull();
    const add = await manager.rpc("add_vendor_payment", { p_assignment_id: job.assignmentId, p: { kind: "advance", paid_on: istDate(0), amount: 1, mode: "cash" } });
    expect(add.error?.code).toBe("42501");
    const rev = await manager.rpc("reverse_vendor_payment", { p_payment_id: paymentIds[0], p_reason: "test" });
    expect(rev.error?.code).toBe("42501");
    const inv = await manager.rpc("record_vendor_invoice", { p_assignment_id: job.assignmentId, p_expected_version: await version(), p: { amount: 1 } });
    expect(inv.error?.code).toBe("42501");
    // the job amount cannot be changed through the job screens once money is recorded
    const amt = await manager.rpc("update_assignment", { p_assignment_id: job.assignmentId, p_expected_version: await version(), p: { amount: 10 } });
    expect(amt.error?.message).toMatch(/Record vendor invoice/);
    expect(await account(staff)).toBeNull();
    expect((await ok(staff.from("vendor_payments").select("id"))) as Json[]).toEqual([]);
    expect((await staff.rpc("vendor_payment_summary", { p: {} })).error?.code).toBe("42501");
    const direct = await admin.from("vendor_payments").insert({ payment_no: "X", assignment_id: job.assignmentId, job_id: job.jobId, vendor_id: vendorId, kind: "payment", paid_on: istDate(0), amount: 1, mode: "cash" });
    expect(direct.error).not.toBeNull(); // even Admin writes only through the checked functions
  });

  it("vendor-wise totals, monthly / FY payments and the vendor statement", async () => {
    const summary = (await ok(manager.rpc("vendor_payment_summary", { p: {} }))) as Json[];
    const v = summary.find((s) => s.vendor_id === vendorId)!;
    expect(v).toMatchObject({ total_payable: 51000, amount_paid: 51000, outstanding: 0 });
    const period = (await ok(manager.rpc("payments_by_period", { p_fy: null }))) as Json;
    const month = (period.months as Json[]).find((m) => m.month === istDate(0).slice(0, 7))!;
    // this month: 15,000 - 15,000 reversal + 31,000 (+ the advance if it was paid this month)
    const advanceThisMonth = istDate(-2).slice(0, 7) === istDate(0).slice(0, 7) ? 20000 : 0;
    expect(month.paid).toBe(31000 + advanceThisMonth);
    expect((period.years as Json[])[0]!.paid).toBe(51000);
    const st = (await ok(manager.rpc("vendor_statement", { p_vendor_id: vendorId, p_from: null, p_to: null }))) as Json;
    expect(st).toMatchObject({ opening_balance: 0, total_payable: 51000, total_paid: 51000, closing_balance: 0 });
    expect((st.lines as Json[]).map((l) => l.type)).toEqual(expect.arrayContaining(["Job amount", "Advance", "Payment", "Payment reversal", "Additional charge", "Discount"]));
    expect((st.lines as Json[]).at(-1)!.balance).toBe(0);
  });
});
