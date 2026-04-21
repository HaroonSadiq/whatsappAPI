/**
 * session.js
 * Async session store backed by LibSQL (Turso).
 *
 * All exported functions are async — await them at call sites.
 * followUpTimers remain in-memory (setTimeout handles cannot be serialised).
 */

import { db } from './db.js';

const MAX_HISTORY = 20;

// ─── Conversation history ─────────────────────────────────────────────────────

export async function getHistory(phone) {
  const result = await db.execute({
    sql: 'SELECT role, content, ts FROM messages WHERE phone = ? ORDER BY ts DESC LIMIT ?',
    args: [phone, MAX_HISTORY],
  });
  return result.rows.slice().reverse().map(r => ({ role: r.role, content: r.content, ts: Number(r.ts) }));
}

export async function addToHistory(phone, role, content) {
  await db.execute({
    sql: 'INSERT INTO messages (phone, role, content, ts) VALUES (?, ?, ?, ?)',
    args: [phone, role, content, Date.now()],
  });
}

export async function clearSession(phone) {
  await db.execute({ sql: 'DELETE FROM messages             WHERE phone = ?', args: [phone] });
  await db.execute({ sql: 'DELETE FROM conversation_states  WHERE phone = ?', args: [phone] });
  await db.execute({ sql: 'DELETE FROM contacts             WHERE phone = ?', args: [phone] });
  await db.execute({ sql: 'DELETE FROM session_meta         WHERE phone = ?', args: [phone] });
  // active_chats cleared separately via releaseAssignment
}

// ─── Conversation states ──────────────────────────────────────────────────────

export async function getState(phone) {
  const result = await db.execute({
    sql: 'SELECT state FROM conversation_states WHERE phone = ?',
    args: [phone],
  });
  return result.rows[0]?.state ?? 'new';
}

export async function setState(phone, state) {
  await db.execute({
    sql: 'INSERT INTO conversation_states (phone, state) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET state = excluded.state',
    args: [phone, state],
  });
}

// ─── Session metadata ─────────────────────────────────────────────────────────

export async function getSessionMeta(phone) {
  const result = await db.execute({
    sql: 'SELECT * FROM session_meta WHERE phone = ?',
    args: [phone],
  });
  const row = result.rows[0];
  if (!row) return {};
  return {
    firstMessageAt: Number(row.first_message_at),
    lastMessageAt:  Number(row.last_message_at),
    messageCount:   Number(row.message_count),
    intentHistory:  JSON.parse(row.intent_history || '[]'),
    category:       row.category,
    sentiment:      row.sentiment,
  };
}

export async function updateSessionMeta(phone, fields) {
  const existingResult = await db.execute({
    sql: 'SELECT * FROM session_meta WHERE phone = ?',
    args: [phone],
  });
  const existing = existingResult.rows[0] ?? null;
  const now = Date.now();

  const intentHistory = (() => {
    const prev = JSON.parse(existing?.intent_history || '[]');
    if (fields.intent) {
      return [...prev, { intent: fields.intent, ts: now }].slice(-10);
    }
    return prev;
  })();

  await db.execute({
    sql: `INSERT INTO session_meta
            (phone, first_message_at, last_message_at, message_count, intent_history, category, sentiment)
          VALUES
            (@phone, @first_message_at, @last_message_at, @message_count, @intent_history, @category, @sentiment)
          ON CONFLICT(phone) DO UPDATE SET
            last_message_at  = excluded.last_message_at,
            message_count    = excluded.message_count,
            intent_history   = excluded.intent_history,
            category         = COALESCE(excluded.category,  session_meta.category),
            sentiment        = COALESCE(excluded.sentiment, session_meta.sentiment)`,
    args: {
      phone,
      first_message_at: existing?.first_message_at ?? now,
      last_message_at:  now,
      message_count:    fields.messageCount !== undefined
        ? fields.messageCount
        : (Number(existing?.message_count ?? 0) + 1),
      intent_history: JSON.stringify(intentHistory),
      category:  fields.category  ?? null,
      sentiment: fields.sentiment ?? null,
    },
  });

  return getSessionMeta(phone);
}

// ─── Contact info ─────────────────────────────────────────────────────────────

export async function getContact(phone) {
  const result = await db.execute({
    sql: 'SELECT * FROM contacts WHERE phone = ?',
    args: [phone],
  });
  return result.rows[0] ?? { phone };
}

export async function updateContact(phone, fields) {
  await db.execute({
    sql: `INSERT INTO contacts (phone, name, last_seen) VALUES (@phone, @name, @last_seen)
          ON CONFLICT(phone) DO UPDATE SET
            name      = COALESCE(excluded.name, contacts.name),
            last_seen = excluded.last_seen`,
    args: { phone, name: fields.name ?? null, last_seen: Date.now() },
  });
}

