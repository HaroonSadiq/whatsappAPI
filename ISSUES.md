# WhatsApp Intelligent Router — Issue Report

> Comprehensive audit of the codebase at `https://github.com/HaroonSadiq/whatsappAPI`
> Live deployment: `https://whatsapp-api-haroonsadiqs-projects.vercel.app/`

---

## 🔴 CRITICAL (Production-Breaking / Security / Data Loss)

### C1. Vercel Serverless — In-Memory State Lost on Every Cold Start
**Files:** `src/agents.js`, `src/session.js`, `src/queue.js`, `src/server.js`, `src/logger.js`, `src/integrations.js`, `src/ws/handler.js`, `src/events.js`

Vercel serverless runs each HTTP request in a separate ephemeral invocation. Any state stored in JavaScript memory is wiped on cold start. The codebase stores massive amounts of critical runtime state in memory:

| In-Memory State | Consequence on Cold Start |
|---|---|
| `agentRegistry` (status, activeConversations, cooldownTimer) | All agents reset to `AVAILABLE` with 0 active chats. Agents get over-assigned beyond max capacity. Cooldowns never expire. |
| `followUpTimers` | Customers in `active` state never receive the 5-min nudge or 10-min auto-close. Chats stay orphaned forever. |
| `customerQueues` | Same customer's messages may be processed in parallel across invocations (race conditions). |
| `messageLog[]` | Dashboard message feed is always empty after cold start. |
| `events[]` | Event log is always empty after cold start. |
| `integrationState` | Integration toggles reset to env defaults on every cold start. |
| `agentSockets`, `socketMeta` | Socket.IO can't find authenticated sockets on subsequent polling requests. Real-time push breaks. |
| `appEvents` EventEmitter | Events emitted in one invocation are not received by listeners in another. |

**Why it matters:** This is an architectural mismatch. The app was built for a long-running Node.js process but is deployed on serverless.

**Fix:** Move all runtime state to Turso DB. Replace `setTimeout`/`setInterval` with DB-polling or external cron jobs. Replace Socket.IO with a Vercel-compatible transport (short-polling or SSE backed by DB).

---

### C2. Auto-Assigned Sessions Never Push Customer Messages to Agents
**Files:** `src/orchestrator.js` (lines 118–135), `src/supportSessions.js` (line 57–66)

**Root cause:** `assignToAgent()` updates `assignedAgentId` in the DB but **does NOT update `agent_id`**:
```js
await updateSession(session.id, {
  assignedAgentId: agent.id,   // ← updates assigned_agent_id column
  // agentId is NOT passed here
});
```

Later, `pushCustomerMessage()` looks up the session from DB and checks `session.agentId` (which maps to the `agent_id` column). Since it's `NULL`, the event is **never emitted to the agent's Socket.IO room** — only to the admin room.

**Impact:** Agents see the session in their sidebar but receive **zero customer messages** after the initial assignment. The chat appears completely dead to the agent.

**Fix:** In `assignToAgent()`, pass `agentId: agent.id` to `updateSession()`.

---

### C3. Hardcoded JWT Fallback Secret
**File:** `src/auth/middleware.js` (line 4)
```js
export const JWT_SECRET = process.env.JWT_SECRET || 'wa_router_dev_secret_change_in_prod';
```

If `JWT_SECRET` is missing in production, anyone who knows this fallback string can forge JWTs and authenticate as any user (including admin).

**Fix:** Throw on startup if `JWT_SECRET` is not set. Remove the fallback string entirely.

---

### C4. Hardcoded Default Admin Password
**File:** `src/auth/users.js` (line 52)
```js
bcrypt.hashSync('admin123', 10)
```

The seed admin account uses a predictable password (`admin123`). If the admin doesn't change it immediately, the dashboard is trivially accessible by anyone.

**Fix:** Generate a random password on first seed and log it to console, or require admin creation via a secure CLI/setup flow.

---

### C5. No Rate Limiting
**Files:** `src/server.js`, `src/auth/routes.js`

- `/api/auth/login` — vulnerable to brute-force password attacks
- `POST /webhook` — can be spammed to rack up AI API costs
- `POST /api/send` — can be abused to spam arbitrary WhatsApp numbers
- `POST /agent-done`, `/api/assign` — no abuse protection

