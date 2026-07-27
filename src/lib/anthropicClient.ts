// Client for calling Claude through our own backend proxy (api/claude.ts on
// Vercel, or netlify/functions/claude.js on Netlify — both are reached at the
// same "/api/claude" path from the frontend's point of view).
//
// This means: no API key of any kind lives in this file or in the shipped
// browser bundle. The real key lives only as a server-side environment
// variable on whichever platform this is deployed to. This is what makes the
// deployed app safe to share as a public link.
//
// For local development, `npm run dev` alone won't have this endpoint
// available unless you're running `vercel dev` or `netlify dev` (both spin up
// the local function alongside the frontend). See README.deploy.md.

/**
 * Calls Claude via the backend proxy with a system prompt + user message,
 * expecting a JSON-only response. Strips markdown code fences defensively,
 * then parses.
 */
export async function callClaudeJSON<T>(
  systemPrompt: string,
  userMessage: string
): Promise<T> {
  const response = await fetch("/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ system: systemPrompt, message: userMessage }),
  });

  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    throw new Error(errBody.error ? String(errBody.error) : `Server error (${response.status})`);
  }

  const data = await response.json();
  const textBlocks = (data.content ?? [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n");

  const cleaned = textBlocks.replace(/```json|```/g, "").trim();

  try {
    return JSON.parse(cleaned) as T;
  } catch (e) {
    throw new Error(
      `Failed to parse Claude's response as JSON. Raw response:\n${textBlocks}`
    );
  }
}
