/**
 * agents.js
 * Agent registry with category metadata, multi-capacity load tracking,
 * load balancing, and performance metrics.
 *
 * Agent states:
 *  available  — ready to accept more conversations (load < max)
 *  busy       — at full capacity (activeConversations >= maxConcurrentConversations)
 *  cooldown   — all conversations done, post-chat break (auto → available)
 *  offline    — manually taken offline (requires manual reset)
 *  failed     — system flagged after repeated send failures (requires manual reset)
 *
 * Key change vs simple on/off:
 *  Agents stay "available" until activeConversations reaches maxConcurrentConversations.
 *  This allows one agent to handle multiple chats before being marked busy.
 */

import { logEvent } from "./logger.js";
import { db }       from "./db.js";

// ─── Metric persistence helpers ───────────────────────────────────────────────
const _upsertMetrics = db.prepare(`
  INSERT INTO agent_metrics (agent_id, chat_count, total_response_ms, last_active_at)
  VALUES (@agent_id, @chat_count, @total_response_ms, @last_active_at)
  ON CONFLICT(agent_id) DO UPDATE SET
    chat_count        = excluded.chat_count,
    total_response_ms = excluded.total_response_ms,
    last_active_at    = excluded.last_active_at
`);

function _persistMetrics(agent) {
  _upsertMetrics.run({
    agent_id:          agent.id,
    chat_count:        agent.chatCount,
    total_response_ms: agent.totalResponseMs,
    last_active_at:    agent.lastActiveAt,
  });
}

export const AGENT_STATES = {
  AVAILABLE: "available",
  BUSY:      "busy",
  COOLDOWN:  "cooldown",
  OFFLINE:   "offline",
  FAILED:    "failed",
};

const COOLDOWN_MS = 2 * 60 * 1000; // 2-minute break after all chats complete

// ─── Category Registry ────────────────────────────────────────────────────────
// Source of truth for categories. Add new categories here — routing picks them
// up automatically without any other code change.
export const categoryRegistry = {
  clothing: {
    id:          "clothing",
    name:        "Clothing",
    description: "Product inquiries, sizing help, order assistance, fashion recommendations, return/exchange questions",
    skills:      ["product_inquiries", "sizing_help", "order_assistance", "fashion_recommendations", "returns_exchanges"],
  },
  tech: {
    id:          "tech",
    name:        "Tech",
    description: "Device troubleshooting, technical support, product specifications, setup guidance, warranty inquiries",
    skills:      ["device_troubleshooting", "technical_support", "product_specs", "setup_guidance", "warranty_inquiries"],
  },
  general: {
    id:          "general",
    name:        "General",
    description: "General support and overflow routing",
    skills:      ["general_support"],
  },
};

// ─── Agent Registry ───────────────────────────────────────────────────────────
// Extra runtime fields per agent:
//   chatCount            — total completed chats (lifetime)
//   totalResponseMs      — sum of response times for avg calculation
//   currentChatStart     — timestamp of current chat batch start
//   cooldownTimer        — setTimeout handle
//   activeConversations  — how many chats this agent is currently handling
//   lastActiveAt         — timestamp of last conversation assignment
export const agentRegistry = {
  clothing: [
    {
      id:                       "clothing_agent_1",
      name:                     "Hamza Tariq",
      status:                   AGENT_STATES.AVAILABLE,
      skills:                   ["sizing_help", "fashion_recommendations", "returns_exchanges"],
      maxConcurrentConversations: 3,
      activeConversations:      0,
      lastActiveAt:             null,
      chatCount:                0,
      totalResponseMs:          0,
      currentChatStart:         null,
      cooldownTimer:            null,
    },
    {
      id:                       "clothing_agent_2",
      name:                     "Nida Awan",
      status:                   AGENT_STATES.AVAILABLE,
      skills:                   ["product_inquiries", "order_assistance", "returns_exchanges"],
      maxConcurrentConversations: 3,
      activeConversations:      0,
      lastActiveAt:             null,
      chatCount:                0,
      totalResponseMs:          0,
      currentChatStart:         null,
      cooldownTimer:            null,
    },
  ],
  tech: [
    {
      id:                       "tech_agent_1",
      name:                     "Hafiz",
      status:                   AGENT_STATES.AVAILABLE,
      skills:                   ["device_troubleshooting", "technical_support", "product_specs"],
      maxConcurrentConversations: 2,
      activeConversations:      0,
      lastActiveAt:             null,
      chatCount:                0,
      totalResponseMs:          0,
      currentChatStart:         null,
      cooldownTimer:            null,
    },
    {
      id:                       "tech_agent_2",
      name:                     "Haroon",
      status:                   AGENT_STATES.AVAILABLE,
      skills:                   ["setup_guidance", "warranty_inquiries", "technical_support"],
      maxConcurrentConversations: 2,
      activeConversations:      0,
      lastActiveAt:             null,
      chatCount:                0,
      totalResponseMs:          0,
      currentChatStart:         null,
      cooldownTimer:            null,
    },
  ],
  general: [
    {
      id:                       "G1",
      name:                     "Faisal Beg",
      status:                   AGENT_STATES.AVAILABLE,
      skills:                   ["general_support"],
      maxConcurrentConversations: 5,
      activeConversations:      0,
      lastActiveAt:             null,
      chatCount:                0,
      totalResponseMs:          0,
      currentChatStart:         null,
      cooldownTimer:            null,
    },
  ],
};

