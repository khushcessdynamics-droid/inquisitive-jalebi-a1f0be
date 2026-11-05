// Pre-deployment checks of the production build served like Cloudflare Pages: security headers, single-page routing,
// no Content-Security-Policy violations in the main screens (charts, PDF, Excel, WhatsApp), and the optional
// Turnstile CAPTCHA wiring (token sent to Supabase Auth). Uses the LOCAL Supabase stack.
import { existsSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PASSWORD, closeSql, createAuthUser, enrollAndVerifyMfa, signIn, sql, uniqueEmail } from "../helpers/clients";
import { totp } from "../helpers/totp";

const APP = "http://127.0.0.1:4173";
const CAPTCHA_APP = "http://127.0.0.1:4174";
const email = uniqueEmail("prod.mgr");
let secret = "";
let api: SupabaseClient;
let jobId = "";

test.describe.configure({ mode: "serial" });

function istDate(offset = 0): string {
  return new Date(Date.now() + 330 * 60_000 + offset * 86_400_000).toISOString().slice(0, 10);
}

test.beforeAll(async () => {
  const id = await createAuthUser(email, "Prod Manager");
  await sql("update public.profiles set role_key = 'manager', is_active = true, full_name = 'Prod Manager' where id = $1", [id]);
  api = await signIn(email);
  secret = (await enrollAndVerifyMfa(api)).secret;
  const cnc = (await sql<{ id: string }>("select id from public.work_categories where name = 'CNC Turning'"))[0]!.id;
  const { data: v } = await api.rpc("save_vendor", { p_vendor_id: null, p_expected_version: null, p: { name: "Prod Vendor", wa_number: "9822012345", category_ids: [cnc] } });
  const { data, error } = await api.rpc("create_job", {
    p: { part_label: "PROD-1 / Shaft", qty_sent: 10, category_id: cnc, vendor: { vendor_id: (v as { id: string }).id, dispatched_on: istDate(-5), commitment_date: istDate(-1), amount: 1000 } },
  });
  if (error) throw error;
  jobId = (data as { id: string }).id;
});
test.afterAll(async () => {
  await closeSql();
});

function watchCsp(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy|Refused to (load|connect|execute|apply|frame)/i.test(m.text())) problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
  return problems;
}

async function login(page: Page, base: string) {
  await page.addInitScript(() => {
    window.open = (() => null) as typeof window.open;
  });
  await page.goto(`${base}/login`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByLabel("6-digit code").waitFor();
  const remaining = 30_000 - (Date.now() % 30_000);
  if (remaining < 4_000) await page.waitForTimeout(remaining + 300);
  await page.getByLabel("6-digit code").fill(totp(secret));
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByRole("heading", { name: /Welcome/ })).toBeVisible();
}

test("security headers, caching and single-page routing", async ({ request }) => {
  const home = await request.get(`${APP}/`);
  expect(home.status()).toBe(200);
  const h = home.headers();
  expect(h["content-security-policy"]).toMatch(/default-src 'self'/);
  expect(h["content-security-policy"]).toMatch(/connect-src 'self' http:\/\/127\.0\.0\.1:54321 ws:\/\/127\.0\.0\.1:54321/);
  expect(h["content-security-policy"]).toMatch(/frame-ancestors 'none'/);
  expect(h["content-security-policy"]).toMatch(/frame-src 'none'/);
  expect(h["x-frame-options"]).toBe("DENY");
  expect(h["x-content-type-options"]).toBe("nosniff");
  expect(h["strict-transport-security"]).toMatch(/max-age=31536000/);
  expect(h["cache-control"]).toBe("no-cache");
  const deep = await request.get(`${APP}/jobs/${jobId}`);
  expect(deep.status()).toBe(200);
  expect(await deep.text()).toContain('<div id="root">');
  expect(deep.headers()["content-security-policy"]).toBe(h["content-security-policy"]);
  // no catch-all rewrite: Cloudflare Pages applies _redirects even to real files; its SPA mode needs none
  expect(existsSync("apps/web/dist/_redirects")).toBe(false);
  expect(existsSync("apps/web/dist/404.html")).toBe(false);
  const asset = (await home.text()).match(/\/assets\/[^"]+\.js/)![0];
  expect((await request.get(`${APP}${asset}`)).headers()["cache-control"]).toMatch(/immutable/);
  expect((await request.get(`${APP}/_headers`)).status()).toBe(400);
});

test("the main screens work under the Content-Security-Policy (charts, PDF, Excel, WhatsApp)", async ({ page }) => {
  const problems = watchCsp(page);
  await login(page, APP);
  await expect(page.getByText("Monthly job trend")).toBeVisible();
  await expect(page.locator(".recharts-surface").first()).toBeVisible();
  await page.goto(`${APP}/jobs/${jobId}`);
  await page.getByRole("button", { name: "WhatsApp", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Open WhatsApp" }).click();
  await expect(page.getByRole("dialog").getByText("WhatsApp was opened with your message")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.goto(`${APP}/jobs`);
  const xlsx = page.waitForEvent("download");
  await page.getByRole("button", { name: /Export to Excel/ }).click();
  expect((await xlsx).suggestedFilename()).toMatch(/\.xlsx$/);
  await page.goto(`${APP}/reports`);
  await page.getByRole("button", { name: "Make report" }).click();
  await expect(page.getByRole("heading", { name: "A. Job summary" })).toBeVisible();
  const pdf = page.waitForEvent("download");
  await page.getByRole("button", { name: "PDF" }).click();
  expect((await pdf).suggestedFilename()).toMatch(/\.pdf$/);
  await page.goto(`${APP}/payments?tab=periods`);
  await expect(page.getByText("Paid per month (net of reversals)")).toBeVisible();
  expect(problems).toEqual([]);
});

test("optional CAPTCHA: the Turnstile token is sent to Supabase Auth and the CSP allows only Cloudflare's challenge", async ({ page, request }) => {
  const csp = (await request.get(`${CAPTCHA_APP}/`)).headers()["content-security-policy"]!;
  expect(csp).toMatch(/script-src 'self' https:\/\/challenges\.cloudflare\.com/);
  expect(csp).toMatch(/frame-src https:\/\/challenges\.cloudflare\.com/);
  // stand-in for Cloudflare's script: renders a widget that "solves" immediately
  await page.route("https://challenges.cloudflare.com/**", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `window.turnstile = { render(el, o) { el.textContent = "Security check passed"; setTimeout(() => o.callback("test-captcha-token"), 50); return "w1"; }, reset() {}, remove() {} };`,
    }),
  );
  let sentToken: string | null = null;
  await page.route("**/auth/v1/token**", async (route) => {
    const body = route.request().postDataJSON() as { gotrue_meta_security?: { captcha_token?: string } };
    sentToken = body.gotrue_meta_security?.captcha_token ?? null;
    await route.continue();
  });
  await page.goto(`${CAPTCHA_APP}/login`);
  await expect(page.getByTestId("captcha")).toHaveText("Security check passed");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByLabel("6-digit code").waitFor();
  expect(sentToken).toBe("test-captcha-token");
});
