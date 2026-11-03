// Phase 7 in the browser: WhatsApp click-to-chat (prepared message, opened-not-sent log, duplicate warning),
// reminders created by the server engine reaching the notification center, reminder and template settings, phone layout.
import { expect, test, type Page } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PASSWORD, closeSql, createAuthUser, enrollAndVerifyMfa, signIn, sql, uniqueEmail } from "../helpers/clients";
import { totp } from "../helpers/totp";

const managerEmail = uniqueEmail("e2e.p7m");
const adminEmail = uniqueEmail("e2e.p7a");
const secrets: Record<string, string> = {};
let api: SupabaseClient;
let jobId = "";
let jobNo = "";

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
  const { data: v, error: ve } = await api.rpc("save_vendor", { p_vendor_id: null, p_expected_version: null, p: { name: "Laxmi Precision", contact_person: "Mr. Kulkarni", wa_number: "98901 23456", category_ids: [cnc] } });
  if (ve) throw ve;
  const { data, error } = await api.rpc("create_job", {
    p: { part_label: "E2E-7001 / Spindle Nut", qty_sent: 25, category_id: cnc,
         vendor: { vendor_id: (v as { id: string }).id, dispatched_on: istDate(-8), commitment_date: istDate(-2) } },
  });
  if (error) throw error;
  jobId = (data as { id: string; job_no: string }).id;
  jobNo = (data as { job_no: string }).job_no;
  // the server's daily reminder run (normally pg_cron at 09:00 IST)
  await sql("select private.run_reminders(now(), true)");
});
test.afterAll(async () => {
  await closeSql();
});

async function login(page: Page, email: string) {
  // record instead of really opening WhatsApp
  await page.addInitScript(() => {
    (window as unknown as { __opened: string[] }).__opened = [];
    window.open = ((url: string) => {
      (window as unknown as { __opened: string[] }).__opened.push(String(url));
      return null;
    }) as typeof window.open;
  });
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

test("WhatsApp click-to-chat: prepared overdue message, logged as opened, marked sent by the user, duplicate warning", async ({ page }) => {
  await login(page, managerEmail);
  await page.goto(`/jobs/${jobId}`);
  await page.getByRole("button", { name: "WhatsApp", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Message")).toHaveValue("overdue");
  await expect(dialog.getByText("Mr. Kulkarni, Laxmi Precision · +919890123456")).toBeVisible();
  const text = dialog.getByLabel("Text (you can edit it before opening WhatsApp)");
  await expect(text).toHaveValue(new RegExp(`Dear Mr. Kulkarni,\\nJob ${jobNo} \\(E2E-7001 / Spindle Nut\\) was due on .* and is 2 days late. 25 pcs are still pending`));
  await text.fill(`${await text.inputValue()}\nPlease call me.`);
  await dialog.getByRole("button", { name: "Open WhatsApp" }).click();
  await expect(dialog.getByText("WhatsApp was opened with your message")).toBeVisible();
  const opened = await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);
  expect(opened).toHaveLength(1);
  expect(opened[0]).toMatch(/^https:\/\/wa\.me\/919890123456\?text=Dear%20Mr\.%20Kulkarni%2C%0AJob%20/);
  expect(decodeURIComponent(opened[0]!.split("text=")[1]!)).toContain("Please call me.");
  await dialog.getByRole("button", { name: "I pressed Send in WhatsApp" }).click();
  await expect(dialog.getByText("Marked as sent by you.")).toBeVisible();
  await dialog.locator("footer").getByRole("button", { name: "Close" }).click();

  const history = page.locator("section").filter({ has: page.getByRole("heading", { name: "WhatsApp with the vendor" }) });
  await expect(history.getByText("Marked as sent by Meera Manager")).toBeVisible();
  await expect(page.getByText("WhatsApp opened with a message")).toBeVisible(); // job history

  // the same message again within 12 hours asks first
  await page.getByRole("button", { name: "WhatsApp", exact: true }).click();
  await dialog.getByRole("button", { name: "Open WhatsApp" }).click();
  await expect(dialog.getByText(/already opened in WhatsApp at .* by Meera Manager/)).toBeVisible();
  await dialog.getByRole("button", { name: "Open again anyway" }).click();
  await expect(dialog.getByText("WhatsApp was opened with your message")).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened.length)).toBe(2);
});

test("reminders from the server engine reach the notification center", async ({ page }) => {
  await login(page, managerEmail);
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: /Notifications/ }).getByLabel(/unread/)).toBeVisible();
  await nav.getByRole("link", { name: /Notifications/ }).click();
  await expect(page.getByRole("link", { name: new RegExp(`${jobNo} overdue by 2 days · Laxmi Precision`) })).toBeVisible();
  await expect(page.getByText(/E2E-7001 \/ Spindle Nut · committed .* · 25 pcs with the vendor/)).toBeVisible();
  // one-click follow-up from the notification
  await page.getByRole("listitem").filter({ hasText: jobNo }).getByRole("button", { name: "WhatsApp" }).click();
  await expect(page.getByRole("dialog").getByLabel("Message")).toHaveValue("overdue");
  await page.getByRole("dialog").locator("footer").getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Mark all as read" }).click();
  await expect(page.getByText("No unread notifications")).toBeVisible();
  await expect(nav.getByRole("link", { name: /Notifications/ }).getByLabel(/unread/)).toHaveCount(0);
});

test("Admin: reminder schedule preview and template editing with placeholder checks", async ({ page }) => {
  await login(page, adminEmail);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Reminders" }).click();
  await expect(page.getByText(/Preview: a job committed for/)).toBeVisible();
  await expect(page.getByText(/\(due soon\) · .* \(due soon\) · .* \(due today\) · .* \(overdue\)/)).toBeVisible();
  await page.getByLabel("Run daily at (IST)").fill("08:30");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();

  await page.getByRole("tab", { name: "WhatsApp" }).click();
  const editor = page.locator("div.rounded-md.border").filter({ hasText: "Overdue job reminder" });
  const box = editor.getByRole("textbox");
  await box.fill("Dear {contact_person}, {job_no} is {delay_days} days late. {nonsense}");
  await expect(editor.getByText("Unknown placeholders: {nonsense}")).toBeVisible();
  await expect(editor.getByRole("button", { name: "Save template" })).toBeDisabled();
  await box.fill("Dear {contact_person}, job {job_no} is {delay_days} days late. Please call us. - {company}");
  await expect(editor.getByText("Dear Mr. Patil, job JOB-2627-0007 is 2 days late. Please call us. - CESS")).toBeVisible();
  await editor.getByRole("button", { name: "Save template" }).click();
  await expect(editor.getByText("Saved.")).toBeVisible();
});

test("Phase 7 screens fit a phone screen", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 851 });
  await login(page, managerEmail);
  await expect(page.getByRole("link", { name: /^Notifications/ }).first()).toBeVisible(); // bell in the phone header
  for (const path of ["/notifications", "/whatsapp", "/whatsapp?tab=history", `/jobs/${jobId}`]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await expect
      .poll(async () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), { timeout: 5_000, message: path })
      .toBeLessThanOrEqual(1);
  }
});
