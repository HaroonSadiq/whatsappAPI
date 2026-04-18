/**
 * orchestrator.js
 * Agent Orchestrator / Router Service
 *
 * Pipeline:
 *  1. classifyIntent        — Gemini classifies message intent
 *  2. selectAgent           — load-balanced availability check
 *  3. assignToAgent         — assign + create support session + push to agent dashboard
 *  4. fallbackIfBusy        — priority queue when all agents busy
 *  5. processNextInQueue    — auto-dequeue when an agent frees up
 *  6. orchestrate           — full pipeline entry point
 *
 * Key architecture change:
 *  Agents are no longer alerted via WhatsApp.
 *  Instead, a support session is created and pushed to the agent's web dashboard
 *  via WebSocket (Socket.IO) through appEvents.
 */

import { classifyAndRespond }            from "./classifier.js";
import {
  findAvailableAgent, assignConversation, setAgentStatus,
  markAgentFailed, completeChat,
  agentRegistry, AGENT_STATES,
}                                         from "./agents.js";
import {
  assignAgent, getHistory, getQueue,
  dequeue, setState, enqueue, updateQueueEntry,
}                                         from "./session.js";
import { sendMessage }                    from "./whatsapp.js";
import { onEscalation }                   from "./integrations.js";
import { logEvent, EVENT_TYPES }          from "./logger.js";
import { appEvents }                      from "./events.js";
import {
  createSession, getSessionByPhone, updateSession,
}                                         from "./supportSessions.js";

// ─── Config ───────────────────────────────────────────────────────────────────
const MAX_SEND_RETRIES     = 3;
const RETRY_DELAY_MS       = 1500;
const MAX_QUEUE_WAIT_MS    = 10 * 60 * 1000;  // 10 min → trigger AI fallback
const AI_FALLBACK_INTERVAL = 60 * 1000;        // check queue every 60s

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * sendWithRetry — sends to customer only (WhatsApp).
 * No longer sends to agent phone — agents use web dashboard.
 */
async function sendWithRetry(to, text) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_SEND_RETRIES; attempt++) {
    try {
      await sendMessage(to, text);
      return;
    } catch (err) {
      lastErr = err;
      logEvent({
        type:   EVENT_TYPES.SEND_RETRY,
        status: "retry",
        meta:   { attempt, to, error: err.message },
      });
      console.warn(`[Orchestrator] send attempt ${attempt}/${MAX_SEND_RETRIES} failed → ${err.message}`);
      if (attempt < MAX_SEND_RETRIES) await sleep(RETRY_DELAY_MS * attempt);
    }
  }
  logEvent({ type: EVENT_TYPES.SEND_FAILED, status: "failure", meta: { to } });
  throw lastErr;
}

// ─── Step 1 — Classify ────────────────────────────────────────────────────────
export async function classifyIntent(message, history = []) {
  const result = await classifyAndRespond(message, history);
  logEvent({
    type:     EVENT_TYPES.CLASSIFIED,
    intent:   result.type,
    category: result.productCategory,
    meta:     { sentiment: result.customerSentiment },
  });
  return result;
}

// ─── Step 2 — Map category → pool ────────────────────────────────────────────
export function mapCategoryToPool(category) {
  return agentRegistry[category] || agentRegistry.general || [];
}

// ─── Step 3 — Check availability ─────────────────────────────────────────────
export function selectAgent(category) {
  return findAvailableAgent(category);
}

// ─── Step 4 — Assign + push to agent dashboard ───────────────────────────────
/**
 * Assigns the customer to an agent.
 * - Customer receives a "connecting…" message via WhatsApp.
 * - Agent receives a new session pushed to their web dashboard via WebSocket.
 * - NO WhatsApp alerts are sent to agents.
 *
 * Throws "NO_AGENT_AVAILABLE" if all agents are at capacity / offline.
 */
