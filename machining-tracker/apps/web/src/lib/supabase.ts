import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

export const configError =
  !url || !key ? "The app is not configured: VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY are missing." : null;

// Only the public URL and publishable key are used in the browser. All data access is checked by
// Row Level Security and permission-checked database functions on the server.
export const supabase = createClient(url ?? "http://invalid.local", key ?? "missing", {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false, // links use token_hash + verifyOtp on /auth/confirm
    flowType: "pkce",
  },
});

export const functionsUrl = `${(url ?? "").replace(/\/+$/, "")}/functions/v1`;
