#!/usr/bin/env node
// Checks a deployed copy of the app from the outside, without any secret: the public website (HTTPS, security headers,
// single-page routing, no secrets in the JavaScript) and the Supabase project (sign-ups closed, nothing readable
// without signing in, private file bucket, Edge Function accepts only the website's origin).
//
// Usage:
//   node tools/deploy-check/verify.mjs --site https://<your-site> --supabase https://<ref>.supabase.co --key <publishable key> [--report file.md]
// Add --allow-http only for testing against a local copy. --check-login-limit also tests that repeated failed sign-ins
// are blocked (it blocks sign-ins from the address running the check for about 5 minutes: never run it from the office).
import { writeFileSync } from "node:fs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? "true" : all[i + 1]]] : acc), []),
);
const site = (args.site ?? "").replace(/\/+$/, "");
const supa = (args.supabase ?? "").replace(/\/+$/, "");
const key = args.key ?? "";
const allowHttp = args["allow-http"] === "true";
if (!site || !supa || !key) {
  console.error("Usage: node tools/deploy-check/verify.mjs --site https://<your-site> --supabase https://<ref>.supabase.co --key <publishable key> [--report file.md]");
  process.exit(2);
}

const results = [];
const record = (level, check, detail) => {
  results.push({ level, check, detail });
  console.log(`${level.padEnd(4)} ${check}${detail ? ` — ${detail}` : ""}`);
};
const pass = (c, d) => record("PASS", c, d);
const fail = (c, d) => record("FAIL", c, d);
const warn = (c, d) => record("WARN", c, d);
async function get(url, init = {}) {
  return fetch(url, { redirect: "manual", ...init, signal: AbortSignal.timeout(20_000) });
}

