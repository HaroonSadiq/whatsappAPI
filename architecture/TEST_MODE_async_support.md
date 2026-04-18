# TEST_MODE Async Customer Support Routing — System Architecture

## 1. Overview

A ticket-based async support layer where **customers never chat directly with agents over WhatsApp**. Instead, the WhatsApp channel is used only as a **notification and authentication layer**. All actual conversation happens inside ephemeral web support sessions.

### Test Users (Google API Registered)

| Role | Name | Phone | Category | Status |
|------|------|-------|----------|--------|
| Agent | Haroon | `923105806053` | Tech | `available` |
| Customer | — | `923234758743` | — | — |

---

## 2. Minimal Architecture

```
┌─────────────────────────────────┐      WhatsApp      ┌─────────────────────────────────┐
│  Customer Phone                 │◄─────notification──│  Meta Webhook                   │
│  923234758743                   │                    │  POST /webhook                  │
└─────────────────────────────────┘                    └─────────────────────────────────┘
                                                                    │
                       ┌──────────────────────────────────────────────────────────────────┐
                       │                                                                  │
         ┌─────────────▼─────────────┐                                                    │
         │   Express Gateway         │                                                    │
         │   (src/server.js)         │                                                    │
         └─────────────┬─────────────┘                                                    │
                       │                                                                  │
       ┌───────────────┼───────────────┐                                                  │
       │               │               │                                                  │
┌──────▼──────┐ ┌──────▼──────┐ ┌──────▼──────┐                                          │
│ Session     │ │ Async Queue │ │ Agent       │                                          │
│ Manager     │ │ Router      │ │ Registry    │                                          │
│(session.js) │ │(queue.js)   │ │(agents.js)  │                                          │
└──────┬──────┘ └──────┬──────┘ └──────┬──────┘                                          │
       │               │               │                                                  │
       └───────────────┴───────────────┘                                                  │
                       │                                                                  │
         ┌─────────────▼─────────────┐                                                    │
         │   In-Memory Session DB    │                                                    │
         │   + Message Log           │                                                    │
         └─────────────┬─────────────┘                                                    │
                       │                                                                  │
       ┌───────────────┼───────────────┐                                                  │
       │               │               │                                                  │
┌──────▼──────┐ ┌──────▼──────┐ ┌──────▼──────┐                                          │
│ /support    │ │ /api/       │ │ Dashboard   │                                          │
│ /:id        │ │ test/*      │ │ (SSE/       │                                          │
│ Web UI      │ │             │ │ polling)    │                                          │
└─────────────┘ └─────────────┘ └─────────────┘                                          │
```

### Components

| Component | Responsibility |
|-----------|----------------|
| **Webhook Handler** | Receives WhatsApp events, identifies sender, triggers session creation or message relay. |
| **Session Manager** | CRUD for `session_id`, lifecycle state machine, metadata (customer phone, agent id, created_at). |
| **Async Queue Router** | Holds `waiting` sessions in FIFO order per category. Agents pull/accept from this queue. |
| **Agent Registry** | Tracks agent status (`available` \| `busy` \| `offline`), active assignment, reconnect tokens. |
| **Message Logger** | Immutable append-only log per `session_id`. Required for reconnect and audit. |
| **Support Web UI** | Lightweight page served at `/support/:session_id`. Customer types here; messages sync via SSE or polling. |
| **Agent Dashboard** | Lists waiting queue, active sessions, allows manual accept/done. |

---

## 3. Session Lifecycle

```
                    ┌─────────────┐
     Customer       │   NONE      │
     messages ─────►│  (no session)│
                    └──────┬──────┘
                           │ create session
                           ▼
                    ┌─────────────┐
                    │  WAITING    │◄────────────────────────────┐
                    │  (queued)   │                             │
                    └──────┬──────┘                             │
                           │ agent accepts                       │ agent disconnects
                           │                                    │ (requeue if active)
                           ▼                                    │
                    ┌─────────────┐◄────────────────────────────┘
                    │   ACTIVE    │
                    │  (chatting) │
                    └──────┬──────┘
                           │ agent marks done
                           │ or customer idle timeout
                           ▼
                    ┌─────────────┐
                    │   CLOSED    │
                    │  (archived) │
                    └─────────────┘
```

