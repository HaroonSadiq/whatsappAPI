import express from "express";
import { sendMessage } from "../whatsapp.js";
import {
  sessions, messageLogs, categoryQueues, agents, customers, sseClients,
  generateId, findOpenSessionByCustomer, createSession, getSession,
  updateSession, logMessage, getMessages,
  enqueueSession, dequeueSession, peekQueue, getQueue,
  getAgent, updateAgent, findAvailableAgentByCategory,
  getAllSessions, getCustomer, getAllCustomers,
  addSseClient, removeSseClient, broadcastToSession
} from "./store.js";
import { BASE_URL } from "./config.js";

const router = express.Router();

// ─── Middleware ───────────────────────────────────────────────────────────────
function requireAgent(req, res, next) {
  const agentId = req.headers["x-agent-id"];
  if (!agentId || !getAgent(agentId)) {
    return res.status(401).json({ error: "x-agent-id header required" });
  }
  req.agentId = agentId;
  next();
}

// ─── Customer Support UI (mounted at root in server.js) ───────────────────────
router.get("/support/:session_id", (req, res) => {
  const { session_id } = req.params;
  const session = getSession(session_id);
  if (!session) return res.status(404).send("Session not found");
  if (session.status === "closed") return res.status(410).send("This support session has ended.");
  res.redirect(`/support.html?session=${session_id}`);
});

// ─── Session SSE Stream ───────────────────────────────────────────────────────
router.get("/api/test/session/:session_id/stream", (req, res) => {
  const { session_id } = req.params;
  const session = getSession(session_id);
  if (!session) return res.sendStatus(404);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  addSseClient(session_id, res);

  // Send initial heartbeat / session info
  res.write(`data: ${JSON.stringify({ event: "connected", session_id })}\n\n`);

  req.on("close", () => {
    removeSseClient(session_id, res);
  });
});

// ─── Post Message (Customer) ──────────────────────────────────────────────────
router.post("/api/test/session/:session_id/message", async (req, res) => {
  const { session_id } = req.params;
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: "text required" });

  const session = getSession(session_id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (session.status !== "active") return res.status(409).json({ error: "Session not active" });

  const msg = logMessage(session_id, "customer", session.customer_phone, text.trim());
  updateSession(session_id, {
    last_customer_activity: msg.ts,
    message_count: (session.message_count || 0) + 1
  });

  broadcastToSession(session_id, { event: "new_message", msg });

  // Nudge agent if idle > 2 minutes
  const lastAgent = new Date(session.last_agent_activity || session.accepted_at).getTime();
  if (Date.now() - lastAgent > 2 * 60 * 1000 && session.agent_phone) {
    await sendMessage(session.agent_phone, "New customer message waiting in your dashboard.").catch(() => {});
  }

  res.json({ success: true, msg });
});

