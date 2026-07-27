// Vercel serverless function. Deployed automatically as POST /api/claude
// when this project is deployed to Vercel — no extra config needed, Vercel
// detects any file under /api as a function.
//
// This is what makes the app actually shareable: the frontend calls THIS
// endpoint, never Anthropic directly, so the real API key lives only here,
// in an environment variable on Vercel's servers, never in the browser bundle.
//
// Setup: in the Vercel project settings, add an environment variable named
// ANTHROPIC_API_KEY (no VITE_ prefix — that prefix is what tells Vite to
// expose a variable to client code, which is exactly what we don't want here).

export const config = { runtime: "nodejs" };

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { system, message } = req.body ?? {};
  if (!system || !message) {
    res.status(400).json({ error: "Request must include 'system' and 'message'." });
    return;
  }

  // Basic abuse guard: this endpoint is public once deployed, so cap input
  // size. This is not real rate limiting — see the deployment notes in
  // README.deploy.md for what a hardened version would add.
  if (typeof message !== "string" || message.length > 6000) {
    res.status(400).json({ error: "Message too long." });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "Server is missing ANTHROPIC_API_KEY. Set it in your hosting provider's environment variables." });
    return;
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
    res.status(upstream.status).json(data);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Unknown error calling Anthropic." });
  }
}