// ---------------------------------------------------------------- website
async function website() {
  if (!site.startsWith("https://")) (allowHttp ? warn : fail)("Website uses HTTPS", site);
  else {
    pass("Website uses HTTPS", site);
    try {
      const r = await get(site.replace("https://", "http://") + "/");
      const loc = r.headers.get("location") ?? "";
      if ([301, 302, 307, 308].includes(r.status) && loc.startsWith("https://")) pass("Plain http:// is redirected to https://", `${r.status}`);
      else warn("Plain http:// is redirected to https://", `status ${r.status}`);
    } catch (e) {
      warn("Plain http:// is redirected to https://", String(e.message ?? e));
    }
  }
  const home = await get(`${site}/`);
  const html = await home.text();
  if (home.status === 200 && html.includes('<div id="root">')) pass("Home page loads", "200");
  else return fail("Home page loads", `status ${home.status}`);

  const h = home.headers;
  const csp = h.get("content-security-policy") ?? "";
  const need = [
    ["Content-Security-Policy present", csp.includes("default-src 'self'")],
    ["CSP blocks framing (frame-ancestors 'none')", csp.includes("frame-ancestors 'none'")],
    ["CSP allows only this Supabase project", csp.includes(supa)],
    ["CSP blocks plugins (object-src 'none')", csp.includes("object-src 'none'")],
    ["X-Frame-Options DENY", h.get("x-frame-options") === "DENY"],
    ["X-Content-Type-Options nosniff", h.get("x-content-type-options") === "nosniff"],
    ["Referrer-Policy set", !!h.get("referrer-policy")],
    ["Strict-Transport-Security (HSTS)", /max-age=\d{7,}/.test(h.get("strict-transport-security") ?? "")],
  ];
  for (const [label, ok] of need) (ok ? pass : fail)(label);
  (/no-cache|max-age=0/.test(h.get("cache-control") ?? "") ? pass : warn)("The app page is re-checked on every visit (updates reach users at once)", h.get("cache-control") ?? "none");

  const deep = await get(`${site}/jobs/00000000-0000-0000-0000-000000000000`);
  ((deep.status === 200 && (await deep.text()).includes('<div id="root">')) ? pass : fail)("Direct links (e.g. /jobs/...) open the app", `${deep.status}`);
  ((deep.headers.get("content-security-policy") ?? "") === csp && csp ? pass : fail)("Direct links get the same security headers");
  for (const f of ["/_headers", "/_redirects", "/.env", "/.env.local"]) {
    const r = await get(`${site}${f}`);
    const body = r.status === 200 ? await r.text() : "";
    (body.includes('<div id="root">') || r.status !== 200 ? pass : fail)(`${f} is not published`, `${r.status}`);
  }

  // every JavaScript file the app can load: entry + chunks referenced from it
  const seen = new Set();
  const queue = [...html.matchAll(/\/assets\/[A-Za-z0-9_.-]+\.js/g)].map((m) => m[0]);
  let containsProject = false;
  let secrets = [];
  while (queue.length && seen.size < 200) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    seen.add(path);
    const r = await get(`${site}${path}`);
    if (r.status !== 200) continue;
    if (path === [...seen][0]) (/immutable/.test(r.headers.get("cache-control") ?? "") ? pass : warn)("Script files are cached long-term (immutable)");
    const js = await r.text();
    for (const m of js.matchAll(/(?:\.\/|\/assets\/)([A-Za-z0-9_.-]+\.js)/g)) queue.push(`/assets/${m[1]}`);
    if (js.includes(supa)) containsProject = true;
    if (/sb_secret_[A-Za-z0-9_-]{10,}/.test(js)) secrets.push(`${path}: Supabase secret key`);
    if (/postgres(ql)?:\/\/[^"'\s]*:[^"'\s]*@/.test(js)) secrets.push(`${path}: database connection string`);
    for (const t of js.matchAll(/eyJ[A-Za-z0-9_-]{10,}\.(eyJ[A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+/g)) {
      try {
        const payload = JSON.parse(Buffer.from(t[1], "base64url").toString("utf8"));
        if (payload.role === "service_role") secrets.push(`${path}: service_role key`);
      } catch {
        /* not a JWT */
      }
    }
  }
  pass("JavaScript files checked", `${seen.size} files`);
  (containsProject ? pass : fail)("The website is built for this Supabase project", supa);
  secrets = [...new Set(secrets)];
  (secrets.length ? fail : pass)("No secret keys or database passwords in the website", secrets.join("; "));
}

// ---------------------------------------------------------------- Supabase
async function supabase() {
  const hdr = { apikey: key, Authorization: `Bearer ${key}` };
  const settings = await get(`${supa}/auth/v1/settings`, { headers: { apikey: key } });
  if (settings.status !== 200) return fail("Supabase Auth reachable", `status ${settings.status}`);
  const s = await settings.json();
  pass("Supabase Auth reachable");
  (s.disable_signup === true ? pass : fail)("Public sign-up is switched off (accounts only by invitation)", `disable_signup=${s.disable_signup}`);
  (s.external?.email === true ? pass : fail)("Email + password sign-in is enabled");

  // every table and view in the public schema (keep in step with the migrations)
  const tables = `activity_log app_settings assignment_quantities attachments backup_runs cancel_reason_codes commitment_history commitment_revisions given_by_names import_batches job_assignments job_register jobs material_return_lots material_returns message_templates notifications number_counters payment_accounts payment_adjustments payment_ledger permissions profiles quality_inspection_log quality_inspections quality_records quotation_requests reminder_runs reminders role_permissions roles session_activity user_permission_overrides vendor_categories vendor_payments vendor_quotations vendors weekly_reports whatsapp_log whatsapp_messages work_categories`.split(" ");
  const leaks = [];
  for (const t of tables) {
    const r = await get(`${supa}/rest/v1/${t}?select=*&limit=1`, { headers: hdr });
    const body = await r.text();
    if (r.status === 200 && body.trim() !== "[]") leaks.push(`${t} (${body.slice(0, 60)})`);
  }
  (leaks.length ? fail : pass)("Nothing is readable without signing in", leaks.length ? leaks.join(", ") : `${tables.length} tables and views checked`);

  const me = await get(`${supa}/rest/v1/rpc/my_access`, { method: "POST", headers: { ...hdr, "Content-Type": "application/json" }, body: "{}" });
  const meBody = me.status === 200 ? await me.json() : null;
  (me.status === 401 || me.status === 403 || meBody?.status === "anonymous" ? pass : fail)("Account check gives nothing to anonymous visitors", `my_access → ${me.status}${meBody ? ` ${JSON.stringify(meBody)}` : ""}`);
  const dash = await get(`${supa}/rest/v1/rpc/dashboard_data`, { method: "POST", headers: { ...hdr, "Content-Type": "application/json" }, body: "{}" });
  (dash.status >= 400 ? pass : fail)("Business functions refuse anonymous calls", `dashboard_data → ${dash.status}`);
  const internal = await get(`${supa}/rest/v1/rpc/bootstrap_first_admin`, { method: "POST", headers: { ...hdr, "Content-Type": "application/json" }, body: '{"p_email":"x@example.com"}' });
  (internal.status >= 400 ? pass : fail)("Admin bootstrap is not reachable through the API", `${internal.status}`);

  const pub = await get(`${supa}/storage/v1/object/public/job-files/does-not-exist.pdf`);
  (pub.status !== 200 ? pass : fail)("Attachment bucket is private", `${pub.status}`);
  const list = await get(`${supa}/storage/v1/object/list/job-files`, { method: "POST", headers: { ...hdr, "Content-Type": "application/json" }, body: '{"prefix":""}' });
  const listBody = list.status === 200 ? await list.text() : "[]";
  (listBody.trim() === "[]" ? pass : fail)("Attachments cannot be listed without signing in", `${list.status}`);

  // The function sets its own CORS headers; the local development gateway overwrites them with "*", so the origin rule is
  // judged by the function's answer (403 "Origin not allowed"), and the header only when it is not the gateway's "*".
  const fn = `${supa}/functions/v1/admin-users`;
  const json = { ...hdr, "Content-Type": "application/json" };
  const evilOrigin = "https://attacker.example";
  const pre = await get(fn, { method: "OPTIONS", headers: { Origin: evilOrigin, "Access-Control-Request-Method": "POST" } });
  const evil = await get(fn, { method: "POST", headers: { ...json, Origin: evilOrigin }, body: '{"action":"invite"}' });
  const evilText = await evil.text();
  const reflected = [pre, evil].some((r) => (r.headers.get("access-control-allow-origin") ?? "").includes("attacker"));
  const gatewayStar = [pre, evil].some((r) => r.headers.get("access-control-allow-origin") === "*");
  const refused = (evil.status === 403 && evilText.includes("Origin not allowed")) || evil.status === 401;
  (refused && !reflected ? pass : fail)("User-admin function refuses other websites", `${evil.status} ${evilText.slice(0, 60)}${gatewayStar ? " (gateway sent CORS *)" : ""}`);
  const ours = await get(fn, { method: "POST", headers: { ...json, Origin: site }, body: '{"action":"invite"}' });
  const oursText = await ours.text();
  const oursOrigin = ours.headers.get("access-control-allow-origin");
  if (oursText.includes("Origin not allowed")) fail("User-admin function accepts this website", "APP_ALLOWED_ORIGINS does not contain the website address");
  else if (oursText.includes("not configured")) fail("User-admin function accepts this website", "APP_SITE_URL is not set for the function");
  else if (oursOrigin === site || (oursOrigin === "*" && ours.status !== 401)) pass("User-admin function accepts this website", `allow-origin: ${oursOrigin}`);
  else if (ours.status === 401) warn("User-admin function accepts this website", "the gateway asked for a signed-in user first; check it by inviting a user in the app");
  else fail("User-admin function accepts this website", `${ours.status}, allow-origin: ${oursOrigin ?? "none"}`);
  (ours.status === 401 || ours.status === 403 ? pass : fail)("User-admin function refuses visitors who are not signed in", `${ours.status} ${oursText.slice(0, 70)}`);

  // Security acceptance test 4. Opt-in, because it blocks sign-ins FROM THE ADDRESS RUNNING THIS CHECK for about 5 minutes:
  // never run it from the office network. Uses an address that has no account.
  if (args["check-login-limit"] === "true") {
    const email = `deploy-check-${Date.now()}@example.invalid`;
    const codes = [];
    for (let i = 0; i < 60; i++) {
      const r = await get(`${supa}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { apikey: key, "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: `wrong-${i}-${Math.random()}` }),
      });
      codes.push(r.status);
      if (r.status === 429) break;
    }
    const at = codes.indexOf(429);
    (at >= 0 ? pass : fail)("Repeated failed sign-ins are blocked", at >= 0 ? `blocked after ${at} failed attempts` : `${codes.length} attempts, none blocked`);
  }
}

try {
  await website();
} catch (e) {
  fail("Website checks", String(e.message ?? e));
}
try {
  await supabase();
} catch (e) {
  fail("Supabase checks", String(e.message ?? e));
}
const failed = results.filter((r) => r.level === "FAIL").length;
const warned = results.filter((r) => r.level === "WARN").length;
console.log(`\n${results.length - failed - warned} passed, ${warned} warnings, ${failed} failed`);
if (args.report) {
  const lines = [
    `# Deployment verification`,
    ``,
    `Checked ${new Date().toISOString()} from outside, without any secret.`,
    ``,
    `- Website: ${site}`,
    `- Supabase: ${supa}`,
    ``,
    `| Result | Check | Detail |`,
    `|---|---|---|`,
    ...results.map((r) => `| ${r.level} | ${r.check} | ${(r.detail ?? "").replace(/\|/g, "/")} |`),
    ``,
    `**${results.length - failed - warned} passed, ${warned} warnings, ${failed} failed.**`,
    ``,
  ];
  writeFileSync(args.report, lines.join("\n"));
}
process.exit(failed ? 1 : 0);