// ─── Get Messages ─────────────────────────────────────────────────────────────
router.get("/api/test/session/:session_id/messages", (req, res) => {
  const { session_id } = req.params;
  const session = getSession(session_id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json({ session, messages: getMessages(session_id) });
});

// ─── Agent Queue ──────────────────────────────────────────────────────────────
router.get("/api/test/agent/queue", (req, res) => {
  const category = req.query.category || "Tech";
  const queue = getQueue(category).map(q => {
    const sess = getSession(q.session_id);
    return {
      ...q,
      customer_phone: sess?.customer_phone,
      created_at: sess?.created_at,
      message_count: sess?.message_count || 0
    };
  });
  res.json({ category, queue });
});

// ─── Agent Active Sessions ────────────────────────────────────────────────────
router.get("/api/test/agent/sessions", requireAgent, (req, res) => {
  const agent = getAgent(req.agentId);
  const active = getAllSessions().filter(s => s.agent_id === req.agentId && s.status === "active");
  res.json({ agent, sessions: active });
});

// ─── Agent Accept Session ─────────────────────────────────────────────────────
router.post("/api/test/agent/accept", requireAgent, async (req, res) => {
  const { session_id } = req.body;
  if (!session_id) return res.status(400).json({ error: "session_id required" });

  const agent = getAgent(req.agentId);
  if (agent.status !== "available") {
    return res.status(409).json({ error: "Agent not available" });
  }

  const session = getSession(session_id);
  if (!session || session.status !== "waiting") {
    return res.status(409).json({ error: "Session no longer waiting" });
  }

  dequeueSession(session.category, session_id);
  const reconnect_token = generateId("rtok_");
  const nowIso = new Date().toISOString();

  updateSession(session_id, {
    status: "active",
    agent_id: agent.id,
    agent_phone: agent.phone,
    accepted_at: nowIso,
    reconnect_token,
    last_agent_activity: nowIso
  });

  updateAgent(agent.id, {
    status: "busy",
    current_session_id: session_id,
    last_seen_at: nowIso,
    total_sessions_today: (agent.total_sessions_today || 0) + 1
  });

  logMessage(session_id, "system", "system", `Agent ${agent.name} accepted session.`);
  broadcastToSession(session_id, { event: "agent_joined", agent_name: agent.name, agent_id: agent.id });

  await sendMessage(session.customer_phone,
    `Agent ${agent.name} has joined your support session. Use your link to chat.`
  ).catch(() => {});

  res.json({ success: true, reconnect_token, session: getSession(session_id) });
});

// ─── Agent Post Message ───────────────────────────────────────────────────────
router.post("/api/test/agent/message", requireAgent, async (req, res) => {
  const { session_id, text } = req.body;
  if (!session_id || !text || !text.trim()) return res.status(400).json({ error: "session_id and text required" });

  const session = getSession(session_id);
  if (!session || session.status !== "active") return res.status(409).json({ error: "Session not active" });
  if (session.agent_id !== req.agentId) return res.status(403).json({ error: "Not assigned to this session" });

  const msg = logMessage(session_id, "agent", req.agentId, text.trim());
  updateSession(session_id, {
    last_agent_activity: msg.ts,
    message_count: (session.message_count || 0) + 1
  });

  broadcastToSession(session_id, { event: "new_message", msg });

  const agent = getAgent(req.agentId);
  await sendMessage(session.customer_phone,
    `New message from ${agent?.name || "Agent"}. Open your support link to read it.`
  ).catch(() => {});

  res.json({ success: true, msg });
});

// ─── Agent Done / Close Session ───────────────────────────────────────────────
router.post("/api/test/agent/done", requireAgent, async (req, res) => {
  const { session_id, reason = "done" } = req.body;
  if (!session_id) return res.status(400).json({ error: "session_id required" });

  const session = getSession(session_id);
  if (!session || session.agent_id !== req.agentId) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  const nowIso = new Date().toISOString();
  updateSession(session_id, {
    status: "closed",
    closed_at: nowIso,
    closed_reason: reason
  });

  const agent = getAgent(req.agentId);
  updateAgent(req.agentId, {
    status: "available",
    current_session_id: null,
    last_seen_at: nowIso
  });

  logMessage(session_id, "system", "system", `Session closed by ${agent.name}. Reason: ${reason}`);
  broadcastToSession(session_id, { event: "session_closed", reason });

  await sendMessage(session.customer_phone,
    "Your support session has been closed. Reply here if you need further help."
  ).catch(() => {});

  // Notify dashboard about next queue item
  const next = peekQueue(session.category || "Tech");
  if (next && agent.phone) {
    await sendMessage(agent.phone, "Another Tech session is waiting in your dashboard.").catch(() => {});
  }

  res.json({ success: true });
});

// ─── Agent Reconnect ──────────────────────────────────────────────────────────
router.post("/api/test/agent/reconnect", requireAgent, (req, res) => {
  const { session_id, reconnect_token } = req.body;
  if (!session_id || !reconnect_token) return res.status(400).json({ error: "session_id and reconnect_token required" });

  const session = getSession(session_id);
  if (!session || session.agent_id !== req.agentId) return res.status(403).json({ error: "Unauthorized" });
  if (session.reconnect_token !== reconnect_token) return res.status(403).json({ error: "Invalid reconnect token" });
  if (session.status === "closed") return res.status(410).json({ error: "Session already closed" });

  updateAgent(req.agentId, { last_seen_at: new Date().toISOString() });

  res.json({
    success: true,
    session,
    messages: getMessages(session_id)
  });
});

// ─── TEST_MODE Login ──────────────────────────────────────────────────────────
router.post("/api/test/login", (req, res) => {
  const { agentId } = req.body;
  const agent = getAgent(agentId);
  if (!agent) return res.status(401).json({ error: "Invalid agent" });
  res.json({ success: true, agent });
});

// ─── TEST_MODE Dashboard Snapshot ─────────────────────────────────────────────
router.get("/api/test/dashboard", (req, res) => {
  const allSessions = getAllSessions();
  const waiting = allSessions.filter(s => s.status === "waiting");
  const active = allSessions.filter(s => s.status === "active");
  const closed = allSessions.filter(s => s.status === "closed");
  const allAgents = Array.from(agents.values());

  const enrichSession = s => {
    const cust = getCustomer(s.customer_phone);
    return {
      ...s,
      customer_name: cust?.name || s.customer_phone,
      queue_info: getQueue(s.category || "Tech").find(q => q.session_id === s.session_id)
    };
  };

  res.json({
    agents: allAgents,
    customers: getAllCustomers(),
    waiting: waiting.map(enrichSession),
    active: active.map(enrichSession),
    closed: closed.slice(-20).map(enrichSession),
    queue: getQueue("Tech").map(q => {
      const sess = getSession(q.session_id);
      const cust = getCustomer(sess?.customer_phone);
      return { ...q, customer_phone: sess?.customer_phone, customer_name: cust?.name };
    }),
    stats: {
      totalSessions: allSessions.length,
      waitingCount: waiting.length,
      activeCount: active.length,
      closedCount: closed.length,
      availableAgents: allAgents.filter(a => a.status === "available").length,
      busyAgents: allAgents.filter(a => a.status === "busy").length
    }
  });
});

export default router;
