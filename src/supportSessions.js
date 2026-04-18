/**
 * supportSessions.js
 * Persistent support session store backed by SQLite.
 *
 * Session states: waiting → active → closed
 *
 * Schema fields:
 *   id                — unique session id
 *   customerPhone     — customer's WhatsApp number
 *   customerName      — display name
 *   category          — routing category (clothing / tech / general)
 *   state             — waiting | active | closed
 *   assignedAgentId   — agent pre-routed by orchestrator (before accept)
 *   agentId           — agent who accepted the session (null until accepted)
 *   agentName         — agent display name
 *   aiSuggestedReply  — AI-generated reply suggestion shown on dashboard
 *   reason            — escalation reason
 *   priority          — 0=normal, 1=frustrated
 *   createdAt         — epoch ms
 *   assignedAt        — epoch ms | null
 *   closedAt          — epoch ms | null
 */

import { randomUUID } from 'crypto';
import { db } from './db.js';

// ─── Prepared statements ──────────────────────────────────────────────────────

const stmts = {
  insert: db.prepare(`
    INSERT INTO support_sessions
      (id, customer_phone, customer_name, category, state,
       assigned_agent_id, agent_id, agent_name,
       ai_suggested_reply, reason, priority, created_at)
    VALUES
      (@id, @customer_phone, @customer_name, @category, @state,
       @assigned_agent_id, @agent_id, @agent_name,
       @ai_suggested_reply, @reason, @priority, @created_at)
  `),

  activate: db.prepare(`
    UPDATE support_sessions
    SET state = 'active', agent_id = @agent_id, assigned_at = @assigned_at
    WHERE id = @id AND state = 'waiting'
  `),

  close: db.prepare(`
    UPDATE support_sessions
    SET state = 'closed', closed_at = @closed_at
    WHERE id = @id AND state != 'closed'
  `),

  update: db.prepare(`
    UPDATE support_sessions
    SET
      state              = COALESCE(@state,              state),
      assigned_agent_id  = COALESCE(@assigned_agent_id,  assigned_agent_id),
      agent_id           = COALESCE(@agent_id,           agent_id),
      agent_name         = COALESCE(@agent_name,         agent_name),
      ai_suggested_reply = COALESCE(@ai_suggested_reply, ai_suggested_reply),
      reason             = COALESCE(@reason,             reason),
      assigned_at        = COALESCE(@assigned_at,        assigned_at),
      closed_at          = COALESCE(@closed_at,          closed_at)
    WHERE id = @id
  `),

  getById:    db.prepare('SELECT * FROM support_sessions WHERE id = ?'),
  getAll:     db.prepare('SELECT * FROM support_sessions ORDER BY created_at DESC'),
  getByPhone: db.prepare(`
    SELECT * FROM support_sessions
    WHERE customer_phone = ? AND state != 'closed'
    ORDER BY created_at DESC
    LIMIT 1
  `),
  getWaiting: db.prepare(`SELECT * FROM support_sessions WHERE state = 'waiting' ORDER BY priority DESC, created_at ASC`),
  getWaitingCat: db.prepare(`SELECT * FROM support_sessions WHERE state = 'waiting' AND category = ? ORDER BY priority DESC, created_at ASC`),
  getActive:     db.prepare(`SELECT * FROM support_sessions WHERE state = 'active' ORDER BY assigned_at ASC`),
  getActiveAgent: db.prepare(`SELECT * FROM support_sessions WHERE state = 'active' AND agent_id = ? ORDER BY assigned_at ASC`),
  getForAgent:    db.prepare(`SELECT * FROM support_sessions WHERE agent_id = ? AND state != 'closed' ORDER BY created_at DESC`),
};

// ─── Row → JS object ──────────────────────────────────────────────────────────

function rowToSession(row) {
  if (!row) return null;
  return {
    id:               row.id,
    customerPhone:    row.customer_phone,
    customerName:     row.customer_name,
    category:         row.category,
    state:            row.state,
    assignedAgentId:  row.assigned_agent_id,
    agentId:          row.agent_id,
    agentName:        row.agent_name,
    aiSuggestedReply: row.ai_suggested_reply,
    reason:           row.reason,
    priority:         row.priority,
    createdAt:        row.created_at,
    assignedAt:       row.assigned_at,
    closedAt:         row.closed_at,
  };
}

// ─── Write ────────────────────────────────────────────────────────────────────

export function createSession({ customerPhone, customerName, category, priority = 0 }) {
  const id = `s_${Date.now()}_${randomUUID().slice(0, 6)}`;
  stmts.insert.run({
    id,
    customer_phone:    customerPhone,
    customer_name:     customerName ?? null,
    category:          category ?? null,
    state:             'waiting',
    assigned_agent_id: null,
    agent_id:          null,
    agent_name:        null,
    ai_suggested_reply: null,
    reason:            null,
    priority,
    created_at:        Date.now(),
  });
  return rowToSession(stmts.getById.get(id));
}

export function assignSession(id, agentId) {
  const changes = stmts.activate.run({ id, agent_id: agentId, assigned_at: Date.now() }).changes;
  if (!changes) return null;
  return rowToSession(stmts.getById.get(id));
}

export function closeSession(id) {
  const changes = stmts.close.run({ id, closed_at: Date.now() }).changes;
  if (!changes) return null;
  return rowToSession(stmts.getById.get(id));
}

/**
 * updateSession — persist arbitrary field changes to a session.
 * Used by the orchestrator to attach agentId, aiSuggestedReply, reason, etc.
 *
 * @param {string} id
 * @param {object} patch — camelCase field names
 */
export function updateSession(id, patch) {
  stmts.update.run({
    id,
    state:              patch.state             ?? null,
    assigned_agent_id:  patch.assignedAgentId   ?? null,
    agent_id:           patch.agentId           ?? null,
    agent_name:         patch.agentName         ?? null,
    ai_suggested_reply: patch.aiSuggestedReply  ?? null,
    reason:             patch.reason            ?? null,
    assigned_at:        patch.assignedAt        ?? null,
    closed_at:          patch.closedAt          ?? null,
  });
  return rowToSession(stmts.getById.get(id));
}

// ─── Read ─────────────────────────────────────────────────────────────────────

export function getSession(id)   { return rowToSession(stmts.getById.get(id)); }
export function getAllSessions()  { return stmts.getAll.all().map(rowToSession); }

export function getSessionByPhone(phone) {
  return rowToSession(stmts.getByPhone.get(phone));
}

export function getWaitingSessions(category) {
  if (category) return stmts.getWaitingCat.all(category).map(rowToSession);
  return stmts.getWaiting.all().map(rowToSession);
}

export function getActiveSessions(agentId) {
  if (agentId) return stmts.getActiveAgent.all(agentId).map(rowToSession);
  return stmts.getActive.all().map(rowToSession);
}

export function getSessionsForAgent(agentId) {
  return stmts.getForAgent.all(agentId).map(rowToSession);
}
