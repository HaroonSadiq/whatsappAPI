/**
 * agents.js
 * Agent registry with category metadata, multi-capacity load tracking,
 * load balancing, and performance metrics.
 *
 * Vercel-safe architecture: all runtime state is persisted to Turso DB.
 * In-memory Maps and setTimeout handles have been replaced with DB queries
 * and timestamp-based cooldown checks.
 *
 * Agent states:
 *  available  — ready to accept more conversations (load < max)
 *  busy       — at full capacity (activeConversations >= maxConcurrentConversations)
 *  cooldown   — post-chat break (auto-resets when cooldown_until < now)
 *  offline    — manually taken offline (requires manual reset)
 *  failed     — system flagged after repeated send failures (requires manual reset)
 */

import { logEvent } from "./logger.js";
import { db }       from "./db.js";

// ─── Metric persistence helpers ───────────────────────────────────────────────

function _persistMetrics(agentId, chatCount, totalResponseMs, lastActiveAt) {
  db.execute({
    sql: `INSERT INTO agent_metrics (agent_id, chat_count, total_response_ms, last_active_at)
          VALUES (@agent_id, @chat_count, @total_response_ms, @last_active_at)
          ON CONFLICT(agent_id) DO UPDATE SET
            chat_count        = excluded.chat_count,
            total_response_ms = excluded.total_response_ms,
            last_active_at    = excluded.last_active_at`,
    args: { agent_id: agentId, chat_count: chatCount, total_response_ms: totalResponseMs, last_active_at: lastActiveAt },
  }).catch(err => console.error('[Agents] metrics persist error:', err.message));
}

// ─── Seed data (migrated from hardcoded registry) ─────────────────────────────

const SEED_AGENTS = [
  { id: 'clothing_agent_1', name: 'Hamza Tariq',   category: 'clothing', skills: ['sizing_help','fashion_recommendations','returns_exchanges'], maxConcurrentConversations: 3 },
  { id: 'clothing_agent_2', name: 'Nida Awan',     category: 'clothing', skills: ['product_inquiries','order_assistance','returns_exchanges'], maxConcurrentConversations: 3 },
  { id: 'tech_agent_1',     name: 'Hafiz',         category: 'tech',     skills: ['device_troubleshooting','technical_support','product_specs'], maxConcurrentConversations: 2 },
  { id: 'tech_agent_2',     name: 'Haroon',        category: 'tech',     skills: ['setup_guidance','warranty_inquiries','technical_support'], maxConcurrentConversations: 2 },
  { id: 'G1',               name: 'Faisal Beg',    category: 'general',  skills: ['general_support'], maxConcurrentConversations: 5 },
];

export const AGENT_STATES = {
  AVAILABLE: "available",
  BUSY:      "busy",
  COOLDOWN:  "cooldown",
  OFFLINE:   "offline",
  FAILED:    "failed",
};

const COOLDOWN_MS = 2 * 60 * 1000;

// ─── Category Registry ────────────────────────────────────────────────────────
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

// ─── Seed agents into DB on startup ───────────────────────────────────────────

export async function initAgents() {
  for (const a of SEED_AGENTS) {
    await db.execute({
      sql: `INSERT INTO agents (id, name, category, skills, max_concurrent_conversations, created_at)
            VALUES (@id, @name, @category, @skills, @max, @created)
            ON CONFLICT(id) DO NOTHING`,
      args: {
        id: a.id, name: a.name, category: a.category,
        skills: JSON.stringify(a.skills), max: a.maxConcurrentConversations,
        created: Date.now(),
      },
    });
    // Ensure runtime row exists
    await db.execute({
      sql: `INSERT INTO agent_runtime (agent_id, status, active_conversations, updated_at)
            VALUES (@id, 'available', 0, @now)
            ON CONFLICT(agent_id) DO NOTHING`,
      args: { id: a.id, now: Date.now() },
    });
  }
  console.log('[Agents] Seeded into DB');
}

// ─── Restore persisted metrics on startup ────────────────────────────────────

