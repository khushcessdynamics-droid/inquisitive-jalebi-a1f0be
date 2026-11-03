// Phase 5 in the browser: commitment revision + timeline (Example 2), reliability ranking with sample sizes and the
// "how calculated" panel (Example 7), cost comparison with charts, manual choice and confirmed job creation (Example 6).
import { expect, test, type Page } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PASSWORD, closeSql, createAuthUser, enrollAndVerifyMfa, signIn, sql, uniqueEmail } from "../helpers/clients";
import { totp } from "../helpers/totp";

const managerEmail = uniqueEmail("e2e.p5");
let secret = "";
let api: SupabaseClient;
let cnc = "";
let jobId = "";
let requestUrl = "";
const vendor: Record<string, string> = {};

test.describe.configure({ mode: "serial" });

function istDate(offset = 0): string {
  return new Date(Date.now() + 330 * 60_000 + offset * 86_400_000).toISOString().slice(0, 10);
}
function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function dmy(iso: string): string {
  const m = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(iso.slice(5, 7)) - 1];
  return `${iso.slice(8, 10)}-${m}-${iso.slice(0, 4)}`;
}

test.beforeAll(async () => {
  const id = await createAuthUser(managerEmail, "Priya Manager");
  await sql("update public.profiles set role_key = 'manager', is_active = true, full_name = 'Priya Manager' where id = $1", [id]);
  api = await signIn(managerEmail);
  secret = (await enrollAndVerifyMfa(api)).secret;
  cnc = (await sql<{ id: string }>("select id from public.work_categories where name = 'CNC Turning'"))[0]!.id;
  for (const name of ["Kiran Precision", "Laxmi Tools", "Om Turners", "Sai CNC", "Raj Machining"]) {
    const { data, error } = await api.rpc("save_vendor", { p_vendor_id: null, p_expected_version: null, p: { name, category_ids: [cnc] } });
    if (error) throw error;
    vendor[name] = (data as { id: string }).id;
  }
  // job history for the reliability score (completed jobs are recorded by returns in Phase 6; inserted directly here)
  const D = "2026-08-01";
  const hist: Array<[string, string, number, string]> = [
    ["E2E-K1", "Kiran Precision", 4, "completed"], ["E2E-K2", "Kiran Precision", 3, "completed"], ["E2E-K3", "Kiran Precision", 4, "completed"],
    ["E2E-K4", "Kiran Precision", 4, "completed"], ["E2E-K5", "Kiran Precision", 8, "completed"], ["E2E-K6", "Kiran Precision", 10, "completed"],
    ["E2E-K7", "Kiran Precision", 6, "cancelled"], ["E2E-L1", "Laxmi Tools", 2, "completed"], ["E2E-L2", "Laxmi Tools", 2, "completed"],
  ];
  for (const [no, v, days, state] of hist) {
    const job = (await sql<{ id: string }>("insert into public.jobs (job_no, part_label, category_id) values ($1, $2, $3) returning id", [no, `${no} / Part`, cnc]))[0]!.id;
    await sql(
      `insert into public.job_assignments (job_id, sequence_no, vendor_id, dispatched_on, original_commitment_date, current_commitment_date, state,
         completed_on, cancelled_on, cancel_reason_code, cancel_reason_text)
       values ($1, 1, $2, $3, $4, $4, $5, $6, $7, $8, $9)`,
      [job, vendor[v], D, addDays(D, 4), state, state === "completed" ? addDays(D, days) : null, state === "cancelled" ? addDays(D, days) : null,
       state === "cancelled" ? "vendor_missed_commitment" : null, state === "cancelled" ? "Missed the date twice" : null],
    );
  }
  // an open job for the commitment revision
  const { data, error } = await api.rpc("create_job", {
    p: { part_label: "E2E-9001 / Spindle", qty_sent: 40, category_id: cnc,
         vendor: { vendor_id: vendor["Kiran Precision"], dispatched_on: istDate(-3), commitment_date: istDate(2), amount: 8000 } },
  });
  if (error) throw error;
  jobId = (data as { id: string }).id;
});
test.afterAll(async () => {
  await closeSql();
});

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(managerEmail);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByLabel("6-digit code").waitFor();
  const remaining = 30_000 - (Date.now() % 30_000);
  if (remaining < 4_000) await page.waitForTimeout(remaining + 300);
  await page.getByLabel("6-digit code").fill(totp(secret));
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByRole("heading", { name: /Welcome/ })).toBeVisible();
}

