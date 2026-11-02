import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Writes Cloudflare `_headers` into the build output with a strict Content-Security-Policy.
 * connect-src is limited to the configured Supabase project (REST, Auth, Realtime websockets, Storage, Functions).
 */
function securityHeaders(supabaseUrl: string): Plugin {
  return {
    name: "cess-security-headers",
    apply: "build",
    generateBundle() {
      if (!supabaseUrl) throw new Error("VITE_SUPABASE_URL must be set for production builds");
      const api = new URL(supabaseUrl);
      const ws = `${api.protocol === "https:" ? "wss:" : "ws:"}//${api.host}`;
      const csp = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self'",
        `connect-src 'self' ${api.origin} ${ws}`,
        "frame-src 'none'",
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
    plugins: [react(), tailwindcss(), securityHeaders(env.VITE_SUPABASE_URL ?? "")],
    build: { sourcemap: false, target: "es2022" },
    server: { strictPort: true },
    preview: { strictPort: true },
  };
});
