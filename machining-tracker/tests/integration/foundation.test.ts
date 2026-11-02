// End-to-end security tests of the Phase 3 foundation against the LOCAL Supabase stack
// (real Postgres + Auth + REST API + Edge Functions). Run with: npm run test:integration
// The database is reset first, so the "first Admin" bootstrap can be tested.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_ROLE_PERMISSIONS, PERMISSION_KEYS } from "@cess/shared";
import { localEnv } from "../helpers/env";
import {
  PASSWORD,
  access,
  anonClient,
  closeSql,
  createAuthUser,
  enrollAndVerifyMfa,
  resetLocalDatabase,
  serviceClient,
  signIn,
  sql,
  uniqueEmail,
  verifyMfa,
} from "../helpers/clients";

const env = localEnv();
const functionsUrl = `${env.apiUrl}/functions/v1/admin-users`;
const ORIGIN = "http://127.0.0.1:5173";

async function callFunction(client: SupabaseClient | null, body: unknown, origin = ORIGIN) {
  const token = client ? (await client.auth.getSession()).data.session?.access_token : undefined;
  const res = await fetch(functionsUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: env.publishableKey,
      Origin: origin,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, string> };
}

/** Follows an invitation / reset link the way the browser page /auth/confirm does. */
async function acceptLink(link: string, newPassword = PASSWORD): Promise<void> {
  const url = new URL(link);
  expect(url.origin).toBe(ORIGIN);
  expect(url.pathname).toBe("/auth/confirm");
  const client = anonClient();
  const { error } = await client.auth.verifyOtp({
    token_hash: url.searchParams.get("token_hash")!,
    type: url.searchParams.get("type") as "invite" | "recovery",
  });
  if (error) throw error;
  const { error: upErr } = await client.auth.updateUser({ password: newPassword });
  if (upErr) throw upErr;
}

const adminEmail = uniqueEmail("admin");
const managerEmail = uniqueEmail("manager");
const staffEmail = uniqueEmail("staff");
let admin: SupabaseClient;
let adminMfa: { factorId: string; secret: string; lastCode: string };
let staffId: string;

beforeAll(async () => {
  // Fresh database state is required for the first-Admin bootstrap test.
  await resetLocalDatabase();
});

afterAll(async () => {
  await closeSql();
});

describe("anonymous access", () => {
  it("cannot read any table or call RPCs", async () => {
    const anon = anonClient();
    for (const table of ["profiles", "app_settings", "activity_log", "work_categories", "roles", "role_permissions", "backup_runs"]) {
      const { data, error } = await anon.from(table).select("*").limit(1);
      expect(error, `table ${table}`).not.toBeNull();
      expect(data).toBeNull();
    }
    for (const fn of ["my_access", "system_health", "admin_list_users"]) {
      const { error } = await anon.rpc(fn);
      expect(error, `rpc ${fn}`).not.toBeNull();
    }
  });

  it("cannot sign up (public registration is disabled)", async () => {
    const { data, error } = await anonClient().auth.signUp({ email: uniqueEmail("intruder"), password: PASSWORD });
    expect(error).not.toBeNull();
    expect(data.user).toBeNull();
  });

  it("cannot call the admin-users Edge Function", async () => {
    const r = await callFunction(null, { action: "invite", email: "x@example.test", full_name: "X", role_key: "admin" });
    expect(r.status).toBe(401);
  });
});