test("Example 2: revising the committed date keeps the original and shows the timeline", async ({ page }) => {
  await login(page);
  await page.goto(`/jobs/${jobId}`);
  await page.getByRole("button", { name: "Revise commitment" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("New committed date").fill(istDate(5));
  await dialog.getByLabel(/The vendor asked for more time/).check();
  await dialog.getByLabel("Reason for the change (saved permanently)").fill("Vendor waiting for raw material");
  await dialog.getByRole("button", { name: "Save revision 1" }).click();
  await expect(dialog).toBeHidden();

  const timeline = page.getByRole("list", { name: /Commitment timeline/ });
  await expect(timeline.getByText(`Original commitment · ${dmy(istDate(2))}`)).toBeVisible();
  await expect(timeline.getByText(/Revision 1 ·/)).toBeVisible();
  await expect(timeline.getByText("Requested by vendor")).toBeVisible();
  await expect(timeline.getByText(/Vendor waiting for raw material · Priya Manager/)).toBeVisible();
  await expect(page.getByText("Revised 1×").first()).toBeVisible();
  await expect(page.getByText("Committed date revised")).toBeVisible(); // job history

  await page.getByRole("link", { name: "Jobs Register", exact: true }).click();
  await page.getByLabel("Search job ID, part or vendor").fill("Spindle");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByRole("row", { name: /E2E-9001/ }).getByText("Revised 1×")).toBeVisible();
});

test("Example 7: reliability ranking shows sample sizes and how each score was calculated", async ({ page }) => {
  await login(page);
  await page.getByRole("link", { name: "Vendor Reliability", exact: true }).click();
  await page.getByLabel("Financial year").selectOption("all");
  const kiran = page.getByRole("row", { name: /Kiran Precision/ });
  await expect(kiran.getByText(/^(Excellent|Good|Average|Needs Improvement)$/)).toBeVisible();
  await expect(page.getByRole("row", { name: /Laxmi Tools/ }).getByText("Insufficient data (2 of 5 jobs)")).toBeVisible();
  await kiran.getByRole("button", { name: "How calculated" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "How the score was calculated · Kiran Precision" })).toBeVisible();
  await expect(dialog.getByRole("row", { name: /Quality performance/ }).getByText("not used")).toBeVisible();
  await expect(dialog.getByText(/7 eligible jobs \(6 returned \+ 1 vendor-caused cancellation\)/)).toBeVisible();
  await expect(dialog.getByRole("row", { name: /E2E-K7/ }).getByText("Cancelled: vendor-caused")).toBeVisible();
  await expect(dialog.getByRole("row", { name: /E2E-9001/ }).getByText("Still with the vendor")).toBeVisible();
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Export to Excel" }).click();
  expect((await download).suggestedFilename()).toMatch(/^CESS-Reliability-Kiran-Precision-.*\.xlsx$/);
});

