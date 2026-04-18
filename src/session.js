/**
 * session.js
 * Persistent session store backed by SQLite.
 *
 * All state survives server restarts except:
 *  - followUpTimers  (setTimeout handles — cannot be serialised)
 *  - cooldownTimers  (same — live in agents.js)
 */

import { db } from './db.js';

const MAX_HISTORY = 20;

// ─── Prepared statements ──────────────────────────────────────────────────────

const stmts = {
  // messages
  insertMsg:    db.prepare('INSERT INTO messages (phone, role, content, ts) VALUES (?, ?, ?, ?)'),
  selectMsgs:   db.prepare('SELECT role, content, ts FROM messages WHERE phone = ? ORDER BY ts DESC LIMIT ?'),
  deleteMsgs:   db.prepare('DELETE FROM messages WHERE phone = ?'),

  // states
  getState:     db.prepare('SELECT state FROM conversation_states WHERE phone = ?'),
  upsertState:  db.prepare('INSERT INTO conversation_states (phone, state) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET state = excluded.state'),
  deleteState:  db.prepare('DELETE FROM conversation_states WHERE phone = ?'),

  // session meta
  getMeta:      db.prepare('SELECT * FROM session_meta WHERE phone = ?'),
  upsertMeta:   db.prepare(`
    INSERT INTO session_meta (phone, first_message_at, last_message_at, message_count, intent_history, category, sentiment)
    VALUES (@phone, @first_message_at, @last_message_at, @message_count, @intent_history, @category, @sentiment)
    ON CONFLICT(phone) DO UPDATE SET
      last_message_at  = excluded.last_message_at,
      message_count    = excluded.message_count,
      intent_history   = excluded.intent_history,
      category         = COALESCE(excluded.category, session_meta.category),
      sentiment        = COALESCE(excluded.sentiment, session_meta.sentiment)
  `),
  deleteMeta:   db.prepare('DELETE FROM session_meta WHERE phone = ?'),

  // contacts
  getContact:    db.prepare('SELECT * FROM contacts WHERE phone = ?'),
  upsertContact: db.prepare(`
    INSERT INTO contacts (phone, name, last_seen) VALUES (@phone, @name, @last_seen)
    ON CONFLICT(phone) DO UPDATE SET
      name      = COALESCE(excluded.name, contacts.name),
      last_seen = excluded.last_seen
  `),
  deleteContact: db.prepare('DELETE FROM contacts WHERE phone = ?'),

  // active chats
  getChat:       db.prepare('SELECT * FROM active_chats WHERE customer_phone = ?'),
  upsertChat:    db.prepare(`
    INSERT INTO active_chats (customer_phone, agent_id, agent_name, assigned_at)
    VALUES (@customer_phone, @agent_id, @agent_name, @assigned_at)
    ON CONFLICT(customer_phone) DO UPDATE SET
      agent_id    = excluded.agent_id,
      agent_name  = excluded.agent_name,
      assigned_at = excluded.assigned_at
  `),
  deleteChat:    db.prepare('DELETE FROM active_chats WHERE customer_phone = ?'),
  allChats:      db.prepare('SELECT * FROM active_chats'),

  // queue
  insertQueue:   db.prepare(`
    INSERT OR IGNORE INTO queue (phone, name, category, enqueued_at, priority, retry_count)
    VALUES (@phone, @name, @category, @enqueued_at, @priority, @retry_count)
  `),
  deleteQueue:   db.prepare('DELETE FROM queue WHERE phone = ?'),
  allQueue:      db.prepare('SELECT * FROM queue ORDER BY priority DESC, enqueued_at ASC'),
  updateFallback: db.prepare('UPDATE queue SET ai_fallback_sent = 1 WHERE phone = ?'),
  nextQueue:     db.prepare(`
    SELECT * FROM queue
    WHERE category = ? OR category = 'general'
    ORDER BY priority DESC, enqueued_at ASC
    LIMIT 1
  `),

  // ratings
  insertRating: db.prepare('INSERT INTO ratings (phone, name, score, created_at) VALUES (?, ?, ?, ?)'),
  allRatings:   db.prepare('SELECT * FROM ratings ORDER BY id ASC'),
};

// ─── Conversation history ─────────────────────────────────────────────────────

export function getHistory(phone) {
  const rows = stmts.selectMsgs.all(phone, MAX_HISTORY);
  return rows.reverse().map(r => ({ role: r.role, content: r.content, ts: r.ts }));
}

export function addToHistory(phone, role, content) {
  stmts.insertMsg.run(phone, role, content, Date.now());
}

