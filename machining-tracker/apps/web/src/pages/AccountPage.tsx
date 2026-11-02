import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { passwordProblems, formatDateTimeIST } from "@cess/shared";
import { useAuth } from "../auth/AuthProvider";
import { listTotpFactors } from "../auth/mfa";
import { supabase } from "../lib/supabase";
import { toAppError, unwrap } from "../lib/errors";
import { useDateFormat } from "../hooks/data";
import { Alert, Badge, Button, Card, Field, Input, PageHeader, ReasonDialog, Spinner } from "../components/ui";

export function AccountPage() {
  const { access, session, refreshAccess, signOut } = useAuth();
  const dateFormat = useDateFormat();
  const queryClient = useQueryClient();

  // --- profile name
  const [name, setName] = useState(access?.full_name ?? "");
  const [nameMsg, setNameMsg] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [savingName, setSavingName] = useState(false);
  useEffect(() => setName(access?.full_name ?? ""), [access?.full_name]);

  async function saveName(e: FormEvent) {
    e.preventDefault();
    setSavingName(true);
    setNameMsg(null);
    try {
      unwrap(await supabase.rpc("update_my_profile", { p_full_name: name, p_expected_version: access?.profile_version ?? 0 }));
      await refreshAccess();
      setNameMsg({ tone: "success", text: "Name saved." });
    } catch (err) {
      setNameMsg({ tone: "error", text: toAppError(err).message });
    } finally {
      setSavingName(false);
    }
  }

  // --- password
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [pwMsg, setPwMsg] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [savingPw, setSavingPw] = useState(false);
  const problems = passwordProblems(pw, session?.user.email ?? undefined);

  async function savePassword(e: FormEvent) {
    e.preventDefault();
    setSavingPw(true);
    setPwMsg(null);
    const { error } = await supabase.auth.updateUser({ password: pw });
    if (error) {
      setPwMsg({
        tone: "error",
        text: /reauthentication/i.test(error.message)
          ? "For security, sign out and sign in again, then change your password within a few minutes."
          : /same/i.test(error.message)
            ? "Choose a password different from your current one."
            : error.message,
      });
    } else {
      await supabase.rpc("log_activity", { p_action: "password.changed", p_module: "auth" });
      setPw("");
      setPw2("");
      setPwMsg({ tone: "success", text: "Password changed." });
    }
    setSavingPw(false);
  }

  // --- MFA factors
  const factors = useQuery({ queryKey: ["mfa-factors", session?.user.id], queryFn: listTotpFactors });
  const [removeId, setRemoveId] = useState<string | null>(null);

  // --- sign out everywhere
  const [confirmGlobal, setConfirmGlobal] = useState(false);

  return (
    <>
      <PageHeader title="My Account" description={access?.email} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Profile">
          <form onSubmit={saveName} className="space-y-3">
            <Field label="Full name" htmlFor="full-name">
              <Input id="full-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
            </Field>
            <p className="text-sm text-slate-600">
              Role: <Badge tone="blue">{access?.role_label}</Badge> <span className="text-slate-400">(changed only by an Admin)</span>
            </p>
            {nameMsg && <Alert tone={nameMsg.tone}>{nameMsg.text}</Alert>}
            <Button type="submit" loading={savingName} disabled={!name.trim() || name.trim() === access?.full_name}>
              Save name
            </Button>
          </form>
        </Card>

        <Card title="Change password">
          <form onSubmit={savePassword} className="space-y-3" noValidate>
            <Field label="New password" htmlFor="pw" hint="At least 12 characters with upper-case, lower-case letters and a digit.">
              <Input id="pw" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
            </Field>
            {pw.length > 0 && problems.length > 0 && (
              <ul className="list-disc pl-5 text-xs text-amber-800">
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
            <Field label="Confirm new password" htmlFor="pw2" error={pw2 && pw2 !== pw ? "Passwords do not match" : null}>
              <Input id="pw2" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
            </Field>
            {pwMsg && <Alert tone={pwMsg.tone}>{pwMsg.text}</Alert>}
            <Button type="submit" loading={savingPw} disabled={problems.length > 0 || pw !== pw2}>
              Change password
            </Button>
          </form>
        </Card>

        <Card title="Two-factor authentication">
          {factors.isLoading ? (
            <Spinner />
          ) : factors.error ? (
            <Alert tone="error">{toAppError(factors.error).message}</Alert>
          ) : factors.data && factors.data.verified.length > 0 ? (
            <ul className="space-y-2">
              {factors.data.verified.map((f) => (
                <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 px-3 py-2">
                  <div className="text-sm">
                    <p className="font-medium text-slate-800">{f.friendly_name || "Authenticator app"}</p>
                    <p className="text-xs text-slate-500">Added {formatDateTimeIST(f.created_at, dateFormat)}</p>
                  </div>
                  {access?.mfa_required ? (
                    <span className="text-xs text-slate-500">Required for your role</span>
                  ) : (
                    <Button variant="secondary" onClick={() => setRemoveId(f.id)}>
                      Remove
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-slate-600">No authenticator app is set up. It is optional for your role but strongly recommended.</p>
              <Link to="/mfa?setup=1">
                <Button>Set up authenticator app</Button>
              </Link>
            </div>
          )}
        </Card>

        <Card title="Sessions">
          <p className="text-sm text-slate-600">
            Signs you out on every computer and phone, including this one. Use it if you signed in on a shared or lost device.
          </p>
          <Button className="mt-3" variant="secondary" onClick={() => setConfirmGlobal(true)}>
            Sign out on all devices
          </Button>
        </Card>
      </div>

      <ReasonDialog
        open={!!removeId}
        title="Remove authenticator app?"
        message="After removing it, you will sign in with your password only."
        confirmLabel="Remove"
        danger
        requireReason={false}
        onCancel={() => setRemoveId(null)}
        onConfirm={async () => {
          const { error } = await supabase.auth.mfa.unenroll({ factorId: removeId! });
          if (error) throw new Error(error.message);
          await supabase.rpc("log_activity", { p_action: "mfa.removed", p_module: "auth" });
          await supabase.auth.refreshSession();
          setRemoveId(null);
          await queryClient.invalidateQueries({ queryKey: ["mfa-factors"] });
          await refreshAccess();
        }}
      />
      <ReasonDialog
        open={confirmGlobal}
        title="Sign out on all devices?"
        message="You will need to sign in again everywhere."
        confirmLabel="Sign out everywhere"
        requireReason={false}
        onCancel={() => setConfirmGlobal(false)}
        onConfirm={async () => {
          await signOut({ scope: "global", notice: "You were signed out on all devices." });
        }}
      />
    </>
  );
}
