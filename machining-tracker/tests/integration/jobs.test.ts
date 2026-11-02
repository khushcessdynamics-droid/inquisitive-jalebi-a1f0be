// Phase 4 business rules through the real API (local Supabase): jobs, vendor assignments, cancel & forward,
// visibility per role, status calculation, Excel import, attachments.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { closeSql, createAuthUser, enrollAndVerifyMfa, resetLocalDatabase, signIn, sql, uniqueEmail } from "../helpers/clients";

let admin: SupabaseClient;
let manager: SupabaseClient;
let staff1: SupabaseClient;
let staff2: SupabaseClient;
let staff2Id: string;
const vendor: Record<string, { id: string; version: number }> = {};
let category: Record<string, string> = {};
let givenBy: Record<string, string> = {};

function istDate(offsetDays = 0): string {
  return new Date(Date.now() + 330 * 60_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
}
function fyCode(iso: string): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const start = m >= 4 ? y : y - 1;
  return `${String(start % 100).padStart(2, "0")}${String((start + 1) % 100).padStart(2, "0")}`;
}

async function user(email: string, role: "admin" | "manager" | "staff", name: string): Promise<{ client: SupabaseClient; id: string }> {
  const id = await createAuthUser(email, name);
  await sql("update public.profiles set role_key = $2, is_active = true, full_name = $3 where id = $1", [id, role, name]);
  const client = await signIn(email);
  if (role !== "staff") await enrollAndVerifyMfa(client);
  return { client, id };
}

