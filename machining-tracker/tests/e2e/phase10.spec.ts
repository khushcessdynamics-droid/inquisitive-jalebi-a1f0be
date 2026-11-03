// Phase 10 in the browser:
//  * every page, opened as Admin, Manager and Staff: pages a role may use open without errors (no crash, no console
//    error, no failed request, every button has a readable name); pages it may not use show "No access"
//  * two tabs editing the same job: the second save is refused with a clear message, nothing is silently overwritten
//  * repeated failed sign-ins: the sign-in page explains the block (the limit itself is Supabase's, checked on the live project)
import { expect, test, type Page } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PASSWORD, closeSql, createAuthUser, enrollAndVerifyMfa, signIn, sql, uniqueEmail } from "../helpers/clients";
import { totp } from "../helpers/totp";

type Role = "admin" | "manager" | "staff";
const emails: Record<Role, string> = { admin: uniqueEmail("e2e.p10a"), manager: uniqueEmail("e2e.p10m"), staff: uniqueEmail("e2e.p10s") };
const secrets: Record<string, string> = {};
const ids: Record<string, string> = {};
let staffJobId = "";

test.describe.configure({ mode: "serial" });

// route -> permissions that open it (from App.tsx); null = every signed-in user
const ROUTES: [string, string[] | null][] = [
  ["/", null],
  ["/account", null],
  ["/notifications", null],
  ["/admin/users", ["users.manage"]],
  ["/admin/permissions", ["users.manage"]],
  ["/settings", ["settings.change", "users.manage"]],
  ["/activity", ["activity.view"]],
  ["/system", ["system.view"]],
  ["/jobs", ["jobs.view_all", "jobs.view_assigned"]],
  ["/jobs/new", ["jobs.create"]],
  ["/jobs/review", ["jobs.view_all", "jobs.view_assigned"]],
  ["/jobs/:job", ["jobs.view_all", "jobs.view_assigned"]],
  ["/vendors", ["vendors.view"]],
  ["/vendors/reliability", ["reliability.view"]],
  ["/vendors/:vendor", ["vendors.view"]],
  ["/quotes", ["costcompare.view"]],
  ["/quotes/history", ["costcompare.view"]],
  ["/quotes/:quote", ["costcompare.view"]],
  ["/reports", ["reports.view"]],
  ["/quality", ["quality.manage", "returns.record", "reports.view"]],
  ["/whatsapp", ["whatsapp.send"]],
  ["/payments", ["payments.view"]],
  ["/data", ["data.import", "reports.export"]],
];

async function permissionsOf(role: Role): Promise<Set<string>> {
  if (role === "admin") return new Set((await sql<{ key: string }>("select key from public.permissions")).map((r) => r.key));
  return new Set((await sql<{ k: string }>("select permission_key as k from public.role_permissions where role_key = $1", [role])).map((r) => r.k));
}

test.beforeAll(async () => {
  let manager: SupabaseClient | null = null;
  for (const role of ["admin", "manager", "staff"] as Role[]) {
    const id = await createAuthUser(emails[role], `P10 ${role}`);
    await sql("update public.profiles set role_key = $2, is_active = true, full_name = $3 where id = $1", [id, role, `Phase10 ${role[0]!.toUpperCase()}${role.slice(1)}`]);
    ids[role] = id;
    if (role !== "staff") {
      const c = await signIn(emails[role]);
      secrets[emails[role]] = (await enrollAndVerifyMfa(c)).secret;
      if (role === "manager") manager = c;
    }
  }
  const api = manager!;
  const cnc = (await sql<{ id: string }>("select id from public.work_categories where name = 'CNC Turning'"))[0]!.id;
  const { data: v, error: ve } = await api.rpc("save_vendor", { p_vendor_id: null, p_expected_version: null, p: { name: "Phase10 Tools", wa_number: "9822011111", category_ids: [cnc] } });
  if (ve) throw ve;
  ids.vendor = (v as { id: string }).id;
  const day = (o: number) => new Date(Date.now() + 330 * 60_000 + o * 86_400_000).toISOString().slice(0, 10);
  const { data: j, error: je } = await api.rpc("create_job", {
    p: { part_label: "P10-1 / Spindle", qty_sent: 20, category_id: cnc, assigned_staff_id: ids.staff, vendor: { vendor_id: ids.vendor, dispatched_on: day(-4), commitment_date: day(2), amount: 4000 } },
  });
  if (je) throw je;
  staffJobId = (j as { id: string }).id;
  const { data: q, error: qe } = await api.rpc("save_quotation_request", { p_request_id: null, p_expected_version: null, p: { part_label: "P10-Q / Sleeve", category_id: cnc, qty: 10 } });
  if (qe) throw qe;
  ids.quote = (q as { id: string }).id;
});
test.afterAll(async () => {
  await closeSql();
});

function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`crash: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console: ${m.text()}`);
  });
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().includes("/auth/v1/logout")) problems.push(`request ${r.status()}: ${r.request().method()} ${r.url().replace(/\?.*/, "")}`);
  });
  return problems;
}

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  if (secrets[email]) {
    await page.getByLabel("6-digit code").waitFor();
    const remaining = 30_000 - (Date.now() % 30_000);
    if (remaining < 4_000) await page.waitForTimeout(remaining + 300);
    await page.getByLabel("6-digit code").fill(totp(secrets[email]!));
    await page.getByRole("button", { name: "Verify" }).click();
  }
  await expect(page.getByRole("heading", { name: /Welcome/ })).toBeVisible();
}

