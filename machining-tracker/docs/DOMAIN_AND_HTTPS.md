# Domain and HTTPS

## Default: no domain needed (₹0)

Cloudflare Pages gives the site a free address, `https://<project-name>.pages.dev` (for example
`https://cess-machining-tracker.pages.dev`), with HTTPS already working. Browsers only ever open `.dev` addresses over HTTPS, and
the app adds HSTS and the other security headers itself (`docs/CLOUD_SECURITY.md`). You can stay on this address permanently.

## Optional: your own address, e.g. `tracker.cess.co.in` (₹0 if you use your existing domain)

Your company already uses `cess.co.in` for email, so the cheapest option is a **subdomain** of it. No new domain has to be bought,
and the company's email and website are not touched. (Cloudflare's own domain shop does not list `.in` / `.co.in`; if you ever want
a new domain, buy it from an Indian registrar, about ₹800–1,200 a year, and follow the same steps.)

### Who does what

You need whoever manages the DNS of `cess.co.in` (your IT person, web agency or the registrar's control panel). They add **one
record**; nothing else changes.

### Steps

1. **Cloudflare first.** Workers & Pages → the project → **Custom domains** → **Set up a domain** → type `tracker.cess.co.in` →
   **Continue**. Cloudflare shows the record to add. (Adding the DNS record before this step makes the address fail with error 522.)
2. **DNS record** at the provider of `cess.co.in`:

   | Type | Name | Target | TTL |
   |---|---|---|---|
   | CNAME | `tracker` | `cess-machining-tracker.pages.dev` | Automatic / 1 hour |

   If the domain has **CAA** records, they must also allow the certificate authorities Cloudflare uses, or HTTPS cannot be set up
   (Cloudflare's custom-domain page lists this as the common problem).
3. **Wait** until Cloudflare shows the domain as **Active** (it checks the record and sets up the HTTPS certificate itself; this can
   take from minutes to a few hours). Open `https://tracker.cess.co.in` to confirm.
4. **Tell the other services about the new address** (the old `.pages.dev` address keeps working during the change):

   | Where | Change |
   |---|---|
   | Supabase → Authentication → URL Configuration | Site URL `https://tracker.cess.co.in`; add redirect URL `https://tracker.cess.co.in/auth/confirm` (keep the old one until everyone has moved) |
   | Edge Function secrets | `APP_SITE_URL=https://tracker.cess.co.in` and `APP_ALLOWED_ORIGINS=https://tracker.cess.co.in,https://cess-machining-tracker.pages.dev` (GitHub variable `APP_SITE_URL` + "Deploy to Supabase", or `npx supabase secrets set …`) |
   | Turnstile (if used) | Cloudflare → Turnstile → the widget → add the hostname `tracker.cess.co.in` |
   | GitHub variable `APP_SITE_URL` (daily live-site check) | `https://tracker.cess.co.in` |
5. **Check** with the deployment checker against the new address (`docs/DEPLOYMENT.md`, step 7), then tell the team the new address.
   Invitation and reset links use the Site URL, so new links point to the new address automatically.

Use a subdomain rather than `cess.co.in` itself: putting the app on the main domain would require moving the whole domain's DNS to
Cloudflare, which also carries the company email.
