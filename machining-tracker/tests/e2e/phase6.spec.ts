// Phase 6 in the browser: partial return and inspection (Examples 3 and 4) through to automatic completion,
// vendor payments by the Admin (Example 5), view-only payments for a Manager, phone layout.
import { expect, test, type Page } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PASSWORD, closeSql, createAuthUser, enrollAndVerifyMfa, signIn, sql, uniqueEmail } from "../helpers/clients";
import { totp } from "../helpers/totp";

const managerEmail = uniqueEmail("e2e.p6m");
const adminEmail = uniqueEmail("e2e.p6a");
const secrets: Record<string, string> = {};
let api: SupabaseClient;
let jobId = "";

test.describe.configure({ mode: "serial" });

function istDate(offset = 0): string {
  return new Date(Date.now() + 330 * 60_000 + offset * 86_400_000).toISOString().slice(0, 10);
}

test.beforeAll(async () => {
  for (const [email, role, name] of [[managerEmail, "manager", "Meera Manager"], [adminEmail, "admin", "Arun Admin"]] as const) {
    const id = await createAuthUser(email, name);
    await sql("update public.profiles set role_key = $2, is_active = true, full_name = $3 where id = $1", [id, role, name]);
    const client = await signIn(email);
    secrets[email] = (await enrollAndVerifyMfa(client)).secret;
    if (role === "manager") api = client;
  }
  const cnc = (await sql<{ id: string }>("select id from public.work_categories where name = 'CNC Turning'"))[0]!.id;
  const { data: v, error: ve } = await api.rpc("save_vendor", { p_vendor_id: null, p_expected_version: null, p: { name: "Ganesh Engineering", category_ids: [cnc] } });
  if (ve) throw ve;
  const { data, error } = await api.rpc("create_job", {
    p: { part_label: "E2E-6001 / Flange", qty_sent: 100, category_id: cnc,
         vendor: { vendor_id: (v as { id: string }).id, dispatched_on: istDate(-6), commitment_date: istDate(4), amount: 48000 } },
  });
  if (error) throw error;
  jobId = (data as { id: string }).id;
});
test.afterAll(async () => {
  await closeSql();
});

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByLabel("6-digit code").waitFor();
  const remaining = 30_000 - (Date.now() % 30_000);
  if (remaining < 4_000) await page.waitForTimeout(remaining + 300);
  await page.getByLabel("6-digit code").fill(totp(secrets[email]!));
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByRole("heading", { name: /Welcome/ })).toBeVisible();
}

test("Examples 3 and 4: 60 of 100 back, 55 accepted and 5 rejected, then the rest; the job completes only after inspection", async ({ page }) => {
  await login(page, managerEmail);
  await page.goto(`/jobs/${jobId}`);
  const card = page.locator("section").filter({ has: page.getByRole("heading", { name: "Material returns and quality inspection" }) });

  await card.getByRole("button", { name: "Record return" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Quantity received").fill("60");
  await dialog.getByLabel("Delivery challan number (optional)").fill("DC-778");
  await dialog.getByRole("button", { name: "Save return" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Quality Inspection Pending").first()).toBeVisible();
  await expect(card.getByText("With vendor", { exact: true }).locator("..")).toContainText("40");
  await expect(card.getByText("Awaiting inspection", { exact: true }).locator("..")).toContainText("60");

  await card.getByRole("button", { name: "Inspect 60" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Accepted").fill("55");
  await dialog.getByLabel("Rejected").fill("5");
  await dialog.getByLabel("Inspection remarks").fill("5 pcs undersize");
  await dialog.getByRole("button", { name: "Save inspection" }).click();
  await expect(dialog).toBeHidden();
  await expect(card.getByText("Partially Accepted").first()).toBeVisible();
  await expect(card.getByText("Accepted 55 · Rejected 5 · Rework 0")).toBeVisible();
  await expect(page.getByText("Partially Returned").first()).toBeVisible();

  await card.getByRole("button", { name: "Record return" }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Quantity received")).toHaveValue("40");
  await dialog.getByLabel("Record the quality inspection now").check();
  await dialog.getByRole("button", { name: "All 40 accepted" }).click();
  await dialog.getByRole("button", { name: "Save return" }).click();
  await expect(dialog.getByText("the job is now Completed")).toBeVisible();
  await dialog.locator("footer").getByRole("button", { name: "Close" }).click();
  await expect(page.getByText("All 100 pieces returned and inspected: 95 accepted, 5 rejected.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Reopen job" })).toBeVisible();

  // Managers see payments but cannot record them
  const payments = page.locator("section").filter({ has: page.getByRole("heading", { name: "Payments", exact: true }) });
  await expect(payments.getByText("View only. Payments are recorded by an Admin.")).toBeVisible();
  await expect(payments.getByRole("button", { name: "Add payment" })).toHaveCount(0);
});

test("Example 5: Admin records the invoice and payments; balance, statuses, statement", async ({ page }) => {
  await login(page, adminEmail);
  await page.goto(`/jobs/${jobId}`);
  const payments = page.locator("section").filter({ has: page.getByRole("heading", { name: "Payments", exact: true }) });

  await payments.getByRole("button", { name: "Record invoice" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Invoice number").fill("GE/1187");
  await dialog.getByLabel("Invoice amount (₹)").fill("50000");
  await dialog.getByLabel("Reason for changing the job amount (required)").fill("Final invoice includes deburring");
  await dialog.getByRole("button", { name: "Save invoice" }).click();
  await expect(dialog).toBeHidden();

  for (const [kind, amount] of [["Advance", "20000"], ["Payment", "15000"]] as const) {
    await payments.getByRole("button", { name: "Add payment" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel(kind, { exact: true }).check();
    await dialog.getByLabel("Amount paid (₹)").fill(amount);
    await dialog.getByLabel("Transaction reference (UTR / cheque no.)").fill(`UTR-${amount}`);
    await dialog.getByRole("button", { name: "Save payment" }).click();
    await expect(dialog).toBeHidden();
  }
  await expect(payments.getByText("Partially Paid")).toBeVisible();
  await expect(payments.getByText("Total payable").locator("..")).toContainText("₹50,000.00");
  await expect(payments.getByText("Amount paid (incl. advance)").locator("..")).toContainText("₹35,000.00");
  await expect(payments.getByText("Balance", { exact: true }).locator("..")).toContainText("₹15,000.00");

  // overpayment is refused in the form
  await payments.getByRole("button", { name: "Add payment" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Amount paid (₹)").fill("16000");
  await expect(dialog.getByText("This is more than the balance of ₹15,000.00.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Save payment" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();

  await page.getByRole("link", { name: "Payments", exact: true }).click();
  await expect(page.getByRole("row", { name: /E2E-6001/ }).getByText("₹15,000.00").first()).toBeVisible();
  await page.getByRole("tab", { name: "Vendor-wise" }).click();
  await page.getByRole("row", { name: /Ganesh Engineering/ }).getByRole("button", { name: "Statement" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("From").fill("");
  await expect(dialog.getByRole("row", { name: /Closing balance/ })).toContainText("₹15,000.00");
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download Excel" }).click();
  expect((await download).suggestedFilename()).toMatch(/^CESS-Statement-Ganesh-Engineering-.*\.xlsx$/);
});

test("Phase 6 screens fit a phone screen", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 851 });
  await login(page, adminEmail);
  for (const path of [`/jobs/${jobId}`, "/payments", "/payments?tab=vendors", "/payments?tab=periods", "/payments?tab=history"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await expect
      .poll(async () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), { timeout: 5_000, message: path })
      .toBeLessThanOrEqual(1);
  }
});