for (const role of ["admin", "manager", "staff"] as Role[]) {
  test(`every page as ${role}: allowed pages open cleanly, the others show "No access"`, async ({ page }) => {
    test.setTimeout(240_000);
    const perms = await permissionsOf(role);
    const problems = watch(page);
    await login(page, emails[role]);
    const report: string[] = [];
    for (const [pattern, need] of ROUTES) {
      const path = pattern.replace(":job", staffJobId).replace(":vendor", ids.vendor!).replace(":quote", ids.quote!);
      const allowed = need === null || need.some((p) => perms.has(p));
      problems.length = 0;
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      await expect(page.locator("main").first()).toBeVisible();
      const noAccess = page.getByText("You do not have permission to open this page.");
      if (!allowed) {
        await expect(noAccess, `${role} ${path}`).toBeVisible();
        continue;
      }
      await expect(page.getByRole("heading").first(), `${role} ${path}`).toBeVisible();
      await expect(noAccess, `${role} ${path}`).toHaveCount(0);
      await expect(page.getByText("This page could not be displayed")).toHaveCount(0);
      const unnamed = await page.evaluate(() =>
        Array.from(document.querySelectorAll("button, a[href], [role=button]"))
          .filter((el) => (el as HTMLElement).offsetParent !== null)
          .filter((el) => !(el.getAttribute("aria-label") || el.getAttribute("title") || (el.textContent ?? "").trim() || el.getAttribute("aria-labelledby")))
          .map((el) => el.outerHTML.slice(0, 120)),
      );
      expect(unnamed, `${role} ${path}: buttons or links without a readable name`).toEqual([]);
      if (problems.length) report.push(`${path}: ${problems.join(" | ")}`);
    }
    expect(report, `${role}: errors while opening pages`).toEqual([]);
  });
}

test("two tabs editing the same job: the other tab is warned, keeps its typing, and its save is refused", async ({ browser }) => {
  const context = await browser.newContext();
  const a = await context.newPage();
  await login(a, emails.manager);
  const b = await context.newPage();
  await a.goto(`/jobs/${staffJobId}`);
  await b.goto(`/jobs/${staffJobId}`);
  await a.getByRole("button", { name: "Edit job" }).click();
  await b.getByRole("button", { name: "Edit job" }).click();
  await a.getByRole("dialog").getByLabel("Remarks").fill("Changed in tab A");
  await b.getByRole("dialog").getByLabel("Remarks").fill("Changed in tab B");
  await a.getByRole("dialog").getByRole("button", { name: "Save changes" }).click();
  await expect(a.getByRole("dialog")).toHaveCount(0);
  await expect(a.getByText("Changed in tab A").first()).toBeVisible();
  // tab B learns about it (live update), keeps its own typing, and saving it must not overwrite tab A's change
  const dialogB = b.getByRole("dialog");
  await expect(dialogB.getByText("Changed by someone else")).toBeVisible();
  await expect(dialogB.getByLabel("Remarks")).toHaveValue("Changed in tab B");
  await dialogB.getByRole("button", { name: "Save changes" }).click();
  await expect(dialogB.getByText(/was changed by someone else\. Reload and try again\./)).toBeVisible();
  const saved = await sql<{ remarks: string }>("select remarks from public.jobs where id = $1", [staffJobId]);
  expect(saved[0]!.remarks).toBe("Changed in tab A");
  await context.close();
});

test("repeated failed sign-ins: the sign-in page explains the block", async ({ page }) => {
  await page.route("**/auth/v1/token**", (route) =>
    route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ code: "over_request_rate_limit", message: "Request rate limit reached" }) }),
  );
  await page.goto("/login");
  await page.getByLabel("Email").fill(emails.staff);
  await page.getByLabel("Password").fill("wrong-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Too many sign-in attempts. Please wait a few minutes and try again.")).toBeVisible();
});

test("Admin resets a Manager's authenticator (lost phone); the Manager must set up a new one", async ({ page, browser }) => {
  await login(page, emails.admin);
  await page.getByRole("link", { name: "Users", exact: true }).click();
  await page.getByRole("button", { name: `Actions for ${emails.manager}` }).click();
  await page.getByRole("button", { name: "Reset authenticator" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(/lost or replaced their phone/)).toBeVisible();
  await dialog.getByLabel("Reason (saved in the activity history)").fill("Phone lost, confirmed by call");
  await dialog.getByRole("button", { name: "Reset authenticator" }).click();
  await expect(page.getByText(/authenticator of .* was reset/)).toBeVisible();
  expect((await sql("select 1 from auth.mfa_factors where user_id = $1", [ids.manager])).length).toBe(0);
  // the Admin's own row offers no reset
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: `Actions for ${emails.admin}` }).click();
  await expect(page.getByRole("button", { name: "Reset authenticator" })).toHaveCount(0);

  const context = await browser.newContext();
  const m = await context.newPage();
  await m.goto("/login");
  await m.getByLabel("Email").fill(emails.manager);
  await m.getByLabel("Password").fill(PASSWORD);
  await m.getByRole("button", { name: "Sign in" }).click();
  await expect(m.getByRole("heading", { name: "Set up two-factor authentication" })).toBeVisible();
  await context.close();
});
