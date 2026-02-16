# Amtrak Board (Vercel-ready)

## Deploy to Vercel
1. Create a new Vercel project from this folder.
2. Set an Environment Variable:
   - `SESSION_SECRET` = any long random string.
3. Deploy.

## Local dev
Vercel CLI:
- `npm i -g vercel`
- `vercel dev`

Or simple static preview (no realtime auth):
- `python3 -m http.server 8000` (note: /api won't run)

## Accounts
Edit `accounts.json` in the project root.