export async function assignToAgent(phone, name, text, result, logMsg, history = []) {
  const agent = selectAgent(result.productCategory);
  if (!agent) throw new Error("NO_AGENT_AVAILABLE");

  assignConversation(agent.id);
  assignAgent(phone, agent);
  setState(phone, "escalated");

  // Tell customer they're being connected
  const connectMsg =
    `Connecting you with *${agent.name}*, our ${result.productCategory} specialist.\n` +
    `They'll be with you in a moment! 🙏`;

  logMsg("outbound", phone, "Bot", connectMsg, {
    type: "escalate", category: result.productCategory, agent: agent.name,
  });

  try {
    await sendWithRetry(phone, connectMsg);
  } catch (err) {
    // Customer unreachable — release agent and abort
    setAgentStatus(agent.id, AGENT_STATES.AVAILABLE);
    throw err;
  }

  // Create a support session visible in the agent's web dashboard
  const existingSession = getSessionByPhone(phone);
  const session = existingSession || createSession({
    customerPhone: phone,
    customerName:  name,
    category:      result.productCategory,
    priority:      result.customerSentiment === "frustrated" ? 1 : 0,
  });

  // Persist agent pre-assignment and AI context (waiting → active when agent accepts)
  updateSession(session.id, {
    assignedAgentId:  agent.id,
    agentName:        agent.name,
    aiSuggestedReply: result.reply,
    reason:           result.reason,
  });
  // Refresh the local object so downstream code sees the updated fields
  session.assignedAgentId  = agent.id;
  session.agentName        = agent.name;
  session.aiSuggestedReply = result.reply;
  session.reason           = result.reason;

  // Build message snapshot for dashboard context
  const messageSnapshot = history.slice(-10).map(m => ({
    sender:    m.role === 'user' ? 'customer' : 'bot',
    text:      m.content,
    timestamp: Date.now(),
  }));

  // Push new session to agent's dashboard via Socket.IO
  appEvents.emit('session:new', {
    session,
    agentId:   agent.id,
    messages:  messageSnapshot,
  });

  console.log(`🔀 ${phone} → Agent ${agent.name} (${agent.id}) [web dashboard]`);
  logMsg("system", phone, "System",
    `Assigned to agent ${agent.name} (${agent.id}) — ${result.productCategory}`,
    { type: "assigned", agent: agent.name, agentId: agent.id, category: result.productCategory }
  );
  logEvent({
    type:             EVENT_TYPES.ASSIGNED,
    customerId:       phone,
    agentId:          agent.id,
    intent:           "escalate",
    category:         result.productCategory,
    assignmentReason: result.reason,
    status:           "success",
    meta:             { sentiment: result.customerSentiment },
  });

  onEscalation({
    customerPhone:    phone,
    customerName:     name,
    category:         result.productCategory,
    sentiment:        result.customerSentiment,
    reason:           result.reason,
    message:          text,
    agentName:        agent.name,
  }).catch(() => {});

  return { assigned: true, agent, session };
}

// ─── Step 5 — Fallback: queue ─────────────────────────────────────────────────
export async function fallbackIfBusy(phone, name, category, sentiment = "neutral") {
  const priority = sentiment === "frustrated" ? 1 : 0;

  enqueue(phone, name, category, { priority });
  setState(phone, "escalated");

  // Create a waiting session so it appears in admin/agent dashboard
  const existing = getSessionByPhone(phone);
  if (!existing) {
    const session = createSession({ customerPhone: phone, customerName: name, category, priority });
    appEvents.emit('queue:update', { action: 'enqueued', session });
  }

  const queueMsg =
    `All our ${category} specialists are currently busy.\n` +
    `You're in the queue — we'll connect you within *10–15 minutes*. ⏳\n` +
    `We'll message you the moment someone is free!`;

  await sendWithRetry(phone, queueMsg);
  console.log(`⏳ Queued: ${phone} (${category}) priority=${priority}`);

  logEvent({
    type:      EVENT_TYPES.QUEUED,
    customerId: phone,
    category,
    status:    "queued",
    meta:      { priority, sentiment },
  });
}

