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
 *  awaiting_rating  → agent marked done, waiting for 1–5 star rating
 *  closed           → session ended
 */

import "dotenv/config";
import express          from "express";
import { createServer } from "http";
import { Server as SocketIO } from "socket.io";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createHmac, timingSafeEqual } from "crypto";
import rateLimit from "express-rate-limit";

// ─── DB init ──────────────────────────────────────────────────────────────────
import { initDb }          from "./db.js";
import { initUsers }       from "./auth/users.js";
import { initAgents, initAgentMetrics } from "./agents.js";

await initDb();
await initUsers();
await initAgents();
await initAgentMetrics();

// ─── Session & state ──────────────────────────────────────────────────────────
import {
  getHistory, addToHistory, clearSession,
  getState,   setState,
  getContact, updateContact,
  getAssignment, releaseAssignment,
  dequeue, getQueue,
  saveRating, getRatings,
  scheduleFollowUp, clearFollowUpTimer, getOverdueFollowUps,
  getActiveChats, updateSessionMeta, getSessionMeta,
} from "./session.js";

// ─── Agents ───────────────────────────────────────────────────────────────────
import {
  setAgentStatus, findAvailableAgent,
  getAvailabilitySnapshot, getCategorySnapshot,
  getAgentMetrics, resetAgent, completeChat, releaseConversation,
  AGENT_STATES,
} from "./agents.js";

// ─── Messaging & classification ───────────────────────────────────────────────
import { sendMessage, sendButtonMessage } from "./whatsapp.js";
import { integrationState, onRating, onFaqAnswered } from "./integrations.js";
import { enqueueJob, getQueueStats }  from "./queue.js";
import { logEvent, getEventLog, getConversationLog, getLogStats, EVENT_TYPES } from "./logger.js";
import {
  orchestrate, classifyIntent, processNextInQueue, checkQueueFallback,
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
const APP_SECRET   = process.env.APP_SECRET;

// ─── App setup ────────────────────────────────────────────────────────────────
const app        = express();
const httpServer = createServer(app);
const io         = new SocketIO(httpServer, {
  cors: { origin: process.env.CLIENT_ORIGIN || "*", methods: ["GET", "POST"] },
  transports: ["websocket", "polling"],
});

app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

// ─── Page routes (before static, so /agent doesn't 301 to /agent/) ───────────
app.get("/login", (_req, res) => res.sendFile(join(__dirname, "../public/login.html")));
app.get("/agent", (_req, res) => res.sendFile(join(__dirname, "../public/agent/dashboard.html")));

// Static files — serve admin dashboard and assets
// ─── Rate limiting ────────────────────────────────────────────────────────────
const standardLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 60,
  message: { error: 'Too many requests, please try again later.' },
});

const webhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 30,
  message: { error: 'Webhook rate limit exceeded.' },
});

const loginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts. Please try again later.' },
});

const sendLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 20,
  message: { error: 'Too many messages sent. Please slow down.' },
});

