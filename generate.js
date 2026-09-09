// functions/api/generate.js
// Cloudflare Pages Function (runs on Cloudflare's Workers runtime, not
// Node.js — that's why this looks different from a typical Vercel/Express
// handler: no req/res, no Node "crypto" or "Buffer", just Request/Response
// and the Web Fetch API, which Workers implements natively).
//
// Proxies generation requests to Anthropic, holding the real API key
// server-side. Two request paths, same logic as the Vercel version:
//  - Anonymous (no email yet): tracked by a silent "anonId" the browser
//    generates itself, enforced against FREE_LIMIT in the D1 anon_usage table.
//  - Identified (email present): allowed only if their D1 users row shows
//    unexpired access. No separate email-based free allowance.
//
// Requires:
//   - A D1 database bound as "DB" (see wrangler.toml)
//   - Environment variable ANTHROPIC_API_KEY, set in the Cloudflare Pages
//     dashboard under Settings -> Environment variables

const FREE_LIMIT = 10; // must match FREE_TRY_LIMIT in the frontend source

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function callAnthropic(env, prompt, maxTokens) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: maxTokens || 1000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await r.json();
  if (!r.ok) {
    const msg = (data && data.error && data.error.message) || `Anthropic API error (HTTP ${r.status})`;
    throw new Error(msg);
  }
  const text = (data.content || []).map((b) => b.text || "").join("").trim();
  if (!text) throw new Error("Model returned an empty response");
  return text;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "invalid_request", message: "Malformed JSON body." }, 400);
  }

  const { email, name, anonId, prompt, maxTokens } = body || {};
  if (!prompt || typeof prompt !== "string") {
    return jsonResponse({ error: "invalid_prompt", message: "Missing prompt." }, 400);
  }

  const normalizedEmail = typeof email === "string" && email.trim() ? email.trim().toLowerCase() : null;
  const normalizedName = typeof name === "string" && name.trim() ? name.trim() : null;

  // ---- Path 1: identified user (has provided email at some point) ----
  if (normalizedEmail) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return jsonResponse({ error: "invalid_email", message: "Invalid email." }, 400);
    }

    let user;
    try {
      user = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(normalizedEmail).first();
      if (user && normalizedName && normalizedName !== user.name) {
        await env.DB.prepare("UPDATE users SET name = ? WHERE email = ?").bind(normalizedName, normalizedEmail).run();
        user.name = normalizedName;
      }
    } catch (e) {
      console.error("D1 user lookup failed:", e);
      return jsonResponse({ error: "user_lookup_failed", message: "Could not verify your account." }, 500);
    }

    const isActive =
      user &&
      user.subscription_status === "active" &&
      user.access_expires_at &&
      new Date(user.access_expires_at).getTime() > Date.now();

    if (!isActive) {
      return jsonResponse(
        { error: "limit_reached", message: "Your access has expired. Subscribe to keep generating." },
        402
      );
    }

    try {
      const text = await callAnthropic(env, prompt, maxTokens);
      return jsonResponse({ text, subscribed: true, accessExpiresAt: user.access_expires_at, remaining: null }, 200);
    } catch (e) {
      console.error("Anthropic call failed:", e);
      return jsonResponse({ error: "upstream_error", message: e.message || "Generation failed upstream." }, 502);
    }
  }

  // ---- Path 2: anonymous free-trial user (no email yet) ----
  if (!anonId || typeof anonId !== "string") {
    return jsonResponse({ error: "invalid_request", message: "Missing anonId or email." }, 400);
  }

  let anon;
  try {
    anon = await env.DB.prepare("SELECT * FROM anon_usage WHERE anon_id = ?").bind(anonId).first();
    if (!anon) {
      await env.DB.prepare("INSERT INTO anon_usage (anon_id, generation_count) VALUES (?, 0)").bind(anonId).run();
      anon = { anon_id: anonId, generation_count: 0 };
    }
  } catch (e) {
    console.error("D1 anon lookup failed:", e);
    return jsonResponse({ error: "user_lookup_failed", message: "Could not verify free-trial usage." }, 500);
  }

  if (anon.generation_count >= FREE_LIMIT) {
    return jsonResponse(
      { error: "limit_reached", message: `You've used all ${FREE_LIMIT} free generations. Subscribe to keep going.` },
      402
    );
  }

  let text;
  try {
    text = await callAnthropic(env, prompt, maxTokens);
  } catch (e) {
    console.error("Anthropic call failed:", e);
    return jsonResponse({ error: "upstream_error", message: e.message || "Generation failed upstream." }, 502);
  }

  const newCount = anon.generation_count + 1;
  try {
    await env.DB.prepare("UPDATE anon_usage SET generation_count = ? WHERE anon_id = ?").bind(newCount, anonId).run();
  } catch (e) {
    console.error("Failed to increment anon generation_count:", e);
  }

  return jsonResponse(
    { text, subscribed: false, accessExpiresAt: null, remaining: Math.max(0, FREE_LIMIT - newCount) },
    200
  );
}
