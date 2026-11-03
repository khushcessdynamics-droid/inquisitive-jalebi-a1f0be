import { expect, test, type Page } from "@playwright/test";
import { PASSWORD, closeSql, createAuthUser, sql, uniqueEmail } from "../helpers/clients";
import { totp } from "../helpers/totp";

const adminEmail = uniqueEmail("e2e.admin");
const staffEmail = uniqueEmail("e2e.staff");
let inviteLink = "";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await createAuthUser(adminEmail, "Nityam Admin");
  await sql("select private.bootstrap_first_admin($1)", [adminEmail]);
});
test.afterAll(async () => {
  await closeSql();
});

async function signIn(page: Page, email: string, password = PASSWORD) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

async function enterCode(page: Page, secret: string) {
  // avoid the last 3 seconds of a 30-second window
  const remaining = 30_000 - (Date.now() % 30_000);
  if (remaining < 3_000) await page.waitForTimeout(remaining + 200);
  await page.getByLabel("6-digit code").fill(totp(secret));
}

test("Admin signs in, must set up MFA, then changes a setting that appears in the activity history", async ({ page }) => {
  await signIn(page, adminEmail);
  await expect(page.getByRole("heading", { name: "Set up two-factor authentication" })).toBeVisible();
  await expect(page.getByAltText("QR code for your authenticator app")).toBeVisible();
  const secret = (await page.getByTestId("totp-secret").textContent())!.trim();
  await enterCode(page, secret);
  await page.getByRole("button", { name: "Activate" }).click();

  await expect(page.getByRole("heading", { name: /Welcome, Nityam Admin/ })).toBeVisible();
  await expect(page.getByText("On (verified this session)")).toBeVisible();
  await expect(page.getByRole("link", { name: "Users", exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByLabel("Company name").fill("CESS Dynamics Pvt Ltd");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();

  await page.getByRole("tab", { name: "Reliability score" }).click();
  await page.getByLabel("On-time delivery (%)").fill("35");
  await expect(page.getByText("Total: 105 / 100")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save changes" })).toBeDisabled();

  await page.getByRole("link", { name: "Activity History", exact: true }).click();
  await expect(page.getByRole("cell", { name: /Setting changed/ }).first()).toBeVisible();
  await page.getByRole("cell", { name: /Setting changed/ }).first().click();
  await expect(page.getByText("CESS Dynamics Pvt Ltd").first()).toBeVisible();
});

test("Admin invites a Staff user and gets a one-time link", async ({ page }) => {
  // the previous test's session is in another browser context; sign in again (MFA code required)
  await signIn(page, adminEmail);
  await expect(page.getByRole("heading", { name: "Two-factor authentication" })).toBeVisible();
  const rows = await sql<{ secret: string }>(
    "select f.secret from auth.mfa_factors f join auth.users u on u.id = f.user_id where u.email = $1 and f.status = 'verified'",
    [adminEmail],
  );
  await enterCode(page, rows[0]!.secret);
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByRole("heading", { name: /Welcome/ })).toBeVisible();

  await page.getByRole("link", { name: "Users", exact: true }).click();
  await page.getByRole("button", { name: "Invite user" }).click();
  await page.getByLabel("Full name").fill("Sanjay Staff");
  await page.getByLabel("Email", { exact: true }).fill(staffEmail);
  await page.getByLabel("Role").selectOption("staff");
  await page.getByRole("button", { name: "Create invitation link" }).click();
  const linkBox = page.getByLabel("One-time link");
  await expect(linkBox).toHaveValue(/\/auth\/confirm\?token_hash=/);
  inviteLink = await linkBox.inputValue();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("cell", { name: /Sanjay Staff/ })).toBeVisible();
  await expect(page.getByText("Invited")).toBeVisible();
});

test("Staff accepts the invitation, sets a password and only sees permitted pages", async ({ page }) => {
  await page.goto(inviteLink);
  await expect(page.getByRole("heading", { name: /choose your password/ })).toBeVisible();
  await expect(page).toHaveURL(/\/set-password/); // token removed from the address bar
  await page.getByLabel("New password", { exact: true }).fill("weak");
  await expect(page.getByRole("listitem").filter({ hasText: "At least 12 characters" })).toBeVisible();
  await page.getByLabel("New password", { exact: true }).fill("Staff-Passw0rd-2026");
  await page.getByLabel("Confirm new password").fill("Staff-Passw0rd-2026");
  await page.getByRole("button", { name: "Save password" }).click();

  await expect(page.getByRole("heading", { name: /Welcome, Sanjay Staff/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "Users", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toHaveCount(0);
  await page.goto("/admin/users");
  await expect(page.getByText("You do not have permission to open this page.")).toBeVisible();

  // the invitation link cannot be used a second time
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.goto(inviteLink);
  await expect(page.getByText(/expired or was already used/)).toBeVisible();
});
