import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import ExcelJS from "exceljs";
import { PASSWORD, closeSql, createAuthUser, enrollAndVerifyMfa, signIn, sql, uniqueEmail } from "../helpers/clients";
import { totp } from "../helpers/totp";

const managerEmail = uniqueEmail("e2e.manager");
let secret = "";

test.describe.configure({ mode: "serial" });

function istDate(offset = 0): string {
  return new Date(Date.now() + 330 * 60_000 + offset * 86_400_000).toISOString().slice(0, 10);
}
function dmy(iso: string): string {
  return `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;
}

test.beforeAll(async () => {
  const id = await createAuthUser(managerEmail, "Mona Manager");
  await sql("update public.profiles set role_key = 'manager', is_active = true, full_name = 'Mona Manager' where id = $1", [id]);
  // Excel import is Admin-only by default; grant it to this Manager as a personal exception
  await sql("insert into public.user_permission_overrides (user_id, permission_key, granted, reason) values ($1, 'data.import', true, 'e2e test')", [id]);
  const client = await signIn(managerEmail);
  secret = (await enrollAndVerifyMfa(client)).secret;
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

test("Manager adds vendors, creates a job, cancels and forwards it, and uploads a drawing", async ({ page }) => {
  await login(page);

  // vendors
  await page.getByRole("link", { name: "Vendors", exact: true }).click();
  for (const [name, category] of [["Shree Engineering", "CNC Turning"], ["Precision Works", null]] as const) {
    await page.getByRole("button", { name: "Add vendor" }).click();
    await page.getByLabel("Vendor name (as used on jobs)").fill(name);
    await page.getByLabel("Mobile number").fill("98220 12345");
    if (category) await page.getByRole("checkbox", { name: category }).check();
    await page.getByRole("button", { name: "Save vendor" }).click();
    await expect(page.getByRole("link", { name })).toBeVisible();
  }

  // new job
  await page.getByRole("link", { name: "New Job", exact: true }).click();
  await page.getByLabel("Part No / Part Name").fill("4711 / Drive Shaft");
  await page.getByLabel("Quantity sent").fill("100");
  await page.getByLabel("Work / machining category").selectOption({ label: "CNC Turning" });
  await page.getByLabel("Given By").selectOption({ label: "Samyak" });
  await page.getByLabel("Vendor", { exact: true }).selectOption({ label: "Shree Engineering ✓ does this work" });
  await page.getByLabel("Vendor committed delivery date").fill(istDate(2));
  await page.getByLabel("Estimated amount (₹)").fill("12500");
  await page.getByRole("button", { name: "Save and send to vendor" }).click();

  await expect(page.getByText(/Job JOB-\d{4}-0001 saved/)).toBeVisible();
  await expect(page.getByText("Due Soon").first()).toBeVisible();
  await expect(page.getByText("₹12,500.00").first()).toBeVisible();

  // attachment
  await page.locator('input[type="file"]').setInputFiles({ name: "drawing rev A.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 drawing") });
  await expect(page.getByText("drawing rev A.pdf")).toBeVisible();

  // cancel and forward
  await page.getByRole("button", { name: "Cancel / forward vendor" }).click();
  await page.getByLabel("Reason").selectOption({ label: "Vendor failed to meet delivery commitment" });
  await page.getByLabel("What happened (saved with the cancellation)").fill("Machine breakdown, cannot deliver this week");
  await page.locator("#fw-vendor").selectOption({ label: "Precision Works" });
  await page.locator("#fw-commit").fill(istDate(6));
  await page.getByRole("button", { name: "Cancel and forward" }).click();

  // vendor names appear in the vendor journey and in the commitment timeline
  await expect(page.getByText("2. Precision Works").first()).toBeVisible();
  await expect(page.getByText("1. Shree Engineering").first()).toBeVisible();
  await expect(page.getByText("Vendor-caused")).toBeVisible();
  await expect(page.getByText("forwarded to Precision Works")).toBeVisible();
  await expect(page.getByText("Cancelled and forwarded to another vendor")).toBeVisible(); // job history

  // register
  await page.getByRole("link", { name: "Jobs Register", exact: true }).click();
  await expect(page.getByRole("cell", { name: /4711 \/ Drive Shaft/ })).toBeVisible();
  await expect(page.getByText("2 vendors (forwarded)")).toBeVisible();
  await page.getByLabel("Search job ID, part or vendor").fill("Shaft");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByText("1 job · page 1 of 1")).toBeVisible();
});

test("Excel import of the original tracker layout with preview, then classifying an imported cancellation", async ({ page }) => {
  // workbook in the layout of CESS_Machining_Job_Tracker.xlsx
  const wb = new ExcelJS.Workbook();
  const entry = wb.addWorksheet("ENTRY");
  entry.addRow(["MACHINING JOB ENTRY"]);
  entry.addRow(["Enter only the white columns."]);
  entry.addRow([]);
  entry.addRow(["Go to DASHBOARD"]);
  entry.addRow(["Sr No", "Part No / Name", "Date Given to Vendor", "Date Returned by Vendor", "Vendor Name", "Given By", "Work / Machining Process", "Amount (₹)", "Days Taken", "Status", "Cancelled On", "Forwarded To", "Remarks"]);
  entry.addRow([1, "P-100 / Flange", dmy(istDate(-20)), null, "Old Turner", "Vansh", "VMC Machining", 5000, null, null, dmy(istDate(-12)), "Shree Engineering", "late"]);
  entry.addRow([2, "P-200 / Pin", dmy(istDate(-15)), dmy(istDate(-9)), "Shree Engineering", "Sanjay", "Grinding", 800]);
  entry.addRow([3, "P-100 / Flange", dmy(istDate(-12)), null, "Shree Engineering", "Vansh", "VMC Machining", 5600]);
  const vend = wb.addWorksheet("VENDORS");
  vend.addRow(["VENDOR MASTER"]);
  vend.addRow([]);
  vend.addRow([]);
  vend.addRow([]);
  vend.addRow(["Sr No", "Vendor Name", "Company Name", "Work Category", "Address", "Phone No", "Email", "GST No"]);
  vend.addRow([1, "Old Turner", "Old Turner Works", "VMC Machining", "MIDC", "9822012345", "", ""]);
  vend.addRow([2, "Shree Engineering", "Shree Engg", "CNC Turning", "", "", "", ""]);
  const file = join(mkdtempSync(join(tmpdir(), "cess-e2e-")), "CESS_Machining_Job_Tracker.xlsx");
  await wb.xlsx.writeFile(file);

  await login(page);
  await page.getByRole("link", { name: "Excel Import / Export", exact: true }).click();
  await page.locator('input[type="file"]').setInputFiles(file);
  await expect(page.getByText(/original Excel tracker/)).toBeVisible();
  await expect(page.getByText(/forming/)).toContainText("2 job(s)");

  // vendors: Shree Engineering already exists, Old Turner is new
  await page.getByRole("button", { name: "Check" }).first().click();
  await expect(page.getByText("Already exists", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Import vendors" }).click();
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.getByText(/^Saved:/).first()).toBeVisible();

  // jobs: preview, then import
  await page.getByRole("button", { name: "Check" }).last().click();
  await expect(page.getByText(/Preview \(nothing saved yet\)/)).toBeVisible();
  await page.getByRole("button", { name: "Import jobs" }).click();
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.getByRole("link", { name: /JOB-\d{4}-\d{4}/ }).first()).toBeVisible();

  // the imported cancellation has no recorded reason: classify it
  await page.getByRole("link", { name: "Missing Data", exact: true }).click();
  await expect(page.getByText("Cancellation not classified").first()).toBeVisible();
  await page.getByRole("button", { name: "Classify" }).click();
  await page.getByLabel("Reason").selectOption({ label: "Vendor: Vendor failed to meet delivery commitment" });
  await page.getByLabel("How do you know? (saved in the history)").fill("Confirmed with Vansh");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("button", { name: "Classify" })).toHaveCount(0);
});

test("Jobs Register is usable on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 851 });
  await login(page);
  await page.goto("/jobs?tab=all");
  await expect(page.getByRole("heading", { name: "Jobs Register" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(overflow).toBe(false);
});