### State Definitions

| State | Meaning | Transitions |
|-------|---------|-------------|
| `waiting` | Session created, link sent to customer, queued for agent. | → `active` (agent accepts) |
| `active` | Agent and customer are messaging through the support portal. | → `closed` (done/timeout) \| → `waiting` (agent disconnect/reconnect) |
| `closed` | Terminal state. Immutable log retained. | — |

---

## 4. Session DB Schema (In-Memory / JSON)

### `sessions` Map
```js
{
  "sess_abc123": {
    "session_id": "sess_abc123",
    "status": "active",           // waiting | active | closed
    "category": "Tech",
    "created_at": "2026-04-16T20:00:00Z",
    "updated_at": "2026-04-16T20:05:00Z",
    "customer_phone": "923234758743",
    "agent_id": "haroon_923105806053",
    "agent_phone": "923105806053",
    "accepted_at": "2026-04-16T20:02:00Z",
    "closed_at": null,
    "last_customer_activity": "2026-04-16T20:05:00Z",
    "last_agent_activity": "2026-04-16T20:04:00Z",
    "reconnect_token": "rtok_xyz789", // rotated on every accept
    "message_count": 12
  }
}
```

### `session_messages` Map (append-only log)
```js
{
  "sess_abc123": [
    {
      "msg_id": "msg_001",
      "session_id": "sess_abc123",
      "direction": "system",      // system | customer | agent
      "sender_id": "system",
      "text": "Your support link: https://localhost:3001/support/sess_abc123",
      "ts": "2026-04-16T20:00:01Z",
      "meta": { "type": "link_generated" }
    },
    {
      "msg_id": "msg_002",
      "session_id": "sess_abc123",
      "direction": "customer",
      "sender_id": "923234758743",
      "text": "My app is crashing on login.",
      "ts": "2026-04-16T20:01:00Z",
      "meta": {}
    },
    {
      "msg_id": "msg_003",
      "session_id": "sess_abc123",
      "direction": "agent",
      "sender_id": "haroon_923105806053",
      "text": "Thanks, checking your account now.",
      "ts": "2026-04-16T20:02:30Z",
      "meta": {}
    }
  ]
}
```

### `agent_registry` Map
```js
{
  "haroon_923105806053": {
    "id": "haroon_923105806053",
    "name": "Haroon",
    "phone": "923105806053",
    "category": "Tech",
    "role": "agent",
    "status": "available",        // available | busy | offline
    "current_session_id": "sess_abc123",
    "total_sessions_today": 4,
    "last_seen_at": "2026-04-16T20:05:00Z"
  }
}
```

### `category_queues` Map
```js
{
  "Tech": [
    { "session_id": "sess_def456", "enqueued_at": "2026-04-16T20:10:00Z", "priority": 1 },
    { "session_id": "sess_ghi789", "enqueued_at": "2026-04-16T20:11:00Z", "priority": 1 }
  ]
}
```

---

## 5. Routing Pseudocode

### A. Customer Initiates (WhatsApp Webhook)
```
function onCustomerWhatsAppMessage(customerPhone, text):
    if customerPhone has ACTIVE or WAITING session:
        // Notify them to use the existing link
        sendWhatsAppText(customerPhone, "Please continue in your active support session: {link}")
        return

    session_id = generateId("sess_")
    createSession({
        session_id,
        customer_phone: customerPhone,
        status: "waiting",
        category: inferCategory(text) or "Tech", // TEST_MODE defaults to Tech
        created_at: now()
    })

    supportLink = `${BASE_URL}/support/${session_id}`
    logMessage(session_id, "system", "system", `Link generated: ${supportLink}`)
    enqueueSession(category="Tech", session_id)

    sendWhatsAppText(customerPhone,
        "Hi! Your support session has been created.\n\n"
        + "Please use this secure link to chat with our agent:\n"
        + supportLink + "\n\n"
        + "Do not reply here — all replies must go through the link above.")

    notifyAgentDashboard(category="Tech")
```

