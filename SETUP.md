# Deployment Setup — Project Blueprint Designer (Cloudflare Pages version)

This is the Cloudflare version of the same app — same frontend, same
features, same free-trial-then-subscribe flow — but running on Cloudflare
Pages + D1 instead of Vercel + Supabase. The main reason to use this
version: Cloudflare Pages' free plan explicitly allows commercial use
including payment processing, so this can stay free even after PayMongo
goes live (Vercel's free tier does not allow that).

**Note**: this is a separate Cloudflare *project* from your existing "Four

States of Life" Pages site — a different site needs its own project, even
though both live under the same Cloudflare account.

## Folder structure (what you're deploying)

```
your-project/
├── wrangler.toml
├── schema.sql
├── public/
│   └── index.html            <- the whole app (unchanged from the Vercel version)
└── functions/
    └── api/
        ├── generate.js            <- proxies to Anthropic, enforces the free-try limit
        ├── paymongo-checkout.js   <- creates a PayMongo Checkout Session
        └── paymongo-webhook.js    <- PayMongo tells this when someone pays
```

No `package.json` or `node_modules` needed this time — everything here uses
what Cloudflare's Workers runtime provides natively (`fetch`, Web Crypto),
with zero external dependencies.

---

## Step 1 — Create the D1 database

You'll need [Node.js](https://nodejs.org) installed to run these one-time
commands (Wrangler, Cloudflare's CLI tool, comes bundled via `npx` — no
separate install required).

1. Open a terminal in this project folder and log in to Cloudflare:
   ```
   npx wrangler login
   ```
   This opens a browser window to authorize.
2. Create the database:
   ```
   npx wrangler d1 create blueprint-designer-db
   ```
   This prints a `database_id` — copy it.
3. Open `wrangler.toml` and paste that ID in place of
   `REPLACE_WITH_YOUR_D1_DATABASE_ID`.
4. Run the schema to create the two tables:
   ```
   npx wrangler d1 execute blueprint-designer-db --remote --file=./schema.sql
   ```

## Step 2 — Get your Anthropic API key

Go to [console.anthropic.com](https://console.anthropic.com) → **API Keys** →
create one. This key is only ever used inside `functions/api/generate.js`,
on the server — never sent to anyone's browser.

## Step 3 — PayMongo (can wait — payments are off for now)

Your PayMongo account is still pending review, and `PAYMENTS_ENABLED` in
`public/index.html` is set to `false`, so the app works fine without this
yet — people just see a "you're on our early access list" message instead
of a payment screen once they use their free generations. Come back to this
step once PayMongo approves you; it doesn't block going live today.

When you're ready: [paymongo.com](https://www.paymongo.com) → activate a
business account → **Developer Tools → API Keys** for your secret key.

## Step 4 — Create the Cloudflare Pages project

1. In the Cloudflare dashboard → **Workers & Pages** → **Create application** → **Pages** tab → **Connect to Git**.
2. Choose the GitHub repo containing these files (same repo you already set up).
3. Build settings: **Framework preset: None**, **Build command:** (leave blank), **Build output directory:** `public`.
4. Click **Save and Deploy**. The first deploy may show errors about missing environment variables/bindings — that's expected, fix those next.

## Step 5 — Bind the D1 database to this Pages project

1. In this Pages project → **Settings → Functions → D1 database bindings**.
2. Add a binding: **Variable name:** `DB`, **D1 database:** the `blueprint-designer-db` you created in Step 1.
3. Save — this needs a redeploy to take effect (Cloudflare usually prompts you, or trigger one from the **Deployments** tab).

## Step 6 — Set environment variables

Same Pages project → **Settings → Environment variables**. Add these for
**Production** (and Preview, if you want preview deploys to also work):

| Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | from Step 2 |
| `APP_URL` | your Pages URL, e.g. `https://blueprint-designer-live.pages.dev` (or your custom domain once you add one) |
| `PAYMONGO_SECRET_KEY` | from Step 3 (can add later) |
| `PAYMONGO_MONTHLY_AMOUNT_PHP` | e.g. `499` (can add later) |
| `PAYMONGO_ANNUAL_AMOUNT_PHP` | e.g. `4999` (can add later) |
| `PAYMONGO_WEBHOOK_SECRET` | placeholder for now, e.g. `pending` (can add later) |

Redeploy after saving.

## Step 7 — Check your PayMongo payment method types (when you get there)

Open `functions/api/paymongo-checkout.js` and check this line:
```js
payment_method_types: ["card", "gcash"],
```
Confirm against your PayMongo Dashboard which other methods (Maya, GrabPay,
ShopeePay) your account has enabled, and their exact string values, before
adding them — an unrecognized value will make the checkout API call fail.

## Step 8 — Connect the PayMongo webhook (when you get there)

1. PayMongo Dashboard → **Developer Tools → Webhooks → Add Endpoint**.
2. URL: `https://your-project.pages.dev/api/paymongo-webhook`
3. Event: `checkout_session.payment.paid`
4. Copy the signing secret it gives you into `PAYMONGO_WEBHOOK_SECRET` in Cloudflare's environment variables. Redeploy.
5. Flip `PAYMENTS_ENABLED` to `true` near the top of `public/index.html`, commit, push — this redeploys automatically and turns the subscribe flow back on.

## Step 9 — Test it

1. Visit your live `.pages.dev` URL. Click any "✨ Generate..." button — it should run immediately, no prompt.
2. Generate 10 times total. On the 11th, the name/email modal should appear.
3. With `PAYMENTS_ENABLED` still `false`, submitting it should show the "early access list" message. Once you flip it to `true` (after Step 8), this same moment should show the Monthly/Annual picker and go to a real PayMongo Checkout page instead.

---

## Notes

- **Why no `package.json`**: the Vercel version needed `@supabase/supabase-js`
  as an npm dependency. This version talks to D1 directly through the
  `env.DB` binding Cloudflare provides — no library needed. Simpler, and
  nothing to keep updated.
- **Changing the free-try limit**: it's set to `10` in two places that must
  match — `FREE_LIMIT` in `functions/api/generate.js` and `FREE_TRY_LIMIT`
  near the top of `public/index.html`.
- **The no-signup free trial is a deliberate tradeoff, not a bug**: free
  tries are tracked by an anonymous ID in `localStorage`, not a verified
  identity — someone who clears their browser storage gets a fresh set of
  10. This is the same tradeoff as the Vercel version had; see the code
  comments in `generate.js` if you want to tighten this later.
- **Costs to expect**: Cloudflare Pages, Functions, and D1 are all free at
  this scale (Workers free tier: 100,000 requests/day; D1 free tier: 5GB
  storage, 5 million reads/month) — and unlike Vercel, this stays free even
  once PayMongo is live, since Cloudflare's free plan explicitly permits
  commercial/payment use. PayMongo itself still takes its per-transaction
  fee once you're charging people; Anthropic API usage is billed per
  request, which the 10-free-tries limit protects against.