// ─── Active agent assignments ─────────────────────────────────────────────────

export async function assignAgent(customerPhone, agent) {
  await db.execute({
    sql: `INSERT INTO active_chats (customer_phone, agent_id, agent_name, assigned_at)
          VALUES (@customer_phone, @agent_id, @agent_name, @assigned_at)
          ON CONFLICT(customer_phone) DO UPDATE SET
            agent_id    = excluded.agent_id,
            agent_name  = excluded.agent_name,
            assigned_at = excluded.assigned_at`,
    args: {
      customer_phone: customerPhone,
      agent_id:       agent.id,
      agent_name:     agent.name,
      assigned_at:    Date.now(),
    },
  });
}

export async function getAssignment(customerPhone) {
  const result = await db.execute({
    sql: 'SELECT * FROM active_chats WHERE customer_phone = ?',
    args: [customerPhone],
  });
  const row = result.rows[0];
  if (!row) return null;
  return {
    agentId:    row.agent_id,
    agentName:  row.agent_name,
    assignedAt: Number(row.assigned_at),
  };
}

export async function releaseAssignment(customerPhone) {
  await db.execute({
    sql: 'DELETE FROM active_chats WHERE customer_phone = ?',
    args: [customerPhone],
  });
}

export async function getActiveChats() {
  const result = await db.execute('SELECT * FROM active_chats');
  return result.rows.map(row => ({
    phone:      row.customer_phone,
    agentId:    row.agent_id,
    agentName:  row.agent_name,
    assignedAt: Number(row.assigned_at),
  }));
}

// ─── Customer queue ───────────────────────────────────────────────────────────

export async function enqueue(phone, name, category, opts = {}) {
  await db.execute({
    sql: `INSERT OR IGNORE INTO queue (phone, name, category, enqueued_at, priority, retry_count)
          VALUES (@phone, @name, @category, @enqueued_at, @priority, @retry_count)`,
    args: {
      phone,
      name,
      category,
      enqueued_at: Date.now(),
      priority:    opts.priority   ?? 0,
      retry_count: opts.retryCount ?? 0,
    },
  });
}

export async function dequeue(phone) {
  await db.execute({ sql: 'DELETE FROM queue WHERE phone = ?', args: [phone] });
}

export async function nextInQueue(category) {
  const result = await db.execute({
    sql: `SELECT * FROM queue
          WHERE category = ? OR category = 'general'
          ORDER BY priority DESC, enqueued_at ASC
          LIMIT 1`,
    args: [category],
  });
  const row = result.rows[0];
  if (!row) return null;
  await db.execute({ sql: 'DELETE FROM queue WHERE phone = ?', args: [row.phone] });
  return _rowToQueueEntry(row);
}

export async function getQueue() {
  const result = await db.execute(
    'SELECT * FROM queue ORDER BY priority DESC, enqueued_at ASC'
  );
  return result.rows.map(_rowToQueueEntry);
}

export async function updateQueueEntry(phone, fields) {
  if (fields._aiFallbackSent) {
    await db.execute({ sql: 'UPDATE queue SET ai_fallback_sent = 1 WHERE phone = ?', args: [phone] });
  }
}

function _rowToQueueEntry(row) {
  return {
    phone:           row.phone,
    name:            row.name,
    category:        row.category,
    enqueuedAt:      Number(row.enqueued_at),
    priority:        Number(row.priority),
    retryCount:      Number(row.retry_count),
    _aiFallbackSent: Number(row.ai_fallback_sent) === 1,
  };
}

// ─── Ratings ──────────────────────────────────────────────────────────────────

export async function saveRating(phone, name, score) {
  await db.execute({
    sql: 'INSERT INTO ratings (phone, name, score, created_at) VALUES (?, ?, ?, ?)',
    args: [phone, name, score, new Date().toISOString()],
  });
}

export async function getRatings() {
  const result = await db.execute('SELECT * FROM ratings ORDER BY id ASC');
  return result.rows.map(r => ({
    phone:     r.phone,
    name:      r.name,
    score:     Number(r.score),
    createdAt: r.created_at,
  }));
}

// ─── Follow-up timers (in-memory only — setTimeout handles) ──────────────────

const followUpTimers = new Map();

export function setFollowUpTimer(phone, timerId) {
  followUpTimers.set(phone, timerId);
}

export function clearFollowUpTimer(phone) {
  const id = followUpTimers.get(phone);
  if (id) { clearTimeout(id); followUpTimers.delete(phone); }
}