export async function initAgentMetrics() {
  const result = await db.execute('SELECT * FROM agent_metrics');
  const metricMap = new Map(result.rows.map(r => [r.agent_id, r]));
  // Restore chat counts into agent_runtime as well for consistency
  for (const [agentId, m] of metricMap) {
    await db.execute({
      sql: `UPDATE agent_runtime SET chat_count = @cc, total_response_ms = @tr WHERE agent_id = @id`,
      args: { id: agentId, cc: Number(m.chat_count), tr: Number(m.total_response_ms) },
    }).catch(() => {});
  }
  console.log('[Agents] Metrics restored from DB');
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function _getAgentDef(agentId) {
  const r = await db.execute({ sql: 'SELECT * FROM agents WHERE id = ?', args: [agentId] });
  return r.rows[0] ?? null;
}

async function _getRuntime(agentId) {
  const r = await db.execute({ sql: 'SELECT * FROM agent_runtime WHERE agent_id = ?', args: [agentId] });
  return r.rows[0] ?? null;
}

async function _setRuntime(agentId, patch) {
  const sets = [];
  const args = { id: agentId, now: Date.now() };
  for (const [k, v] of Object.entries(patch)) {
    sets.push(`${k} = @${k}`);
    args[k] = v;
  }
  if (sets.length === 0) return;
  sets.push('updated_at = @now');
  await db.execute({
    sql: `UPDATE agent_runtime SET ${sets.join(', ')} WHERE agent_id = @id`,
    args,
  });
}

async function _allAgentsWithRuntime() {
  const r = await db.execute(`
    SELECT a.*, r.status, r.active_conversations, r.current_chat_start, r.cooldown_until, r.last_active_at, r.chat_count, r.total_response_ms
    FROM agents a
    LEFT JOIN agent_runtime r ON a.id = r.agent_id
    ORDER BY a.category, a.id
  `);
  return r.rows;
}

function _categoryOf(agentId) {
  const m = agentId.match(/^([^_]+)/);
  return m ? m[1] : 'general';
}

// ─── Cooldown checker (replaces setTimeout) ───────────────────────────────────

async function _resolveCooldowns() {
  const now = Date.now();
  const r = await db.execute({
    sql: `SELECT agent_id FROM agent_runtime WHERE status = 'cooldown' AND cooldown_until <= ?`,
    args: [now],
  });
  for (const row of r.rows) {
    await _setRuntime(row.agent_id, { status: AGENT_STATES.AVAILABLE, cooldown_until: null });
    logEvent({ type: 'agent_cooldown_done', agentId: row.agent_id, category: _categoryOf(row.agent_id) });
    console.log(`[Agents] ${row.agent_id} cooldown ended — available`);
  }
}

// ─── findAvailableAgent — load-balanced ───────────────────────────────────────

export async function findAvailableAgent(category) {
  await _resolveCooldowns();
  const now = Date.now();

  const rows = await _allAgentsWithRuntime();

  const canAccept = (a) =>
    a.status !== AGENT_STATES.OFFLINE &&
    a.status !== AGENT_STATES.FAILED &&
    a.status !== AGENT_STATES.COOLDOWN &&
    (a.active_conversations ?? 0) < (a.max_concurrent_conversations ?? 1);

  const leastLoaded = (pool) =>
    pool
      .filter(canAccept)
      .sort((a, b) => ((a.active_conversations ?? 0) / (a.max_concurrent_conversations ?? 1)) -
                      ((b.active_conversations ?? 0) / (b.max_concurrent_conversations ?? 1)))[0] || null;

  const byCat = (cat) => rows.filter(r => r.category === cat);

  const pool = byCat(category).length ? byCat(category) : byCat('general');
  const agent = leastLoaded(pool);
  if (agent) return _toAgentObj(agent);

  // Fallback: general pool
  if (category !== 'general') {
    const gen = leastLoaded(byCat('general'));
    if (gen) return _toAgentObj(gen);
  }

  // Last resort: any agent across all categories
  return leastLoaded(rows) ? _toAgentObj(leastLoaded(rows)) : null;
}

function _toAgentObj(row) {
  return {
    id:                       row.id,
    name:                     row.name,
    category:                 row.category,
    status:                   row.status,
    skills:                   JSON.parse(row.skills || '[]'),
    maxConcurrentConversations: row.max_concurrent_conversations ?? 3,
    activeConversations:      row.active_conversations ?? 0,
    lastActiveAt:             row.last_active_at ? Number(row.last_active_at) : null,
    chatCount:                row.chat_count ? Number(row.chat_count) : 0,
    totalResponseMs:          row.total_response_ms ? Number(row.total_response_ms) : 0,
    currentChatStart:         row.current_chat_start ? Number(row.current_chat_start) : null,
  };
}

// ─── assignConversation ───────────────────────────────────────────────────────

export async function assignConversation(agentId) {
  const def = await _getAgentDef(agentId);
  if (!def) return false;

  const rt = await _getRuntime(agentId);
  if (!rt) return false;

  const active = (rt.active_conversations ?? 0) + 1;
  const status = active >= (def.max_concurrent_conversations ?? 1) ? AGENT_STATES.BUSY : AGENT_STATES.AVAILABLE;
  const chatStart = active === 1 ? Date.now() : (rt.current_chat_start ?? Date.now());

  await _setRuntime(agentId, {
    active_conversations: active,
    status,
    current_chat_start: chatStart,
    last_active_at: Date.now(),
    cooldown_until: null,
  });

  logEvent({
    type:     'agent_conversation_assigned',
    agentId,
    category: _categoryOf(agentId),
    meta:     { activeConversations: active, max: def.max_concurrent_conversations },
  });

  return true;
}

// ─── releaseConversation ──────────────────────────────────────────────────────

export async function releaseConversation(agentId, opts = {}) {
  const rt = await _getRuntime(agentId);
  if (!rt) return false;

  const def = await _getAgentDef(agentId);
  const max = def?.max_concurrent_conversations ?? 1;

  let chatCount = rt.chat_count ? Number(rt.chat_count) : 0;
  let totalResponseMs = rt.total_response_ms ? Number(rt.total_response_ms) : 0;

  if (rt.current_chat_start) {
    const elapsed = Date.now() - Number(rt.current_chat_start);
    totalResponseMs += elapsed;
    chatCount += 1;
    _persistMetrics(agentId, chatCount, totalResponseMs, Date.now());
    logEvent({
      type:     'agent_chat_complete',
      agentId,
      category: _categoryOf(agentId),
      meta:     { chatCount, responseMs: elapsed, activeConversations: Math.max(0, (rt.active_conversations ?? 1) - 1) },
    });
  }

  const active = Math.max(0, (rt.active_conversations ?? 1) - 1);

  if (active > 0) {
    await _setRuntime(agentId, {
      active_conversations: active,
      status: AGENT_STATES.AVAILABLE,
      current_chat_start: Date.now(),
      chat_count: chatCount,
      total_response_ms: totalResponseMs,
    });
    logEvent({ type: 'agent_conversation_released', agentId, meta: { remaining: active } });
  } else {
    const delay = opts.cooldownMs ?? COOLDOWN_MS;
    await _setRuntime(agentId, {
      active_conversations: 0,
      status: AGENT_STATES.COOLDOWN,
      current_chat_start: null,
      cooldown_until: Date.now() + delay,
      chat_count: chatCount,
      total_response_ms: totalResponseMs,
    });
  }

  return true;
}

// ─── completeChat (alias) ─────────────────────────────────────────────────────

export async function completeChat(agentId) {
  return releaseConversation(agentId);
}

// ─── setAgentStatus ───────────────────────────────────────────────────────────

export async function setAgentStatus(agentId, status, opts = {}) {
  const def = await _getAgentDef(agentId);
  if (!def) return false;

  const patch = { status };

  if (status === AGENT_STATES.AVAILABLE) {
    patch.active_conversations = 0;
    patch.current_chat_start = null;
    patch.cooldown_until = null;
  }

  if (status === AGENT_STATES.COOLDOWN) {
    const delay = opts.cooldownMs ?? COOLDOWN_MS;
    patch.cooldown_until = Date.now() + delay;
  }

  if (status !== AGENT_STATES.COOLDOWN) {
    patch.cooldown_until = null;
  }

  await _setRuntime(agentId, patch);
  return true;
}

// ─── resetAgent ───────────────────────────────────────────────────────────────

export async function resetAgent(agentId) {
  const def = await _getAgentDef(agentId);
  if (!def) return false;
  await _setRuntime(agentId, {
    status: AGENT_STATES.AVAILABLE,
    active_conversations: 0,
    current_chat_start: null,
    cooldown_until: null,
  });
  logEvent({ type: 'agent_reset', agentId });
  return true;
}

// ─── markAgentFailed ─────────────────────────────────────────────────────────

export async function markAgentFailed(agentId) {
  const def = await _getAgentDef(agentId);
  if (!def) return false;
  await _setRuntime(agentId, { status: AGENT_STATES.FAILED, cooldown_until: null });
  logEvent({ type: 'agent_failed', agentId });
  console.warn(`[Agents] Agent ${agentId} marked FAILED`);
  return true;
}

// ─── getAgentById / findAgent ─────────────────────────────────────────────────

export async function getAgentById(agentId) {
  const row = await _getAgentDef(agentId);
  if (!row) return null;
  const rt = await _getRuntime(agentId);
  return _mergeAgent(row, rt);
}

export async function findAgent(agentId) {
  return getAgentById(agentId);
}

function _mergeAgent(def, rt) {
  return {
    id: def.id,
    name: def.name,
    category: def.category,
    skills: JSON.parse(def.skills || '[]'),
    maxConcurrentConversations: def.max_concurrent_conversations ?? 3,
    status: rt?.status ?? AGENT_STATES.AVAILABLE,
    activeConversations: rt?.active_conversations ?? 0,
    lastActiveAt: rt?.last_active_at ? Number(rt.last_active_at) : null,
    chatCount: rt?.chat_count ? Number(rt.chat_count) : 0,
    totalResponseMs: rt?.total_response_ms ? Number(rt.total_response_ms) : 0,
    currentChatStart: rt?.current_chat_start ? Number(rt.current_chat_start) : null,
  };
}

// ─── getAvailabilitySnapshot ─────────────────────────────────────────────────

export async function getAvailabilitySnapshot() {
  const rows = await _allAgentsWithRuntime();
  const snap = {};
  for (const row of rows) {
    const cat = row.category;
    if (!snap[cat]) snap[cat] = [];
    snap[cat].push({
      id: row.id,
      name: row.name,
      status: row.status ?? AGENT_STATES.AVAILABLE,
      chatCount: row.chat_count ? Number(row.chat_count) : 0,
      skills: JSON.parse(row.skills || '[]'),
      maxConcurrentConversations: row.max_concurrent_conversations ?? 3,
      activeConversations: row.active_conversations ?? 0,
      lastActiveAt: row.last_active_at ? Number(row.last_active_at) : null,
    });
  }
  return snap;
}

// ─── getCategorySnapshot ─────────────────────────────────────────────────────

export async function getCategorySnapshot() {
  const rows = await _allAgentsWithRuntime();
  const stats = {};
  for (const row of rows) {
    const cat = row.category;
    if (!stats[cat]) stats[cat] = { count: 0, available: 0 };
    stats[cat].count++;
    if ((row.status ?? AGENT_STATES.AVAILABLE) === AGENT_STATES.AVAILABLE || (row.active_conversations ?? 0) < (row.max_concurrent_conversations ?? 1)) {
      stats[cat].available++;
    }
  }
  return Object.entries(categoryRegistry).map(([key, cat]) => ({
    ...cat,
    agentCount:     stats[key]?.count ?? 0,
    availableCount: stats[key]?.available ?? 0,
  }));
}

// ─── createAgent — dynamic agent provisioning ─────────────────────────────────

export async function createAgent({ name, category, skills = ['general_support'], maxConcurrentConversations = 3, phone = '' }) {
  if (!categoryRegistry[category]) categoryRegistry[category] = { id: category, name: category, description: '', skills: [] };
  const id = `${category}_dyn_${Date.now()}`;
  const now = Date.now();
  await db.execute({
    sql: `INSERT INTO agents (id, name, category, skills, max_concurrent_conversations, phone, created_at)
          VALUES (@id, @name, @category, @skills, @max, @phone, @created)`,
    args: { id, name, category, skills: JSON.stringify(skills), max: maxConcurrentConversations, phone, created: now },
  });
  await db.execute({
    sql: `INSERT INTO agent_runtime (agent_id, status, active_conversations, updated_at)
          VALUES (@id, 'available', 0, @now)`,
    args: { id, now },
  });
  logEvent({ type: 'agent_created', agentId: id, category, meta: { name } });
  return _mergeAgent(
    { id, name, category, skills: JSON.stringify(skills), max_concurrent_conversations: maxConcurrentConversations },
    { status: AGENT_STATES.AVAILABLE, active_conversations: 0 }
  );
}

// ─── removeAgent ─────────────────────────────────────────────────────────────

export async function removeAgent(agentId) {
  await db.execute({ sql: 'DELETE FROM agent_metrics WHERE agent_id = ?', args: [agentId] });
  await db.execute({ sql: 'DELETE FROM agent_runtime WHERE agent_id = ?', args: [agentId] });
  const r = await db.execute({ sql: 'DELETE FROM agents WHERE id = ?', args: [agentId] });
  if (r.rowsAffected > 0) {
    logEvent({ type: 'agent_removed', agentId });
    return true;
  }
  return false;
}

// ─── getAgentMetrics ─────────────────────────────────────────────────────────

export async function getAgentMetrics() {
  const rows = await _allAgentsWithRuntime();
  return rows.map((a) => ({
    id:                       a.id,
    name:                     a.name,
    category:                 a.category,
    status:                   a.status ?? AGENT_STATES.AVAILABLE,
    skills:                   JSON.parse(a.skills || '[]'),
    maxConcurrentConversations: a.max_concurrent_conversations ?? 3,
    activeConversations:      a.active_conversations ?? 0,
    currentLoad:              `${a.active_conversations ?? 0}/${a.max_concurrent_conversations ?? 1}`,
    loadPct:                  Math.round(((a.active_conversations ?? 0) / (a.max_concurrent_conversations ?? 1)) * 100),
    chatCount:                a.chat_count ? Number(a.chat_count) : 0,
    lastActiveAt:             a.last_active_at ? Number(a.last_active_at) : null,
    avgResponseMs:            (a.chat_count ? Number(a.chat_count) : 0) > 0
      ? Math.round((a.total_response_ms ? Number(a.total_response_ms) : 0) / (a.chat_count ? Number(a.chat_count) : 1))
      : null,
  }));
}