app.use('/api/auth/login', loginLimiter);
app.use('/webhook', webhookLimiter);
app.use('/api/send', sendLimiter);
app.use(standardLimiter);

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

  // Verify Meta signature when APP_SECRET is configured
  if (APP_SECRET) {
    const sig = req.headers["x-hub-signature-256"];
    if (!sig) return res.status(403).end();
    const expected = "sha256=" + createHmac("sha256", APP_SECRET).update(req.rawBody).digest("hex");
    const sigBuf      = Buffer.from(sig);
    const expectedBuf = Buffer.from(expected);
    if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
      return res.status(403).end();
    }
  }

  res.sendStatus(200);

  const value   = req.body?.entry?.[0]?.changes?.[0]?.value;
  const msg     = value?.messages?.[0];
  const contact = value?.contacts?.[0];
  if (!msg) return;

  const phone = msg.from;
  const name  = contact?.profile?.name || "there";

  enqueueJob(phone, async () => {
    try {
      await updateContact(phone, { name });
      await clearFollowUpTimer(phone);

      // Check and process any overdue follow-ups globally
      await processOverdueFollowUps();
      // Check for long-waiting queue customers needing AI fallback
      await checkQueueFallback();

      // Interactive button reply
      if (msg.type === "interactive" && msg.interactive?.type === "button_reply") {
        await handleButtonReply(phone, name, msg.interactive.button_reply.id);
        return;
      }

      // Handle non-text messages gracefully
      if (msg.type !== "text") {
        await sendMessage(phone, "Sorry, I can only process text messages right now. Please send your question as text. 😊");
        return;
      }

      const text  = msg.text.body.trim();
      const state = await getState(phone);
      console.log(`📩 [${state}] ${name} (+${phone}): ${text}`);
      logMsg("inbound", phone, name, text, { state });
      await updateSessionMeta(phone, { intent: null });

      switch (state) {
        case "new":
          await handleNewCustomer(phone, name, text);
          break;
        case "active":
          await handleActiveConversation(phone, name, text);
          break;
        case "escalated":
          await addToHistory(phone, "user", text);
          logMsg("inbound", phone, name, text, { state: "escalated" });
          await pushCustomerMessage(phone, name, text);
          break;
        case "awaiting_rating":
          await handleRating(phone, name, text);
          break;
        case "closed":
          await setState(phone, "new");
          await handleNewCustomer(phone, name, text);
          break;
        default:
          await setState(phone, "active");
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
  await setState(phone, "active");
  await addToHistory(phone, "user", text);
  const firstName = name.split(" ")[0];
  const greeting =
    `Hi ${firstName}! 👋 Welcome! I'm your virtual assistant.\n\n` +
    `I can help with product info, pricing, delivery times, and more — or connect you with a specialist.`;
  await sendMessage(phone, greeting);
  await handleActiveConversation(phone, name, text, true);
}

// ─── Active AI conversation ───────────────────────────────────────────────────
async function handleActiveConversation(phone, name, text, alreadyInHistory = false) {
  if (!alreadyInHistory) await addToHistory(phone, "user", text);

  const history = await getHistory(phone);
  const result  = await orchestrate(phone, name, text, history, logMsg);

  await addToHistory(phone, "assistant", result.reply);
  await updateSessionMeta(phone, {
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
    await scheduleFollowUp(phone, name, 'nudge', 5 * 60 * 1000);
  }
}

// ─── Button reply ─────────────────────────────────────────────────────────────
async function handleButtonReply(phone, name, buttonId) {
  await clearFollowUpTimer(phone);

  switch (buttonId) {
    case "more_questions":
      await sendMessage(phone, "Of course! What would you like to know? 😊");
      await scheduleFollowUp(phone, name, 'nudge', 5 * 60 * 1000);
      break;

    case "connect_human": {
      await sendMessage(phone, "Sure! Let me find the right specialist for you. One moment... 🙏");
      const history = await getHistory(phone);
      const lastMsg = [...history].reverse().find((h) => h.role === "user");
      const result  = await classifyIntent("I want to speak to a human agent", history);
      await orchestrate(phone, name, lastMsg?.content || "Customer requested support", history, logMsg, result);
      break;
    }

    case "book_demo": {
      await sendMessage(phone, "Great choice! Let me connect you with a specialist who will arrange a demo for you. 📅");
      const history = await getHistory(phone);
      const lastMsg = [...history].reverse().find((h) => h.role === "user");
      const result  = await classifyIntent("I want to book a demo", history);
      result.reason = "Customer requested demo booking";
      await orchestrate(phone, name, lastMsg?.content || "Demo request", history, logMsg, result);
      break;
    }

    default:
      await sendMessage(phone, "What can I help you with? 😊");
      await scheduleFollowUp(phone, name, 'nudge', 5 * 60 * 1000);
  }
}

// ─── Rating ───────────────────────────────────────────────────────────────────
async function handleRating(phone, name, text) {
  // Extract numeric score, handling emojis and text
  const score = extractRating(text);
  if (score >= 1 && score <= 5) {
    await saveRating(phone, name, score);
    onRating({ customerPhone: phone, customerName: name, score }).catch(() => {});
    logEvent({ type: EVENT_TYPES.RATING, customerId: phone, status: "success", meta: { score } });
    const stars = "⭐".repeat(score);
    await sendMessage(phone,
      `Thank you for rating us ${stars} (${score}/5)! Your feedback means a lot. 🙏\n\nFeel free to message us anytime! 👋`
    );
    await setState(phone, "closed");

    // Clean up support session and active chat
    const session = await getSessionByPhone(phone);
    if (session) await closeSession(session.id);
    const assignment = await getAssignment(phone);
    if (assignment?.agentId) await releaseConversation(assignment.agentId);
    await releaseAssignment(phone);
    await clearSession(phone);
  } else {
    await setState(phone, "active");
    await handleActiveConversation(phone, name, text);
  }
}

function extractRating(text) {
  const cleaned = text.trim();
  // Try direct parse first
  const direct = parseInt(cleaned, 10);
  if (!isNaN(direct) && direct >= 1 && direct <= 5) return direct;
  // Count star emojis
  const starCount = (cleaned.match(/[⭐★]/g) || []).length;
  if (starCount >= 1 && starCount <= 5) return starCount;
  // Fallback: find first digit 1-5
  const match = cleaned.match(/[1-5]/);
  return match ? parseInt(match[0], 10) : NaN;
}

// ─── Follow-up processing (DB-driven, Vercel-safe) ────────────────────────────
async function processOverdueFollowUps() {
  try {
    const overdue = await getOverdueFollowUps();
    for (const fu of overdue) {
      await clearFollowUpTimer(fu.phone);
      const state = await getState(fu.phone);
      if (state !== 'active') continue;

      if (fu.stage === 'nudge') {
        await sendMessage(fu.phone, `Hi ${fu.name?.split(' ')[0] || 'there'}, just checking if you're still there? 😊`);
        await scheduleFollowUp(fu.phone, fu.name, 'close', 5 * 60 * 1000);
      } else if (fu.stage === 'close') {
        await sendMessage(fu.phone, "I'll close the chat for now, but feel free to message us anytime! 👋");
        await setState(fu.phone, "closed");

        // Close support session and clean up
        const session = await getSessionByPhone(fu.phone);
        if (session) await closeSession(session.id);
        const assignment = await getAssignment(fu.phone);
        if (assignment?.agentId) await releaseConversation(assignment.agentId);
        await releaseAssignment(fu.phone);
        await clearSession(fu.phone);
      }
    }
  } catch (err) {
    console.error('[FollowUp] Error processing overdue:', err.message);
  }
}

// ─── Admin & Agent APIs (protected) ──────────────────────────────────────────

/** GET /status — quick health check (auth required) */
app.get("/status", requireAuth, async (_req, res) => {
  res.json({
    agents:       await getAvailabilitySnapshot(),
    integrations: integrationState,
  });
});

/** GET /api/dashboard — full data for admin dashboard */
app.get("/api/dashboard", requireAuth, async (_req, res) => {
  try {
    const agents   = await getAvailabilitySnapshot();
    const queue    = await getQueue();
    const ratings  = await getRatings();
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
      categories:  await getCategorySnapshot(),
      queue,
      ratings: ratings.slice(-20).reverse(),
      activeChats: await getActiveChats(),
      metrics: await getAgentMetrics(),
      sessions: await getAllSessions(),
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
  } catch (err) {
    console.error("[Dashboard]", err);
    res.status(500).json({ error: "Failed to load dashboard data" });
  }
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
app.get("/api/metrics", requireAuth, async (_req, res) => {
  res.json(await getAgentMetrics());
});

/** GET /api/sessions — all support sessions */
app.get("/api/sessions", requireAuth, async (_req, res) => {
  res.json(await getAllSessions());
});

/** GET /api/sessions/mine — sessions for logged-in agent */
app.get("/api/sessions/mine", requireAgent, async (req, res) => {
  const sessions = (await getAllSessions()).filter(
    s => s.agentId === req.user.agentId && s.state !== 'closed'
  );
  res.json(sessions);
});

/** POST /api/sessions/:id/accept — agent accepts a waiting session (polling fallback) */
app.post("/api/sessions/:id/accept", requireAgent, async (req, res) => {
  const session = await getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (session.state !== 'waiting') return res.status(409).json({ error: "Session not waiting" });
  if (session.assignedAgentId && session.assignedAgentId !== req.user.agentId) {
    return res.status(403).json({ error: "Session assigned to a different agent" });
  }

  const activated = await assignSession(session.id, req.user.agentId);
  if (!activated) return res.status(409).json({ error: "Could not activate session" });

  // Send welcome message to customer
  const acceptMsg = `Hi! I'm ${session.agentName || 'your support agent'}. I'm here to help. 😊`;
  try {
    await sendMessage(session.customerPhone, acceptMsg);
    await addToHistory(session.customerPhone, 'assistant', acceptMsg);
    logMsg('outbound', session.customerPhone, session.agentName || 'Agent', acceptMsg, {
      type: 'agent_message', agentId: req.user.agentId,
    });
  } catch (err) {
    console.error('[API] Failed to send acceptance message:', err.message);
  }

  const history = await getHistory(session.customerPhone);
  const messages = history.map(m => ({
    sender:    m.role === 'user' ? 'customer' : (m.role === 'assistant' ? 'agent' : 'bot'),
    text:      m.content,
    timestamp: Date.now(),
  }));

  io.to('admin').emit('session:activated', { session: activated });
  logEvent({ type: EVENT_TYPES.ASSIGNED, customerId: session.customerPhone, agentId: req.user.agentId, status: 'success' });

  res.json({ ok: true, session: activated, messages });
});

/** GET /api/sessions/:id/history */
app.get("/api/sessions/:id/history", requireAuth, async (req, res) => {
  const sessions = await getAllSessions();
  const session  = sessions.find(s => s.id === req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json(await getHistory(session.customerPhone));
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
  const session = await getSessionByPhone(customerPhone);
  if (session) await closeSession(session.id);
  await releaseConversation(agentId);
  await releaseAssignment(customerPhone);
  await setState(customerPhone, "awaiting_rating");
  await sendMessage(customerPhone, "Your query has been resolved. Thank you! 🙏\nPlease rate your experience (reply 1–5).");
  logEvent({ type: EVENT_TYPES.DONE, customerId: customerPhone, agentId, status: "success" });
  await processNextInQueue(logMsg);
  res.json({ success: true });
});

/** POST /api/set-agent-status — agents can toggle their own status; admins can toggle anyone */
app.post("/api/set-agent-status", requireAgent, async (req, res) => {
  const { agentId, status } = req.body;
  const validStates = Object.values(AGENT_STATES);
  if (!agentId || !validStates.includes(status)) {
    return res.status(400).json({ error: `agentId and status (${validStates.join("|")}) required` });
  }

  // Agents can only change their own status; admins can change anyone's
  if (req.user.role === 'agent' && agentId !== req.user.agentId) {
    return res.status(403).json({ error: "You can only change your own status" });
  }

  const ok = status === AGENT_STATES.AVAILABLE ? await resetAgent(agentId) : await setAgentStatus(agentId, status);
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

  const queue = await getQueue();
  const entry = queue.find((e) => e.phone === customerPhone);
  if (!entry) return res.status(404).json({ error: "Customer not in queue" });

  const agent = await findAvailableAgent(entry.category);
  if (!agent) return res.status(409).json({ error: "No available agent for this category" });

  await dequeue(customerPhone);
  const history = await getHistory(customerPhone);
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

/** POST /api/send — manual message from dashboard or agent */
app.post("/api/send", requireAuth, async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: "phone and message required" });
  try {
    await sendMessage(phone.replace("+", ""), message);
    const senderName = req.user.role === 'agent' ? (req.user.username || 'Agent') : 'Admin';
    logMsg("outbound", phone.replace("+", ""), senderName, message, { type: "manual", agentId: req.user.agentId || null });
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

// ─── Start (local only — Vercel manages its own HTTP server) ──────────────────
if (!process.env.VERCEL) {
  httpServer.listen(PORT, () => {
    console.log(`\n✅ WhatsApp Support Platform running on port ${PORT}`);
    console.log(`   Admin dashboard : http://localhost:${PORT}/`);
    console.log(`   Agent dashboard : http://localhost:${PORT}/agent`);
    console.log(`   Login           : http://localhost:${PORT}/login`);
    console.log(`   Webhook         : POST /webhook`);
    console.log(`   Default admin   : admin / admin123\n`);
  });
}

export { app, httpServer };
export default httpServer;