### B. Agent Accepts Session (Dashboard API)
```
function agentAcceptSession(agentId, session_id):
    agent = getAgent(agentId)
    if agent.status != "available":
        return error("Agent not available")

    session = getSession(session_id)
    if session.status != "waiting":
        return error("Session no longer waiting")

    dequeueSession(session.category, session_id)

    updateSession(session_id, {
        status: "active",
        agent_id: agentId,
        agent_phone: agent.phone,
        accepted_at: now(),
        reconnect_token: generateToken()
    })

    updateAgent(agentId, {
        status: "busy",
        current_session_id: session_id,
        last_seen_at: now()
    })

    logMessage(session_id, "system", "system", f"Agent {agent.name} accepted session.")

    // Notify both sides
    sendWhatsAppText(session.customer_phone,
        f"Agent {agent.name} has joined your support session. Use your link to chat.")

    return { reconnect_token: session.reconnect_token }
```

### C. Message Relay (Support Portal ↔ Dashboard)
```
function postMessage(session_id, senderRole, senderId, text):
    session = getSession(session_id)
    if session.status != "active":
        return error("Session not active")

    direction = (senderRole == "agent") ? "agent" : "customer"
    msg = logMessage(session_id, direction, senderId, text)

    updateSession(session_id, {
        last_customer_activity: (senderRole == "customer") ? now() : session.last_customer_activity,
        last_agent_activity:    (senderRole == "agent")    ? now() : session.last_agent_activity,
        message_count: session.message_count + 1
    })

    // Push to the other party via SSE / WebSocket / polling
    broadcastToSession(session_id, {
        event: "new_message",
        msg_id: msg.msg_id,
        direction: direction,
        text: text,
        ts: msg.ts
    })

    // Optional: WhatsApp ping only for first unread or after idle
    if senderRole == "agent":
        sendWhatsAppText(session.customer_phone,
            f"New message from {session.agent_name}. Open your support link to read it.")
    else if senderRole == "customer":
        // Dashboard gets it via SSE; optionally ping agent on WhatsApp if idle > 2 min
        if now() - session.last_agent_activity > 120000:
            sendWhatsAppText(session.agent_phone,
                "New customer message waiting in your dashboard.")
```

### D. Agent Done / Close Session
```
function closeSession(agentId, session_id, reason="done"):
    session = getSession(session_id)
    if session.agent_id != agentId:
        return error("Unauthorized")

    updateSession(session_id, {
        status: "closed",
        closed_at: now(),
        closed_reason: reason
    })

    updateAgent(agentId, {
        status: "available",
        current_session_id: null
    })

    logMessage(session_id, "system", "system", f"Session closed by {agentId}. Reason: {reason}")

    sendWhatsAppText(session.customer_phone,
        "Your support session has been closed. Reply here if you need further help.")

    // Try to auto-assign next waiting session to this agent
    nextSession = peekQueue(session.category)
    if nextSession:
        notifyAgentDashboard(session.category)
```

### E. Agent Reconnect
```
function agentReconnect(agentId, session_id, token):
    session = getSession(session_id)
    if session.agent_id != agentId:
        return error("Unauthorized")
    if session.reconnect_token != token:
        return error("Invalid reconnect token")

    updateAgent(agentId, { last_seen_at: now() })

    // Return full message history so UI can replay
    return {
        session: session,
        messages: getMessages(session_id)
    }
```

---

## 6. Webhook Handling Example