async function ok<T>(p: PromiseLike<{ data: T; error: { message: string; code?: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`${error.code}: ${error.message}`);
  return data;
}

async function register(client: SupabaseClient, jobId: string) {
  return ok(client.from("job_register").select("*").eq("id", jobId).single()) as Promise<Record<string, unknown>>;
}

beforeAll(async () => {
  await resetLocalDatabase();
  const adminEmail = uniqueEmail("jobs.admin");
  const a = await createAuthUser(adminEmail, "Jobs Admin");
  await sql("select private.bootstrap_first_admin($1)", [adminEmail]);
  admin = await signIn(adminEmail);
  await enrollAndVerifyMfa(admin);
  void a;
  manager = (await user(uniqueEmail("jobs.mgr"), "manager", "Mona Manager")).client;
  staff1 = (await user(uniqueEmail("jobs.s1"), "staff", "Sanjay Staff")).client;
  const s2 = await user(uniqueEmail("jobs.s2"), "staff", "Vansh Staff");
  staff2 = s2.client;
  staff2Id = s2.id;
  category = Object.fromEntries((await sql<{ name: string; id: string }>("select name, id from public.work_categories")).map((r) => [r.name, r.id]));
  givenBy = Object.fromEntries((await sql<{ name: string; id: string }>("select name, id from public.given_by_names")).map((r) => [r.name, r.id]));
}, 300_000);

afterAll(async () => {
  await closeSql();
});

describe("vendors", () => {
  it("Manager creates vendors with automatic codes; duplicates and invalid GST are rejected", async () => {
    for (const name of ["Shree Engineering", "Precision Works", "Old Vendor"]) {
      const v = (await ok(manager.rpc("save_vendor", { p_vendor_id: null, p_expected_version: null, p: { name, mobile: "98220 12345", category_ids: [category["CNC Turning"]] } }))) as { id: string; version: number; vendor_code: string };
      vendor[name] = { id: v.id, version: v.version };
      expect(v.vendor_code).toMatch(/^V-\d{4}$/);
    }
    const dup = await manager.rpc("save_vendor", { p_vendor_id: null, p_expected_version: null, p: { name: "shree engineering" } });
    expect(dup.error?.message).toMatch(/already exists/);
    const gst = await manager.rpc("save_vendor", { p_vendor_id: null, p_expected_version: null, p: { name: "Bad GST", gst_no: "123" } });
    expect(gst.error?.code).toBe("22023");
    const old = vendor["Old Vendor"]!;
    const v = (await ok(manager.rpc("save_vendor", { p_vendor_id: old.id, p_expected_version: old.version, p: { name: "Old Vendor", is_active: false } }))) as { version: number };
    old.version = v.version;
  });

  it("Staff can see vendors but cannot change them", async () => {
    expect((await ok(staff1.from("vendors").select("id"))).length).toBe(3);
    const r = await staff1.rpc("save_vendor", { p_vendor_id: null, p_expected_version: null, p: { name: "Staff vendor" } });
    expect(r.error?.code).toBe("42501");
    expect((await staff1.from("vendors").insert({ vendor_code: "X", name: "Direct" })).error).not.toBeNull();
  });
});

describe("job entry, numbering, status and visibility", () => {
  let jobId: string;

  it("Staff creates a job; it gets the next number of the current financial year", async () => {
    const today = istDate();
    const r = (await ok(
      staff1.rpc("create_job", {
        p: {
          part_label: "4711 / Drive Shaft",
          qty_sent: 100,
          category_id: category["CNC Turning"],
          given_by_id: givenBy["Samyak"],
          vendor: { vendor_id: vendor["Shree Engineering"]!.id, dispatched_on: today, commitment_date: istDate(10), amount: "12,500.50" },
        },
      }),
    )) as { id: string; job_no: string };
    jobId = r.id;
    expect(r.job_no).toBe(`JOB-${fyCode(today)}-0001`);
    const row = await register(staff1, jobId);
    expect(row).toMatchObject({
      status: "Sent to Vendor", vendor_name: "Shree Engineering", given_by_name: "Samyak", created_by_name: "Sanjay Staff",
      original_commitment_date: istDate(10), current_commitment_date: istDate(10), remaining_days: 10, days_since_given: 0, amount: 12500.5,
    });
  });

  it("validates input on the server", async () => {
    const bad = async (p: Record<string, unknown>) => (await staff1.rpc("create_job", { p })).error?.message;
    expect(await bad({ part_label: "", category_id: category["Grinding"] })).toMatch(/Part No/);
    expect(await bad({ part_label: "X", category_id: category["Grinding"], vendor: { vendor_id: vendor["Old Vendor"]!.id, dispatched_on: istDate() } })).toMatch(/active vendor/);
    expect(await bad({ part_label: "X", category_id: category["Grinding"], vendor: { vendor_id: vendor["Precision Works"]!.id, dispatched_on: "2014-12-31" } })).toMatch(/between 01-Jan-2015/);
    expect(await bad({ part_label: "X", category_id: category["Grinding"], vendor: { vendor_id: vendor["Precision Works"]!.id, dispatched_on: istDate(), commitment_date: istDate(-1) } })).toMatch(/cannot be before/);
    expect(await bad({ part_label: "X", category_id: category["Grinding"], qty_sent: 0 })).toMatch(/at least 1/);
  });

  it("Staff see only jobs created by or assigned to them; Managers see all", async () => {
    expect((await ok(staff2.from("job_register").select("id"))).length).toBe(0);
    expect((await ok(manager.from("job_register").select("id"))).length).toBe(1);
    const job = await register(manager, jobId);
    await ok(manager.rpc("update_job", { p_job_id: jobId, p_expected_version: job.version, p: { assigned_staff_id: staff2Id } }));
    const seen = await register(staff2, jobId);
    expect(seen.assigned_staff_name).toBe("Vansh Staff");
  });

  it("calculates Draft, Commitment Date Missing, Due Today and Overdue from real dates", async () => {
    const draft = (await ok(manager.rpc("create_job", { p: { part_label: "Draft part", category_id: category["Grinding"] } }))) as { id: string };
    expect((await register(manager, draft.id)).status).toBe("Draft");
    const missing = (await ok(manager.rpc("create_job", { p: { part_label: "No date part", category_id: category["Grinding"], vendor: { vendor_id: vendor["Precision Works"]!.id, dispatched_on: istDate(-2) } } }))) as { id: string };
    expect((await register(manager, missing.id)).status).toBe("Commitment Date Missing");
    const due = (await ok(manager.rpc("create_job", { p: { part_label: "Due part", category_id: category["Grinding"], vendor: { vendor_id: vendor["Precision Works"]!.id, dispatched_on: istDate(-4), commitment_date: istDate() } } }))) as { id: string };
    expect((await register(manager, due.id)).status).toBe("Due Today");
    const late = (await ok(manager.rpc("create_job", { p: { part_label: "Late part", category_id: category["Grinding"], vendor: { vendor_id: vendor["Precision Works"]!.id, dispatched_on: istDate(-12), commitment_date: istDate(-3) } } }))) as { id: string };
    const lateRow = await register(manager, late.id);
    expect(lateRow).toMatchObject({ status: "Overdue", delay_days: 3, days_since_given: 12, long_pending: true });
  });

  it("the original commitment date can never be changed", async () => {
    const row = await register(manager, jobId);
    const r = await manager.rpc("update_assignment", { p_assignment_id: row.assignment_id, p_expected_version: row.assignment_version, p: { commitment_date: istDate(20) } });
    expect(r.error?.message).toMatch(/Revise commitment/);
    await expect(sql("update public.job_assignments set original_commitment_date = original_commitment_date + 1 where id = $1", [row.assignment_id])).rejects.toThrow(/never be changed/);
    await expect(sql("update public.job_assignments set current_commitment_date = current_commitment_date + 1 where id = $1", [row.assignment_id])).rejects.toThrow(/commitment revision/);
  });

  it("detects conflicting edits and limits what Staff may change", async () => {
    const row = await register(staff1, jobId);
    const first = await staff1.rpc("update_job", { p_job_id: jobId, p_expected_version: row.version, p: { description: "Hardened" } });
    expect(first.error).toBeNull();
    const stale = await staff1.rpc("update_job", { p_job_id: jobId, p_expected_version: row.version, p: { remarks: "x" } });
    expect(stale.error?.code).toBe("PT409");
    const fresh = await register(staff1, jobId);
    const part = await staff1.rpc("update_job", { p_job_id: jobId, p_expected_version: fresh.version, p: { part_label: "Changed" } });
    expect(part.error?.code).toBe("42501");
    expect((await staff1.from("jobs").update({ part_label: "Direct" }).eq("id", jobId).select()).error).not.toBeNull();
  });
});

describe("cancel and forward to another vendor (vendor journey)", () => {
  let jobId: string;

  it("keeps both vendor assignments in the same job history (Example 8)", async () => {
    const r = (await ok(
      manager.rpc("create_job", {
        p: { part_label: "P-100 / Flange", qty_sent: 40, category_id: category["VMC Machining"], vendor: { vendor_id: vendor["Shree Engineering"]!.id, dispatched_on: istDate(-6), commitment_date: istDate(-1) } },
      }),
    )) as { id: string; assignment_id: string };
    jobId = r.id;
    const before = await register(manager, jobId);

    expect((await staff1.rpc("cancel_assignment", { p_assignment_id: r.assignment_id, p_expected_version: before.assignment_version, p_cancelled_on: istDate(), p_reason_code: "vendor_missed_commitment", p_reason_text: "late" })).error?.code).toBe("42501");
    expect((await manager.rpc("cancel_assignment", { p_assignment_id: r.assignment_id, p_expected_version: before.assignment_version, p_cancelled_on: istDate(), p_reason_code: "vendor_missed_commitment", p_reason_text: "" })).error?.message).toMatch(/reason/);
    expect(
      (await manager.rpc("cancel_assignment", { p_assignment_id: r.assignment_id, p_expected_version: before.assignment_version, p_cancelled_on: istDate(), p_reason_code: "vendor_missed_commitment", p_reason_text: "Missed date", p_forward: { vendor_id: vendor["Shree Engineering"]!.id, dispatched_on: istDate() } })).error?.message,
    ).toMatch(/different vendor/);

    const res = (await ok(
      manager.rpc("cancel_assignment", {
        p_assignment_id: r.assignment_id, p_expected_version: before.assignment_version, p_cancelled_on: istDate(),
        p_reason_code: "vendor_missed_commitment", p_reason_text: "Missed the 5-day commitment twice",
        p_forward: { vendor_id: vendor["Precision Works"]!.id, dispatched_on: istDate(), commitment_date: istDate(2), amount: 7000 },
      }),
    )) as { new_assignment_id: string };

    const journey = (await ok(manager.from("job_assignments").select("*").eq("job_id", jobId).order("sequence_no"))) as Array<Record<string, unknown>>;
    expect(journey.map((j) => [j.sequence_no, j.state, j.vendor_id])).toEqual([
      [1, "cancelled", vendor["Shree Engineering"]!.id],
      [2, "open", vendor["Precision Works"]!.id],
    ]);
    expect(journey[0]).toMatchObject({ cancel_reason_code: "vendor_missed_commitment", cancel_reason_text: "Missed the 5-day commitment twice", original_commitment_date: istDate(-1) });
    expect(journey[1]).toMatchObject({ id: res.new_assignment_id, previous_assignment_id: r.assignment_id, qty_sent: 40 });
    const row = await register(manager, jobId);
    expect(row).toMatchObject({ vendor_name: "Precision Works", assignment_count: 2, status: "Due Soon" });
    const history = (await ok(manager.rpc("job_activity", { p_job_id: jobId }))) as Array<{ action: string }>;
    expect(history.map((h) => h.action)).toEqual(expect.arrayContaining(["job.created", "job.sent_to_vendor", "job.cancelled_and_forwarded"]));
  });

  it("allows only one open vendor per job, and closed assignments cannot be edited", async () => {
    const first = (await sql<{ id: string }>("select id from public.job_assignments where job_id = $1 and sequence_no = 1", [jobId]))[0]!.id;
    await expect(
      sql("insert into public.job_assignments (job_id, sequence_no, vendor_id, dispatched_on) values ($1, 3, $2, current_date)", [jobId, vendor["Shree Engineering"]!.id]),
    ).rejects.toThrow(/one_open/);
    await expect(sql("update public.job_assignments set amount = 1 where id = $1", [first])).rejects.toThrow(/closed vendor assignment/);
    await expect(sql("delete from public.job_assignments where id = $1", [first])).rejects.toThrow(/not allowed/);
  });

  it("cancelling without forwarding makes the job Cancelled; archiving needs no open vendor", async () => {
    const row = await register(manager, jobId);
    expect((await manager.rpc("archive_job", { p_job_id: jobId, p_expected_version: row.version, p_reason: "test" })).error).not.toBeNull();
    await ok(manager.rpc("cancel_assignment", { p_assignment_id: row.assignment_id, p_expected_version: row.assignment_version, p_cancelled_on: istDate(), p_reason_code: "customer_cancelled", p_reason_text: "Customer order withdrawn" }));
    expect((await register(manager, jobId)).status).toBe("Cancelled");
    const v = (await register(manager, jobId)).version as number;
    expect((await manager.rpc("archive_job", { p_job_id: jobId, p_expected_version: v, p_reason: "Order withdrawn" })).error?.code).toBe("42501"); // jobs.archive is Admin-only by default
    await ok(admin.rpc("archive_job", { p_job_id: jobId, p_expected_version: v, p_reason: "Order withdrawn" }));
    expect((await register(admin, jobId)).archived_at).not.toBeNull();
  });
});

describe("Excel import", () => {
  const today = istDate();
  const groups = [
    { ref: "Rows 6, 8", part_label: "Legacy Flange", category_name: "vmc machining", given_by_name: "Vansh", qty_sent: null, remarks: "", assignments: [
      { vendor_name: "Shree Engineering", dispatched_on: "2025-06-01", cancelled_on: "2025-06-10", returned_on: null, commitment_date: null, amount: 5000, remarks: "" },
      { vendor_name: "Precision Works", dispatched_on: "2025-06-10", cancelled_on: null, returned_on: "2025-06-20", commitment_date: null, amount: 5600, remarks: "" },
    ] },
    { ref: "Row 7", part_label: "Legacy Pin", category_name: "Grinding", given_by_name: "", qty_sent: 25, remarks: "", assignments: [
      { vendor_name: "New Import Vendor", dispatched_on: today, cancelled_on: null, returned_on: null, commitment_date: null, amount: null, remarks: "" },
    ] },
    { ref: "Row 9", part_label: "Bad category", category_name: "Painting", given_by_name: "", qty_sent: 1, remarks: "", assignments: [
      { vendor_name: "Shree Engineering", dispatched_on: today, cancelled_on: null, returned_on: null, commitment_date: null, amount: null, remarks: "" },
    ] },
  ];

  it("Staff and Managers cannot import (Admin permission by default)", async () => {
    expect((await manager.rpc("import_jobs", { p_file_name: "x.xlsx", p_file_sha256: null, p_jobs: groups, p_options: {} })).error?.code).toBe("42501");
  });

  it("preview validates on the server without saving anything", async () => {
    const before = (await sql<{ n: number }>("select count(*)::int as n from public.jobs"))[0]!.n;
    const r = (await ok(admin.rpc("import_jobs", { p_file_name: "old.xlsx", p_file_sha256: null, p_jobs: groups, p_options: { dry_run: true } }))) as { results: Array<{ status: string; message?: string }>; imported: number; errors: number };
    expect(r.results.map((x) => x.status)).toEqual(["imported", "error", "error"]);
    expect(r.results[1]!.message).toMatch(/not in the vendor master/);
    expect(r.results[2]!.message).toMatch(/Painting/);
    expect((await sql<{ n: number }>("select count(*)::int as n from public.jobs"))[0]!.n).toBe(before);
    expect((await sql("select 1 from public.import_batches")).length).toBe(0);
  });

  it("imports chains, completed and pending jobs, keeps missing data empty, and skips duplicates", async () => {
    const r = (await ok(admin.rpc("import_jobs", { p_file_name: "old.xlsx", p_file_sha256: "abc", p_jobs: groups, p_options: { dry_run: false, create_missing_vendors: true } }))) as {
      results: Array<{ status: string; job_no?: string; job_id?: string; outcome?: string }>;
    };
    expect(r.results.map((x) => x.status)).toEqual(["imported", "imported", "error"]);
    expect(r.results[0]).toMatchObject({ job_no: "JOB-2526-0001", outcome: "Completed" });
    const flange = await register(admin, r.results[0]!.job_id!);
    expect(flange).toMatchObject({ status: "Completed", assignment_count: 2, vendor_name: "Precision Works", return_date: "2025-06-20", days_since_given: 10, qty_sent: null });
    const pin = await register(admin, r.results[1]!.job_id!);
    expect(pin).toMatchObject({ status: "Commitment Date Missing", original_commitment_date: null, qty_sent: 25 });
    const cancelled = (await sql<{ cancel_reason_code: string }>("select cancel_reason_code from public.job_assignments where job_id = $1 and sequence_no = 1", [r.results[0]!.job_id]))[0]!;
    expect(cancelled.cancel_reason_code).toBe("legacy_unclassified");

    const review = (await ok(admin.rpc("missing_data_review"))) as Array<{ issue: string; job_no: string }>;
    expect(review.filter((x) => x.job_no === "JOB-2526-0001").map((x) => x.issue)).toEqual(["cancellation_unclassified"]);
    expect(review.some((x) => x.issue === "commitment_missing" && x.job_no === pin.job_no)).toBe(true);

    const again = (await ok(admin.rpc("import_jobs", { p_file_name: "old.xlsx", p_file_sha256: "abc", p_jobs: groups.slice(0, 1), p_options: { dry_run: false } }))) as { results: Array<{ status: string }> };
    expect(again.results[0]!.status).toBe("duplicate");
  });

  it("an imported cancellation can be classified once, with a reason", async () => {
    const a = (await sql<{ id: string; version: number }>("select a.id, a.version from public.job_assignments a join public.jobs j on j.id = a.job_id where j.job_no = 'JOB-2526-0001' and a.sequence_no = 1"))[0]!;
    await ok(manager.rpc("reclassify_cancellation", { p_assignment_id: a.id, p_expected_version: a.version, p_reason_code: "vendor_missed_commitment", p_reason_text: "Confirmed with Vansh: vendor was late" }));
    const again = await manager.rpc("reclassify_cancellation", { p_assignment_id: a.id, p_expected_version: a.version + 1, p_reason_code: "customer_cancelled", p_reason_text: "x change" });
    expect(again.error?.message).toMatch(/Only imported cancellations/);
  });
});

describe("attachments (private storage)", () => {
  let jobId: string;
  const path = (job: string, name: string) => `${job}/${crypto.randomUUID()}__${name}`;

  it("the job's staff can upload, list and download; others cannot", async () => {
    const r = (await ok(staff1.rpc("create_job", { p: { part_label: "Drawing part", category_id: category["Wire EDM"] } }))) as { id: string };
    jobId = r.id;
    const p1 = path(jobId, "drawing.pdf");
    expect((await staff1.storage.from("job-files").upload(p1, new Blob(["%PDF-1.4 drawing"]), { contentType: "application/pdf" })).error).toBeNull();
    const att = (await ok(staff1.rpc("register_attachment", { p_job_id: jobId, p_storage_path: p1, p_file_name: "drawing.pdf" }))) as { id: string; size_bytes: number };
    expect(att.size_bytes).toBe(16);
    const signed = await staff1.storage.from("job-files").createSignedUrl(p1, 60);
    expect(signed.error).toBeNull();
    expect(await (await fetch(signed.data!.signedUrl)).text()).toBe("%PDF-1.4 drawing");

    // staff2 is not on this job
    expect((await staff2.storage.from("job-files").upload(path(jobId, "x.pdf"), new Blob(["x"]))).error).not.toBeNull();
    expect((await staff2.storage.from("job-files").createSignedUrl(p1, 60)).error).not.toBeNull();
    expect((await ok(staff2.from("attachments").select("id"))).length).toBe(0);
  });

  it("blocks disallowed file types, registering someone else's file, overwriting and deleting", async () => {
    expect((await staff1.storage.from("job-files").upload(path(jobId, "virus.exe"), new Blob(["MZ"]))).error).not.toBeNull();
    const p2 = path(jobId, "photo.png");
    await ok(staff1.storage.from("job-files").upload(p2, new Blob(["png"]), { contentType: "image/png" }) as never);
    expect((await manager.rpc("register_attachment", { p_job_id: jobId, p_storage_path: p2, p_file_name: "photo.png" })).error?.message).toMatch(/not found/);
    await ok(staff1.rpc("register_attachment", { p_job_id: jobId, p_storage_path: p2, p_file_name: "photo.png" }));
    expect((await staff1.storage.from("job-files").upload(p2, new Blob(["other"]), { upsert: true })).error).not.toBeNull();
    const del = await staff1.storage.from("job-files").remove([p2]);
    expect(del.data ?? []).toEqual([]); // registered files cannot be deleted
    const att = (await ok(admin.from("attachments").select("id").eq("storage_path", p2).single())) as { id: string };
    expect((await staff1.rpc("archive_attachment", { p_attachment_id: att.id, p_reason: "wrong file" })).error?.code).toBe("42501");
    await ok(admin.rpc("archive_attachment", { p_attachment_id: att.id, p_reason: "Wrong file uploaded" }));
    expect((await staff1.storage.from("job-files").createSignedUrl(p2, 60)).error).not.toBeNull(); // archived = no download
  });
});
