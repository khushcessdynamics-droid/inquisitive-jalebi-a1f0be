import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import { Alert, Spinner } from "../../components/ui";
import { AuthShell } from "./AuthShell";

const ALLOWED = ["invite", "recovery"] as const;
type LinkType = (typeof ALLOWED)[number];

/** Landing page of one-time links (invitation / password reset). Exchanges token_hash for a session. */
export function AuthConfirmPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const tokenHash = params.get("token_hash");
    const type = params.get("type") as LinkType | null;
    if (!tokenHash || !type || !ALLOWED.includes(type)) {
      setError("This link is incomplete or not valid.");
      return;
    }
    // Remove the token from the address bar and browser history straight away.
    window.history.replaceState(null, "", "/auth/confirm");
    void (async () => {
      await supabase.auth.signOut({ scope: "local" }); // never mix with another signed-in account
      const { error: err } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
      if (err) {
        setError("This link has expired or was already used. Ask your Admin for a new link.");
        return;
      }
      navigate(`/set-password?type=${type}`, { replace: true });
    })();
  }, [params, navigate]);

  return (
    <AuthShell title="Checking your link">
      {error ? (
        <>
          <Alert tone="error">{error}</Alert>
          <Link to="/login" className="block text-sm text-brand-700 hover:underline">
            Go to sign in
          </Link>
        </>
      ) : (
        <Spinner label="Verifying..." />
      )}
    </AuthShell>
  );
}