**Fix:** Add `express-rate-limit` middleware to all sensitive endpoints.

---

## 🟠 HIGH (Major Bugs, Incorrect Behavior)

### H1. `createAgent` Ignores `phone` Parameter
**File:** `src/auth/routes.js` (lines 69–75)
```js
const agent = createAgent({
  name,
  number: phone || '',   // ← passed but ignored
  ...
});
```

`createAgent` in `src/agents.js` does not accept a `number` field. Agents created via the admin dashboard have no phone number stored anywhere.

**Fix:** Add `phone` to the `createAgent` function signature and persist it.

---

### H2. Support Sessions Not Closed on Auto-Timeout
**File:** `src/server.js` (`scheduleFollowUp`, lines 330–335)

When a chat auto-closes due to customer inactivity:
```js
await setState(phone, "closed");
await clearSession(phone);
```

`clearSession` deletes from `messages`, `conversation_states`, `contacts`, `session_meta` — but **does NOT close the `support_sessions` row**. The session stays in `active` or `waiting` state forever in the DB.

**Impact:** Stale sessions accumulate indefinitely. `getSessionByPhone` may return ghost sessions for customers who were auto-closed.

**Fix:** Call `closeSession(session.id)` before `clearSession()` in the auto-timeout path.

---

### H3. `active_chats` Not Cleared on Rating or Auto-Timeout
**Files:** `src/server.js` (`handleRating` lines 306–318, `scheduleFollowUp` lines 330–335)

Both paths call `clearSession()` which explicitly skips `active_chats` ("cleared separately via releaseAssignment"). But neither path calls `releaseAssignment()`.

**Impact:** Stale rows remain in `active_chats`. The dashboard shows incorrect active chat assignments.

**Fix:** Call `releaseAssignment(phone)` and `releaseConversation(agentId)` in both the rating and auto-timeout paths.

---

### H4. Agent Active Conversation Count Reset to 0 on Send Failure
**File:** `src/orchestrator.js` (lines 111–116)

If the WhatsApp connection message fails after retries:
```js
} catch (err) {
  setAgentStatus(agent.id, AGENT_STATES.AVAILABLE);  // ← resets activeConversations to 0!
  throw err;
}
```

`setAgentStatus(AVAILABLE)` sets `activeConversations = 0`. If the agent was already handling 2 other legitimate chats, those are now invisible to the load balancer. The agent can be assigned 3 more chats, exceeding their capacity.

**Fix:** Decrement `activeConversations` (or call `releaseConversation`) instead of fully resetting the agent.

---

### H5. Socket.IO Is Fundamentally Broken on Vercel
**Files:** `src/server.js` (lines 96–99), `src/ws/handler.js`

Vercel serverless does not support:
- **WebSocket transport** — no persistent connections between invocations
- **Sticky sessions** — subsequent polling requests may hit different serverless instances
- **In-memory socket stores** — `agentSockets` and `socketMeta` Maps are per-invocation only

**Impact:** Agent dashboard real-time updates are unreliable or completely non-functional. Agents may connect successfully in one invocation but subsequent polling hits an instance with an empty socket registry.

**Fix:** Replace Socket.IO with a DB-backed polling mechanism (e.g., agent dashboard polls `GET /api/sessions/mine` every 2–3 seconds, as the admin dashboard already does).

---

### H6. Missing `openai` Dependency in `package.json`
**File:** `src/classifier-kimi.js` (line 15)
```js
import OpenAI from "openai";
```

`package.json` does not list `"openai"` as a dependency. If `AI_CLASSIFIER=kimi` is set, the app will crash with `Cannot find package 'openai'`.

**Fix:** Add `"openai": "^4.x"` to `package.json` dependencies.

---

### H7. Race Condition in Queue Auto-Dequeue
**File:** `src/orchestrator.js` (`processNextInQueue`, lines 209–244)

```js
const fullQueue = await getQueue();            // SELECT all queue entries
const nextEntry = fullQueue.find((entry) => selectAgent(entry.category) !== null);
if (!nextEntry) return null;
await dequeue(nextEntry.phone);                // DELETE by phone
```

