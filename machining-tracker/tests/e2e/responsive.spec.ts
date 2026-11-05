import { expect, test } from "@playwright/test";

test("login page works on a phone screen", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  const box = await page.getByRole("button", { name: "Sign in" }).boundingBox();
  expect(box!.width).toBeGreaterThan(200);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
});