```js
// src/server.js — TEST_MODE webhook handler
app.post('/webhook', async (req, res) => {
  const entry = req.body?.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const message = value?.messages?.[0];

  if (!message || message.type !== 'text') {
    return res.sendStatus(200);
  }

  const customerPhone = message.from;           // e.g. "923234758743"
  const text = message.text.body;

  // 🔷 TEST_MODE: Async ticket routing 🔷
  // If this customer already has an open session, redirect them to the link.
  const activeSession = findOpenSessionByCustomer(customerPhone);
  if (activeSession) {
    await sendWhatsAppText(customerPhone,
      `You have an active support session. Please continue here:\n` +
      `${BASE_URL}/support/${activeSession.session_id}`
    );
    return res.sendStatus(200);
  }

  // Create new support session
  const sessionId = `sess_${crypto.randomUUID().replace(/-/g, '')}`;
  const supportLink = `${BASE_URL}/support/${sessionId}`;

  createSession({
    session_id: sessionId,
    customer_phone: customerPhone,
    status: 'waiting',
    category: 'Tech',        // TEST_MODE: Haroon is Tech
    created_at: new Date().toISOString()
  });

  logMessage(sessionId, 'system', 'system',
    `Support link generated: ${supportLink}`);

  enqueueSession('Tech', sessionId);

  // Notify customer
  await sendWhatsAppText(customerPhone,
    `Support request received.\n\n` +
    `Click to chat with an agent:\n${supportLink}\n\n` +
    `Please do not reply directly to this WhatsApp number.`
  );

  // Notify available agent (Haroon) via WhatsApp nudge
  const availableAgent = findAvailableAgentByCategory('Tech');
  if (availableAgent) {
    await sendWhatsAppText(availableAgent.phone,
      `New Tech support session waiting. Open dashboard to accept: ${BASE_URL}`
    );
  }

  res.sendStatus(200);
});
```

---

## 7. Required API Surface

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET`  | `/support/:session_id` | Serve customer chat UI |
| `POST` | `/api/test/session/:session_id/message` | Customer posts message |
| `GET`  | `/api/test/session/:session_id/messages` | Poll messages (customer or agent) |
| `GET`  | `/api/test/session/:session_id/stream` | SSE stream for session |
| `GET`  | `/api/test/agent/queue` | Dashboard: list waiting sessions |
| `GET`  | `/api/test/agent/sessions` | Dashboard: list active sessions for agent |
| `POST` | `/api/test/agent/accept` | Agent accepts waiting session |
| `POST` | `/api/test/agent/message` | Agent posts message to active session |
| `POST` | `/api/test/agent/done` | Agent closes active session |
| `POST` | `/api/test/agent/reconnect` | Agent reconnects to session |
| `GET`  | `/api/test/dashboard` | Full snapshot for TEST_MODE dashboard |

---

## 8. Key Design Decisions

1. **No Direct WhatsApp Chat**  
   WhatsApp is reduced to a notification pipe. This prevents customers from bypassing the queue or sending out-of-band messages.

2. **Manual Accept (Not Auto-Routing)**  
   Haroon must click *Accept* on the dashboard. This gives agents control over workload and context switching.

3. **Reconnect Token**  
   Every `active` session gets a `reconnect_token`. If Haroon refreshes the dashboard or loses connection, he can resume with full history replay.

4. **Per-Category Queue**  
   `Tech` queue holds waiting sessions. Future categories (Billing, Sales) get their own queues without schema changes.

5. **Immutable Message Log**  
   Messages are never deleted or updated. The log is the single source of truth for session replay and audit.

6. **Idle Auto-Close (optional)**  
   If customer is idle for >15 min while `active`, system can auto-close to free Haroon. Not required in TEST_MODE but recommended.

---

## 9. Test Mode Verification Checklist

- [ ] Customer `923234758743` sends WhatsApp message → receives support link.
- [ ] Session created with `status: waiting`, `category: Tech`.
- [ ] Dashboard shows session in "Tech Queue".
- [ ] Haroon (`923105806053`) clicks Accept → session `status: active`.
- [ ] Customer types in `/support/:session_id` → Haroon sees message on dashboard.
- [ ] Haroon replies on dashboard → Customer sees message in web UI.
- [ ] All messages stored in `session_messages[sess_id]`.
- [ ] Haroon clicks Done → session `status: closed`, agent status `available`.
- [ ] Haroon reconnects to closed session? → denied. Reconnects to active session? → full history loaded.