describe("first Admin bootstrap and MFA", () => {
  it("a user created outside the invitation flow has no access", async () => {
    await createAuthUser(adminEmail, "First Admin");
    admin = await signIn(adminEmail);
    expect((await access(admin)).status).toBe("inactive");
    const { data } = await admin.from("app_settings").select("key");
    expect(data).toEqual([]);
  });

  it("bootstrap_first_admin works once from SQL and is not callable through the API", async () => {
    const { error: apiErr } = await admin.rpc("bootstrap_first_admin", { p_email: adminEmail });
    expect(apiErr).not.toBeNull();
    const rows = await sql<{ r: string }>("select private.bootstrap_first_admin($1) as r", [adminEmail]);
    expect(rows[0]!.r).toMatch(/^OK/);
    await expect(sql("select private.bootstrap_first_admin($1)", [adminEmail])).rejects.toThrow(/already exists/);
  });

  it("an Admin without MFA (aal1) is blocked from all data", async () => {
    const a = await access(admin);
    expect(a.status).toBe("mfa_required");
    expect(a.permissions).toEqual([]);
    const { data } = await admin.from("app_settings").select("key");
    expect(data).toEqual([]);
    const { error } = await admin.rpc("system_health");
    expect(error?.code).toBe("42501");
  });

  it("after TOTP verification (aal2) the Admin has every permission", async () => {
    adminMfa = await enrollAndVerifyMfa(admin);
    const a = await access(admin);
    expect(a.status).toBe("ok");
    expect(a.aal).toBe("aal2");
    expect([...(a.permissions as string[])].sort()).toEqual([...PERMISSION_KEYS].sort());
    const { data } = await admin.from("app_settings").select("key");
    expect(data?.length).toBe(9);
  });

  it("a new sign-in starts at aal1 again and needs the code", async () => {
    const second = await signIn(adminEmail);
    expect((await access(second)).status).toBe("mfa_required");
    await verifyMfa(second, adminMfa.factorId, adminMfa.secret, adminMfa.lastCode);
    expect((await access(second)).status).toBe("ok");
    await second.auth.signOut({ scope: "local" }); // "global" would also end the other Admin session
  });
});

