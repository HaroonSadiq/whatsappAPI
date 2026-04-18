# Category-Based Routing Architecture

Single WhatsApp admin number `923234758743` serving multiple customers
simultaneously, routed to category-specific agent pools via web dashboard.

---

## System Topology

```
Customers (many)
    │
    │  WhatsApp message
    ▼
┌─────────────────────────────────────┐
│  Meta WhatsApp Business API         │
│  Phone Number ID: 1053456724519879  │
│  Single number: 923234758743        │
└────────────────┬────────────────────┘
                 │  POST /webhook
                 ▼
┌─────────────────────────────────────┐
│  Express Server  (src/server.js)    │
│  Per-customer async job queue       │
│  Conversation state machine         │
└──────┬───────────────────┬──────────┘
       │                   │
       ▼                   ▼
┌────────────┐    ┌──────────────────────┐
│  Gemini AI │    │  Session Store        │
│  Classifier│    │  (phone → state,      │
│  (intent + │    │   history, assignment)│
│  category) │    └──────────────────────┘
└────────────┘
       │
       ▼
┌─────────────────────────────────────┐
│  Orchestrator  (src/orchestrator.js)│
│  Route by productCategory           │
└──────────────────┬──────────────────┘
                   │
       ┌───────────┼───────────┐
       ▼           ▼           ▼
  ┌─────────┐ ┌─────────┐ ┌─────────┐
  │ Clothing│ │  Tech   │ │ General │  ← Agent Pools
  │  Pool   │ │  Pool   │ │  Pool   │
  └────┬────┘ └────┬────┘ └────┬────┘
       └───────────┴───────────┘
                   │  Socket.IO push
                   ▼
         ┌──────────────────┐
         │  Agent Dashboard │  (browser)
         │  /agent          │
         └──────────────────┘
                   │  agent:message event
                   ▼
         WhatsApp API → Customer
```

---

## Routing Workflow

```
1. Customer sends message to 923234758743
2. Meta webhook → POST /webhook
3. Job enqueued per-customer (prevents race conditions)
4. State machine checks conversation state:
   - "new"       → greet + classify
   - "active"    → classify + reply or escalate
   - "escalated" → push message to agent dashboard
   - "awaiting_rating" → collect 1–5 rating
   - "closed"    → restart as "new"

5. Gemini classifies intent:
   → type: "faq_answer" | "escalate"
   → productCategory: "clothing" | "tech" | "general"
   → customerSentiment: "happy" | "neutral" | "frustrated"

6. If faq_answer:
   → Bot replies via WhatsApp API
   → Offer interactive buttons (More Questions / Talk to Specialist)

7. If escalate:
   → findAvailableAgent(productCategory)
   → Least-loaded agent in category pool selected
   → assignConversation(agentId) — increment activeConversations
   → assignAgent(customerPhone, agent) — record assignment in session
   → sendMessage(customerPhone, "Connecting you with…")
   → createSession() → appEvents.emit('session:new') → Socket.IO
   → Agent sees new chat card on dashboard

8. If no agent available:
   → enqueue(phone, name, category, { priority })
   → sendMessage(customerPhone, "All specialists busy, queue position…")
   → When agent frees up: processNextInQueue() auto-assigns
```

---

## Routing Pseudocode

```js
async function handleMessage(phone, name, text) {
  const state = getState(phone)

  if (state === 'escalated') {
    // Customer already with agent — push message to dashboard
    pushCustomerMessage(phone, name, text)
    return
  }

  // AI classification
  const { type, productCategory, customerSentiment, reply } =
    await classifyAndRespond(text, getHistory(phone))

  if (type === 'faq_answer') {
    await sendMessage(phone, reply)
    return
  }

  // type === 'escalate'
  const agent = findAvailableAgent(productCategory)

  if (agent) {
    assignConversation(agent.id)              // load tracking
    assignAgent(phone, agent)                 // session record
    setState(phone, 'escalated')
    await sendMessage(phone, `Connecting you with ${agent.name}…`)
    pushSessionToDashboard(agent.id, phone)   // Socket.IO
  } else {
    enqueue(phone, name, productCategory, {
      priority: customerSentiment === 'frustrated' ? 1 : 0,
    })
    setState(phone, 'escalated')
    await sendMessage(phone, 'All specialists busy, you are in queue…')
  }
}
```

---

## Agent Selection: Load Balancing

```js
function findAvailableAgent(category) {
  // 1. Try category-specific pool
  // 2. Fallback to general pool
  // 3. Last resort: any agent across all categories

  const canAccept = (a) =>
    a.status !== OFFLINE && a.status !== FAILED &&
    a.status !== COOLDOWN &&
    a.activeConversations < a.maxConcurrentConversations

  const leastLoaded = (pool) =>
    pool
      .filter(canAccept)
      .sort((a, b) =>
        (a.activeConversations / a.maxConcurrentConversations) -
        (b.activeConversations / b.maxConcurrentConversations)
      )[0] || null

  return leastLoaded(agentRegistry[category])
      || leastLoaded(agentRegistry.general)
      || leastLoaded(allAgents())
      || null
}
```

---

## Session Lifecycle

