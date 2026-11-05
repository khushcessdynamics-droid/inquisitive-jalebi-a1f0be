import { defineConfig, devices } from "@playwright/test";

// Pre-deployment checks of the PRODUCTION build, served like Cloudflare Pages (security headers, CSP, SPA routing),
// against the LOCAL Supabase stack. `npm run test:prod` builds apps/web/dist and apps/web/dist-captcha first.
export default defineConfig({
  testDir: "tests/prod",
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "production-build", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    { command: "node scripts/serve-dist.mjs apps/web/dist 4173", url: "http://127.0.0.1:4173", reuseExistingServer: false, timeout: 30_000 },
    { command: "node scripts/serve-dist.mjs apps/web/dist-captcha 4174", url: "http://127.0.0.1:4174", reuseExistingServer: false, timeout: 30_000 },
  ],
});