// ─── Step 6 — Auto-dequeue ────────────────────────────────────────────────────
export async function processNextInQueue(logMsg) {
  const fullQueue = getQueue();
  const nextEntry = fullQueue.find((entry) => selectAgent(entry.category) !== null);
  if (!nextEntry) return null;

  dequeue(nextEntry.phone);
  console.log(`📋 Auto-dequeuing: ${nextEntry.phone} (${nextEntry.category})`);
  logEvent({
    type:      EVENT_TYPES.DEQUEUED,
    customerId: nextEntry.phone,
    category:  nextEntry.category,
    status:    "dequeued",
    meta:      { waitMs: Date.now() - nextEntry.enqueuedAt, retryCount: nextEntry.retryCount },
  });

  const history = getHistory(nextEntry.phone);
  const lastMsg = [...history].reverse().find((m) => m.role === "user");

  await orchestrate(
    nextEntry.phone,
    nextEntry.name,
    lastMsg?.content || "(queued)",
    history,
    logMsg,
    {
      type:              "escalate",
      productCategory:   nextEntry.category,
      reason:            "Dequeued — agent became available",
      customerSentiment: "neutral",
      reply:             "",
      showDemoOffer:     false,
    }
  );

  return nextEntry;
}

// ─── AI Fallback for long-waiting queue customers ─────────────────────────────
setInterval(async () => {
  const now = Date.now();
  const longWaiters = getQueue().filter(
    (e) => (now - e.enqueuedAt) > MAX_QUEUE_WAIT_MS && !e._aiFallbackSent
  );

  for (const entry of longWaiters) {
    updateQueueEntry(entry.phone, { _aiFallbackSent: true });
    const fallbackMsg =
      `Hi ${entry.name.split(" ")[0]}! We apologize for the wait. ` +
      `All our ${entry.category} specialists are still busy but you're next in line.\n\n` +
      `If it's urgent, you can reply and our AI assistant will try to help right away.`;

    try {
      await sendWithRetry(entry.phone, fallbackMsg);
      logEvent({
        type:      EVENT_TYPES.FALLBACK_AI,
        customerId: entry.phone,
        category:  entry.category,
        status:    "success",
        meta:      { waitMs: now - entry.enqueuedAt },
      });
    } catch {
      // Best effort
    }
  }
}, AI_FALLBACK_INTERVAL);

// ─── Main pipeline ─────────────────────────────────────────────────────────────
export async function orchestrate(phone, name, text, history, logMsg, preClassified = null) {
  const startTs = Date.now();

  const result = preClassified || await classifyIntent(text, history.slice(0, -1));

  logEvent({
    type:      EVENT_TYPES.CLASSIFIED,
    customerId: phone,
    intent:    result.type,
    category:  result.productCategory,
    status:    "success",
    text,
    meta:      { sentiment: result.customerSentiment },
  });

  console.log(`🤖 ${result.type.toUpperCase()} | ${result.productCategory} | ${result.customerSentiment}`);

  if (result.type !== "escalate") {
    logEvent({
      type:          EVENT_TYPES.MESSAGE_OUT,
      customerId:    phone,
      intent:        "faq_answer",
      category:      result.productCategory,
      responseTimeMs: Date.now() - startTs,
      status:        "success",
    });
    return result;
  }

  try {
    await assignToAgent(phone, name, text, result, logMsg, history);
  } catch (err) {
    if (err.message === "NO_AGENT_AVAILABLE") {
      await fallbackIfBusy(phone, name, result.productCategory, result.customerSentiment);
    } else {
      logEvent({ type: EVENT_TYPES.ERROR, customerId: phone, status: "failure", text: err.message });
      throw err;
    }
  }

  return result;
}
