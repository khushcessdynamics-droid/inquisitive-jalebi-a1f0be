// Admin "Reset authenticator" (lost phone): removes the person's authenticator, ends their sessions at once, records it in the
// activity history; at their next sign-in a Manager must set up a new authenticator before any access. Only Admins (users.manage
// with MFA), never for oneself, always with a reason.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { access, closeSql, createAuthUser, enrollAndVerifyMfa, resetLocalDatabase, signIn, sql, uniqueEmail } from "../helpers/clients";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let admin: SupabaseClient;
let manager: SupabaseClient;
let adminId = "";
let managerId = "";
let staffId = "";
const managerEmail = uniqueEmail("mr.mgr");

beforeAll(async () => {
  await resetLocalDatabase();
  const adminEmail = uniqueEmail("mr.admin");
  adminId = await createAuthUser(adminEmail, "Reset Admin");
  await sql("select private.bootstrap_first_admin($1)", [adminEmail]);
  admin = await signIn(adminEmail);
  await enrollAndVerifyMfa(admin);
  managerId = await createAuthUser(managerEmail, "Mona Manager");
  await sql("update public.profiles set role_key = 'manager', is_active = true, full_name = 'Mona Manager' where id = $1", [managerId]);
  manager = await signIn(managerEmail);
  await enrollAndVerifyMfa(manager);
  staffId = await createAuthUser(uniqueEmail("mr.staff"), "Sunil Staff");
  await sql("update public.profiles set role_key = 'staff', is_active = true where id = $1", [staffId]);
}, 300_000);

afterAll(async () => {
  await closeSql();
});

describe("Reset authenticator", () => {
  it("is refused without a reason, for oneself, for someone without an authenticator, and for non-Admins", async () => {
    expect((await admin.rpc("admin_reset_mfa", { p_user_id: managerId, p_reason: "" })).error?.code).toBe("22023");
    expect((await admin.rpc("admin_reset_mfa", { p_user_id: adminId, p_reason: "Lost phone" })).error?.message).toMatch(/own authenticator/);
    expect((await admin.rpc("admin_reset_mfa", { p_user_id: staffId, p_reason: "Lost phone" })).error?.message).toMatch(/no authenticator/);
    expect((await manager.rpc("admin_reset_mfa", { p_user_id: staffId, p_reason: "Lost phone" })).error?.code).toBe("42501");
    expect((await sql("select 1 from auth.mfa_factors where user_id = $1", [managerId])).length).toBe(1);
  });

  it("removes the authenticator, signs the person out at once and records it", async () => {
    expect((await access(manager)).status).toBe("ok");
    const { data, error } = await admin.rpc("admin_reset_mfa", { p_user_id: managerId, p_reason: "Lost phone, confirmed by call" });
    expect(error).toBeNull();
    expect(data).toMatchObject({ authenticators_removed: 1, sessions_ended: expect.any(Number) });
    expect((await sql("select 1 from auth.mfa_factors where user_id = $1", [managerId])).length).toBe(0);
    expect((await access(manager)).status).toBe("session_expired"); // the signed-in session stops working immediately
    const log = await sql<Json>("select actor_id, reason, new_value, previous_value from public.activity_log where action = 'user.mfa_reset' and entity_id = $1", [managerId]);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ actor_id: adminId, reason: "Lost phone, confirmed by call", previous_value: null });
    expect(JSON.stringify(log[0])).not.toMatch(/secret|totp|otpauth/i);
  });

  it("at the next sign-in the Manager has no access until a new authenticator is set up", async () => {
    const again = await signIn(managerEmail);
    const a = await access(again);
    expect(a).toMatchObject({ status: "mfa_required", mfa_required: true, mfa_enrolled: false });
    expect((await again.from("jobs").select("id").limit(1)).data ?? []).toEqual([]);
    await enrollAndVerifyMfa(again);
    expect((await access(again)).status).toBe("ok");
  });
});
