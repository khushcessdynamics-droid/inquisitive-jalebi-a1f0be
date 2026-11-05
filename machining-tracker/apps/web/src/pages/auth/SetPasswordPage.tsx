import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { passwordProblems } from "@cess/shared";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../auth/AuthProvider";
import { cleanCode, listTotpFactors, verifyTotp } from "../../auth/mfa";
import { Alert, Button, Field, Input, Spinner } from "../../components/ui";
import { AuthShell } from "./AuthShell";

/** Set a new password after following an invitation or reset link (the user is signed in by the link). */
export function SetPasswordPage() {
  const [params] = useSearchParams();
  const isInvite = params.get("type") === "invite";
  const { session, refreshAccess } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mfaFactor, setMfaFactor] = useState<string | null | undefined>(undefined);
  const [code, setCode] = useState("");
  const started = useRef(false);

  // A user who already has MFA must confirm a code first (a reset link must not bypass MFA).
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (data && data.nextLevel === "aal2" && data.currentLevel !== "aal2") {
        const { verified } = await listTotpFactors();
        setMfaFactor(verified[0]?.id ?? null);
      } else {
        setMfaFactor(null);
      }
    })();
  }, []);

  const problems = passwordProblems(password, session?.user.email ?? undefined);
  const mismatch = confirm.length > 0 && confirm !== password;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mfaFactor) await verifyTotp(mfaFactor, code);
      const { error: err } = await supabase.auth.updateUser({ password });
      if (err) {
        if (/reauthentication/i.test(err.message)) throw new Error("For security, please sign in again and then change your password.");
        if (/same/i.test(err.message)) throw new Error("Choose a password different from the previous one.");
        throw new Error(err.message);
      }
      await supabase.rpc("log_activity", { p_action: "password.changed", p_module: "auth" });
      await refreshAccess();
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not set the password");
    } finally {
      setBusy(false);
    }
  }

  if (mfaFactor === undefined) {
    return (
      <AuthShell title="Set your password">
        <Spinner />
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={isInvite ? "Welcome - choose your password" : "Choose a new password"}
      subtitle={session?.user.email ? <>Account: <strong>{session.user.email}</strong></> : undefined}
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {mfaFactor && (
          <Field label="Authenticator code" htmlFor="otp" hint="Your account uses two-factor authentication.">
            <Input id="otp" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(cleanCode(e.target.value))} />
          </Field>
        )}
        <Field label="New password" htmlFor="new-password" hint="At least 12 characters with upper-case, lower-case letters and a digit.">
          <Input id="new-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {password.length > 0 && problems.length > 0 && (
          <ul className="list-disc pl-5 text-xs text-amber-800">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <Field label="Confirm new password" htmlFor="confirm-password" error={mismatch ? "Passwords do not match" : null}>
          <Input id="confirm-password" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        {error && <Alert tone="error">{error}</Alert>}
        <Button
          type="submit"
          className="w-full"
          loading={busy}
          disabled={problems.length > 0 || confirm !== password || (!!mfaFactor && code.length !== 6)}
        >
          Save password
        </Button>
      </form>
    </AuthShell>
  );
}