describe("invitations through the Edge Function", () => {
  it("rejects requests from origins that are not allowed", async () => {
    const r = await callFunction(admin, { action: "invite", email: uniqueEmail("x"), full_name: "X", role_key: "staff" }, "https://evil.example");
    expect(r.status).toBe(403);
  });

  it("Admin invites Staff and Manager with one-time links; the links work once", async () => {
    const s = await callFunction(admin, { action: "invite", email: staffEmail, full_name: "Staff One", role_key: "staff", delivery: "link" });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    staffId = s.body.user_id!;
    await acceptLink(s.body.link!);
    await expect(acceptLink(s.body.link!)).rejects.toThrow(); // single use

    const m = await callFunction(admin, { action: "invite", email: managerEmail, full_name: "Manager One", role_key: "manager", delivery: "link" });
    expect(m.status).toBe(200);
    await acceptLink(m.body.link!);

    const dup = await callFunction(admin, { action: "invite", email: staffEmail, full_name: "Again", role_key: "staff" });
    expect(dup.status).toBe(409);
  });

  it("invitation links are never stored in the activity history", async () => {
    const rows = await sql<{ n: number }>("select count(*)::int as n from public.activity_log where new_value::text like '%token_hash%' or new_value::text like '%/auth/confirm%'");
    expect(rows[0]!.n).toBe(0);
    const logged = await sql<{ action: string }>("select action from public.activity_log where entity_id = $1 order by id", [staffId]);
    expect(logged.map((r) => r.action)).toEqual(expect.arrayContaining(["user.invited", "user.invite_link_generated"]));
  });

  it("invitation by email uses the token_hash template (local mail catcher)", async () => {
    const email = uniqueEmail("emailinvite");
    const r = await callFunction(admin, { action: "invite", email, full_name: "Email Invitee", role_key: "staff", delivery: "email" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.link).toBeUndefined();
    let html = "";
    for (let i = 0; i < 20 && !html; i++) {
      const list = (await (await fetch(`${env.mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)).json()) as {
        messages?: Array<{ ID: string }>;
      };
      const id = list.messages?.[0]?.ID;
      if (id) html = ((await (await fetch(`${env.mailpitUrl}/api/v1/message/${id}`)).json()) as { HTML: string }).HTML;
      else await new Promise((res) => setTimeout(res, 500));
    }
    expect(html).toContain(`${ORIGIN}/auth/confirm?token_hash=`);
    expect(html).toContain("type=invite");
  });

  it("Staff cannot use the Edge Function", async () => {
    const staff = await signIn(staffEmail);
    const r = await callFunction(staff, { action: "invite", email: uniqueEmail("x"), full_name: "X", role_key: "admin" });
    expect(r.status).toBe(403);
    const rec = await callFunction(staff, { action: "recovery", user_id: staffId });
    expect(rec.status).toBe(403);
  });
});

describe("role permissions are enforced by the server", () => {
  it("Staff gets exactly the approved default permissions without MFA", async () => {
    const staff = await signIn(staffEmail);
    const a = await access(staff);
    expect(a.status).toBe("ok");
    expect([...(a.permissions as string[])].sort()).toEqual([...DEFAULT_ROLE_PERMISSIONS.staff].sort());
  });

  it("Staff cannot change settings, master data, users or read the audit history via direct API calls", async () => {
    const staff = await signIn(staffEmail);
    const settings = (await staff.from("app_settings").select("*").eq("key", "company").single()).data as { version: number; value: Record<string, string> };
    const upd = await staff.rpc("update_setting", { p_key: "company", p_value: { ...settings.value, name: "Hacked" }, p_expected_version: settings.version });
    expect(upd.error?.code).toBe("42501");

    const ins = await staff.from("work_categories").insert({ name: "Staff category" });
    expect(ins.error).not.toBeNull();
    const upd2 = await staff.from("work_categories").update({ name: "Renamed" }).eq("name", "Grinding").select();
    expect(upd2.data ?? []).toEqual([]);
    expect((await sql("select 1 from public.work_categories where name = 'Grinding'")).length).toBe(1);

    expect((await staff.from("activity_log").select("id")).data).toEqual([]);
    expect((await staff.rpc("admin_list_users")).error?.code).toBe("42501");
    expect((await staff.rpc("admin_set_role_permission", { p_role_key: "staff", p_permission_key: "payments.view", p_granted: true, p_reason: "self-grant" })).error?.code).toBe(
      "42501",
    );
    expect((await staff.rpc("admin_update_user", { p_user_id: staffId, p_expected_version: 1, p_role_key: "admin", p_reason: "escalate" })).error?.code).toBe("42501");
    expect((await staff.from("profiles").select("id")).data?.map((r) => r.id)).toEqual([staffId]); // only own profile
    expect((await staff.from("profiles").update({ role_key: "admin" }).eq("id", staffId).select()).error).not.toBeNull();
  });

  it("Manager must complete MFA before any access", async () => {
    const manager = await signIn(managerEmail);
    expect((await access(manager)).status).toBe("mfa_required");
    expect((await manager.from("work_categories").select("id")).data).toEqual([]);
    await enrollAndVerifyMfa(manager);
    const a = await access(manager);
    expect(a.status).toBe("ok");
    expect([...(a.permissions as string[])].sort()).toEqual([...DEFAULT_ROLE_PERMISSIONS.manager].sort());
    expect(a.permissions).toContain("payments.view");
    expect(a.permissions).not.toContain("payments.add");
    expect(a.permissions).not.toContain("payments.manage");
    expect((await manager.rpc("admin_list_users")).error?.code).toBe("42501");
  });

  it("Admin can grant and revoke a role permission; Admin-only permissions cannot be granted", async () => {
    const grant = await admin.rpc("admin_set_role_permission", { p_role_key: "staff", p_permission_key: "activity.view", p_granted: true, p_reason: "Test grant" });
    expect(grant.error).toBeNull();
    const staff = await signIn(staffEmail);
    expect((await staff.from("activity_log").select("id").limit(1)).data?.length).toBe(1);
    await admin.rpc("admin_set_role_permission", { p_role_key: "staff", p_permission_key: "activity.view", p_granted: false, p_reason: "Test revoke" });
    expect((await staff.from("activity_log").select("id").limit(1)).data).toEqual([]);

    const bad = await admin.rpc("admin_set_role_permission", { p_role_key: "manager", p_permission_key: "users.manage", p_granted: true, p_reason: "Not allowed" });
    expect(bad.error?.code).toBe("42501");
    const noReason = await admin.rpc("admin_set_role_permission", { p_role_key: "staff", p_permission_key: "reports.view", p_granted: true, p_reason: "" });
    expect(noReason.error?.code).toBe("22023");
  });

  it("per-user exception overrides the role default", async () => {
    await admin.rpc("admin_set_user_permission", { p_user_id: staffId, p_permission_key: "returns.record", p_granted: true, p_reason: "Store keeper" });
    const staff = await signIn(staffEmail);
    expect((await access(staff)).permissions).toContain("returns.record");
    await admin.rpc("admin_set_user_permission", { p_user_id: staffId, p_permission_key: "returns.record", p_granted: null, p_reason: "Back to default" });
    expect((await access(staff)).permissions).not.toContain("returns.record");
  });
});

describe("settings validation, optimistic locking and audit trail", () => {
  it("rejects weights that do not add up to 100 and accepts the approved Option 1 weights", async () => {
    const row = (await admin.from("app_settings").select("*").eq("key", "reliability").single()).data as { version: number; value: Record<string, unknown> };
    expect(row.value.weights).toEqual({ on_time: 30, quality: 25, delay: 15, stability: 10, completion_time: 10, vendor_cancellation: 10 });
    const bad = await admin.rpc("update_setting", {
      p_key: "reliability",
      p_value: { ...row.value, weights: { on_time: 35, quality: 25, delay: 15, stability: 10, completion_time: 10, vendor_cancellation: 10 } },
      p_expected_version: row.version,
    });
    expect(bad.error?.code).toBe("22023");
    expect(bad.error?.message).toMatch(/exactly 100/);
  });

  it("detects a stale edit (two users editing the same setting)", async () => {
    const row = (await admin.from("app_settings").select("*").eq("key", "company").single()).data as { version: number; value: Record<string, string> };
    const first = await admin.rpc("update_setting", { p_key: "company", p_value: { ...row.value, name: "CESS Dynamics" }, p_expected_version: row.version });
    expect(first.error).toBeNull();
    const stale = await admin.rpc("update_setting", { p_key: "company", p_value: { ...row.value, name: "Other" }, p_expected_version: row.version });
    expect(stale.error?.code).toBe("PT409");
    const now = (await admin.from("app_settings").select("value").eq("key", "company").single()).data as { value: { name: string } };
    expect(now.value.name).toBe("CESS Dynamics");
  });

  it("records who changed what, with previous and new values", async () => {
    const rows = await sql<{ actor_name: string; actor_role: string; action: string; previous_value: { value: { name: string } }; new_value: { value: { name: string } } }>(
      "select actor_name, actor_role, action, previous_value, new_value from public.activity_log where action = 'settings.changed' and entity_id = 'company' order by id desc limit 1",
    );
    expect(rows[0]).toMatchObject({ actor_name: "First Admin", actor_role: "admin", action: "settings.changed" });
    expect(rows[0]!.previous_value.value.name).toBe("");
    expect(rows[0]!.new_value.value.name).toBe("CESS Dynamics");
  });

  it("the activity history is append-only, even for the service role and the database owner", async () => {
    const svc = serviceClient();
    const del = await svc.from("activity_log").delete().gt("id", 0).select();
    expect(del.error).not.toBeNull();
    const upd = await svc.from("activity_log").update({ action: "tampered" }).gt("id", 0).select();
    expect(upd.error).not.toBeNull();
    await expect(sql("update public.activity_log set action = 'x' where id = 1")).rejects.toThrow(/append-only/);
    await expect(sql("delete from public.activity_log where id = 1")).rejects.toThrow(/append-only/);
    await expect(sql("truncate public.activity_log")).rejects.toThrow(/append-only/);
  });

  it("master data cannot be deleted", async () => {
    const del = await admin.from("work_categories").delete().eq("name", "Others").select();
    expect(del.error).not.toBeNull();
    await expect(sql("delete from public.work_categories where name = 'Others'")).rejects.toThrow(/not allowed/);
  });

  it("built-in cancellation reasons keep their vendor classification", async () => {
    const r = (await admin.from("cancel_reason_codes").select("*").eq("code", "customer_cancelled").single()).data as { version: number };
    const upd = await admin.from("cancel_reason_codes").update({ vendor_related: true, vendor_subtype: "delivery" }).eq("code", "customer_cancelled").eq("version", r.version).select();
    expect(upd.error?.message).toMatch(/classification/);
  });
});

describe("sessions: revocation, deactivation, idle timeout", () => {
  it("'log out everywhere' invalidates an existing access token immediately", async () => {
    const tab1 = await signIn(staffEmail);
    const tab2 = await signIn(staffEmail);
    expect((await access(tab1)).status).toBe("ok");
    await tab2.auth.signOut({ scope: "global" });
    expect((await access(tab1)).status).toBe("session_expired");
    expect((await tab1.from("work_categories").select("id")).data).toEqual([]);
  });

  it("Admin can end another user's sessions", async () => {
    const staff = await signIn(staffEmail);
    const r = await admin.rpc("admin_revoke_sessions", { p_user_id: staffId, p_reason: "Lost phone" });
    expect(r.error).toBeNull();
    expect((await access(staff)).status).toBe("session_expired");
  });

  it("the server-side idle timeout ends inactive sessions", async () => {
    const staff = await signIn(staffEmail);
    expect(await staff.rpc("touch_session").then((r) => r.data)).toBe(true);
    await sql("update public.session_activity set last_seen_at = now() - interval '31 minutes' where user_id = $1", [staffId]);
    expect((await access(staff)).status).toBe("session_expired");
    expect((await staff.rpc("touch_session")).data).toBe(false);
    expect((await sql("select 1 from auth.sessions where user_id = $1", [staffId])).length).toBe(0);
  });

  it("deactivation blocks a signed-in user at once and prevents new sign-ins; history is kept", async () => {
    const staff = await signIn(staffEmail);
    const profile = (await admin.from("profiles").select("version").eq("id", staffId).single()).data as { version: number };
    const noReason = await admin.rpc("admin_update_user", { p_user_id: staffId, p_expected_version: profile.version, p_is_active: false });
    expect(noReason.error?.code).toBe("22023");
    const r = await admin.rpc("admin_update_user", { p_user_id: staffId, p_expected_version: profile.version, p_is_active: false, p_reason: "Left the company" });
    expect(r.error).toBeNull();
    expect((await access(staff)).status).toBe("inactive");
    expect((await staff.from("work_categories").select("id")).data).toEqual([]);
    await expect(signIn(staffEmail)).rejects.toThrow();
    const log = await sql<{ reason: string }>("select reason from public.activity_log where action = 'user.deactivated' and entity_id = $1", [staffId]);
    expect(log[0]!.reason).toBe("Left the company");

    const v = (await admin.from("profiles").select("version").eq("id", staffId).single()).data as { version: number };
    expect((await admin.rpc("admin_update_user", { p_user_id: staffId, p_expected_version: v.version, p_is_active: true, p_reason: "Rejoined" })).error).toBeNull();
    expect((await access(await signIn(staffEmail))).status).toBe("ok");
  });

  it("the last active Admin cannot be deactivated or demoted", async () => {
    const me = (await admin.from("profiles").select("id,version").eq("email", adminEmail).single()).data as { id: string; version: number };
    const self = await admin.rpc("admin_update_user", { p_user_id: me.id, p_expected_version: me.version, p_is_active: false, p_reason: "test" });
    expect(self.error?.code).toBe("42501");
    await expect(sql("update public.profiles set role_key = 'staff' where id = $1", [me.id])).rejects.toThrow(/last active Admin/);
  });
});

describe("password recovery and voluntary MFA", () => {
  it("Admin-generated reset link lets the user set a new password", async () => {
    const r = await callFunction(admin, { action: "recovery", user_id: staffId, delivery: "link" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(new URL(r.body.link!).searchParams.get("type")).toBe("recovery");
    await acceptLink(r.body.link!, "New-Passw0rd-Strong");
    await expect(signIn(staffEmail)).rejects.toThrow();
    await signIn(staffEmail, "New-Passw0rd-Strong");
  });

  it("Staff who enrol MFA voluntarily must use it from then on", async () => {
    const staff = await signIn(staffEmail, "New-Passw0rd-Strong");
    const f = await enrollAndVerifyMfa(staff);
    expect((await access(staff)).status).toBe("ok");
    const again = await signIn(staffEmail, "New-Passw0rd-Strong");
    expect((await access(again)).status).toBe("mfa_required");
    expect((await again.from("work_categories").select("id")).data).toEqual([]);
    await verifyMfa(again, f.factorId, f.secret, f.lastCode);
    expect((await access(again)).status).toBe("ok");
  });

  it("MFA policy: Admin and Manager cannot be made optional; Staff can be made mandatory", async () => {
    const roles = (await admin.from("roles").select("key,version")).data as Array<{ key: string; version: number }>;
    const v = (k: string) => roles.find((r) => r.key === k)!.version;
    expect((await admin.rpc("admin_set_role_mfa", { p_role_key: "manager", p_required: false, p_reason: "test", p_expected_version: v("manager") })).error?.code).toBe("22023");
    expect((await admin.rpc("admin_set_role_mfa", { p_role_key: "staff", p_required: true, p_reason: "Policy", p_expected_version: v("staff") })).error).toBeNull();
    const r2 = (await admin.from("roles").select("version").eq("key", "staff").single()).data as { version: number };
    expect((await admin.rpc("admin_set_role_mfa", { p_role_key: "staff", p_required: false, p_reason: "Back", p_expected_version: r2.version })).error).toBeNull();
  });
});