Between the SELECT and DELETE, another Vercel invocation could select the same queue entry. Both invocations would try to assign the same customer.

**Fix:** Use an atomic DB operation (e.g., `DELETE ... RETURNING *` in a transaction) or add a `processing` flag column.

---

## 🟡 MEDIUM (Bugs, Performance, Maintenance)

### M1. `PRODUCT_KB` Duplicated Across Classifiers
**Files:** `src/classifier.js`, `src/classifier-kimi.js`

The entire product knowledge base (~60 lines) is copy-pasted between both files. Any product update requires editing both files.

**Fix:** Extract `PRODUCT_KB` to a shared module (e.g., `src/knowledge-base.js`) and import it into both classifiers.

---

### M2. CORS Too Permissive on Socket.IO
**File:** `src/server.js` (line 97)
```js
cors: { origin: "*", methods: ["GET", "POST"] }
```

Any domain can connect to the Socket.IO endpoint.

**Fix:** Restrict `origin` to the deployed domain(s).

---

### M3. No Phone Number Validation
**Files:** `src/server.js` (`/api/send`), `src/whatsapp.js`

No validation that phone numbers are valid E.164 format before sending to Meta API. Invalid numbers waste API calls and may trigger confusing errors from Meta.

**Fix:** Add E.164 regex validation at API boundary.

---

### M4. `/status` Endpoint Unauthenticated
**File:** `src/server.js` (lines 346–351)

```js
app.get("/status", (_req, res) => {
  res.json({ agents: getAvailabilitySnapshot(), integrations: integrationState });
});
```

Exposes full agent roster and integration configuration without any authentication.

**Fix:** Add `requireAuth` middleware.

---

### M5. Tables Grow Forever (No Cleanup)
**Files:** `src/db.js`, `src/session.js`, `src/supportSessions.js`

- `messages` — never deleted except per-customer `clearSession`
- `support_sessions` — never cleaned up; stale entries accumulate
- `ratings` — never cleaned up

**Impact:** Long-term DB bloat and query performance degradation.

**Fix:** Add scheduled cleanup or retention policies (e.g., delete messages older than 90 days, archive closed sessions).

---

### M6. `getQueueDepth` Is Misleading
**File:** `src/queue.js` (lines 85–87)
```js
export function getQueueDepth(customerId) {
  return customerQueues.has(customerId) ? 1 : 0;
}
```

Always returns 0 or 1, not the actual number of pending jobs for that customer.

**Fix:** Track actual pending count or rename to `hasPendingJob()`.

---

### M7. `nextInQueue` Is Dead Code
**File:** `src/session.js` (lines 208–220)

Exported but never imported or called anywhere in the codebase.

**Fix:** Remove or integrate into the dequeue flow.

---

### M8. Non-Text WhatsApp Messages Silently Ignored
**File:** `src/server.js` (line 182)
```js
if (msg.type !== "text") return;
```

Images, videos, voice notes, and locations are dropped with no acknowledgment to the customer.

**Fix:** Reply with "We can only process text messages at the moment" or handle media appropriately.

---

### M9. Emoji-Only Ratings Fail
**File:** `src/server.js` (line 304)
```js
const score = parseInt(text.trim(), 10);
```

A customer sending "⭐⭐⭐⭐⭐" results in `NaN`. The rating is rejected and the conversation restarts as `active` instead of accepting the rating.

**Fix:** Strip non-numeric characters before parsing, or explicitly handle emoji input.

---

### M10. Admin Dashboard Doesn't Use Socket.IO
**File:** `public/index.html`

The admin dashboard polls REST APIs every 4 seconds but does not subscribe to Socket.IO real-time events. The admin view is always 0–4 seconds behind actual state.

**Fix:** Either add Socket.IO to the admin dashboard or accept the polling-only design.

---

### M11. `AGENTS.md` Documentation Is Outdated
**File:** `AGENTS.md`

Claims that are no longer true:
- "State: In-memory only (sessions, queue, logs, ratings). There is no database or Redis in the current codebase."
- Missing documentation for: Turso DB, JWT auth, Socket.IO agent dashboard, test mode, support sessions lifecycle.

