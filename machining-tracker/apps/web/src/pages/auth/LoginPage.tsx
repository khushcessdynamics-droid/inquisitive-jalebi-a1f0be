import { useState, type FormEvent } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../auth/AuthProvider";
import { Alert, Button, Field, Input } from "../../components/ui";
import { AuthShell } from "./AuthShell";

function loginErrorMessage(message: string, status?: number): string {
  if (status === 429 || /rate limit|too many/i.test(message)) return "Too many sign-in attempts. Please wait a few minutes and try again.";
  if (/invalid login credentials/i.test(message)) return "Email or password is incorrect.";
  if (/banned/i.test(message)) return "This account is deactivated. Contact your Admin.";
  if (/email not confirmed/i.test(message)) return "This account has not been activated yet. Use the link your Admin sent you.";
  return message;
}

export function LoginPage() {
  const { session, access, notice, clearNotice } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? "/";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (session && access?.status === "ok") return <Navigate to={from} replace />;
  if (session && access?.status === "mfa_required") return <Navigate to="/mfa" replace state={{ from }} />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    clearNotice();
    const { error: err } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (err) {
      setError(loginErrorMessage(err.message, err.status));
      setBusy(false);
      return;
    }
    await supabase.rpc("log_activity", { p_action: "auth.signed_in", p_module: "auth" });
    setBusy(false);
    navigate(from, { replace: true });
  }

  return (
    <AuthShell title="Sign in">
      {notice && (
        <Alert tone="info" onClose={clearNotice}>
          {notice}
        </Alert>
      )}
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field label="Email" htmlFor="email">
          <Input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password" htmlFor="password">
          <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {error && <Alert tone="error">{error}</Alert>}
        <Button type="submit" className="w-full" loading={busy} disabled={!email || !password}>
          Sign in
        </Button>
      </form>
      <div className="flex justify-between text-sm">
        <Link to="/forgot-password" className="text-brand-700 hover:underline">
          Forgot password?
        </Link>
        <span className="text-slate-400">Accounts are created by your Admin</span>
      </div>
    </AuthShell>
  );
}
