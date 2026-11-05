// Reads connection details of the LOCAL Supabase stack (npx supabase start). Never used for production.
import { execSync } from "node:child_process";

export interface LocalEnv {
  apiUrl: string;
  publishableKey: string;
  secretKey: string;
  serviceRoleKey: string;
  anonKey: string;
  dbUrl: string;
  mailpitUrl: string;
}

let cached: LocalEnv | null = null;

export function localEnv(): LocalEnv {
  if (cached) return cached;
  const raw = execSync("npx supabase status -o json", { cwd: process.cwd(), stdio: ["ignore", "pipe", "ignore"] }).toString();
  const s = JSON.parse(raw.slice(raw.indexOf("{"))) as Record<string, string>;
  if (!s.API_URL?.startsWith("http://127.0.0.1")) throw new Error("Refusing to run tests against a non-local Supabase");
  cached = {
    apiUrl: s.API_URL,
    publishableKey: s.PUBLISHABLE_KEY!,
    secretKey: s.SECRET_KEY!,
    serviceRoleKey: s.SERVICE_ROLE_KEY!,
    anonKey: s.ANON_KEY!,
    dbUrl: s.DB_URL!,
    mailpitUrl: s.MAILPIT_URL ?? s.INBUCKET_URL!,
  };
  return cached;
}
