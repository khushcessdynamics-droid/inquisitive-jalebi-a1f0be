import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";
import { localEnv } from "./env";
import { totp } from "./totp";

export const PASSWORD = "Test-Passw0rd-Strong";

export function anonClient(): SupabaseClient {
  const env = localEnv();
  return createClient(env.apiUrl, env.publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

export function serviceClient(): SupabaseClient {
  const env = localEnv();
  return createClient(env.apiUrl, env.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

let pool: pg.Pool | null = null;
/** Direct database access as the database owner (only for test setup and assertions). */
export async function sql<T extends pg.QueryResultRow = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  pool ??= new pg.Pool({ connectionString: localEnv().dbUrl, max: 2 });
  const res = await pool.query<T>(text, params);
  return res.rows;
}
export async function closeSql() {
  await pool?.end();
  pool = null;
}

export function uniqueEmail(prefix: string): string {
  return `${prefix}.${Date.now()}.${Math.random().toString(36).slice(2, 7)}@example.test`;
}

/** Creates a confirmed Auth user directly (as the Supabase dashboard "Add user" does). */
export async function createAuthUser(email: string, fullName = "Test User"): Promise<string> {
  const { data, error } = await serviceClient().auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });
  if (error || !data.user) throw error ?? new Error("createUser failed");
  return data.user.id;
}

export async function signIn(email: string, password = PASSWORD): Promise<SupabaseClient> {
  const client = anonClient();
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return client;
}

/** Waits until a fresh 30-second TOTP window starts if the current one is nearly over, then returns a code. */
async function freshCode(secret: string, avoid?: string): Promise<string> {
  for (;;) {
    const remaining = 30_000 - (Date.now() % 30_000);
    const code = totp(secret);
    if (remaining > 3_000 && code !== avoid) return code;
    await new Promise((r) => setTimeout(r, remaining + 200));
  }
}

export async function enrollAndVerifyMfa(client: SupabaseClient): Promise<{ factorId: string; secret: string; lastCode: string }> {
  const { data, error } = await client.auth.mfa.enroll({ factorType: "totp", friendlyName: `test-${Date.now()}` });
  if (error || !data) throw error ?? new Error("enroll failed");
  const code = await freshCode(data.totp.secret);
  const { error: vErr } = await client.auth.mfa.challengeAndVerify({ factorId: data.id, code });
  if (vErr) throw vErr;
  return { factorId: data.id, secret: data.totp.secret, lastCode: code };
}

export async function verifyMfa(client: SupabaseClient, factorId: string, secret: string, avoid?: string): Promise<string> {
  const code = await freshCode(secret, avoid);
  const { error } = await client.auth.mfa.challengeAndVerify({ factorId, code });
  if (error) throw error;
  return code;
}

export async function access(client: SupabaseClient): Promise<Record<string, unknown>> {
  const { data, error } = await client.rpc("my_access");
  if (error) throw error;
  return data as Record<string, unknown>;
}

/** Recreates the LOCAL database from the migrations (deletes all local data) and waits until the API answers again. */
export async function resetLocalDatabase(): Promise<void> {
  const { execSync } = await import("node:child_process");
  await closeSql();
  execSync("npx supabase db reset", { stdio: "ignore", timeout: 240_000 });
  const env = localEnv();
  for (let i = 0; i < 90; i++) {
    try {
      const auth = await fetch(`${env.apiUrl}/auth/v1/health`, { headers: { apikey: env.publishableKey } });
      const rest = await fetch(`${env.apiUrl}/rest/v1/rpc/my_access`, { method: "POST", headers: { apikey: env.publishableKey, "Content-Type": "application/json" }, body: "{}" });
      if (auth.ok && rest.status < 500) return;
    } catch {
      /* not ready yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Local Supabase did not come back after db reset");
}
