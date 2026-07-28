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
 * Pulls a readable message out of an error response body.
 *
 * Two different shapes arrive here, and conflating them was the bug:
 *
 *   1. Our own proxy's errors, where `error` is a plain string:
 *        { error: "Message too long." }
 *   2. Anthropic's errors, which the proxy forwards verbatim, where `error`
 *      is an object:
 *        { type: "error", error: { type: "authentication_error", message: "..." } }
 *
 * The old code ran String(errBody.error) on both, which turned shape 2 into
 * the literal text "[object Object]" and hid the real message. We also surface
 * Anthropic's error `type` and the HTTP status, because those are what
 * actually tell you which problem you have — e.g. 401/authentication_error
 * means a bad key, 400/invalid_request_error with "credit balance" means
 * billing, 404/not_found_error means a bad model string.
 */
function readErrorMessage(body: any, status: number): string {
  const err = body?.error;

  if (err && typeof err === "object") {
    const message = typeof err.message === "string" ? err.message : "Anthropic returned an error.";
    const type = typeof err.type === "string" ? ` (${err.type})` : "";
    return `${message}${type} [HTTP ${status}]`;
  }

  if (typeof err === "string") {
    return `${err} [HTTP ${status}]`;
  }

  return `Server error (HTTP ${status})`;
}

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
    throw new Error(readErrorMessage(errBody, response.status));
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
