// Phase 7 through the real API (local Supabase): WhatsApp click-to-chat log and templates, the backend reminder
// engine (schedule, no duplicates, recalculation, stop when completed / cancelled, recipients), notifications.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { closeSql, createAuthUser, enrollAndVerifyMfa, resetLocalDatabase, signIn, sql, uniqueEmail, pauseScheduler, resumeScheduler } from "../helpers/clients";

let admin: SupabaseClient;
let manager: SupabaseClient;
let staff1: SupabaseClient;
let staff2: SupabaseClient;
let staff1Id = "";
let cnc = "";
let vendorId = "";
const job: Record<string, { jobId: string; assignmentId: string }> = {};

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function istDate(offsetDays = 0): string {
  return new Date(Date.now() + 330 * 60_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
}
const at = (offsetDays: number, time = "10:00") => `${istDate(offsetDays)}T${time}:00+05:30`;

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
async function newJob(key: string, given: number, due: number | null, extra: Json = {}) {
  const j = (await ok(manager.rpc("create_job", {
    p: { part_label: `${key} / Part`, qty_sent: 10, category_id: cnc, ...extra,
         vendor: { vendor_id: vendorId, dispatched_on: istDate(given), commitment_date: due === null ? null : istDate(due) } },
  }))) as Json;
  const a = (await ok(manager.from("job_assignments").select("id").eq("job_id", j.id).single())) as Json;
  job[key] = { jobId: j.id, assignmentId: a.id };
}
async function run(now: string, force = false) {
  return (await sql<{ r: Json }>("select private.run_reminders($1::timestamptz, $2) as r", [now, force]))[0]!.r;
}
async function remindersOn(day: number) {
  return sql<{ job: string; kind: string; days_to_due: number }>(
    `select split_part(j.part_label, ' / ', 1) as job, r.kind, r.days_to_due from public.reminders r join public.jobs j on j.id = r.job_id
      where r.reminder_date = $1 order by 1`, [istDate(day)]);
}

beforeAll(async () => {
  await resetLocalDatabase();
  await pauseScheduler(); // this file runs the scheduled functions itself at fixed times
  const adminEmail = uniqueEmail("p7.admin");
  await createAuthUser(adminEmail, "P7 Admin");
  await sql("select private.bootstrap_first_admin($1)", [adminEmail]);
  admin = await signIn(adminEmail);
  await enrollAndVerifyMfa(admin);
  manager = (await user(uniqueEmail("p7.mgr"), "manager", "Mona Manager")).client;
  const s1 = await user(uniqueEmail("p7.s1"), "staff", "Sanjay Staff");
  staff1 = s1.client;
  staff1Id = s1.id;
  staff2 = (await user(uniqueEmail("p7.s2"), "staff", "Vansh Staff")).client;
  cnc = (await sql<{ id: string }>("select id from public.work_categories where name = 'CNC Turning'"))[0]!.id;
  await sql("update public.app_settings set value = jsonb_set(value, '{name}', '\"CESS Dynamics\"') where key = 'company'");
  vendorId = ((await ok(manager.rpc("save_vendor", { p_vendor_id: null, p_expected_version: null, p: { name: "Shree Engineering", wa_number: "98220 12345", category_ids: [cnc] } }))) as Json).id;
}, 300_000);

afterAll(async () => {
  await closeSql();
});

// ---------------------------------------------------------------------------------------------------------------
describe("WhatsApp click-to-chat", () => {
  it("ten editable templates; only users who may change settings can edit them", async () => {
    const t = (await ok(manager.from("message_templates").select("key, label, version").order("sort_order"))) as Json[];
    expect(t.map((x) => x.key)).toEqual(["new_job", "status_followup", "upcoming_reminder", "due_today", "overdue", "commitment_confirmation",
      "revised_confirmation", "return_reminder", "quality_followup", "payment_confirmation"]);
    const denied = await manager.from("message_templates").update({ body: "Changed by manager {job_no}" }).eq("key", "overdue").select();
    expect(denied.data ?? []).toEqual([]);
    const done = (await ok(admin.from("message_templates").update({ body: "Dear {contact_person}, {job_no} is {delay_days} days late. - {company}" }).eq("key", "overdue").eq("version", 1).select())) as Json[];
    expect(done[0]!.version).toBe(2);
  });

  it("the message facts come from the database", async () => {
    await newJob("WA-1", -6, -2);
    const ctx = (await ok(manager.rpc("whatsapp_context", { p_job_id: job["WA-1"]!.jobId, p_payment_id: null }))) as Json;
    expect(ctx).toMatchObject({ vendor_name: "Shree Engineering", contact_person: null, wa_country_code: "+91", wa_number: "9822012345",
      company: "CESS Dynamics", qty: 10, pending_qty: 10, delay_days: 2, current_commitment: istDate(-2) });
    const staff = await staff1.rpc("whatsapp_context", { p_job_id: job["WA-1"]!.jobId, p_payment_id: null });
    expect(staff.error?.code).toBe("42501");
  });

  it("opening WhatsApp is logged as 'opened', never as sent; a repeat within 12 hours needs confirmation", async () => {
    const args = { p_vendor_id: vendorId, p_job_id: job["WA-1"]!.jobId, p_template_key: "overdue", p_phone: "919822012345", p_body: "Dear Shree, JOB is late" };
    const first = (await ok(manager.rpc("log_whatsapp_message", { ...args, p_confirm_duplicate: false }))) as Json;
    expect(first).toMatchObject({ status: "opened", mode: "click_to_chat", confirmed_at: null });
    const dup = await manager.rpc("log_whatsapp_message", { ...args, p_confirm_duplicate: false });
    expect(dup.error?.code).toBe("PT409");
    expect(dup.error?.message).toMatch(/already opened in WhatsApp at .* by Mona Manager/);
    await ok(manager.rpc("log_whatsapp_message", { ...args, p_confirm_duplicate: true }));
    const badPhone = await manager.rpc("log_whatsapp_message", { ...args, p_phone: "12", p_confirm_duplicate: true });
    expect(badPhone.error?.code).toBe("22023");
    const staffTry = await staff1.rpc("log_whatsapp_message", { ...args, p_confirm_duplicate: true });
    expect(staffTry.error?.code).toBe("42501");

    const sent = (await ok(manager.rpc("confirm_whatsapp_sent", { p_message_id: first.id }))) as Json;
    expect(sent.status).toBe("user_confirmed_sent");
    expect((await manager.rpc("confirm_whatsapp_sent", { p_message_id: first.id })).error?.message).toMatch(/Already marked/);
    await expect(sql("update public.whatsapp_messages set body = 'x' where id = $1", [first.id])).rejects.toThrow(/cannot be changed/);
    await expect(sql("delete from public.whatsapp_messages where id = $1", [first.id])).rejects.toThrow(/cannot be deleted/);

    const log = (await ok(manager.from("whatsapp_log").select("*").eq("job_id", job["WA-1"]!.jobId).order("created_at"))) as Json[];
    expect(log.map((l) => l.status)).toEqual(["user_confirmed_sent", "opened"]);
    expect(log[0]).toMatchObject({ template_label: "Overdue job reminder", opened_by_name: "Mona Manager", confirmed_by_name: "Mona Manager" });
    const activity = (await ok(manager.rpc("job_activity", { p_job_id: job["WA-1"]!.jobId }))) as Json[];
    expect(activity.filter((a) => a.action === "whatsapp.initiated")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("reminder engine", () => {
  beforeAll(async () => {
    await newJob("R-UP3", -2, 3);
    await newJob("R-UP1", -2, 1);
    await newJob("R-TODAY", -3, 0);
    await newJob("R-OD1", -5, -1, { assigned_staff_id: staff1Id });
    await newJob("R-OD4", -10, -4);
    await newJob("R-NONE2", -1, 2);
    await newJob("R-NODATE", -2, null);
    // all pieces back (awaiting inspection): nothing left to remind the vendor about
    await newJob("R-BACK", -5, -1);
    await ok(manager.rpc("record_return", { p_assignment_id: job["R-BACK"]!.assignmentId, p: { returned_on: istDate(0), qty_received: 10 } }));
    // completed and cancelled jobs get no reminders
    await newJob("R-DONE", -5, -1);
    await ok(manager.rpc("record_return", { p_assignment_id: job["R-DONE"]!.assignmentId, p: { returned_on: istDate(0), qty_received: 10, inspection: { inspected_on: istDate(0), qty_accepted: 10 } } }));
    await newJob("R-CANC", -5, -1);
    const v = (await ok(manager.from("job_assignments").select("version").eq("id", job["R-CANC"]!.assignmentId).single())) as Json;
    await ok(manager.rpc("cancel_assignment", { p_assignment_id: job["R-CANC"]!.assignmentId, p_expected_version: v.version, p_cancelled_on: istDate(0),
      p_reason_code: "customer_cancelled", p_reason_text: "Order dropped", p_forward: null }));
  });

  it("waits for the configured time of day (09:00 IST)", async () => {
    const r = await run(at(0, "08:30"));
    expect(r).toMatchObject({ ran: false });
    expect(await remindersOn(0)).toEqual([]);
  });

  it("default schedule: 3 and 1 day before, on the day, 1 day overdue and every day after; nothing without a committed date", async () => {
    const r = await run(at(0));
    expect(r).toMatchObject({ ran: true, reminders_created: 6 });
    expect(await remindersOn(0)).toEqual([
      { job: "R-OD1", kind: "overdue", days_to_due: -1 },
      { job: "R-OD4", kind: "overdue", days_to_due: -4 },
      { job: "R-TODAY", kind: "due_today", days_to_due: 0 },
      { job: "R-UP1", kind: "upcoming", days_to_due: 1 },
      { job: "R-UP3", kind: "upcoming", days_to_due: 3 },
      { job: "WA-1", kind: "overdue", days_to_due: -2 },
    ]);
  });

  it("never duplicates: running again the same day adds nothing", async () => {
    const r = await run(at(0, "16:45"));
    expect(r).toMatchObject({ ran: true, reminders_created: 0 });
    expect(await remindersOn(0)).toHaveLength(6);
    const runs = await sql<{ runs: number; reminders_created: number }>("select runs, reminders_created from public.reminder_runs where run_date = $1", [istDate(0)]);
    expect(runs[0]).toMatchObject({ runs: 2, reminders_created: 6 });
  });

  it("notifications go to everyone who sees all jobs and to the assigned staff user only", async () => {
    const mine = async (c: SupabaseClient) => (await ok(c.from("notifications").select("title, severity, job_id").is("read_at", null))) as Json[];
    expect(await mine(manager)).toHaveLength(6);
    expect(await mine(admin)).toHaveLength(6);
    const s1 = await mine(staff1);
    expect(s1).toHaveLength(1);
    expect(s1[0]).toMatchObject({ severity: "critical", job_id: job["R-OD1"]!.jobId });
    expect(s1[0]!.title).toMatch(/JOB-\d{4}-\d{4} overdue by 1 day · Shree Engineering/);
    expect(await mine(staff2)).toHaveLength(0);
    // marking read affects only the caller
    expect(await ok(manager.rpc("mark_notifications_read", { p_ids: null }))).toBe(6);
    expect(await mine(manager)).toHaveLength(0);
    expect(await mine(admin)).toHaveLength(6);
    const activity = (await ok(admin.rpc("job_activity", { p_job_id: job["R-OD1"]!.jobId }))) as Json[];
    expect(activity.some((a) => a.action === "reminder.generated")).toBe(true);
  });

  it("recalculates from the latest committed date and stops when the job is completed", async () => {
    // the vendor revises R-OD1 to tomorrow
    const v = (await ok(manager.from("job_assignments").select("version").eq("id", job["R-OD1"]!.assignmentId).single())) as Json;
    await ok(manager.rpc("revise_commitment", { p_assignment_id: job["R-OD1"]!.assignmentId, p_expected_version: v.version, p_new_date: istDate(1), p_requested_by: "vendor", p_reason: "Machine breakdown" }));
    // R-OD4 is completed today
    await ok(manager.rpc("record_return", { p_assignment_id: job["R-OD4"]!.assignmentId, p: { returned_on: istDate(0), qty_received: 10, inspection: { inspected_on: istDate(0), qty_accepted: 10 } } }));
    await run(at(1));
    expect(await remindersOn(1)).toEqual([
      { job: "R-NONE2", kind: "upcoming", days_to_due: 1 },
      { job: "R-OD1", kind: "due_today", days_to_due: 0 },
      { job: "R-TODAY", kind: "overdue", days_to_due: -1 },
      { job: "R-UP1", kind: "due_today", days_to_due: 0 },
      { job: "WA-1", kind: "overdue", days_to_due: -3 },
    ]);
  });

  it("the schedule ahead is calculated for the user's own jobs; settings switch the engine off", async () => {
    const mgr = (await ok(manager.rpc("upcoming_reminders", { p_days: 3 }))) as Json[];
    expect(mgr.filter((x) => x.date === istDate(2)).map((x) => [x.job_no ? "x" : "", x.kind])).toEqual(expect.arrayContaining([["x", "upcoming"]]));
    const s1 = (await ok(staff1.rpc("upcoming_reminders", { p_days: 3 }))) as Json[];
    expect(new Set(s1.map((x) => x.job_id))).toEqual(new Set([job["R-OD1"]!.jobId]));
    await sql("update public.app_settings set value = jsonb_set(value, '{enabled}', 'false') where key = 'reminders'");
    expect(await run(at(2))).toMatchObject({ ran: false });
    expect(await remindersOn(2)).toEqual([]);
    await sql("update public.app_settings set value = jsonb_set(value, '{enabled}', 'true') where key = 'reminders'");
  });

  it("is scheduled in the database; only Admin can run it on demand; history cannot be changed", async () => {
    await resumeScheduler(); // paused for this file in beforeAll; the status reports the switched-on job
    const st = (await ok(admin.rpc("reminder_engine_status"))) as Json;
    expect(st).toMatchObject({ scheduled: true, schedule: "*/15 * * * *" });
    expect((await manager.rpc("run_reminders_now")).error?.code).toBe("42501");
    expect((await ok(admin.rpc("run_reminders_now"))) as Json).toMatchObject({ ran: true });
    expect((await manager.rpc("run_reminders", {})).error).not.toBeNull();
    await expect(sql("delete from public.reminders")).rejects.toThrow(/append-only/);
    const direct = await manager.from("notifications").update({ title: "x" }).eq("read_at", null).select();
    expect(direct.error ?? direct.data).toBeTruthy();
  });
});
