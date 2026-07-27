# Deploying so anyone can use it (no API key required on their end)

The app is built so the real Anthropic API key never touches the browser.
The frontend calls `/api/claude`, which is a small server-side function that
holds the key and forwards the request to Anthropic. Pick whichever platform
you prefer — both are already configured.

## Option A: Vercel

1. Push this project to a GitHub repo.
2. Go to vercel.com, "Add New Project," import the repo. Vercel auto-detects
   it as a Vite project — no build config needed.
3. In the project's Settings → Environment Variables, add:
   - Name: `ANTHROPIC_API_KEY`
   - Value: your real key from console.anthropic.com
   - **Do not** prefix it with `VITE_` — that prefix tells Vite to expose a
     variable to client code, which is exactly what you don't want for this one.
4. Deploy. `api/claude.ts` is automatically live at `/api/claude`.

Local testing with the function included: install the Vercel CLI
(`npm i -g vercel`), run `vercel dev` instead of `npm run dev`.

## Option B: Netlify

1. Push this project to a GitHub repo.
2. Go to app.netlify.com, "Add new site" → import the repo. `netlify.toml`
   already sets the build command, publish folder, and the `/api/*` redirect
   to the function.
3. In Site configuration → Environment variables, add `ANTHROPIC_API_KEY`
   (same rule: no `VITE_` prefix) with your real key.
4. Deploy.

Local testing with the function included: install the Netlify CLI
(`npm i -g netlify-cli`), run `netlify dev` instead of `npm run dev`.

## What this does and doesn't protect against

- **Does protect:** your API key. It's never in the shipped JS, so nobody can
  read it out of the bundle and spend money on your account.
- **Does not protect:** the endpoint itself from being called a lot, by
  anyone, once the link is public. There's a basic input-length cap in the
  function, but no real rate limiting or per-user quota. For a portfolio demo
  shared with a reasonable number of people this is a fine tradeoff. If it
  ever got shared widely, the next step would be adding rate limiting (e.g.
  Vercel's built-in options, or a service like Upstash) keyed by IP.
- If you want a hard ceiling on spend regardless, set a usage limit on the
  API key itself in the Anthropic console.
