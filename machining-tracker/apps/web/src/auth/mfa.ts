import { supabase } from "../lib/supabase";
import { AppError } from "../lib/errors";

export interface TotpFactor {
  id: string;
  friendly_name?: string;
  status: string;
  created_at: string;
}

export async function listTotpFactors(): Promise<{ verified: TotpFactor[]; unverified: TotpFactor[] }> {
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error) throw new AppError(error.message);
  const all = ((data?.all ?? []) as Array<TotpFactor & { factor_type: string }>).filter((f) => f.factor_type === "totp");
  return {
    verified: all.filter((f) => f.status === "verified"),
    unverified: all.filter((f) => f.status !== "verified"),
  };
}

export async function verifyTotp(factorId: string, code: string): Promise<void> {
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: code.trim() });
  if (error) {
    if (error.status === 429) throw new AppError("Too many attempts. Wait a minute and try again.");
    throw new AppError(/invalid|expired/i.test(error.message) ? "That code is not correct or has expired. Try the current code." : error.message);
  }
}

export function cleanCode(value: string): string {
  return value.replace(/\D/g, "").slice(0, 6);
}