// ─── Restore persisted metrics on startup ────────────────────────────────────
{
  const rows = db.prepare('SELECT * FROM agent_metrics').all();
  const metricMap = new Map(rows.map(r => [r.agent_id, r]));
  for (const agents of Object.values(agentRegistry)) {
    for (const agent of agents) {
      const m = metricMap.get(agent.id);
      if (m) {
        agent.chatCount       = m.chat_count;
        agent.totalResponseMs = m.total_response_ms;
        agent.lastActiveAt    = m.last_active_at;
      }
    }
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────
function _allAgents() {
  return Object.values(agentRegistry).flat();
}

function _agentEntry(agentId) {
  for (const agents of Object.values(agentRegistry)) {
    const a = agents.find((x) => x.id === agentId);
    if (a) return a;
  }
  return null;
}

function _categoryOf(agentId) {
  for (const [cat, agents] of Object.entries(agentRegistry)) {
    if (agents.find((x) => x.id === agentId)) return cat;
  }
  return null;
}

// ─── findAvailableAgent — load-balanced ───────────────────────────────────────
/**
 * Returns the agent in the pool with available capacity AND the lowest load
 * ratio (activeConversations / maxConcurrentConversations).
 *
 * Falls back to general pool, then any available agent across all categories.
 * Returns null only when every reachable agent is at capacity / offline / failed.
 */
export function findAvailableAgent(category) {
  const canAccept = (a) =>
    a.status !== AGENT_STATES.OFFLINE &&
    a.status !== AGENT_STATES.FAILED  &&
    a.status !== AGENT_STATES.COOLDOWN &&
    a.activeConversations < a.maxConcurrentConversations;

  const leastLoaded = (pool) =>
    pool
      .filter(canAccept)
      .sort((a, b) => (a.activeConversations / a.maxConcurrentConversations) -
                      (b.activeConversations / b.maxConcurrentConversations))[0] || null;

  const pool = agentRegistry[category] || agentRegistry.general;
  const agent = leastLoaded(pool);
  if (agent) return agent;

  // Fallback: general pool
  if (category !== "general") {
    const gen = leastLoaded(agentRegistry.general || []);
    if (gen) return gen;
  }

  // Last resort: any agent across all categories
  return leastLoaded(_allAgents()) || null;
}

// ─── assignConversation ───────────────────────────────────────────────────────
/**
 * Increment an agent's active conversation count.
 * Only marks BUSY when the agent reaches maxConcurrentConversations.
 * Marks chatStart on first conversation.
 *
 * Call this instead of setAgentStatus(BUSY) when routing a customer.
 *
 * @returns {boolean} true if found
 */
export function assignConversation(agentId) {
  const agent = _agentEntry(agentId);
  if (!agent) return false;

  // Clear any pending cooldown — agent is active again
  if (agent.cooldownTimer) {
    clearTimeout(agent.cooldownTimer);
    agent.cooldownTimer = null;
  }

  agent.activeConversations += 1;
  agent.lastActiveAt        = Date.now();

  // Record start time on first conversation
  if (agent.activeConversations === 1) {
    agent.currentChatStart = Date.now();
  }

  // Mark BUSY only when at full capacity
  if (agent.activeConversations >= agent.maxConcurrentConversations) {
    agent.status = AGENT_STATES.BUSY;
  } else {
    agent.status = AGENT_STATES.AVAILABLE;
  }

  _persistMetrics(agent);

  logEvent({
    type:     "agent_conversation_assigned",
    agentId:  agent.id,
    category: _categoryOf(agentId),
    meta:     { activeConversations: agent.activeConversations, max: agent.maxConcurrentConversations },
  });

  return true;
}

// ─── releaseConversation ──────────────────────────────────────────────────────
/**
 * Decrement an agent's active conversation count.
 * Enters cooldown only when the last conversation is released.
 * If more conversations remain, agent stays available.
 *
 * @param {string} agentId
 * @param {object} [opts]
 * @param {number} [opts.cooldownMs] — override cooldown duration
 * @returns {boolean}
 */
export function releaseConversation(agentId, opts = {}) {
  const agent = _agentEntry(agentId);
  if (!agent) return false;

  // Track response time when completing a chat
  if (agent.currentChatStart) {
    const elapsed = Date.now() - agent.currentChatStart;
    agent.totalResponseMs += elapsed;
    agent.chatCount       += 1;
    _persistMetrics(agent);
    logEvent({
      type:     "agent_chat_complete",
      agentId:  agent.id,
      category: _categoryOf(agentId),
      meta:     { chatCount: agent.chatCount, responseMs: elapsed, activeConversations: agent.activeConversations },
    });
  }

  agent.activeConversations = Math.max(0, agent.activeConversations - 1);

  if (agent.activeConversations > 0) {
    // Still handling other conversations — stay available
    agent.status           = AGENT_STATES.AVAILABLE;
    agent.currentChatStart = Date.now(); // reset timer for remaining chats
    logEvent({ type: "agent_conversation_released", agentId: agent.id, meta: { remaining: agent.activeConversations } });
  } else {
    // All conversations done — enter cooldown
    agent.currentChatStart = null;
    agent.status           = AGENT_STATES.COOLDOWN;

    const delay = opts.cooldownMs ?? COOLDOWN_MS;
    agent.cooldownTimer = setTimeout(() => {
      if (agent.status === AGENT_STATES.COOLDOWN) {
        agent.status       = AGENT_STATES.AVAILABLE;
        agent.cooldownTimer = null;
        logEvent({ type: "agent_cooldown_done", agentId: agent.id, category: _categoryOf(agentId) });
        console.log(`[Agents] ${agent.name} (${agentId}) cooldown ended — available`);
      }
    }, delay);
  }

  return true;
}

// ─── completeChat (alias for backward compat) ─────────────────────────────────
export function completeChat(agentId) {
  return releaseConversation(agentId);
}

// ─── setAgentStatus ───────────────────────────────────────────────────────────
/**
 * Manually force an agent's status (offline, available reset, etc.).
 * Not used for normal conversation assignment — use assignConversation / releaseConversation.
 */
export function setAgentStatus(agentId, status, opts = {}) {
  const agent = _agentEntry(agentId);
  if (!agent) return false;

  if (agent.cooldownTimer) {
    clearTimeout(agent.cooldownTimer);
    agent.cooldownTimer = null;
  }

  // When manually resetting to available, clear load counters
  if (status === AGENT_STATES.AVAILABLE) {
    agent.activeConversations = 0;
    agent.currentChatStart    = null;
  }

  agent.status = status;

  if (status === AGENT_STATES.COOLDOWN) {
    const delay = opts.cooldownMs ?? COOLDOWN_MS;
    agent.cooldownTimer = setTimeout(() => {
      if (agent.status === AGENT_STATES.COOLDOWN) {
        agent.status        = AGENT_STATES.AVAILABLE;
        agent.cooldownTimer = null;
        logEvent({ type: "agent_cooldown_done", agentId: agent.id, category: _categoryOf(agentId) });
      }
    }, delay);
  }

  return true;
}

// ─── resetAgent ───────────────────────────────────────────────────────────────
export function resetAgent(agentId) {
  const agent = _agentEntry(agentId);
  if (!agent) return false;
  if (agent.cooldownTimer) { clearTimeout(agent.cooldownTimer); agent.cooldownTimer = null; }
  agent.status              = AGENT_STATES.AVAILABLE;
  agent.activeConversations = 0;
  agent.currentChatStart    = null;
  logEvent({ type: "agent_reset", agentId: agent.id });
  return true;
}

// ─── markAgentFailed ─────────────────────────────────────────────────────────
export function markAgentFailed(agentId) {
  const agent = _agentEntry(agentId);
  if (!agent) return false;
  if (agent.cooldownTimer) { clearTimeout(agent.cooldownTimer); agent.cooldownTimer = null; }
  agent.status = AGENT_STATES.FAILED;
  logEvent({ type: "agent_failed", agentId: agent.id });
  console.warn(`[Agents] Agent ${agentId} marked FAILED`);
  return true;
}

// ─── getAgentById ─────────────────────────────────────────────────────────────
export function getAgentById(agentId) {
  return _agentEntry(agentId);
}

// ─── getAvailabilitySnapshot ─────────────────────────────────────────────────
export function getAvailabilitySnapshot() {
  const snapshot = {};
  for (const [cat, agents] of Object.entries(agentRegistry)) {
    snapshot[cat] = agents.map(({ id, name, status, chatCount, skills, maxConcurrentConversations, activeConversations, lastActiveAt }) => ({
      id, name, status, chatCount, skills, maxConcurrentConversations, activeConversations, lastActiveAt,
    }));
  }
  return snapshot;
}

// ─── getCategorySnapshot ─────────────────────────────────────────────────────
export function getCategorySnapshot() {
  return Object.entries(categoryRegistry).map(([key, cat]) => ({
    ...cat,
    agentCount:     agentRegistry[key]?.length || 0,
    availableCount: agentRegistry[key]?.filter(
      (a) => a.status === AGENT_STATES.AVAILABLE || a.activeConversations < a.maxConcurrentConversations
    ).length || 0,
  }));
}

// ─── createAgent — dynamic agent provisioning ─────────────────────────────────
export function createAgent({ name, category, skills = ['general_support'], maxConcurrentConversations = 3 }) {
  if (!agentRegistry[category]) agentRegistry[category] = [];
  const id = `${category}_dyn_${Date.now()}`;
  const agent = {
    id,
    name,
    status: AGENT_STATES.AVAILABLE,
    skills,
    maxConcurrentConversations,
    activeConversations: 0,
    lastActiveAt: null,
    chatCount: 0,
    totalResponseMs: 0,
    currentChatStart: null,
    cooldownTimer: null,
  };
  agentRegistry[category].push(agent);
  logEvent({ type: 'agent_created', agentId: id, category, meta: { name } });
  return agent;
}

// ─── removeAgent ─────────────────────────────────────────────────────────────
export function removeAgent(agentId) {
  for (const [cat, agents] of Object.entries(agentRegistry)) {
    const idx = agents.findIndex(a => a.id === agentId);
    if (idx >= 0) {
      if (agents[idx].cooldownTimer) clearTimeout(agents[idx].cooldownTimer);
      agentRegistry[cat].splice(idx, 1);
      logEvent({ type: 'agent_removed', agentId });
      return true;
    }
  }
  return false;
}

// ─── findAgent ───────────────────────────────────────────────────────────────
export function findAgent(agentId) {
  return _agentEntry(agentId);
}

// ─── getAgentMetrics ─────────────────────────────────────────────────────────
export function getAgentMetrics() {
  return _allAgents().map((a) => ({
    id:                       a.id,
    name:                     a.name,
    category:                 _categoryOf(a.id),
    status:                   a.status,
    skills:                   a.skills,
    maxConcurrentConversations: a.maxConcurrentConversations,
    activeConversations:      a.activeConversations,
    currentLoad:              `${a.activeConversations}/${a.maxConcurrentConversations}`,
    loadPct:                  Math.round((a.activeConversations / a.maxConcurrentConversations) * 100),
    chatCount:                a.chatCount,
    lastActiveAt:             a.lastActiveAt,
    avgResponseMs:            a.chatCount > 0 ? Math.round(a.totalResponseMs / a.chatCount) : null,
  }));
}
