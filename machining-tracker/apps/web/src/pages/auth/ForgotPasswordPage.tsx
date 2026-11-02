import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import { Alert, Button, Field, Input } from "../../components/ui";
import { AuthShell } from "./AuthShell";

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/auth/confirm`,
    });
    setBusy(false);
    if (err && (err.status === 429 || /rate limit/i.test(err.message))) {
      setError("Too many requests. Please wait and try again, or ask your Admin for a reset link.");
      return;
    }
    // Same message whether or not the account exists (no account enumeration).
    setSent(true);
  }

  return (
    <AuthShell title="Reset your password" subtitle="We will email you a one-time link if the address belongs to an account.">
      {sent ? (
        <Alert tone="success" title="Request received">
          If an account exists for <strong>{email}</strong>, a reset email is on its way. If email is not set up for this app yet, or nothing
          arrives within a few minutes, ask your Admin to give you a password reset link.
        </Alert>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <Field label="Email" htmlFor="email">
            <Input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          {error && <Alert tone="error">{error}</Alert>}
          <Button type="submit" className="w-full" loading={busy} disabled={!email.includes("@")}>
            Send reset link
          </Button>
        </form>
      )}
      <Link to="/login" className="block text-sm text-brand-700 hover:underline">
        Back to sign in
      </Link>
    </AuthShell>
  );
}