```
Customer messages
       │
       ▼
   state: "new"
       │  greet + classify
       ▼
   state: "active"          ←──────────────────┐
       │                                        │
       │  faq_answer                            │
       ├──────────────────────────────────────  │
       │  Bot replies, offer buttons            │
       │  Follow-up timer set (5 min inactivity)│
       │  Inactivity → state: "closed"          │
       │                                        │
       │  escalate                              │
       ▼                                        │
   state: "escalated"                           │
       │                                        │
       │  Agent sends reply via dashboard        │
       │  → WhatsApp API → Customer              │
       │                                        │
       │  Agent clicks "Done"                   │
       ▼                                        │
   state: "awaiting_rating"                     │
       │                                        │
       │  Customer replies 1–5                  │
       ▼                                        │
   state: "closed"                              │
       │  Next message from customer ───────────┘
       ▼
   restart as "new"
```

**Agent Availability States:**

| State | Trigger | Resolution |
|-------|---------|-----------|
| `available` | Default / cooldown expired | — |
| `busy` | `activeConversations >= max` | Auto when conversation released |
| `cooldown` | Last conversation closed | Auto after 2 min |
| `offline` | Manual toggle | Manual reset |
| `failed` | Repeated send errors | Manual reset via dashboard |

---

## Category Registry

Add new categories by editing `src/agents.js` `categoryRegistry`. No other
code changes required — routing picks up new categories automatically.

```js
categoryRegistry = {
  clothing: {
    description: "Product inquiries, sizing, orders, returns",
    skills: ["product_inquiries", "sizing_help", "order_assistance", ...],
  },
  tech: {
    description: "Troubleshooting, specs, setup, warranty",
    skills: ["device_troubleshooting", "technical_support", ...],
  },
  general: {           // ← overflow / fallback pool
    description: "General support",
    skills: ["general_support"],
  },
  // Add here — routing picks it up automatically
}
```

---

## API Reference

### Customer-facing (WhatsApp only)

All customer messages arrive via `POST /webhook` (Meta webhook).
All customer replies leave via WhatsApp API `sendMessage(phone, text)`.
**Customers never interact with HTTP endpoints directly.**

---

### Agent-facing (Web Dashboard — Socket.IO)

| Event | Direction | Payload | Purpose |
|-------|-----------|---------|---------|
| `authenticate` | Client→Server | `{ token }` | Auth, receive initial snapshot |
| `agent:accept` | Client→Server | `{ sessionId }` | Accept waiting customer |
| `agent:message` | Client→Server | `{ sessionId, text }` | Send reply to customer |
| `agent:done` | Client→Server | `{ sessionId }` | Close session, trigger rating |
| `agent:status` | Client→Server | `{ status }` | Toggle own availability |
| `session:new` | Server→Client | `{ session, messages }` | New customer assigned |
| `session:message` | Server→Client | `{ sessionId, message }` | Customer sent message |
| `session:activated` | Server→Client | `{ session }` | Session accepted |
| `session:closed` | Server→Client | `{ sessionId, session }` | Session closed |

---

### Admin REST API (JWT protected)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/api/dashboard` | Full snapshot: agents, queue, sessions, stats |
| `GET` | `/api/sessions` | All support sessions |
| `GET` | `/api/sessions/:id/history` | Conversation history for a session |
| `GET` | `/api/metrics` | Agent performance metrics |
| `GET` | `/api/messages` | Last 100 message log entries |
| `GET` | `/api/logs` | Structured event log |
| `GET` | `/api/logs/:phone` | Per-customer conversation log |
| `POST` | `/api/set-agent-status` | `{ agentId, status }` — force agent state |
| `POST` | `/api/assign` | `{ customerPhone }` — manually assign queued customer |
| `POST` | `/api/send` | `{ phone, message }` — manual message from dashboard |
| `POST` | `/agent-done` | `{ agentId, customerPhone }` — REST fallback to close session |
| `POST` | `/integrations/toggle` | `{ name, enabled }` — toggle Slack/Sheets/webhook |

---

## Multi-Customer Concurrency

Each customer phone number has its own **serial async job queue** (`src/queue.js`).
Messages from the same customer execute one at a time — preventing race conditions
on shared session state. Messages from different customers execute fully in parallel.

```
Customer A ──► [jobQueue_A]──► handler A ──► Gemini ──► agent pool
Customer B ──► [jobQueue_B]──► handler B ──► Gemini ──► agent pool
Customer C ──► [jobQueue_C]──► handler C ──► Gemini ──► agent pool
              (all parallel)
```

---

## Conversation Log & Audit

Every significant event is appended to the structured event log (`src/logger.js`,
last 500 events). Key event types:

| Type | Trigger |
|------|---------|
| `message_in` | Customer message received |
| `message_out` | Bot or agent message sent |
| `classified` | Gemini returned intent + category |
| `assigned` | Customer routed to agent |
| `queued` | No agent available, customer enqueued |
| `dequeued` | Customer auto-assigned from queue |
| `done` | Session closed by agent |
| `rating` | Customer submitted satisfaction score |
| `agent_conversation_assigned` | Agent load incremented |
| `agent_chat_complete` | Agent load decremented |
| `fallback_ai` | Long-waiting queued customer sent AI message |
