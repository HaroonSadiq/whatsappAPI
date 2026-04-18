/**
 * db.js
 * SQLite database — single source of truth for all persistent state.
 *
 * Tables:
 *  messages             — per-customer conversation history
 *  conversation_states  — customer state machine (new/active/escalated/…)
 *  session_meta         — intent history, message counts, timing
 *  contacts             — customer name / last-seen
 *  active_chats         — current agent assignments
 *  queue                — customers waiting for an agent
 *  ratings              — satisfaction scores
 *  support_sessions     — escalation sessions (waiting → active → closed)
 *  agent_metrics        — chat counts and response times (survives restarts)
 */

import Database  from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = join(__dirname, '../data');

mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(join(DATA_DIR, 'support.db'));

// WAL mode: faster writes, non-blocking reads
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  -- ── Conversation history ──────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS messages (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    phone   TEXT    NOT NULL,
    role    TEXT    NOT NULL,
    content TEXT    NOT NULL,
    ts      INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_msg_phone ON messages(phone, ts);

  -- ── Customer state machine ────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS conversation_states (
    phone TEXT PRIMARY KEY,
    state TEXT NOT NULL DEFAULT 'new'
  );

  -- ── Session metadata ──────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS session_meta (
    phone            TEXT    PRIMARY KEY,
    first_message_at INTEGER NOT NULL,
    last_message_at  INTEGER NOT NULL,
    message_count    INTEGER DEFAULT 0,
    intent_history   TEXT    DEFAULT '[]',
    category         TEXT,
    sentiment        TEXT
  );

  -- ── Customer contacts ─────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS contacts (
    phone     TEXT    PRIMARY KEY,
    name      TEXT,
    last_seen INTEGER
  );

  -- ── Active agent ↔ customer assignments ──────────────────────────────────
  CREATE TABLE IF NOT EXISTS active_chats (
    customer_phone TEXT    PRIMARY KEY,
    agent_id       TEXT    NOT NULL,
    agent_name     TEXT,
    assigned_at    INTEGER NOT NULL
  );

  -- ── Waiting queue ─────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS queue (
    phone            TEXT    PRIMARY KEY,
    name             TEXT,
    category         TEXT,
    enqueued_at      INTEGER NOT NULL,
    priority         INTEGER DEFAULT 0,
    retry_count      INTEGER DEFAULT 0,
    ai_fallback_sent INTEGER DEFAULT 0
  );

  -- ── Satisfaction ratings ──────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS ratings (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    phone      TEXT    NOT NULL,
    name       TEXT,
    score      INTEGER,
    created_at TEXT
  );

  -- ── Support sessions (escalation lifecycle) ───────────────────────────────
  CREATE TABLE IF NOT EXISTS support_sessions (
    id                 TEXT    PRIMARY KEY,
    customer_phone     TEXT    NOT NULL,
    customer_name      TEXT,
    category           TEXT,
    state              TEXT    DEFAULT 'waiting',
    assigned_agent_id  TEXT,
    agent_id           TEXT,
    agent_name         TEXT,
    ai_suggested_reply TEXT,
    reason             TEXT,
    priority           INTEGER DEFAULT 0,
    created_at         INTEGER NOT NULL,
    assigned_at        INTEGER,
    closed_at          INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_phone ON support_sessions(customer_phone);
  CREATE INDEX IF NOT EXISTS idx_sessions_state ON support_sessions(state);

  -- ── Agent lifetime metrics ─────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS agent_metrics (
    agent_id          TEXT    PRIMARY KEY,
    chat_count        INTEGER DEFAULT 0,
    total_response_ms INTEGER DEFAULT 0,
    last_active_at    INTEGER
  );
`);

export default db;
