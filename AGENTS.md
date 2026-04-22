# Agent Instructions — WhatsApp Intelligent Router

You're working inside the **WhatsApp Intelligent Router** project. It follows the **WAT framework** (Workflows, Agents, Tools), which separates probabilistic AI reasoning from deterministic code execution.

> **Critical distinction:** The active production application lives in `src/`. `package.json` confirms `main: "src/server.js"`. When making changes to running behaviour, always edit files in `src/`.

---

## Project Overview

This is a Node.js + Express service that receives WhatsApp messages via Meta webhooks, classifies customer intent using an LLM (Google Gemini by default, with an optional Moonshot Kimi backend), and either:

1. **Answers FAQs instantly** using a built-in product knowledge base, or
2. **Escalates to human agents** with load-balanced routing, queueing, and follow-up timers.

It also serves a pure-HTML admin dashboard (`public/index.html`) for live operations, agent control, and message logs.

---

## Technology Stack

- **Runtime:** Node.js `>=18.0.0` (ES modules — `"type": "module"`)
- **Framework:** Express `^4.18.2`
- **Database:** LibSQL (Turso) — async SQLite, Vercel-compatible
- **AI Classifiers:**
  - Default: Google Gemini (`@google/generative-ai`) — `src/classifier.js`
  - Optional: Moonshot Kimi (`classifier-kimi.js`, OpenAI-compatible API)
- **Messaging:** WhatsApp Cloud API (Meta Graph API v21.0) via native `fetch`
- **Frontend:** Static HTML/CSS/JS (no build step)
- **State:** Persisted in Turso DB. In-memory state is limited to ephemeral caches only.

---

## Directory Layout

```
src/
  server.js          ← Express entry point; webhook verification, state machine, admin APIs
  whatsapp.js        ← Thin wrapper around Meta WhatsApp API (send text / buttons)
  orchestrator.js    ← Full routing pipeline: classify → select agent → assign / queue / dequeue
  classifier.js      ← Gemini-powered FAQ/escalation classifier with PRODUCT_KB
  classifier-kimi.js ← Optional Kimi k2 classifier (drop-in replacement)
  knowledge-base.js  ← Shared PRODUCT_KB used by all classifiers
  agents.js          ← DB-backed agent registry, load balancing, cooldown logic, metrics
  session.js         ← DB-backed session store (history, state, queue, ratings, follow-ups)
  supportSessions.js ← DB-backed escalation lifecycle (waiting → active → closed)
  queue.js           ← Per-customer async serial queue to prevent race conditions
  integrations.js    ← Outbound integrations: Slack, Google Sheets, generic webhook, email
  logger.js          ← Structured in-memory event logger (last 500 events)
  events.js          ← EventEmitter bridge between orchestrator and WebSocket handler
  ws/handler.js      ← Socket.IO real-time agent dashboard bridge
  auth/              ← JWT auth, bcrypt passwords, role-based access (admin/agent)
  test_mode/         ← Complete sandbox for local testing (in-memory, bypasses AI)
  db.js              ← LibSQL (Turso) client and schema initialization

public/
  index.html         ← Production admin dashboard (dark-themed, auto-refreshes)
  agent/dashboard.html ← Agent workspace (Socket.IO + polling fallback)
  login.html         ← Unified login portal
  support.html       ← Customer web chat (test mode)

workflows/
  whatsapp_router.md ← Setup and message-flow SOP

.env                 ← API keys and secrets (gitignored, never commit)
```

---

## Build and Run Commands

No compilation or bundling is required.

```bash
# Install dependencies
npm install

# Start the server
npm start                # → node src/server.js

# Dev mode with auto-reload (Node --watch)
npm run dev              # → node --watch src/server.js
```

The server listens on `process.env.PORT` or defaults to `3001`.

---

## Runtime Architecture

### Conversation States (in `src/server.js`)

| State | Meaning |
|-------|---------|
| `new` | First-ever message from this customer. |
| `active` | Ongoing AI-handled conversation. |
| `escalated` | Human agent assigned and handling the chat. |
| `awaiting_rating` | Agent marked done; waiting for customer to rate 1–5. |
| `closed` | Conversation ended; next message restarts as `new`. |

### Agent States (in `src/agents.js`)

| State | Meaning |
|-------|---------|
| `available` | Ready and has free capacity. |
| `busy` | At maximum concurrent conversations. |
| `cooldown` | Post-chat break (auto-resets after 2 min, checked on DB query). |
| `offline` | Manually taken offline. |
| `failed` | Repeated WhatsApp send failures; requires manual reset. |

### Key Processing Flow

1. **Incoming webhook** (`POST /webhook`) is enqueued per-customer via `queue.js`.
2. **State machine** in `server.js` routes the message based on conversation state.
3. **Classification** (`orchestrator.js` → `classifier.js`) decides `faq_answer` vs `escalate`.
4. **FAQ path:** Bot replies, then offers interactive buttons (More Questions / Talk to Specialist / Book Demo).
5. **Escalation path:** `orchestrator.js` classifies the category (clothing / tech / general), finds the least-loaded available agent in that category pool via DB query, and pushes a new support session to the agent's web dashboard. The customer receives a "connecting you with…" message. If no agent is available, the customer is queued with a priority boost for frustrated sentiment.
6. **Auto-dequeue:** When an agent becomes available or a chat is marked done, the next matching queued customer is assigned automatically.
7. **Follow-up timers:** If a customer is `active` but silent for 5 min, they get a nudge; after another 5 min, the chat auto-closes. These are DB-driven (`follow_up_schedule` table) to survive Vercel cold starts.

