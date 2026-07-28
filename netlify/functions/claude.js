// Netlify function equivalent of api/claude.ts. Combined with the redirect
// rule in netlify.toml (/api/* -> /.netlify/functions/:splat), the frontend
// can call the same "/api/claude" path regardless of which platform you use —
// no frontend code changes needed between Vercel and Netlify.
//
// Setup: in Netlify's site settings, add an environment variable named
// ANTHROPIC_API_KEY (no VITE_ prefix).

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body." }) };
  }

  const { system, message } = body;
  if (!system || !message) {
    return { statusCode: 400, body: JSON.stringify({ error: "Request must include 'system' and 'message'." }) };
  }
  if (typeof message !== "string" || message.length > 24000) {
    return { statusCode: 400, body: JSON.stringify({ error: "Message too long." }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: "Server is missing ANTHROPIC_API_KEY." }) };
  }

  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1500,
        system,
        messages: [{ role: "user", content: message }],
      }),
    });
    const data = await upstream.json();

    // Mirrors api/claude.ts — log upstream failures so the real cause shows up
    // in the Netlify function logs, not just in the browser.
    if (!upstream.ok) {
      console.error("Anthropic error", upstream.status, JSON.stringify(data));
    }

    return { statusCode: upstream.status, body: JSON.stringify(data) };
  } catch (e) {
    console.error("Failed to reach Anthropic:", e);
    return { statusCode: 500, body: JSON.stringify({ error: e.message || "Unknown error calling Anthropic." }) };
  }
};
