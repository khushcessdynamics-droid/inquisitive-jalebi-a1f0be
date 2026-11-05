import { describe, expect, it } from "vitest";
import { pickKeys } from "../../supabase/functions/admin-users/keys.ts";

const envOf = (vars: Record<string, string>) => (n: string) => vars[n];

describe("Edge Function key selection", () => {
  it("prefers the current keys from the hosted JSON dictionaries ('default' key)", () => {
    const k = pickKeys(
      envOf({
        SUPABASE_SECRET_KEYS: JSON.stringify({ other: "sb_secret_other", default: "sb_secret_default" }),
        SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: "sb_publishable_default" }),
        SUPABASE_SERVICE_ROLE_KEY: "eyJlegacy",
        SUPABASE_ANON_KEY: "eyJanon",
      }),
    );
    expect(k).toEqual({ secret: "sb_secret_default", publishable: "sb_publishable_default" });
  });
  it("uses the first named key when there is no 'default'", () => {
    expect(pickKeys(envOf({ SUPABASE_SECRET_KEYS: '{"cess":"sb_secret_cess"}' })).secret).toBe("sb_secret_cess");
  });
  it("falls back to single keys, then to the legacy keys (local stack)", () => {
    expect(pickKeys(envOf({ SUPABASE_SECRET_KEY: "sb_secret_x", SUPABASE_SERVICE_ROLE_KEY: "eyJlegacy" })).secret).toBe("sb_secret_x");
    expect(pickKeys(envOf({ SUPABASE_SERVICE_ROLE_KEY: "eyJlegacy", SUPABASE_ANON_KEY: "eyJanon" }))).toEqual({ secret: "eyJlegacy", publishable: "eyJanon" });
  });
  it("ignores malformed or empty dictionaries", () => {
    expect(pickKeys(envOf({ SUPABASE_SECRET_KEYS: "not json", SUPABASE_SERVICE_ROLE_KEY: "eyJlegacy" })).secret).toBe("eyJlegacy");
    expect(pickKeys(envOf({ SUPABASE_SECRET_KEYS: "{}", SUPABASE_PUBLISHABLE_KEYS: "[]" }))).toEqual({ secret: "", publishable: "" });
  });
});
