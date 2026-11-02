import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { PermissionKey } from "@cess/shared";
import { supabase, configError } from "../lib/supabase";
import { unwrap } from "../lib/errors";
import type { Access } from "../lib/types";

interface AuthContextValue {
  session: Session | null;
  sessionLoading: boolean;
  access: Access | null;
  accessLoading: boolean;
  accessError: Error | null;
  can: (permission: PermissionKey) => boolean;
  refreshAccess: () => Promise<void>;
  signOut: (options?: { scope?: "local" | "global"; notice?: string }) => Promise<void>;
  notice: string | null;
  clearNotice: () => void;
  configError: string | null;
}

const AuthContext = createContext<AuthContextValue | null>(null);
const NOTICE_KEY = "cess.auth.notice";
const HEARTBEAT_MS = 60_000;

/** Reads claims from the access token for routing only (the server verifies the token itself). */
export function tokenClaims(token: string | undefined): { aal?: string; session_id?: string } {
  if (!token) return {};
  try {
    const payload = token.split(".")[1] ?? "";
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json) as { aal?: string; session_id?: string };
  } catch {
    return {};
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<Session | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(() => sessionStorage.getItem(NOTICE_KEY));

  useEffect(() => {
    let mounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session);
      setSessionLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      setSessionLoading(false);
    });
    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const claims = tokenClaims(session?.access_token);
  const accessQuery = useQuery({
    queryKey: ["access", session?.user.id ?? null, claims.session_id ?? null, claims.aal ?? null],
    enabled: !!session,
    queryFn: async () => unwrap(await supabase.rpc("my_access")) as Access,
    staleTime: 30_000,
  });
  const access = session ? (accessQuery.data ?? null) : null;

  const showNotice = useCallback((text: string | undefined) => {
    if (text) {
      sessionStorage.setItem(NOTICE_KEY, text);
      setNotice(text);
    }
  }, []);

  const signOut = useCallback(
    async (options?: { scope?: "local" | "global"; notice?: string }) => {
      try {
        await supabase.rpc("log_activity", { p_action: "auth.signed_out", p_module: "auth" });
      } catch {
        /* best effort: the session may already be invalid */
      }
      await supabase.auth.signOut({ scope: options?.scope ?? "local" });
      queryClient.clear();
      showNotice(options?.notice);
    },
    [queryClient, showNotice],
  );

  // Server says the session is no longer valid (revoked, idle, too old): sign out locally.
  useEffect(() => {
    if (access?.status === "session_expired") {
      void signOut({ notice: "Your session has ended. Please sign in again." });
    }
  }, [access?.status, signOut]);

  // Idle timeout + server heartbeat (server-side idle timeout is enforced by the database as well).
  const lastActivity = useRef(Date.now());
  const lastTouch = useRef(0);
  const sessionValid = access?.status === "ok" || access?.status === "mfa_required";
  const idleMinutes = access?.idle_timeout_minutes ?? 30;

  useEffect(() => {
    if (!sessionValid) return;
    const mark = () => {
      lastActivity.current = Date.now();
    };
    const events = ["mousedown", "keydown", "touchstart", "scroll", "pointermove"] as const;
    events.forEach((e) => window.addEventListener(e, mark, { passive: true }));

    const touch = async () => {
      const { data, error } = await supabase.rpc("touch_session");
      if (!error && data === false) {
        await signOut({ notice: "Your session has ended. Please sign in again." });
        return;
      }
      lastTouch.current = Date.now();
    };
    if (lastTouch.current === 0) void touch();

    const timer = window.setInterval(() => {
      const idleFor = Date.now() - lastActivity.current;
      if (idleFor > idleMinutes * 60_000) {
        void signOut({ notice: `You were signed out after ${idleMinutes} minutes without activity.` });
        return;
      }
      if (lastActivity.current > lastTouch.current) void touch();
    }, HEARTBEAT_MS);

    return () => {
      events.forEach((e) => window.removeEventListener(e, mark));
      window.clearInterval(timer);
    };
  }, [sessionValid, idleMinutes, signOut]);

  useEffect(() => {
    if (!session) lastTouch.current = 0;
  }, [session]);

  // Permission/role changes by an Admin take effect immediately in open browsers.
  useEffect(() => {
    if (!session || access?.status !== "ok") return;
    const channel = supabase
      .channel("access-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "profiles" }, () =>
        queryClient.invalidateQueries({ queryKey: ["access"] }),
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "role_permissions" }, () =>
        queryClient.invalidateQueries({ queryKey: ["access"] }),
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "user_permission_overrides" }, () =>
        queryClient.invalidateQueries({ queryKey: ["access"] }),
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "roles" }, () =>
        queryClient.invalidateQueries({ queryKey: ["access"] }),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [session, access?.status, queryClient]);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      sessionLoading,
      access,
      accessLoading: !!session && accessQuery.isLoading,
      accessError: accessQuery.error,
      can: (permission) => access?.status === "ok" && (access.permissions ?? []).includes(permission),
      refreshAccess: async () => {
        await queryClient.invalidateQueries({ queryKey: ["access"] });
      },
      signOut,
      notice,
      clearNotice: () => {
        sessionStorage.removeItem(NOTICE_KEY);
        setNotice(null);
      },
      configError,
    }),
    [session, sessionLoading, access, accessQuery.isLoading, accessQuery.error, queryClient, signOut, notice],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
