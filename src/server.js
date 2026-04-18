/**
 * server.js
 * WhatsApp Intelligent Router — Central Support Platform
 *
 * Architecture:
 *  Customer WhatsApp → /webhook → AI classify → FAQ reply OR support session
 *  Support session → Socket.IO push → Agent web dashboard
 *  Agent reply (web) → Socket.IO → WhatsApp API → Customer
 *
 * Conversation States:
 *  new              → first message, greet + classify
 *  active           → AI-handled FAQ conversation
 *  escalated        → support session open, agent handles via web
 *  awaiting_rating  → agent marked done, waiting for 1-5 star rating
 *  closed           → session ended
 */

import "dotenv/config";
import express          from "express";
import { createServer } from "http";
import { Server as SocketIO } from "socket.io";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// ─── Session & state ──────────────────────────────────────────────────────────
import {
  getHistory, addToHistory, clearSession,
  getState,   setState,
  getContact, updateContact,
  getAssignment, releaseAssignment,
  dequeue, getQueue,
  saveRating, getRatings,
  setFollowUpTimer, clearFollowUpTimer,
  getActiveChats, updateSessionMeta, getSessionMeta,
} from "./session.js";

// ─── Agents ───────────────────────────────────────────────────────────────────
import {
  setAgentStatus, findAvailableAgent,
  agentRegistry, getAvailabilitySnapshot, getCategorySnapshot,
  getAgentMetrics, resetAgent, completeChat, releaseConversation,
  AGENT_STATES,
} from "./agents.js";

// ─── Messaging & classification ───────────────────────────────────────────────
import { sendMessage, sendButtonMessage } from "./whatsapp.js";
import { integrationState, onRating, onFaqAnswered } from "./integrations.js";
import { enqueueJob, getQueueStats }  from "./queue.js";
import { logEvent, getEventLog, getConversationLog, getLogStats, EVENT_TYPES } from "./logger.js";
import {
  orchestrate, classifyIntent, processNextInQueue,
} from "./orchestrator.js";

// ─── Support sessions ─────────────────────────────────────────────────────────
import {
  getAllSessions, getSessionByPhone,
  getWaitingSessions, getActiveSessions,
  closeSession,
} from "./supportSessions.js";

// ─── Auth ─────────────────────────────────────────────────────────────────────
import { requireAuth, requireAdmin, requireAgent } from "./auth/middleware.js";
import authRoutes from "./auth/routes.js";

// ─── WebSocket ────────────────────────────────────────────────────────────────
import { initWsHandler, pushCustomerMessage } from "./ws/handler.js";

// ─── Test mode ────────────────────────────────────────────────────────────────
const TEST_MODE = process.env.TEST_MODE === "true";
let testRouter, handleTestModeWebhook;
if (TEST_MODE) {
  ({ testRouter, handleTestModeWebhook } = await import("./test_mode/index.js"));
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT         = process.env.PORT || 3001;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

const FOLLOW_UP_DELAY_MS  = 5 * 60 * 1000;
const CLOSE_CHAT_DELAY_MS = 5 * 60 * 1000;

// ─── App setup ────────────────────────────────────────────────────────────────
const app        = express();
const httpServer = createServer(app);
const io         = new SocketIO(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ["websocket", "polling"],
});

app.use(express.json());

// ─── Page routes (before static, so /agent doesn't 301 to /agent/) ───────────
app.get("/login", (_req, res) => res.sendFile(join(__dirname, "../public/login.html")));
app.get("/agent", (_req, res) => res.sendFile(join(__dirname, "../public/agent/dashboard.html")));

// Static files — serve admin dashboard and assets
app.use(express.static(join(__dirname, "../public")));

// ─── In-memory message log ───────────────────────────────────────────────────
const messageLog = [];
function logMsg(direction, phone, name, text, meta = {}) {
  messageLog.push({ direction, phone, name, text, meta, ts: Date.now() });
  if (messageLog.length > 200) messageLog.shift();
  logEvent({
    type:      direction === "inbound" ? EVENT_TYPES.MESSAGE_IN : EVENT_TYPES.MESSAGE_OUT,
    customerId: phone,
    category:  meta.category || null,
    intent:    meta.type     || null,
    agentId:   meta.agentId  || null,
    status:    "success",
    text,
    meta,
  });
}

// ─── Init WebSocket handler ───────────────────────────────────────────────────
initWsHandler(io, logMsg);

// ─── Auth routes ──────────────────────────────────────────────────────────────
app.use("/api/auth", authRoutes);

// ─── Webhook verification ─────────────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    return res.send(challenge);
  }
  res.sendStatus(403);
});

