// Phase 8 in the browser: dashboard KPIs, charts and tables from real records with click-through to filtered
// records, the weekly report (make, view, PDF and Excel downloads), quality records, Staff home, phone layout.
import { expect, test, type Page } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PASSWORD, closeSql, createAuthUser, enrollAndVerifyMfa, signIn, sql, uniqueEmail } from "../helpers/clients";
import { totp } from "../helpers/totp";

const managerEmail = uniqueEmail("e2e.p8m");
const staffEmail = uniqueEmail("e2e.p8s");
const secrets: Record<string, string> = {};
let api: SupabaseClient;
let vendorId = "";

test.describe.configure({ mode: "serial" });

function istDate(offset = 0): string {
  return new Date(Date.now() + 330 * 60_000 + offset * 86_400_000).toISOString().slice(0, 10);
}
function lastMonday(): string {
  const d = new Date(`${istDate(0)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) - 7);
  return d.toISOString().slice(0, 10);
}
function add(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

test.beforeAll(async () => {
  const mid = await createAuthUser(managerEmail, "Meera Manager");
  await sql("update public.profiles set role_key = 'manager', is_active = true, full_name = 'Meera Manager' where id = $1", [mid]);
  api = await signIn(managerEmail);
  secrets[managerEmail] = (await enrollAndVerifyMfa(api)).secret;
  const sid = await createAuthUser(staffEmail, "Sunil Staff");
  await sql("update public.profiles set role_key = 'staff', is_active = true, full_name = 'Sunil Staff' where id = $1", [sid]);

  const cnc = (await sql<{ id: string }>("select id from public.work_categories where name = 'CNC Turning'"))[0]!.id;
  const { data: v } = await api.rpc("save_vendor", { p_vendor_id: null, p_expected_version: null, p: { name: "Kaveri Engineering", category_ids: [cnc] } });
  vendorId = (v as { id: string }).id;
  const job = async (part: string, given: string, due: string, extra: Record<string, unknown> = {}) => {
    const { data, error } = await api.rpc("create_job", { p: { part_label: part, qty_sent: 60, category_id: cnc, ...extra, vendor: { vendor_id: vendorId, dispatched_on: given, commitment_date: due } } });
    if (error) throw error;
    return (data as { id: string }).id;
  };
  await job("E2E-8001 / Overdue Shaft", istDate(-9), istDate(-3));
  await job("E2E-8002 / Due Today Bush", istDate(-2), istDate(0), { assigned_staff_id: sid });
  const done = await job("E2E-8003 / Done Flange", lastMonday(), add(lastMonday(), 2));
  const a = (await sql<{ id: string }>("select id from public.job_assignments where job_id = $1", [done]))[0]!.id;
  const { error } = await api.rpc("record_return", { p_assignment_id: a, p: { returned_on: add(lastMonday(), 3), qty_received: 60, inspection: { inspected_on: add(lastMonday(), 3), qty_accepted: 55, qty_rejected: 5 } } });
  if (error) throw error;
});
test.afterAll(async () => {
  await closeSql();
});

async function login(page: Page, email: string, mfa = true) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  if (mfa) {
    await page.getByLabel("6-digit code").waitFor();
    const remaining = 30_000 - (Date.now() % 30_000);
    if (remaining < 4_000) await page.waitForTimeout(remaining + 300);
    await page.getByLabel("6-digit code").fill(totp(secrets[email]!));
    await page.getByRole("button", { name: "Verify" }).click();
  }
  await expect(page.getByRole("heading", { name: /Welcome/ })).toBeVisible();
}

test("dashboard: KPIs and tables from the records; clicking opens the filtered records", async ({ page }) => {
  await login(page, managerEmail);
  const kpi = (label: string) => page.getByRole("link").filter({ hasText: label }).first();
  // other test files share this database: expected numbers are read from it, not assumed
  const count = async (where: string) => (await sql<{ n: string }>(`select count(*)::text as n from public.job_register where archived_at is null and ${where}`))[0]!.n;
  await expect(kpi("Active jobs (with vendors)")).toContainText(await count("status not in ('Draft', 'Completed', 'Cancelled')"));
  await expect(kpi("Overdue")).toContainText(await count("status = 'Overdue'"));
  await expect(kpi("Due today")).toContainText(await count("status = 'Due Today'"));
  await expect(kpi("Quality acceptance")).toContainText(/%|—/);
  await expect(page.getByText("Monthly job trend")).toBeVisible();
  await expect(page.getByText("Vendor-wise job distribution")).toBeVisible();
  await expect(page.locator("section").filter({ hasText: /Overdue jobs \(\d+\)/ }).getByText("E2E-8001 / Overdue Shaft · Kaveri Engineering")).toBeVisible();

  await kpi("Overdue").click();
  await expect(page.getByRole("heading", { name: "Jobs Register" })).toBeVisible();
  await expect(page.getByRole("row", { name: /E2E-8001/ })).toBeVisible();
  await expect(page.getByText(new RegExp(`^${await count("status = 'Overdue'")} jobs? · page 1 of`))).toBeVisible();

  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  await kpi("Due today").click();
  await expect(page.getByText(/Filtered from the dashboard: status: Due Today/)).toBeVisible();
  await expect(page.getByRole("row", { name: /E2E-8002/ })).toBeVisible();

  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  await page.getByRole("list", { name: "Vendor-wise job distribution" }).getByRole("button", { name: /Kaveri Engineering/ }).click();
  await expect(page).toHaveURL(new RegExp(`vendor=${vendorId}`));
  await expect(page.getByRole("row", { name: /E2E-800/ }).first()).toBeVisible();
});

test("weekly report: make it for last week, view A-F with comparison, download PDF and Excel", async ({ page }) => {
  await login(page, managerEmail);
  await page.getByRole("link", { name: "Weekly Reports", exact: true }).click();
  await expect(page.getByLabel("Week starting")).toHaveValue(lastMonday());
  await page.getByRole("button", { name: "Make report" }).click();
  await expect(page.getByRole("heading", { name: /Weekly management report:/ })).toBeVisible();
  for (const t of ["A. Job summary", "B. Delivery performance", "D. Financial summary", "E. Quality summary", "F. Important follow-ups"]) {
    await expect(page.getByRole("heading", { name: t })).toBeVisible();
  }
  await expect(page.getByRole("heading", { name: /^C\. Vendor performance/ })).toBeVisible();
  // other test files share this database and their dates move with the calendar, so the expected figures are read from the
  // report the app stored, and this file's own records are checked to be part of them
  const stored = (await sql<{ data: { jobs: { completed: number }; quality: { accepted: number; rejected: number; acceptance_pct: number | null } } }>(
    "select data from public.weekly_reports where period_start = $1 order by generated_at desc limit 1", [lastMonday()],
  ))[0]!.data;
  expect(stored.jobs.completed).toBeGreaterThanOrEqual(1); // E2E-8003 completed in that week
  expect(stored.quality.accepted).toBeGreaterThanOrEqual(55); // its inspection: 55 accepted, 5 rejected
  expect(stored.quality.rejected).toBeGreaterThanOrEqual(5);
  const thisWeek = (section: string, row: RegExp) =>
    page.locator("section").filter({ has: page.getByRole("heading", { name: section }) }).getByRole("row", { name: row }).getByRole("cell").nth(1);
  await expect(thisWeek("E. Quality summary", /Accepted quantity/)).toHaveText(String(stored.quality.accepted));
  await expect(thisWeek("E. Quality summary", /Rejected quantity/)).toHaveText(String(stored.quality.rejected));
  await expect(thisWeek("E. Quality summary", /Quality acceptance %/)).toHaveText(`${Number(stored.quality.acceptance_pct).toFixed(1)}%`);
  await expect(thisWeek("A. Job summary", /Completed jobs/)).toHaveText(String(stored.jobs.completed));
  const pdf = page.waitForEvent("download");
  await page.getByRole("button", { name: "PDF" }).click();
  expect((await pdf).suggestedFilename()).toBe(`CESS-Weekly-Report-${lastMonday()}.pdf`);
  const xlsx = page.waitForEvent("download");
  await page.getByRole("button", { name: "Excel" }).click();
  expect((await xlsx).suggestedFilename()).toBe(`CESS-Weekly-Report-${lastMonday()}.xlsx`);
  await page.getByRole("button", { name: "All reports" }).click();
  await expect(page.getByRole("link", { name: /to/ }).first()).toBeVisible();
});

test("quality records with export; Staff see only their own jobs on the home page", async ({ page, browser }) => {
  await login(page, managerEmail);
  await page.getByRole("link", { name: "Quality", exact: true }).click();
  await page.getByLabel("Financial year (inspection date)").selectOption("all");
  await expect(page.getByRole("row", { name: /E2E-8003/ })).toContainText("Partially Accepted");
  const dl = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export to Excel" }).click();
  expect((await dl).suggestedFilename()).toMatch(/^CESS-Quality-Records-all-/);

  const staffPage = await browser.newPage();
  await login(staffPage, staffEmail, false);
  await expect(staffPage.getByRole("link").filter({ hasText: "My open jobs" })).toContainText("1");
  await expect(staffPage.getByText("E2E-8002 / Due Today Bush")).toBeVisible();
  await expect(staffPage.getByText("E2E-8001")).toHaveCount(0);
  await expect(staffPage.getByRole("link", { name: "Weekly Reports", exact: true })).toHaveCount(0);
  await staffPage.close();
});

test("dashboard and reports fit a phone screen", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 851 });
  await login(page, managerEmail);
  for (const path of ["/", "/reports", "/quality"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await expect
      .poll(async () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), { timeout: 5_000, message: path })
      .toBeLessThanOrEqual(1);
  }
});
