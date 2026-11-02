// CESS Machining Job Tracker - admin-users Edge Function (Supabase, Deno)
//
// Admin-only operations that need the Supabase secret (service-role) key, which must never reach the browser:
//   invite   - create the account and return a one-time "set password" link (or email it if custom SMTP is set up)
//   recovery - return a one-time password-reset link for an existing user (or email it)
//
// Security:
//   * The gateway verifies the caller's JWT (verify_jwt = true).
//   * The function then asks the database `has_permission('users.manage')` WITH THE CALLER'S TOKEN, so the same
//     rules apply as everywhere else: active profile, live session, Admin role and MFA (aal2).
//   * Links are returned only to that Admin and are never written to logs or the activity history.
//   * No third-party imports: only the Supabase REST and Auth HTTP APIs via fetch (no supply-chain or boot-time downloads).

const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
const SERVICE_KEY = Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const PUBLIC_KEY = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SITE_URL = (Deno.env.get("APP_SITE_URL") ?? "").replace(/\/+$/, "");
const ALLOWED_ORIGINS = (Deno.env.get("APP_ALLOWED_ORIGINS") ?? SITE_URL)
  .split(",")
  .map((s) => s.trim().replace(/\/+$/, ""))
  .filter(Boolean);

type Json = Record<string, unknown>;
type InviteBody = { action: "invite"; email: string; full_name: string; role_key: string; delivery: "link" | "email" };
type RecoveryBody = { action: "recovery"; user_id: string; delivery: "link" | "email" };

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------- validation
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseBody(raw: unknown): InviteBody | RecoveryBody {
  if (!raw || typeof raw !== "object") throw new HttpError(400, "Invalid request body.");
  const b = raw as Json;
  const delivery = b.delivery === undefined ? "link" : b.delivery;
  if (delivery !== "link" && delivery !== "email") throw new HttpError(400, "delivery must be 'link' or 'email'.");
  if (b.action === "invite") {
    const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
    const fullName = typeof b.full_name === "string" ? b.full_name.trim() : "";
    const role = typeof b.role_key === "string" ? b.role_key : "";
    if (!EMAIL_RE.test(email) || email.length > 254) throw new HttpError(400, "A valid email address is required.");
    if (fullName.length < 1 || fullName.length > 120) throw new HttpError(400, "Full name must be 1 to 120 characters.");
    if (!/^[a-z_]{3,30}$/.test(role)) throw new HttpError(400, "Invalid role.");
    return { action: "invite", email, full_name: fullName, role_key: role, delivery };
  }
  if (b.action === "recovery") {
    const userId = typeof b.user_id === "string" ? b.user_id : "";
    if (!UUID_RE.test(userId)) throw new HttpError(400, "Invalid user id.");
    return { action: "recovery", user_id: userId, delivery };
  }
  throw new HttpError(400, "Unknown action.");
}

// ---------------------------------------------------------------- HTTP helpers
function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Max-Age": "600",
  };
  if (origin && ALLOWED_ORIGINS.includes(origin.replace(/\/+$/, ""))) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function respond(status: number, body: unknown, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function serviceHeaders(): Record<string, string> {
  // New-style secret keys (sb_secret_...) go in `apikey` only; legacy service_role JWTs also as Bearer.
  const h: Record<string, string> = { apikey: SERVICE_KEY, "Content-Type": "application/json" };
  if (SERVICE_KEY.startsWith("eyJ")) h.Authorization = `Bearer ${SERVICE_KEY}`;
  return h;
}

async function call(url: string, init: RequestInit): Promise<{ status: number; data: unknown }> {
  const res = await fetch(url, init);
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { message: text };
  }
  return { status: res.status, data };
}

function errorMessage(data: unknown): string {
  const d = (data ?? {}) as Json;
  return String(d.msg ?? d.message ?? d.error_description ?? d.error ?? "unknown error");
}

/** Database access AS THE CALLER (Row Level Security and permission checks apply). */
function callerApi(authorization: string, apikey: string) {
  const headers = { apikey, Authorization: authorization, "Content-Type": "application/json" };
  return {
    rpc: (fn: string, args: Json) => call(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: "POST", headers, body: JSON.stringify(args) }),
    select: (path: string) => call(`${SUPABASE_URL}/rest/v1/${path}`, { method: "GET", headers }),
  };
}

function confirmLink(hashedToken: string, type: "invite" | "recovery"): string {
  const url = new URL(`${SITE_URL}/auth/confirm`);
  url.searchParams.set("token_hash", hashedToken);
  url.searchParams.set("type", type);
  return url.toString();
}