---

## Admin & Dashboard APIs

The dashboard (`public/index.html`) consumes these endpoints:

- `GET  /api/dashboard` — Full snapshot (agents, categories, queue, ratings, stats, logs, integrations)
- `GET  /api/messages` — Last 100 message log entries
- `GET  /api/logs` — Structured event log
- `GET  /api/logs/:phone` — Per-customer conversation log
- `GET  /api/metrics` — Agent performance metrics
- `GET  /api/sessions` — All support sessions
- `GET  /api/sessions/mine` — Current agent's non-closed sessions
- `GET  /api/sessions/:id/history` — Session message history
- `POST /api/auth/login` — JWT login
- `POST /api/set-agent-status` — Change agent status manually
- `POST /api/assign` — Manually assign a queued customer
- `POST /api/send` — Send a manual message from the dashboard
- `POST /agent-done` — Close a chat, free the agent, and trigger rating request
- `POST /integrations/toggle` — Enable/disable outbound integrations at runtime

Legacy simpler endpoints still exist on the root path for backward compatibility (`/status`, `/webhook`).

---

## Environment Variables

The following are read from `.env` at runtime:

| Variable | Purpose |
|----------|---------|
| `PORT` | Server port (default 3001) |
| `VERIFY_TOKEN` | Meta webhook verification token |
| `PHONE_NUMBER_ID` | WhatsApp Business phone number ID |
| `WHATSAPP_TOKEN` | Meta/WhatsApp access token |
| `GEMINI_API_KEY` | Google Generative AI API key |
| `KIMI_API_KEY` | Moonshot AI API key (only if using `classifier-kimi.js`) |
| `ADMIN_WHATSAPP_NUMBER` | The single WhatsApp number all customers message |
| `SLACK_WEBHOOK_URL` | Slack incoming webhook for escalation alerts |
| `GOOGLE_SHEETS_URL` | Google Apps Script web app for logging rows |
| `OUTBOUND_WEBHOOK_URL` | Generic CRM webhook URL |
| `EMAIL_WEBHOOK_URL` | Email relay webhook (e.g. Make/Zapier) |
| `TURSO_DATABASE_URL` | Turso DB URL (e.g. `libsql://your-db.turso.io`) |
| `TURSO_AUTH_TOKEN` | Turso auth token |
| `JWT_SECRET` | Secret for signing JWTs (required, no fallback) |
| `CLIENT_ORIGIN` | Allowed CORS origin for Socket.IO (default `*`) |

**Security rule:** Secrets live **only** in `.env`. They are not hard-coded anywhere in source control.

---

## Code Style Guidelines

- Use **ES modules** (`import` / `export`) in all `.js` files.
- Prefer **JSDoc-style comments** for function documentation.
- Keep business logic out of `server.js`; route to `orchestrator.js`, `agents.js`, or `session.js`.
- WhatsApp API calls must go through `whatsapp.js` (`sendMessage`, `sendButtonMessage`).
- Any async operation that touches external APIs should be wrapped with retry or graceful fallback.
- All agent state is DB-backed (`agents` + `agent_runtime` tables) for Vercel compatibility.

---

## Testing Instructions

There are **no automated tests** in this codebase (no test runner, no test scripts in `package.json`).

**Manual testing workflow:**
1. Ensure `.env` is populated and dependencies are installed.
2. Run `npm run dev`.
3. Expose localhost via ngrok (or use a permanent public URL for the webhook).
4. Register the webhook URL in the Meta Developer Portal with the `VERIFY_TOKEN`.
5. Send a WhatsApp message to the test number and observe the console logs and dashboard.
6. Use the dashboard to toggle agent status, assign queue items, and send manual messages.

---

## Deployment Notes

- The project is designed to run on **Vercel serverless** via `api/index.js`.
- All runtime state is persisted to **Turso (LibSQL)**. No in-memory state survives cold starts.
- Agent dashboard supports both **Socket.IO** (local dev) and **REST polling** (Vercel production) as fallback.
- Follow-up timers are DB-driven (`follow_up_schedule` table), not in-memory `setTimeout`.
- There is no CI/CD pipeline, Docker, or container configuration present.

---

## Common Agent Tasks

### Switching AI backend (Gemini ↔ Kimi)

Set the environment variable:
```bash
AI_CLASSIFIER=kimi   # uses classifier-kimi.js
# unset or any other value uses classifier.js (Gemini)
```

Then restart the server.

### Updating the knowledge base

Edit `src/knowledge-base.js`. This string is injected into the system prompt for both classifiers, so any factual change to prices, policies, or products must be updated there **only**.

### Adding or modifying agents

Edit the `SEED_AGENTS` array in `src/agents.js` to change the default agents. For dynamic agent creation, use the admin dashboard "Manage Users" tab or the `/api/auth/users` endpoint.

### Recovering from a failed agent

Agents marked `failed` (after repeated WhatsApp send errors) must be manually reset. Use the dashboard or call:

```bash
curl -X POST http://localhost:3001/api/set-agent-status \
  -H "Content-Type: application/json" \
  -d '{"agentId":"AGENT_ID","status":"available"}'
```

---

## Self-Improvement Loop

When something breaks:

1. **Read the error** in console logs or the dashboard Event Logs tab.
2. **Fix the deterministic code** in `src/`.
3. **Retest** via WhatsApp or the dashboard.
4. **Update the workflow** in `workflows/whatsapp_router.md` if the fix reveals a recurring constraint or better process.
5. Keep `.env` and `AGENTS.md` up to date if conventions or environment requirements change.