test("Example 6: three quotations, lowest/highest/average/% difference, manual choice, then a confirmed job", async ({ page }) => {
  await login(page);
  await page.getByRole("link", { name: "Cost Comparison", exact: true }).click();
  await page.getByRole("button", { name: "New comparison" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Part No / Part Name").fill("E2E-4711 / Gear Shaft");
  await dialog.getByLabel("Machining category").selectOption({ label: "CNC Turning" });
  await dialog.getByLabel("Required quantity (pieces)").fill("100");
  await dialog.getByRole("button", { name: "Create and add quotations" }).click();
  await expect(page.getByRole("heading", { name: /QR-\d{4}-\d{4} · E2E-4711 \/ Gear Shaft/ })).toBeVisible();
  requestUrl = page.url();

  for (const [name, basis, price, days] of [["Om Turners", "total", "10000", "10"], ["Sai CNC", "per_part", "120", "5"], ["Raj Machining", "total", "15500", "7"]] as const) {
    await page.getByRole("button", { name: "Add quotation" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Vendor").selectOption({ label: `${name} ✓ does this work` });
    if (basis === "total") await dialog.getByLabel(/one amount for all 100 pcs/).check();
    await dialog.getByLabel(basis === "total" ? "Quoted amount for 100 pcs (₹)" : "Per-part rate (₹)").fill(price);
    await dialog.getByLabel("Expected delivery days").fill(days);
    await dialog.getByRole("button", { name: "Save quotation" }).click();
    await expect(dialog).toBeHidden();
  }

  await expect(page.getByText("₹10,000.00").first()).toBeVisible();
  await expect(page.getByText("₹15,500.00").first()).toBeVisible();
  await expect(page.getByText("₹12,500.00").first()).toBeVisible();
  await expect(page.getByText("₹5,500.00").first()).toBeVisible();
  await expect(page.getByText("highest is 55.0% above lowest")).toBeVisible();
  await expect(page.getByRole("row", { name: /Raj Machining/ }).getByText("+55.0%")).toBeVisible();
  await expect(page.getByRole("row", { name: /Sai CNC/ }).getByText("+20.0%")).toBeVisible();
  // not the cheapest: 12,000 in 5 days beats 10,000 in 10 days
  await expect(page.getByText("Not the cheapest")).toBeVisible();
  await expect(page.getByRole("row", { name: /Sai CNC/ }).getByText("Recommended")).toBeVisible();
  await expect(page.getByText(/Reliability: no score yet for Om Turners, Sai CNC, Raj Machining/)).toBeVisible();
  await expect(page.getByText("Total cost for the required quantity")).toBeVisible();
  await expect(page.getByText("Expected delivery days", { exact: true })).toBeVisible();

  // choose the cheapest anyway: a reason is required because it differs from the recommendation
  await page.getByRole("row", { name: /Om Turners/ }).getByRole("button", { name: "Choose" }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByText("The recommendation was Sai CNC")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Choose this vendor" })).toBeDisabled();
  await dialog.getByLabel("Reason for choosing this vendor (required)").fill("Lowest price; not urgent");
  await dialog.getByRole("button", { name: "Choose this vendor" }).click();
  await expect(page.getByText("Vendor chosen: Om Turners (₹10,000.00)")).toBeVisible();
  await expect(page.getByText(/No job has been created yet/)).toBeVisible();

  await page.getByRole("button", { name: "Create job" }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Vendor committed delivery date")).toHaveValue(istDate(10));
  await dialog.getByRole("button", { name: "Create job and give to Om Turners" }).click();
  await expect(page.getByText(/Job JOB-\d{4}-\d{4} saved/)).toBeVisible();
  await expect(page.getByText("1. Om Turners").first()).toBeVisible();
  await expect(page.getByText("₹10,000.00").first()).toBeVisible();
  await expect(page.getByText("Job created from quotation")).toBeVisible();
});

test("Phase 5 screens fit a phone screen", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 851 });
  await login(page);
  for (const path of [new URL(requestUrl).pathname, "/vendors/reliability?fy=all", "/quotes", `/jobs/${jobId}`, `/vendors/${vendor["Kiran Precision"]}`]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    // charts size themselves after the first paint: measure once the layout has settled
    await expect
      .poll(async () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), { timeout: 5_000, message: path })
      .toBeLessThanOrEqual(1);
  }
});