**Fix:** Update to reflect the actual architecture.

---

### M12. `updateQueueEntry` Only Handles One Field
**File:** `src/session.js` (lines 229–233)
```js
export async function updateQueueEntry(phone, fields) {
  if (fields._aiFallbackSent) {
    await db.execute({ sql: 'UPDATE queue SET ai_fallback_sent = 1 WHERE phone = ?', args: [phone] });
  }
}
```

Generic function name suggesting full CRUD, but only supports `_aiFallbackSent`.

**Fix:** Make it generic or rename to `markAiFallbackSent()`.

---

### M13. `setInterval` Unreliable on Vercel
**File:** `src/orchestrator.js` (lines 247–274)

The AI fallback timer (`setInterval` every 60s) only runs while the serverless instance is warm. It may never fire between requests or on new cold starts.

**Fix:** Replace with a cron job or check for long-waiting queue entries on every incoming webhook.

---

### M14. `sendMessage` / `sendButtonMessage` Missing Env Validation
**File:** `src/whatsapp.js`

If `PHONE_NUMBER_ID` or `WHATSAPP_TOKEN` is missing, the fetch URL is malformed and the error is confusing.

**Fix:** Validate env vars at module load and throw a clear descriptive error.

---

### M15. Dynamically Created Agents Lost on Cold Start
**File:** `src/agents.js` (`createAgent`)

Agents created via the admin UI are added only to the in-memory `agentRegistry`. On Vercel cold start, they disappear completely.

**Fix:** Persist agent definitions to a DB table (not just `agent_metrics`).

---

### M16. Agent Metrics "Response Time" Is Misleading
**File:** `src/agents.js` (lines 296–307)

`releaseConversation` tracks `Date.now() - currentChatStart` as "response time", but this is actually **session duration**, not per-message response time.

**Fix:** Rename the metric to `sessionDurationMs` or implement actual per-message response tracking.

---

### M17. Test Mode Routes Expose Data Without Auth
**File:** `src/test_mode/router.js` (line 251)

`GET /api/test/dashboard` returns all sessions, agents, and customers with no authentication required.

**Fix:** Add auth middleware to test routes.

---

### M18. `classifier.js` JSON Parsing Fragile
**File:** `src/classifier.js` (lines 121–122)
```js
const jsonStr = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
```

If the LLM returns trailing text after the closing ```, parsing fails and falls back to escalate.

**Fix:** Use a more robust extraction regex or a JSON parser that handles markdown wrappers.

---

## 🟢 LOW (Code Quality / Minor)

### L1. Console Logs in Production
Verbose `console.log` / `console.warn` throughout the codebase. Should use a proper logger or respect a `LOG_LEVEL` env var.

### L2. Inconsistent Error Handling in Express Routes
Some async route handlers have `try/catch`, others don't. On Express 4, unhandled async errors crash the process.

### L3. No Automated Tests
Zero test coverage. No unit tests, no integration tests, no test runner configured.

### L4. Express 4 Async Middleware Risk
`requireAuth` / `requireAdmin` / `requireAgent` pass `next()` inside async callbacks. In Express 4, if `next()` throws or if an async error occurs after `next()`, it won't be caught by the global error handler. Consider upgrading to Express 5 or wrapping all async handlers.

---

## Priority Fix Order

| Priority | Issue | Effort |
|---|---|---|
| 1 | **C2** — Auto-assigned messages not reaching agents | 1 line |
| 2 | **C3** — JWT fallback secret | 3 lines |
| 3 | **H2** + **H3** — Stale `support_sessions` and `active_chats` | Small |
| 4 | **H4** — Agent count reset on send failure | Small |
| 5 | **H6** — Missing `openai` dependency | 1 line |
| 6 | **C5** — Rate limiting | Medium |
| 7 | **C1** — Vercel in-memory state architecture | Large (architectural) |
| 8 | **H5** — Socket.IO on Vercel | Large (architectural) |

---

*Report generated from full codebase audit of `src/`, `public/`, `api/`, and configuration files.*