// ---------------------------------------------------------------- handler
Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (req.method !== "POST") return respond(405, { error: "Method not allowed" }, origin);
  if (origin && !ALLOWED_ORIGINS.includes(origin.replace(/\/+$/, ""))) return respond(403, { error: "Origin not allowed" }, origin);
  if (!SUPABASE_URL || !SERVICE_KEY || !SITE_URL) {
    console.error("admin-users: missing configuration (SUPABASE_URL, service key or APP_SITE_URL)");
    return respond(500, { error: "Server is not configured. Ask the administrator to set APP_SITE_URL." }, origin);
  }

  const authorization = req.headers.get("Authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return respond(401, { error: "Sign in first." }, origin);
  const caller = callerApi(authorization, req.headers.get("apikey") ?? PUBLIC_KEY);

  try {
    const perm = await caller.rpc("has_permission", { p_key: "users.manage" });
    if (perm.status !== 200 || perm.data !== true) {
      return respond(403, { error: "Only an Admin with a verified MFA session can manage users." }, origin);
    }

    let body: InviteBody | RecoveryBody;
    try {
      body = parseBody(await req.json());
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, "Invalid JSON.");
    }

    if (body.action === "invite") {
      const role = await caller.select(`roles?select=key&key=eq.${encodeURIComponent(body.role_key)}`);
      if (!Array.isArray(role.data) || role.data.length !== 1) throw new HttpError(400, `Unknown role "${body.role_key}".`);
      const existing = await caller.select(`profiles?select=id&email=ilike.${encodeURIComponent(body.email)}`);
      if (Array.isArray(existing.data) && existing.data.length > 0) {
        throw new HttpError(409, "A user with this email already exists. Use 'Password reset link' instead.");
      }

      let userId: string;
      let link: string | undefined;
      const redirect = encodeURIComponent(`${SITE_URL}/auth/confirm`);
      if (body.delivery === "email") {
        const r = await call(`${SUPABASE_URL}/auth/v1/invite?redirect_to=${redirect}`, {
          method: "POST",
          headers: serviceHeaders(),
          body: JSON.stringify({ email: body.email, data: { full_name: body.full_name } }),
        });
        if (r.status !== 200) throw new HttpError(502, `Invitation email could not be sent: ${errorMessage(r.data)}. Use 'Copy link' instead.`);
        userId = String((r.data as Json).id);
      } else {
        const r = await call(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
          method: "POST",
          headers: serviceHeaders(),
          body: JSON.stringify({ type: "invite", email: body.email, data: { full_name: body.full_name }, redirect_to: `${SITE_URL}/auth/confirm` }),
        });
        const d = (r.data ?? {}) as Json;
        if (r.status !== 200 || typeof d.hashed_token !== "string") {
          throw new HttpError(502, `Could not create the invitation: ${errorMessage(r.data)}`);
        }
        userId = String(d.id);
        link = confirmLink(d.hashed_token, "invite");
      }

      const fin = await caller.rpc("admin_finalize_invite", { p_user_id: userId, p_full_name: body.full_name, p_role_key: body.role_key });
      if (fin.status !== 200) {
        // The account exists but stays INACTIVE (no access). Report clearly.
        throw new HttpError(500, `Account created but not activated: ${errorMessage(fin.data)}`);
      }
      await caller.rpc("log_activity", {
        p_action: body.delivery === "email" ? "user.invite_email_sent" : "user.invite_link_generated",
        p_module: "users",
        p_entity_id: userId,
        p_details: { email: body.email, role_key: body.role_key },
      });
      return respond(200, { user_id: userId, delivery: body.delivery, link }, origin);
    }

    // recovery
    const prof = await caller.select(`profiles?select=id,email,is_active&id=eq.${body.user_id}`);
    const profile = Array.isArray(prof.data) ? (prof.data[0] as { id: string; email: string; is_active: boolean } | undefined) : undefined;
    if (!profile) throw new HttpError(404, "User not found.");
    if (!profile.is_active) throw new HttpError(400, "This user is deactivated. Reactivate the user first.");

    let link: string | undefined;
    if (body.delivery === "email") {
      const redirect = encodeURIComponent(`${SITE_URL}/auth/confirm`);
      const r = await call(`${SUPABASE_URL}/auth/v1/recover?redirect_to=${redirect}`, {
        method: "POST",
        headers: serviceHeaders(),
        body: JSON.stringify({ email: profile.email }),
      });
      if (r.status !== 200) throw new HttpError(502, `Reset email could not be sent: ${errorMessage(r.data)}. Use 'Copy link' instead.`);
    } else {
      const r = await call(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
        method: "POST",
        headers: serviceHeaders(),
        body: JSON.stringify({ type: "recovery", email: profile.email }),
      });
      const d = (r.data ?? {}) as Json;
      if (r.status !== 200 || typeof d.hashed_token !== "string") throw new HttpError(502, `Could not create the reset link: ${errorMessage(r.data)}`);
      link = confirmLink(d.hashed_token, "recovery");
    }
    await caller.rpc("log_activity", {
      p_action: body.delivery === "email" ? "user.recovery_email_sent" : "user.recovery_link_generated",
      p_module: "users",
      p_entity_id: profile.id,
      p_details: { email: profile.email },
    });
    return respond(200, { user_id: profile.id, delivery: body.delivery, link }, origin);
  } catch (e) {
    if (e instanceof HttpError) return respond(e.status, { error: e.message }, origin);
    console.error("admin-users failed:", e instanceof Error ? e.message : "unknown");
    return respond(500, { error: "Unexpected server error." }, origin);
  }
});
