// Optional bot protection for sign-in and password reset with Cloudflare Turnstile (free).
// Active only when VITE_TURNSTILE_SITE_KEY is set at build time AND CAPTCHA protection is switched on in
// Supabase (Authentication > Attack Protection) with the matching secret key. The token is checked by Supabase
// Auth on the server; each token can be used once, so the widget is reset after every attempt.
import { useCallback, useEffect, useRef, useState } from "react";

interface TurnstileApi {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  reset: (id?: string) => void;
  remove: (id: string) => void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

export const TURNSTILE_SITE_KEY: string = (import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined) ?? "";
const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

let loading: Promise<TurnstileApi> | null = null;
function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SCRIPT;
    s.async = true;
    s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("Turnstile did not load")));
    s.onerror = () => {
      loading = null;
      reject(new Error("The security check could not be loaded. Check the internet connection and reload the page."));
    };
    document.head.appendChild(s);
  });
  return loading;
}

/** Returns the current token (null until solved), a reset function and the widget element; disabled = no key configured. */
export function useCaptcha() {
  const enabled = TURNSTILE_SITE_KEY !== "";
  const box = useRef<HTMLDivElement | null>(null);
  const widget = useRef<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !box.current) return;
    let cancelled = false;
    loadTurnstile()
      .then((api) => {
        if (cancelled || !box.current) return;
        widget.current = api.render(box.current, {
          sitekey: TURNSTILE_SITE_KEY,
          action: "login",
          callback: (t: string) => setToken(t),
          "expired-callback": () => setToken(null),
          "error-callback": () => {
            setToken(null);
            setError("The security check failed. Please try again.");
          },
        });
      })
      .catch((e: Error) => setError(e.message));
    return () => {
      cancelled = true;
      if (widget.current && window.turnstile) window.turnstile.remove(widget.current);
      widget.current = null;
    };
  }, [enabled]);

  const reset = useCallback(() => {
    setToken(null);
    if (widget.current && window.turnstile) window.turnstile.reset(widget.current);
  }, []);

  const element = enabled ? <div ref={box} className="flex min-h-[65px] justify-center" data-testid="captcha" /> : null;
  return { enabled, token, ready: !enabled || token !== null, reset, element, error };
}
