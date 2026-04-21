/**
 * supportSessions.js
 * Async support session store backed by LibSQL (Turso).
 *
 * Session states: waiting → active → closed
 */

import { randomUUID } from 'crypto';
import { db } from './db.js';

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
    priority:         Number(row.priority),
    createdAt:        Number(row.created_at),
    assignedAt:       row.assigned_at ? Number(row.assigned_at) : null,
    closedAt:         row.closed_at   ? Number(row.closed_at)   : null,
  };
}

// ─── Write ────────────────────────────────────────────────────────────────────

export async function createSession({ customerPhone, customerName, category, priority = 0 }) {
  const id = `s_${Date.now()}_${randomUUID().slice(0, 6)}`;
  await db.execute({
    sql: `INSERT INTO support_sessions
            (id, customer_phone, customer_name, category, state,
             assigned_agent_id, agent_id, agent_name,
             ai_suggested_reply, reason, priority, created_at)
          VALUES
            (@id, @customer_phone, @customer_name, @category, 'waiting',
             NULL, NULL, NULL, NULL, NULL, @priority, @created_at)`,
    args: {
      id,
      customer_phone: customerPhone,
      customer_name:  customerName ?? null,
      category:       category ?? null,
      priority,
      created_at:     Date.now(),
    },
  });
  return getSession(id);
}

export async function assignSession(id, agentId) {
  const result = await db.execute({
    sql: `UPDATE support_sessions
          SET state = 'active', agent_id = @agent_id, assigned_at = @assigned_at
          WHERE id = @id AND state = 'waiting'`,
    args: { id, agent_id: agentId, assigned_at: Date.now() },
  });
  if (!result.rowsAffected) return null;
  return getSession(id);
}

export async function closeSession(id) {
  const result = await db.execute({
    sql: `UPDATE support_sessions
          SET state = 'closed', closed_at = @closed_at
          WHERE id = @id AND state != 'closed'`,
    args: { id, closed_at: Date.now() },
  });
  if (!result.rowsAffected) return null;
  return getSession(id);
}

export async function updateSession(id, patch) {
  await db.execute({
    sql: `UPDATE support_sessions SET
            state              = COALESCE(@state,              state),
            assigned_agent_id  = COALESCE(@assigned_agent_id,  assigned_agent_id),
            agent_id           = COALESCE(@agent_id,           agent_id),
            agent_name         = COALESCE(@agent_name,         agent_name),
            ai_suggested_reply = COALESCE(@ai_suggested_reply, ai_suggested_reply),
            reason             = COALESCE(@reason,             reason),
            assigned_at        = COALESCE(@assigned_at,        assigned_at),
            closed_at          = COALESCE(@closed_at,          closed_at)
          WHERE id = @id`,
    args: {
      id,
      state:              patch.state             ?? null,
      assigned_agent_id:  patch.assignedAgentId   ?? null,
      agent_id:           patch.agentId           ?? null,
      agent_name:         patch.agentName         ?? null,
      ai_suggested_reply: patch.aiSuggestedReply  ?? null,
      reason:             patch.reason            ?? null,
      assigned_at:        patch.assignedAt        ?? null,
      closed_at:          patch.closedAt          ?? null,
    },
  });
  return getSession(id);
}

// ─── Read ─────────────────────────────────────────────────────────────────────

export async function getSession(id) {
  const result = await db.execute({
    sql: 'SELECT * FROM support_sessions WHERE id = ?',
    args: [id],
  });
  return rowToSession(result.rows[0] ?? null);
}

export async function getAllSessions() {
  const result = await db.execute(
    'SELECT * FROM support_sessions ORDER BY created_at DESC'
  );
  return result.rows.map(rowToSession);
}

export async function getSessionByPhone(phone) {
  const result = await db.execute({
    sql: `SELECT * FROM support_sessions
          WHERE customer_phone = ? AND state != 'closed'
          ORDER BY created_at DESC LIMIT 1`,
    args: [phone],
  });
  return rowToSession(result.rows[0] ?? null);
}

export async function getWaitingSessions(category) {
  if (category) {
    const result = await db.execute({
      sql: `SELECT * FROM support_sessions
            WHERE state = 'waiting' AND category = ?
            ORDER BY priority DESC, created_at ASC`,
      args: [category],
    });
    return result.rows.map(rowToSession);
  }
  const result = await db.execute(
    `SELECT * FROM support_sessions WHERE state = 'waiting' ORDER BY priority DESC, created_at ASC`
  );
  return result.rows.map(rowToSession);
}

export async function getActiveSessions(agentId) {
  if (agentId) {
    const result = await db.execute({
      sql: `SELECT * FROM support_sessions
            WHERE state = 'active' AND agent_id = ?
            ORDER BY assigned_at ASC`,
      args: [agentId],
    });
    return result.rows.map(rowToSession);
  }
  const result = await db.execute(
    `SELECT * FROM support_sessions WHERE state = 'active' ORDER BY assigned_at ASC`
  );
  return result.rows.map(rowToSession);
}

export async function getSessionsForAgent(agentId) {
  const result = await db.execute({
    sql: `SELECT * FROM support_sessions
          WHERE agent_id = ? AND state != 'closed'
          ORDER BY created_at DESC`,
    args: [agentId],
  });
  return result.rows.map(rowToSession);
}