// ─── Incoming WhatsApp messages ───────────────────────────────────────────────
app.post("/webhook", (req, res) => {
  if (TEST_MODE) return handleTestModeWebhook(req, res);
  res.sendStatus(200);

  const value   = req.body?.entry?.[0]?.changes?.[0]?.value;
  const msg     = value?.messages?.[0];
  const contact = value?.contacts?.[0];
  if (!msg) return;

  const phone = msg.from;
  const name  = contact?.profile?.name || "there";

  enqueueJob(phone, async () => {
    try {
      updateContact(phone, { name });
      clearFollowUpTimer(phone);

      // Interactive button reply
      if (msg.type === "interactive" && msg.interactive?.type === "button_reply") {
        await handleButtonReply(phone, name, msg.interactive.button_reply.id);
        return;
      }

      if (msg.type !== "text") return;

      const text  = msg.text.body.trim();
      const state = getState(phone);
      console.log(`📩 [${state}] ${name} (+${phone}): ${text}`);
      logMsg("inbound", phone, name, text, { state });
      updateSessionMeta(phone, { intent: null });

      switch (state) {
        case "new":
          await handleNewCustomer(phone, name, text);
          break;
        case "active":
          await handleActiveConversation(phone, name, text);
          break;
        case "escalated":
          // Message from customer while agent is handling — push to agent dashboard
          addToHistory(phone, "user", text);
          logMsg("inbound", phone, name, text, { state: "escalated" });
          pushCustomerMessage(phone, name, text);
          break;
        case "awaiting_rating":
          await handleRating(phone, name, text);
          break;
        case "closed":
          setState(phone, "new");
          await handleNewCustomer(phone, name, text);
          break;
        default:
          setState(phone, "active");
          await handleActiveConversation(phone, name, text);
      }
    } catch (err) {
      console.error("[Webhook] Error:", err);
      logEvent({ type: EVENT_TYPES.ERROR, customerId: phone, status: "failure", text: err.message });
    }
  });
});

// ─── New customer ─────────────────────────────────────────────────────────────
async function handleNewCustomer(phone, name, text) {
  setState(phone, "active");
  addToHistory(phone, "user", text);
  const firstName = name.split(" ")[0];
  const greeting =
    `Hi ${firstName}! 👋 Welcome! I'm your virtual assistant.\n\n` +
    `I can help with product info, pricing, delivery times, and more — or connect you with a specialist.`;
  await sendMessage(phone, greeting);
  await handleActiveConversation(phone, name, text, true);
}

// ─── Active AI conversation ───────────────────────────────────────────────────
async function handleActiveConversation(phone, name, text, alreadyInHistory = false) {
  if (!alreadyInHistory) addToHistory(phone, "user", text);

  const history = getHistory(phone);
  const result  = await orchestrate(phone, name, text, history, logMsg);

  addToHistory(phone, "assistant", result.reply);
  updateSessionMeta(phone, {
    intent: result.type, category: result.productCategory, sentiment: result.customerSentiment,
  });

  if (result.type === "faq_answer") {
    logMsg("outbound", phone, "Bot", result.reply, {
      type: "faq_answer", category: result.productCategory, sentiment: result.customerSentiment,
    });
    await sendMessage(phone, result.reply);
    onFaqAnswered({ customerPhone: phone, customerName: name, category: result.productCategory, message: text, reply: result.reply }).catch(() => {});

    if (result.showDemoOffer) {
      await sendButtonMessage(phone, "Would you like to take the next step?", [
        { id: "book_demo",      title: "Book a Demo" },
        { id: "connect_human",  title: "Talk to Specialist" },
        { id: "more_questions", title: "More Questions" },
      ]);
    } else {
      await sendButtonMessage(phone, "Is there anything else I can help you with?", [
        { id: "more_questions", title: "Ask Another Question" },
        { id: "connect_human",  title: "Talk to a Specialist" },
      ]);
    }
    scheduleFollowUp(phone, name);
  }
}

// ─── Button reply ─────────────────────────────────────────────────────────────
async function handleButtonReply(phone, name, buttonId) {
  clearFollowUpTimer(phone);

  switch (buttonId) {
    case "more_questions":
      await sendMessage(phone, "Of course! What would you like to know? 😊");
      scheduleFollowUp(phone, name);
      break;

    case "connect_human": {
      await sendMessage(phone, "Sure! Let me find the right specialist for you. One moment... 🙏");
      const history = getHistory(phone);
      const lastMsg = [...history].reverse().find((h) => h.role === "user");
      const result  = await classifyIntent("I want to speak to a human agent", history);
      await orchestrate(phone, name, lastMsg?.content || "Customer requested support", history, logMsg, result);
      break;
    }

    case "book_demo": {
      await sendMessage(phone, "Great choice! Let me connect you with a specialist who will arrange a demo for you. 📅");
      const history = getHistory(phone);
      const lastMsg = [...history].reverse().find((h) => h.role === "user");
      const result  = await classifyIntent("I want to book a demo", history);
      result.reason = "Customer requested demo booking";
      await orchestrate(phone, name, lastMsg?.content || "Demo request", history, logMsg, result);
      break;
    }

    default:
      await sendMessage(phone, "What can I help you with? 😊");
      scheduleFollowUp(phone, name);
  }
}

