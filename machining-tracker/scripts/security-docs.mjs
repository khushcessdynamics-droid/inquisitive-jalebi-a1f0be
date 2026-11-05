#!/usr/bin/env node
// Generates docs/PERMISSION_MATRIX.md and docs/DATABASE_SECURITY.md from the database itself (default roles and
// permissions as created by the migrations, row security, grants, functions, protected tables), so the documents
// always describe what is actually built. Run against the LOCAL stack after `supabase db reset`:
//   node scripts/security-docs.mjs
// It reads the database address from `supabase status` and refuses anything other than 127.0.0.1.
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import pg from "pg";

const status = Object.fromEntries(
  execSync("npx supabase status -o env", { encoding: "utf8" })
    .split("\n")
    .map((l) => l.match(/^([A-Z_]+)="?(.*?)"?$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
const dbUrl = status.DB_URL;
if (!dbUrl || !/@127\.0\.0\.1:/.test(dbUrl)) throw new Error("Local Supabase is not running (or DB_URL is not local).");
const db = new pg.Client({ connectionString: dbUrl });
await db.connect();
const q = async (sql, args = []) => (await db.query(sql, args)).rows;
const today = new Date().toISOString().slice(0, 10);
const migration = (await q("select max(version) as v from supabase_migrations.schema_migrations"))[0].v;

// ------------------------------------------------------------------ permission matrix
const perms = await q("select key, module, label, admin_only from public.permissions order by sort_order, key");
const roles = await q("select key, label, mfa_required from public.roles order by sort_order, key");
const grants = new Set((await q("select role_key || '|' || permission_key as k from public.role_permissions")).map((r) => r.k));
const has = (role, p) => role === "admin" || (!p.admin_only && grants.has(`${role}|${p.key}`));
const modules = [...new Set(perms.map((p) => p.module))];
const lines = [
  "# User permission matrix",
  "",
  `Generated from the database by \`scripts/security-docs.mjs\` on ${today} (migrations up to ${migration}). These are the **default**`,
  "role permissions. An Admin can change a role's permissions or give one person an exception (Users → Permissions), and every change",
  "is recorded in the activity history.",
  "",
  "Rules enforced by the database for every request, including direct API calls:",
  "- **Admin** always has every permission. Permissions marked *Admin only* can never be given to another role or person.",
  "- A person's exception (granted or removed) overrides their role. Deactivated accounts have no permissions at all.",
  `- **${roles.filter((r) => r.mfa_required).map((r) => r.label).join(" and ")} must use their authenticator app (MFA)**: without a verified MFA sign-in they get no access.`,
  "- **Staff** see only jobs assigned to them or created by them, and payments not at all.",
  "",
];
for (const m of modules) {
  lines.push(`## ${m[0].toUpperCase()}${m.slice(1)}`, "", `| Permission | ${roles.map((r) => r.label).join(" | ")} |`, `|---|${roles.map(() => ":-:").join("|")}|`);
  for (const p of perms.filter((x) => x.module === m)) {
    lines.push(`| ${p.label}${p.admin_only ? " *(Admin only)*" : ""} <br><sub>\`${p.key}\`</sub> | ${roles.map((r) => (has(r.key, p) ? "Yes" : "—")).join(" | ")} |`);
  }
  lines.push("");
}
writeFileSync("docs/PERMISSION_MATRIX.md", lines.join("\n"));

// ------------------------------------------------------------------ database security facts
const one = async (sql) => Object.values((await q(sql))[0] ?? {})[0];
const tables = await q(`select c.relname as name, c.relrowsecurity as rls,
    (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname)::int as policies,
    exists (select 1 from information_schema.role_table_grants g where g.table_schema = 'public' and g.table_name = c.relname
            and g.grantee = 'authenticated' and g.privilege_type in ('INSERT','UPDATE','DELETE')) as direct_write,
    exists (select 1 from pg_trigger t join pg_proc f on f.oid = t.tgfoid where t.tgrelid = c.oid and not t.tgisinternal
            and f.proname in ('forbid_change','forbid_delete','guard_void_only')) as protected,
    exists (select 1 from pg_trigger t join pg_proc f on f.oid = t.tgfoid where t.tgrelid = c.oid and not t.tgisinternal
            and f.proname = 'audit_row') as audited
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r','p') order by c.relname`);
const views = await q(`select c.relname as name, coalesce(c.reloptions::text, '') like '%security_invoker=true%' as invoker
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'v' order by 1`);
const writeGrants = await q(`select table_name || ' (' || string_agg(privilege_type, ', ' order by privilege_type) || ')' as g
  from information_schema.role_table_grants where grantee = 'authenticated' and table_schema = 'public' and privilege_type in ('INSERT','UPDATE','DELETE')
  group by table_name order by table_name`);
const facts = {
  anonTables: await one("select count(*)::int from information_schema.role_table_grants where grantee = 'anon' and table_schema = 'public'"),
  anonFunctions: await one(`select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')`),
  definer: await one("select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','private') and p.prosecdef"),
  definerNoPath: await one(`select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public','private') and p.prosecdef and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`),
  publicFunctions: await one("select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'"),
  privateAnon: await one("select has_schema_privilege('anon','private','usage')"),
  privateHelpers: await one(`select count(*) filter (where has_function_privilege('authenticated', p.oid, 'execute'))::int || ' of ' || count(*)::int
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private'`),
  buckets: await q("select id, public, file_size_limit, allowed_mime_types from storage.buckets order by id"),
  storagePolicies: await one("select count(*)::int from pg_policies where schemaname = 'storage'"),
  cron: await q("select jobname, schedule, active from cron.job order by jobname"),
};
const yes = (b) => (b ? "Yes" : "**No**");
const doc = [
  "# Database security configuration",
  "",
  `Generated from the database by \`scripts/security-docs.mjs\` on ${today} (migrations up to ${migration}). The live Supabase project gets`,
  "exactly this configuration from the same migrations (`supabase db push`).",
  "",
  "## Summary",
  "",
  "| Check | Result |",
  "|---|---|",
  `| Tables in the application schema | ${tables.length} |`,
  `| Tables with row-level security switched on | ${tables.filter((t) => t.rls).length} of ${tables.length} |`,
  `| Tables an anonymous visitor may read or change | ${facts.anonTables} |`,
  `| Functions an anonymous visitor may call | ${facts.anonFunctions} of ${facts.publicFunctions} |`,
  `| Tables signed-in users may change directly (without a checked function) | ${writeGrants.length ? `${writeGrants.map((r) => r.g).join("; ")}: the master lists, only with *Change settings* (row-security policies); entries are never deleted; audited` : "none"} |`,
  `| Views that apply the caller's own row security (security invoker) | ${views.filter((v) => v.invoker).length} of ${views.length} |`,
  `| Privileged (security definer) functions | ${facts.definer}, all with a fixed search path: ${facts.definerNoPath === 0 ? "Yes" : `**No (${facts.definerNoPath} without)**`} |`,
  `| Internal \`private\` schema | Not published by the API (only \`public\` is). Anonymous visitors: ${facts.privateAnon ? "**have access**" : "no access"}. Signed-in users: ${facts.privateHelpers} helper functions, used only inside row-security checks, views and triggers |`,
  `| File buckets | ${facts.buckets.map((b) => `\`${b.id}\`: ${b.public ? "**public**" : "private"}, max ${b.file_size_limit ? `${Math.round(b.file_size_limit / 1048576)} MB` : "default"}`).join("; ")} (${facts.storagePolicies} storage policies) |`,
  `| Scheduled jobs | ${facts.cron.map((c) => `\`${c.jobname}\` (${c.schedule}, ${c.active ? "active" : "inactive"})`).join(", ")} |`,
  "",
  "## How data is protected",
  "",
  "- **Changes only through checked functions.** Signed-in users can read only the rows their row-security policies allow. Every",
  "  business change goes through a database function that checks the permission (`private.require_permission`), validates the",
  "  input, uses optimistic locking (`version`) and writes the activity history. Calling the API directly gives exactly the same",
  "  checks as the app. The only direct writes are adding and renaming entries of the three master lists (work categories, Given By",
  "  names, cancellation reasons), allowed by row-security policies only with *Change settings*; entries are never deleted.",
  "- **Append-only records.** Payments, adjustments, commitment revisions, the activity history and other records marked below cannot",
  "  be changed or deleted, not even by the database owner, without switching off the triggers (a deliberate superuser action).",
  "  Corrections are made by reversal entries or voids with a reason.",
  "- **Audit trail.** Tables marked *Audited* record who changed what, the previous and new values, the reason and the session.",
  "- **MFA.** Admin and Manager have no access without a verified authenticator sign-in (`aal2`); this is checked inside the database.",
  "- **Files.** Attachments are in a private bucket. Downloads need a short-lived signed link created for a signed-in user who may see",
  "  that job; registered files cannot be deleted or overwritten through the API.",
  "",
  "## Every table",
  "",
  "| Table | Row security | Policies | Direct writes | Append-only / guarded | Audited |",
  "|---|:-:|:-:|:-:|:-:|:-:|",
  ...tables.map((t) => `| \`${t.name}\` | ${yes(t.rls)} | ${t.policies} | ${t.direct_write ? "**Yes**" : "No"} | ${t.protected ? "Yes" : "—"} | ${t.audited ? "Yes" : "—"} |`),
  "",
  "## Every view",
  "",
  "| View | Applies the caller's row security |",
  "|---|:-:|",
  ...views.map((v) => `| \`${v.name}\` | ${yes(v.invoker)} |`),
  "",
];
writeFileSync("docs/DATABASE_SECURITY.md", doc.join("\n"));
await db.end();
console.log(`Wrote docs/PERMISSION_MATRIX.md (${perms.length} permissions, ${roles.length} roles) and docs/DATABASE_SECURITY.md (${tables.length} tables, ${views.length} views)`);
