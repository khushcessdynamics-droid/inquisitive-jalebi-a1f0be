import { useEffect, useRef, useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../auth/AuthProvider";
import { cleanCode, listTotpFactors, verifyTotp } from "../../auth/mfa";
import { Alert, Button, Field, Input, Spinner } from "../../components/ui";
import { AuthShell } from "./AuthShell";

type Mode = { kind: "loading" } | { kind: "verify"; factorId: string } | { kind: "enroll"; factorId: string; qr: string; secret: string } | { kind: "error"; message: string };

/**
 * Two-factor authentication with an authenticator app (TOTP, free on Supabase).
 * - Mandatory for Admin and Manager (database policy), optional for Staff (reached from My Account).
 */
export function MfaPage() {
  const { access, refreshAccess, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const setup = new URLSearchParams(location.search).get("setup") === "1";
  const next = (location.state as { from?: string } | null)?.from ?? (setup ? "/account" : "/");
  const [mode, setMode] = useState<Mode>({ kind: "loading" });
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      try {
        const { verified, unverified } = await listTotpFactors();
        if (verified[0]) {
          setMode({ kind: "verify", factorId: verified[0].id });
          return;
        }
        for (const f of unverified) await supabase.auth.mfa.unenroll({ factorId: f.id });
        const { data, error: err } = await supabase.auth.mfa.enroll({
          factorType: "totp",
          friendlyName: `Authenticator ${new Date().toISOString().slice(0, 10)}`,
          issuer: "CESS Machining Tracker",
        });
        if (err || !data) throw new Error(err?.message ?? "Could not start MFA setup");
        setMode({ kind: "enroll", factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
      } catch (e) {
        setMode({ kind: "error", message: e instanceof Error ? e.message : "MFA is not available" });
      }
    })();
  }, []);

  if (access?.status === "ok" && access.aal === "aal2" && mode.kind === "verify" && !setup) return <Navigate to={next} replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (mode.kind !== "verify" && mode.kind !== "enroll") return;
    setBusy(true);
    setError(null);
    try {
      await verifyTotp(mode.factorId, code);
      await supabase.rpc("log_activity", { p_action: mode.kind === "enroll" ? "mfa.enrolled" : "mfa.verified", p_module: "auth" });
      await refreshAccess();
      navigate(next, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
      setCode("");
    } finally {
      setBusy(false);
    }
  }

  const title = mode.kind === "enroll" ? "Set up two-factor authentication" : "Two-factor authentication";
  return (
    <AuthShell
      title={title}
      subtitle={
        mode.kind === "enroll"
          ? access?.mfa_required
            ? "Your role requires an authenticator app (Google Authenticator, Microsoft Authenticator, or similar)."
            : "Recommended: protect your account with an authenticator app."
          : "Enter the 6-digit code from your authenticator app."
      }
    >
      {mode.kind === "loading" && <Spinner />}
      {mode.kind === "error" && <Alert tone="error">{mode.message}</Alert>}
      {mode.kind === "enroll" && (
        <div className="space-y-3">
          <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-700">
            <li>Open your authenticator app and add a new account.</li>
            <li>Scan this QR code, or type the setup key below.</li>
            <li>Enter the 6-digit code the app shows.</li>
          </ol>
          <div className="flex justify-center rounded-md border border-slate-200 bg-white p-3">
            <img src={mode.qr} alt="QR code for your authenticator app" className="h-44 w-44" />
          </div>
          <div className="text-xs text-slate-600">
            Setup key: <code data-testid="totp-secret" className="break-all rounded bg-slate-100 px-1.5 py-0.5 font-mono text-slate-900">{mode.secret}</code>
          </div>
        </div>
      )}
      {(mode.kind === "verify" || mode.kind === "enroll") && (
        <form onSubmit={onSubmit} className="space-y-4">
          <Field label="6-digit code" htmlFor="otp">
            <Input
              id="otp"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(cleanCode(e.target.value))}
              className="text-center font-mono text-lg tracking-[0.4em]"
            />
          </Field>
          {error && <Alert tone="error">{error}</Alert>}
          <Button type="submit" className="w-full" loading={busy} disabled={code.length !== 6}>
            {mode.kind === "enroll" ? "Activate" : "Verify"}
          </Button>
        </form>
      )}
      <div className="flex justify-between text-sm">
        {setup && access?.status === "ok" ? (
          <button type="button" className="text-brand-700 hover:underline" onClick={() => navigate("/account")}>
            Cancel
          </button>
        ) : (
          <span />
        )}
        <button type="button" className="text-slate-500 hover:underline" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
    </AuthShell>
  );
}
