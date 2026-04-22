/**
 * db.js
 * LibSQL (Turso) database client.
 * Replaces better-sqlite3 with an async-first, Vercel-compatible driver.
 *
 * Env vars required in production:
 *   TURSO_DATABASE_URL  — e.g. libsql://your-db.turso.io
 *   TURSO_AUTH_TOKEN    — Turso auth token
 *
 * Local dev fallback:
 *   If TURSO_DATABASE_URL is unset, falls back to a local file DB.
 */

import { createClient } from "@libsql/client";

if (!process.env.TURSO_DATABASE_URL) {
  console.warn("[DB] TURSO_DATABASE_URL not set — using local file DB (data/support.db)");
}

// On Vercel the project root is read-only; /tmp is the only writable path.
const _localPath = process.env.VERCEL ? "/tmp/support.db" : "data/support.db";

export const db = createClient({
  url:       process.env.TURSO_DATABASE_URL || `file:${_localPath}`,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

/**
 * initDb — create all tables/indexes if they don't exist.
 * Called once at server startup before any requests are served.
 */
export async function initDb() {
  // Pragmas are no-ops on hosted Turso (WAL is always on), helpful locally.
  await db.execute("PRAGMA journal_mode = WAL").catch(() => {});
  await db.execute("PRAGMA foreign_keys = ON").catch(() => {});

  const ddl = [
    // ── Conversation history ──────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS messages (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      phone   TEXT    NOT NULL,
      role    TEXT    NOT NULL,
      content TEXT    NOT NULL,
      ts      INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_msg_phone ON messages(phone, ts)`,

    // ── Customer state machine ────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS conversation_states (
      phone TEXT PRIMARY KEY,
      state TEXT NOT NULL DEFAULT 'new'
    )`,

    // ── Session metadata ──────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS session_meta (
      phone            TEXT    PRIMARY KEY,
      first_message_at INTEGER NOT NULL,
      last_message_at  INTEGER NOT NULL,
      message_count    INTEGER DEFAULT 0,
      intent_history   TEXT    DEFAULT '[]',
      category         TEXT,
      sentiment        TEXT
    )`,

    // ── Customer contacts ─────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS contacts (
      phone     TEXT    PRIMARY KEY,
      name      TEXT,
      last_seen INTEGER
    )`,

    // ── Active agent ↔ customer assignments ──────────────────────────────────
    `CREATE TABLE IF NOT EXISTS active_chats (
      customer_phone TEXT    PRIMARY KEY,
      agent_id       TEXT    NOT NULL,
      agent_name     TEXT,
      assigned_at    INTEGER NOT NULL
    )`,

    // ── Waiting queue ─────────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS queue (
      phone            TEXT    PRIMARY KEY,
      name             TEXT,
      category         TEXT,
      enqueued_at      INTEGER NOT NULL,
      priority         INTEGER DEFAULT 0,
      retry_count      INTEGER DEFAULT 0,
      ai_fallback_sent INTEGER DEFAULT 0
    )`,

    // ── Satisfaction ratings ──────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS ratings (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      phone      TEXT    NOT NULL,
      name       TEXT,
      score      INTEGER,
      created_at TEXT
    )`,

    // ── Support sessions (escalation lifecycle) ───────────────────────────────
    `CREATE TABLE IF NOT EXISTS support_sessions (
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
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_phone ON support_sessions(customer_phone)`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_state ON support_sessions(state)`,

    // ── Agent lifetime metrics ─────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS agent_metrics (
      agent_id          TEXT    PRIMARY KEY,
      chat_count        INTEGER DEFAULT 0,
      total_response_ms INTEGER DEFAULT 0,
      last_active_at    INTEGER
    )`,

    // ── Users (agents + admins) ───────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS users (
      id            TEXT    PRIMARY KEY,
      username      TEXT    NOT NULL UNIQUE,
      password_hash TEXT    NOT NULL,
      role          TEXT    NOT NULL DEFAULT 'agent',
      agent_id      TEXT,
      enabled       INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT    NOT NULL
    )`,
  ];

  for (const sql of ddl) {
    await db.execute(sql);
  }

  console.log("[DB] Schema ready");
}

export default db;
