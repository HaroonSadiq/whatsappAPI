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
- **AI Classifiers:**
  - Default: Google Gemini (`@google/generative-ai`) — `src/classifier.js`
  - Optional: Moonshot Kimi (`classifier-kimi.js`, OpenAI-compatible API)
- **Messaging:** WhatsApp Cloud API (Meta Graph API v19.0 / v25.0) via native `fetch`
- **Frontend:** Static HTML/CSS/JS (no build step)
- **State:** In-memory only (sessions, queue, logs, ratings). There is no database or Redis in the current codebase.

---

## Directory Layout

```
src/
  server.js          ← Express entry point; webhook verification, state machine, admin APIs
  whatsapp.js        ← Thin wrapper around Meta WhatsApp API (send text / buttons)
  orchestrator.js    ← Full routing pipeline: classify → select agent → assign / queue / dequeue
  classifier.js      ← Gemini-powered FAQ/escalation classifier with PRODUCT_KB
  classifier-kimi.js ← Optional Kimi k2 classifier (drop-in replacement)
  agents.js          ← Agent registry, load balancing, cooldown logic, metrics
  session.js         ← In-memory session store (history, state, assignments, queue, ratings, timers)
  queue.js           ← Per-customer async serial queue to prevent race conditions
  integrations.js    ← Outbound integrations: Slack, Google Sheets, generic webhook, email
  logger.js          ← Structured in-memory event logger (last 500 events)

public/
  index.html         ← Production admin dashboard (dark-themed, auto-refreshes)

workflows/
  whatsapp_router.md ← Setup and message-flow SOP

.env                 ← API keys and secrets (gitignored, never commit)
.tmp/                ← Temporary working files (disposable)
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
| `cooldown` | Post-chat break (auto-resets to `available` after 2 min). |
| `offline` | Manually taken offline. |
| `failed` | Repeated WhatsApp send failures; requires manual reset. |

### Key Processing Flow

1. **Incoming webhook** (`POST /webhook`) is enqueued per-customer via `queue.js`.
2. **State machine** in `server.js` routes the message based on conversation state.
3. **Classification** (`orchestrator.js` → `classifier.js`) decides `faq_answer` vs `escalate`.
4. **FAQ path:** Bot replies, then offers interactive buttons (More Questions / Talk to Specialist / Book Demo).
5. **Escalation path:** `orchestrator.js` classifies the category (clothing / tech / general), finds the least-loaded available agent in that category pool, and pushes a new support session to the agent's web dashboard via Socket.IO. The customer receives a "connecting you with…" message. No WhatsApp alerts are sent to agents — all agent communication goes through the web dashboard. If no agent is available, the customer is queued with a priority boost for frustrated sentiment.
6. **Auto-dequeue:** When an agent becomes available or a chat is marked done, the next matching queued customer is assigned automatically.
7. **Follow-up timers:** If a customer is `active` but silent for 5 min, they get a nudge; after another 5 min, the chat auto-closes.

---

## Admin & Dashboard APIs

The dashboard (`public/index.html`) consumes these endpoints:

- `GET  /api/dashboard` — Full snapshot (agents, categories, queue, ratings, stats, logs, integrations)
- `GET  /api/messages` — Last 100 message log entries
- `GET  /api/logs` — Structured event log
- `GET  /api/logs/:phone` — Per-customer conversation log
- `GET  /api/metrics` — Agent performance metrics
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
| `ADMIN_WHATSAPP_NUMBER` | The single WhatsApp number all customers message (e.g. 923234758743) |
| `SLACK_WEBHOOK_URL` | Slack incoming webhook for escalation alerts |
| `GOOGLE_SHEETS_URL` | Google Apps Script web app for logging rows |
| `OUTBOUND_WEBHOOK_URL` | Generic CRM webhook URL |
| `EMAIL_WEBHOOK_URL` | Email relay webhook (e.g. Make/Zapier) |

**Security rule:** Secrets live **only** in `.env`. They are not hard-coded anywhere in source control.

---

## Code Style Guidelines

- Use **ES modules** (`import` / `export`) in all `.js` files.
- Prefer **JSDoc-style comments** for function documentation.
- Keep business logic out of `server.js`; route to `orchestrator.js`, `agents.js`, or `session.js`.
- WhatsApp API calls must go through `whatsapp.js` (`sendMessage`, `sendButtonMessage`).
- Any async operation that touches external APIs should be wrapped with retry or graceful fallback.
- In-memory data structures are acceptable for the current scope; do not introduce a database unless explicitly requested.

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

- The project is currently designed to run as a single Node.js process.
- For production, the workflow checklist mentions (but does not implement):
  - Replacing in-memory sessions with Redis
  - Persisting the queue in PostgreSQL / MongoDB
  - Using a permanent server instead of ngrok
  - Switching the Meta app to Live mode
- There is no CI/CD pipeline, Docker, or container configuration present.

---

## Common Agent Tasks

### Switching AI backend (Gemini ↔ Kimi)

In `src/server.js`, change this import:

```js
// Default (Gemini)
import { classifyAndRespond } from "./classifier.js";

// Optional (Kimi)
import { classifyAndRespond } from "./classifier-kimi.js";
```

Then restart the server.

### Updating the knowledge base

Edit `PRODUCT_KB` in `src/classifier.js` (and `src/classifier-kimi.js` if you use it). This string is injected into the system prompt, so any factual change to prices, policies, or products must be updated there.

### Adding or modifying agents

Edit `src/agents.js`:
- Update `agentRegistry` to add/remove agents or change capacities.
- Update `categoryRegistry` if you need new routing categories.
- The routing logic (`findAvailableAgent`) automatically picks up new categories without any other code change.

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
