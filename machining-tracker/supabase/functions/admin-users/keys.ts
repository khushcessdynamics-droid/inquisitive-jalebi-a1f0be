// Picks the Supabase API keys the Edge Function runtime provides. Hosted projects provide the current keys as JSON
// dictionaries keyed by key name (SUPABASE_SECRET_KEYS / SUPABASE_PUBLISHABLE_KEYS, e.g. {"default": "sb_secret_..."});
// the legacy SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY are deprecated but still provided while legacy keys are enabled,
// and are what the local development stack provides. Pure function so it can be unit-tested outside Deno.
export type EnvGet = (name: string) => string | undefined;

function fromDictionary(raw: string | undefined): string {
  if (!raw) return "";
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return "";
    const dict = parsed as Record<string, unknown>;
    if (typeof dict.default === "string" && dict.default) return dict.default;
    const first = Object.values(dict).find((v) => typeof v === "string" && v !== "");
    return typeof first === "string" ? first : "";
  } catch {
    return "";
  }
}

export function pickKeys(env: EnvGet): { secret: string; publishable: string } {
  return {
    secret: fromDictionary(env("SUPABASE_SECRET_KEYS")) || env("SUPABASE_SECRET_KEY") || env("SUPABASE_SERVICE_ROLE_KEY") || "",
    publishable: fromDictionary(env("SUPABASE_PUBLISHABLE_KEYS")) || env("SUPABASE_PUBLISHABLE_KEY") || env("SUPABASE_ANON_KEY") || "",
  };
}
