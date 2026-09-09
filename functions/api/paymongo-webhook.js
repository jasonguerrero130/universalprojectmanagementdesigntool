// functions/api/paymongo-webhook.js
// Cloudflare Pages Function. PayMongo calls this URL directly when a
// checkout session is paid.
//
// SECURITY NOTE — same caveat as the Vercel version: PayMongo's exact
// signature format should be double-checked against their current docs.
// This makes a best-effort verification attempt below using the Web Crypto
// API (Workers has no Node "crypto" module, so this cannot use
// crypto.createHmac like the Vercel version did — Web Crypto's
// crypto.subtle is the standards-based equivalent, available natively in
// Workers with no extra setup).
//
// As the REAL safeguard, this does not trust the webhook body alone — it
// always re-fetches the checkout session from PayMongo's API using your own
// secret key, and only grants access if that independent, authenticated
// check confirms the payment was actually made.
//
// Required environment variables:
//   PAYMONGO_SECRET_KEY
//   PAYMONGO_WEBHOOK_SECRET
//
// Requires the D1 database bound as "DB".
//
// Register this endpoint in the PayMongo Dashboard:
//   Developer Tools -> Webhooks -> Add Endpoint
//   -> https://your-project.pages.dev/api/paymongo-webhook
//   Event to send: checkout_session.payment.paid

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function looksSignatureValid(rawBody, signatureHeader, secret) {
  try {
    if (!signatureHeader || !secret) return false;
    const parts = Object.fromEntries(
      signatureHeader.split(",").map((p) => {
        const [k, v] = p.split("=");
        return [k, v];
      })
    );
    const timestamp = parts.t;
    const candidate = parts.li || parts.te; // live-mode or test-mode signature
    if (!timestamp || !candidate) return false;
    const signedPayload = `${timestamp}.${rawBody}`;

    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
    ]);
    const sigBuffer = await crypto.subtle.sign("HMAC", key, enc.encode(signedPayload));
    const expected = [...new Uint8Array(sigBuffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

    if (expected.length !== candidate.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ candidate.charCodeAt(i);
    return diff === 0;
  } catch (e) {
    return false;
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const rawBody = await request.text();

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    return new Response("Invalid JSON", { status: 400 });
  }

  const signatureHeader = request.headers.get("paymongo-signature");
  const verified = await looksSignatureValid(rawBody, signatureHeader, env.PAYMONGO_WEBHOOK_SECRET);
  if (!verified) {
    console.warn(
      "PayMongo webhook signature could not be verified — proceeding on the authenticated re-fetch check only."
    );
  }

  try {
    const eventType = event && event.data && event.data.attributes && event.data.attributes.type;
    const resource = event && event.data && event.data.attributes && event.data.attributes.data;
    const checkoutSessionId = resource && resource.id;

    if (eventType !== "checkout_session.payment.paid" || !checkoutSessionId) {
      return jsonResponse({ received: true, ignored: true }, 200);
    }

    // Authoritative check: re-fetch the session ourselves rather than trusting the webhook body.
    const authHeader = "Basic " + btoa(`${env.PAYMONGO_SECRET_KEY}:`);
    const sessionRes = await fetch(`https://api.paymongo.com/v1/checkout_sessions/${checkoutSessionId}`, {
      headers: { Authorization: authHeader },
    });
    const sessionData = await sessionRes.json();
    if (!sessionRes.ok) {
      console.error("Could not re-fetch checkout session:", sessionData);
      return jsonResponse({ received: true, verified: false }, 200);
    }

    const attrs = sessionData.data.attributes;
    const payments = attrs.payments || [];
    const hasPaidPayment = payments.some((p) => p.attributes && p.attributes.status === "paid");
    if (!hasPaidPayment) {
      return jsonResponse({ received: true, paid: false }, 200);
    }

    const metadata = attrs.metadata || {};
    const email = (metadata.email || (attrs.billing && attrs.billing.email) || "").toLowerCase();
    const name = metadata.name || (attrs.billing && attrs.billing.name) || null;
    const days = parseInt(metadata.days, 10) || 30;

    if (!email) {
      console.error("Paid checkout session had no email in metadata or billing:", checkoutSessionId);
      return jsonResponse({ received: true, error: "no_email" }, 200);
    }

    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

    const existing = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
    if (existing) {
      if (name) {
        await env.DB.prepare(
          "UPDATE users SET subscription_status = 'active', access_expires_at = ?, name = ? WHERE email = ?"
        )
          .bind(expiresAt, name, email)
          .run();
      } else {
        await env.DB.prepare("UPDATE users SET subscription_status = 'active', access_expires_at = ? WHERE email = ?")
          .bind(expiresAt, email)
          .run();
      }
    } else {
      await env.DB.prepare(
        "INSERT INTO users (email, name, subscription_status, access_expires_at) VALUES (?, ?, 'active', ?)"
      )
        .bind(email, name, expiresAt)
        .run();
    }

    return jsonResponse({ received: true, granted: true }, 200);
  } catch (e) {
    console.error("PayMongo webhook handler error:", e);
    return jsonResponse({ received: true, error: "internal" }, 200);
  }
}
