// functions/api/paymongo-checkout.js
// Cloudflare Pages Function. Creates a PayMongo Checkout Session and
// returns the hosted checkout URL to redirect the browser to.
//
// Same "access pass" model as the Vercel version — see the comment in the
// original for why (PayMongo's native recurring billing doesn't cover
// GCash yet). One payment unlocks a fixed period; it does not auto-renew.
//
// Note on base64 encoding: Workers doesn't have Node's Buffer, so this uses
// the Web-standard btoa() instead of Buffer.from(...).toString("base64").
//
// Required environment variables (Cloudflare Pages dashboard):
//   PAYMONGO_SECRET_KEY
//   PAYMONGO_MONTHLY_AMOUNT_PHP  - price for a 30-day pass, in whole pesos
//   PAYMONGO_ANNUAL_AMOUNT_PHP   - price for a 365-day pass, in whole pesos
//   APP_URL                      - e.g. https://your-project.pages.dev

const PLAN_DAYS = { monthly: 30, annual: 365 };

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "invalid_request" }, 400);
  }

  const { email, name, plan } = body || {};
  if (!email || typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonResponse({ error: "invalid_email" }, 400);
  }
  const normalizedPlan = plan === "annual" ? "annual" : "monthly";
  const days = PLAN_DAYS[normalizedPlan];

  const pesos =
    normalizedPlan === "annual"
      ? parseFloat(env.PAYMONGO_ANNUAL_AMOUNT_PHP)
      : parseFloat(env.PAYMONGO_MONTHLY_AMOUNT_PHP);
  if (!pesos || isNaN(pesos) || pesos <= 0) {
    return jsonResponse({ error: "missing_price", message: "Subscription price is not configured." }, 500);
  }
  const amountCentavos = Math.round(pesos * 100);
  const label = normalizedPlan === "annual" ? "Annual Access (365 days)" : "Monthly Access (30 days)";

  try {
    const authHeader = "Basic " + btoa(`${env.PAYMONGO_SECRET_KEY}:`);

    const response = await fetch("https://api.paymongo.com/v1/checkout_sessions", {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        data: {
          attributes: {
            send_email_receipt: true,
            show_description: true,
            show_line_items: true,
            description: `Project Blueprint Designer — ${label}`,
            line_items: [
              {
                currency: "PHP",
                amount: amountCentavos,
                name: `Project Blueprint Designer — ${label}`,
                quantity: 1,
              },
            ],
            // Only "card" and "gcash" are confirmed-safe defaults — check your
            // PayMongo Dashboard for other enabled methods (Maya, GrabPay,
            // ShopeePay may use different string values) before adding them.
            payment_method_types: ["card", "gcash"],
            success_url: `${env.APP_URL}/?checkout=success`,
            billing: {
              email: email.trim().toLowerCase(),
              name: typeof name === "string" && name.trim() ? name.trim() : undefined,
            },
            metadata: {
              email: email.trim().toLowerCase(),
              name: typeof name === "string" ? name.trim() : "",
              plan: normalizedPlan,
              days: String(days),
            },
          },
        },
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      const msg =
        (data && data.errors && data.errors[0] && data.errors[0].detail) || "PayMongo checkout creation failed";
      throw new Error(msg);
    }

    const checkoutUrl = data && data.data && data.data.attributes && data.data.attributes.checkout_url;
    if (!checkoutUrl) throw new Error("PayMongo did not return a checkout URL");

    return jsonResponse({ url: checkoutUrl }, 200);
  } catch (e) {
    console.error("PayMongo checkout session creation failed:", e);
    return jsonResponse({ error: "checkout_failed", message: e.message }, 500);
  }
}
