<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# AI Prompt VEO 3

This is a browser-based, bring-your-own-key (BYOK) application.

## Run Locally

**Prerequisites:** Node.js


1. Install dependencies:
   `npm install`
2. Run the app:
   `npm run dev`
3. In the app, choose a provider and enter an API key that you own.

## API keys and privacy

- Do **not** set `GEMINI_API_KEY`, `VITE_GEMINI_API_KEY`, or any provider key
  in deployment environment variables. Production builds deliberately do not
  embed server API keys in browser JavaScript.
- A key entered in the app is stored in that browser's `localStorage` so the
  user can reuse it. It is not encrypted and can be read by code running on
  the same site (including a browser extension). Use a dedicated, restricted,
  quota-limited key; never enter a shared company key.
- Prompts and reference content are sent directly from the browser to the AI
  provider selected by the user. Only use providers approved for the content
  being processed. Custom providers must use an HTTPS endpoint that the user
  trusts.
- The app does not require an owner API key for BYOK use. A product that
  provides shared API access needs a server-side proxy with authentication,
  per-customer quotas, rate limiting, and server-held provider credentials.

## License administration

The repository contains an offline owner tool at [admin.html](admin.html).
It is excluded from production builds; see [admin/README.md](admin/README.md).

Important: the current Firebase license design is client-side and is **not a
tamper-proof entitlement system**. Do not rely on it to enforce paid access at
scale. Before selling to multiple customers, replace public Firebase access
with an authenticated backend (for example, a Cloudflare Worker using server
credentials), private database rules, atomic activation, rate limits, and an
auditable admin workflow.