// ─── Rating ───────────────────────────────────────────────────────────────────
async function handleRating(phone, name, text) {
  const score = parseInt(text.trim(), 10);
  if (score >= 1 && score <= 5) {
    saveRating(phone, name, score);
    onRating({ customerPhone: phone, customerName: name, score }).catch(() => {});
    logEvent({ type: EVENT_TYPES.RATING, customerId: phone, status: "success", meta: { score } });
    const stars = "⭐".repeat(score);
    await sendMessage(phone,
      `Thank you for rating us ${stars} (${score}/5)! Your feedback means a lot. 🙏\n\nFeel free to message us anytime! 👋`
    );
    setState(phone, "closed");
    clearSession(phone);
  } else {
    setState(phone, "active");
    await handleActiveConversation(phone, name, text);
  }
}

// ─── Follow-up timers ─────────────────────────────────────────────────────────
function scheduleFollowUp(phone, name) {
  clearFollowUpTimer(phone);
  const firstName = name.split(" ")[0];

  const t1 = setTimeout(async () => {
    if (getState(phone) !== "active") return;
    await sendMessage(phone, `Hi ${firstName}, just checking if you're still there? 😊`);

    const t2 = setTimeout(async () => {
      if (getState(phone) !== "active") return;
      await sendMessage(phone, "I'll close the chat for now, but feel free to message us anytime! 👋");
      setState(phone, "closed");
      clearSession(phone);
    }, CLOSE_CHAT_DELAY_MS);

    setFollowUpTimer(phone, t2);
  }, FOLLOW_UP_DELAY_MS);

  setFollowUpTimer(phone, t1);
}

// ─── Admin & Agent APIs (protected) ──────────────────────────────────────────

/** GET /status — quick health check */
app.get("/status", (_req, res) => {
  res.json({
    agents:       getAvailabilitySnapshot(),
    queue:        getQueue(),
    activeChats:  getActiveChats(),
    ratings:      getRatings(),
    integrations: integrationState,
  });
});

/** GET /api/dashboard — full data for admin dashboard */
app.get("/api/dashboard", requireAuth, (_req, res) => {
  const agents   = getAvailabilitySnapshot();
  const queue    = getQueue();
  const ratings  = getRatings();
  const all      = Object.values(agents).flat();

  const totalAgents     = all.length;
  const availableAgents = all.filter((a) => a.status === AGENT_STATES.AVAILABLE).length;
  const busyAgents      = all.filter((a) => a.status === AGENT_STATES.BUSY).length;
  const offlineAgents   = all.filter((a) => a.status === AGENT_STATES.OFFLINE).length;
  const cooldownAgents  = all.filter((a) => a.status === AGENT_STATES.COOLDOWN).length;
  const failedAgents    = all.filter((a) => a.status === AGENT_STATES.FAILED).length;
  const avgRating       = ratings.length
    ? (ratings.reduce((s, r) => s + r.score, 0) / ratings.length).toFixed(1)
    : null;

  const logStats = getLogStats();

  res.json({
    agents,
    categories:  getCategorySnapshot(),
    queue,
    ratings: ratings.slice(-20).reverse(),
    activeChats: getActiveChats(),
    metrics: getAgentMetrics(),
    sessions: getAllSessions(),
    stats: {
      totalAgents, availableAgents, busyAgents,
      offlineAgents, cooldownAgents, failedAgents,
      queueLength: queue.length,
      totalRatings: ratings.length,
      avgRating,
      ...logStats,
    },
    queueStats:    getQueueStats(),
    timestamp:     new Date().toISOString(),
  });
});

/** GET /api/messages */
app.get("/api/messages", requireAuth, (_req, res) => {
  res.json([...messageLog].reverse().slice(0, 100));
});

/** GET /api/logs */
app.get("/api/logs", requireAuth, (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  res.json(getEventLog(limit));
});

/** GET /api/logs/:phone */
app.get("/api/logs/:phone", requireAuth, (req, res) => {
  res.json(getConversationLog(req.params.phone));
});

/** GET /api/metrics */
app.get("/api/metrics", requireAuth, (_req, res) => {
  res.json(getAgentMetrics());
});

