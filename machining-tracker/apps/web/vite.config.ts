import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Writes Cloudflare `_headers` into the build output with a strict Content-Security-Policy.
 * connect-src is limited to the configured Supabase project (REST, Auth, Realtime websockets, Storage, Functions).
 * No `_redirects` file: Cloudflare Pages serves the app for unknown paths by itself when there is no top-level 404.html
 * (single-page application mode), and a catch-all rewrite there would also apply to real files.
 */
function securityHeaders(supabaseUrl: string, turnstile: boolean): Plugin {
  return {
    name: "cess-security-headers",
    apply: "build",
    generateBundle() {
      if (!supabaseUrl) throw new Error("VITE_SUPABASE_URL must be set for production builds");
      const api = new URL(supabaseUrl);
      const ws = `${api.protocol === "https:" ? "wss:" : "ws:"}//${api.host}`;
      const csp = [
        "default-src 'self'",
        // Cloudflare Turnstile (optional CAPTCHA on sign-in) needs its script and iframe
        `script-src 'self'${turnstile ? " https://challenges.cloudflare.com" : ""}`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self'",
        `connect-src 'self' ${api.origin} ${ws}`,
        turnstile ? "frame-src https://challenges.cloudflare.com" : "frame-src 'none'",
        "frame-ancestors 'none'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "upgrade-insecure-requests",
      ].join("; ");
      const headers = [
        "/*",
        `  Content-Security-Policy: ${csp}`,
        "  X-Frame-Options: DENY",
        "  X-Content-Type-Options: nosniff",
        "  Referrer-Policy: strict-origin-when-cross-origin",
        "  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()",
        "  Strict-Transport-Security: max-age=31536000; includeSubDomains",
        "  Cross-Origin-Opener-Policy: same-origin",
        // the app shell must be re-checked on every visit so a new version reaches users at once
        "/",
        "  Cache-Control: no-cache",
        "/index.html",
        "  Cache-Control: no-cache",
        "/assets/*",
        "  Cache-Control: public, max-age=31536000, immutable",
        "",
      ].join("\n");
      this.emitFile({ type: "asset", fileName: "_headers", source: headers });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  return {
    plugins: [react(), tailwindcss(), securityHeaders(env.VITE_SUPABASE_URL ?? "", !!env.VITE_TURNSTILE_SITE_KEY)],
    build: { sourcemap: false, target: "es2022" },
    server: { strictPort: true },
    preview: { strictPort: true },
  };
});
