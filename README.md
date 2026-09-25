# Tennis Court Booking Demo (LINE + Claude API)

A portfolio demo: an AI-powered LINE Official Account that lets people book
one of two tennis courts using natural Thai — no menus, no buttons, just
messages like:

> จองคอร์ตพรุ่งนี้ 18:00 ชั่วโมงนึง

The bot understands the message with the Claude API, checks real
availability in Postgres, and confirms the booking.

## How it works

1. LINE sends every message to `POST /webhook` on this service, signed
   with the channel secret.
2. The signature is verified, then the message text is sent to Claude
   (with a forced tool call) to extract structured intent: book / cancel /
   check availability / greeting / unclear — plus date, time, duration,
   and court preference.
3. Based on that intent, the service checks `tennis_bookings` for
   conflicts and either books, cancels, lists open slots, or asks a
   clarifying question.
4. The reply is sent back to the user via the LINE Messaging API.

## Project layout

- `database/schema-tennis.sql` — new tables only (`tennis_courts`,
  `tennis_bookings`, `tennis_conversation_log`), safe to run against the
  same Postgres database as the Orbit ERP — no shared table names.
- `backend/` — the Fastify service (TypeScript). Deployed as its own
  Railway service in the same project as the ERP, so it can reuse
  `${{Postgres.DATABASE_URL}}` directly.

## Deploying (Railway)

1. In the `krit-kaset-erp` Railway project, add a **new service** from
   this GitHub repo (separate from the ERP backend service).
2. Set the service's **Root Directory** to `backend` (since this repo
   also has a top-level `database/` folder).
3. Set these environment variables on the new service (see
   `backend/.env.example`):
   - `DATABASE_URL` — reference the same Postgres: `${{Postgres.DATABASE_URL}}`
   - `LINE_CHANNEL_SECRET`
   - `LINE_CHANNEL_ACCESS_TOKEN`
   - `ANTHROPIC_API_KEY`
4. Once deployed, Railway gives the service a public URL. In the LINE
   Developers Console, set the **Webhook URL** (Messaging API tab) to
   `https://<that-url>/webhook`, click **Verify**, and make sure
   **Use webhook** is turned on.
5. Turn OFF LINE's own auto-reply/greeting messages in the LINE Official
   Account Manager (Settings > Messaging API / Response settings), so
   they don't fight with the bot's own replies.