/** GET /api/sessions — all support sessions */
app.get("/api/sessions", requireAuth, (_req, res) => {
  res.json(getAllSessions());
});

/** GET /api/sessions/mine — sessions for logged-in agent */
app.get("/api/sessions/mine", requireAgent, (req, res) => {
  const sessions = getAllSessions().filter(
    s => s.agentId === req.user.agentId && s.state !== 'closed'
  );
  res.json(sessions);
});

/** GET /api/sessions/:id/history */
app.get("/api/sessions/:id/history", requireAuth, (req, res) => {
  const sessions = getAllSessions();
  const session  = sessions.find(s => s.id === req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json(getHistory(session.customerPhone));
});

/** POST /integrations/toggle */
app.post("/integrations/toggle", requireAdmin, (req, res) => {
  const { name, enabled } = req.body;
  if (!(name in integrationState)) {
    return res.status(400).json({ error: `Unknown integration: ${name}` });
  }
  integrationState[name] = !!enabled;
  res.json({ success: true, integrations: integrationState });
});

/** POST /agent-done — REST DONE (from admin dashboard) */
app.post("/agent-done", requireAuth, async (req, res) => {
  const { agentId, customerPhone } = req.body;
  if (!agentId || !customerPhone) {
    return res.status(400).json({ error: "agentId and customerPhone required" });
  }
  const session = getSessionByPhone(customerPhone);
  if (session) closeSession(session.id);
  releaseConversation(agentId);
  releaseAssignment(customerPhone);
  setState(customerPhone, "awaiting_rating");
  await sendMessage(customerPhone, "Your query has been resolved. Thank you! 🙏\nPlease rate your experience (reply 1–5).");
  logEvent({ type: EVENT_TYPES.DONE, customerId: customerPhone, agentId, status: "success" });
  await processNextInQueue(logMsg);
  res.json({ success: true });
});

/** POST /api/set-agent-status */
app.post("/api/set-agent-status", requireAdmin, async (req, res) => {
  const { agentId, status } = req.body;
  const validStates = Object.values(AGENT_STATES);
  if (!agentId || !validStates.includes(status)) {
    return res.status(400).json({ error: `agentId and status (${validStates.join("|")}) required` });
  }

  const ok = status === AGENT_STATES.AVAILABLE ? resetAgent(agentId) : setAgentStatus(agentId, status);
  if (!ok) return res.status(404).json({ error: "Agent not found" });

  io.to("all").emit("agent:status", { agentId, status });

  if (status === AGENT_STATES.AVAILABLE) {
    const next = await processNextInQueue(logMsg);
    if (next) return res.json({ success: true, autoAssigned: next.phone });
  }
  res.json({ success: true });
});

/** POST /api/assign — manually assign queued customer */
app.post("/api/assign", requireAdmin, async (req, res) => {
  const { customerPhone } = req.body;
  if (!customerPhone) return res.status(400).json({ error: "customerPhone required" });

  const queue = getQueue();
  const entry = queue.find((e) => e.phone === customerPhone);
  if (!entry) return res.status(404).json({ error: "Customer not in queue" });

  const agent = findAvailableAgent(entry.category);
  if (!agent) return res.status(409).json({ error: "No available agent for this category" });

  dequeue(customerPhone);
  const history = getHistory(customerPhone);
  const lastMsg = [...history].reverse().find((h) => h.role === "user");

  await orchestrate(customerPhone, entry.name, lastMsg?.content || "(manual assign)", history, logMsg, {
    type:              "escalate",
    productCategory:   entry.category,
    reason:            "Manually assigned from dashboard",
    customerSentiment: "neutral",
    reply:             "",
    showDemoOffer:     false,
  });

  res.json({ success: true });
});

/** POST /api/send — manual message from dashboard */
app.post("/api/send", requireAuth, async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: "phone and message required" });
  try {
    await sendMessage(phone.replace("+", ""), message);
    logMsg("outbound", phone.replace("+", ""), "Admin", message, { type: "manual" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Test mode routes ─────────────────────────────────────────────────────────
if (TEST_MODE) {
  app.use(testRouter);
  console.log("🔷 TEST_MODE enabled");
}

// ─── Start ────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`\n✅ WhatsApp Support Platform running on port ${PORT}`);
  console.log(`   Admin dashboard : http://localhost:${PORT}/`);
  console.log(`   Agent dashboard : http://localhost:${PORT}/agent`);
  console.log(`   Login           : http://localhost:${PORT}/login`);
  console.log(`   Webhook         : POST /webhook`);
  console.log(`   Default admin   : admin / admin123\n`);
});