export function clearSession(phone) {
  stmts.deleteMsgs.run(phone);
  stmts.deleteState.run(phone);
  stmts.deleteContact.run(phone);
  stmts.deleteMeta.run(phone);
  // active_chats cleared separately via releaseAssignment
}

// ─── Conversation states ──────────────────────────────────────────────────────

export function getState(phone) {
  return stmts.getState.get(phone)?.state ?? 'new';
}

export function setState(phone, state) {
  stmts.upsertState.run(phone, state);
}

// ─── Session metadata ─────────────────────────────────────────────────────────

export function getSessionMeta(phone) {
  const row = stmts.getMeta.get(phone);
  if (!row) return {};
  return {
    firstMessageAt: row.first_message_at,
    lastMessageAt:  row.last_message_at,
    messageCount:   row.message_count,
    intentHistory:  JSON.parse(row.intent_history || '[]'),
    category:       row.category,
    sentiment:      row.sentiment,
  };
}

export function updateSessionMeta(phone, fields) {
  const existing = stmts.getMeta.get(phone);
  const now      = Date.now();

  const intentHistory = (() => {
    const prev = JSON.parse(existing?.intent_history || '[]');
    if (fields.intent) {
      return [...prev, { intent: fields.intent, ts: now }].slice(-10);
    }
    return prev;
  })();

  stmts.upsertMeta.run({
    phone,
    first_message_at: existing?.first_message_at ?? now,
    last_message_at:  now,
    message_count:    fields.messageCount !== undefined
      ? fields.messageCount
      : (existing?.message_count ?? 0) + 1,
    intent_history: JSON.stringify(intentHistory),
    category:  fields.category  ?? null,
    sentiment: fields.sentiment ?? null,
  });

  return getSessionMeta(phone);
}

// ─── Contact info ─────────────────────────────────────────────────────────────

export function getContact(phone) {
  return stmts.getContact.get(phone) ?? { phone };
}

export function updateContact(phone, fields) {
  stmts.upsertContact.run({
    phone,
    name:      fields.name ?? null,
    last_seen: Date.now(),
  });
}

// ─── Active agent assignments ─────────────────────────────────────────────────

export function assignAgent(customerPhone, agent) {
  stmts.upsertChat.run({
    customer_phone: customerPhone,
    agent_id:       agent.id,
    agent_name:     agent.name,
    assigned_at:    Date.now(),
  });
}

export function getAssignment(customerPhone) {
  const row = stmts.getChat.get(customerPhone);
  if (!row) return null;
  return {
    agentId:    row.agent_id,
    agentName:  row.agent_name,
    assignedAt: row.assigned_at,
  };
}

export function releaseAssignment(customerPhone) {
  stmts.deleteChat.run(customerPhone);
}

export function getActiveChats() {
  return stmts.allChats.all().map(row => ({
    phone:      row.customer_phone,
    agentId:    row.agent_id,
    agentName:  row.agent_name,
    assignedAt: row.assigned_at,
  }));
}

// ─── Customer queue ───────────────────────────────────────────────────────────

export function enqueue(phone, name, category, opts = {}) {
  stmts.insertQueue.run({
    phone,
    name,
    category,
    enqueued_at: Date.now(),
    priority:    opts.priority   ?? 0,
    retry_count: opts.retryCount ?? 0,
  });
}

export function dequeue(phone) {
  stmts.deleteQueue.run(phone);
}

export function nextInQueue(category) {
  const row = stmts.nextQueue.get(category);
  if (!row) return null;
  stmts.deleteQueue.run(row.phone);
  return _rowToQueueEntry(row);
}

export function getQueue() {
  return stmts.allQueue.all().map(_rowToQueueEntry);
}

export function updateQueueEntry(phone, fields) {
  if (fields._aiFallbackSent) {
    stmts.updateFallback.run(phone);
  }
}

function _rowToQueueEntry(row) {
  return {
    phone:          row.phone,
    name:           row.name,
    category:       row.category,
    enqueuedAt:     row.enqueued_at,
    priority:       row.priority,
    retryCount:     row.retry_count,
    _aiFallbackSent: row.ai_fallback_sent === 1,
  };
}

// ─── Ratings ──────────────────────────────────────────────────────────────────

export function saveRating(phone, name, score) {
  stmts.insertRating.run(phone, name, score, new Date().toISOString());
}

export function getRatings() {
  return stmts.allRatings.all().map(r => ({
    phone:     r.phone,
    name:      r.name,
    score:     r.score,
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
