import bcrypt      from 'bcryptjs';
import { randomUUID } from 'crypto';
import { db }       from '../db.js';

/**
 * SQLite-backed user store.
 * Schema: { id, username, passwordHash, role: 'admin'|'agent', agentId, enabled, createdAt }
 *
 * Seeded with one admin account (admin / admin123) on first run.
 */

// Seed default admin if the table is empty
const existing = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
if (!existing) {
  db.prepare(`
    INSERT INTO users (id, username, password_hash, role, agent_id, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(), 'admin',
    bcrypt.hashSync('admin123', 10),
    'admin', null, 1, new Date().toISOString(),
  );
}

// ─── Row mapper ───────────────────────────────────────────────────────────────
function toUser(row) {
  if (!row) return null;
  return {
    id:           row.id,
    username:     row.username,
    passwordHash: row.password_hash,
    role:         row.role,
    agentId:      row.agent_id,
    enabled:      row.enabled === 1,
    createdAt:    row.created_at,
  };
}

// ─── Queries ──────────────────────────────────────────────────────────────────
export function findByUsername(username) {
  return toUser(db.prepare('SELECT * FROM users WHERE username = ?').get(username));
}

export function findById(id) {
  return toUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
}

export function getAllUsers() {
  return db.prepare('SELECT * FROM users').all().map(toUser).map(sanitize);
}

// ─── Mutations ────────────────────────────────────────────────────────────────
export function createUser({ username, password, role, agentId = null }) {
  if (findByUsername(username)) throw new Error('Username already exists');
  const id = randomUUID();
  db.prepare(`
    INSERT INTO users (id, username, password_hash, role, agent_id, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, username, bcrypt.hashSync(password, 10), role, agentId, 1, new Date().toISOString());
  return sanitize(findById(id));
}

export function updateUser(id, updates) {
  if (!findById(id)) return null;
  if (updates.password !== undefined) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
      .run(bcrypt.hashSync(updates.password, 10), id);
  }
  if (updates.enabled !== undefined) {
    db.prepare('UPDATE users SET enabled = ? WHERE id = ?')
      .run(updates.enabled ? 1 : 0, id);
  }
  if (updates.role !== undefined) {
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(updates.role, id);
  }
  if (updates.agentId !== undefined) {
    db.prepare('UPDATE users SET agent_id = ? WHERE id = ?').run(updates.agentId, id);
  }
  return sanitize(findById(id));
}

export function deleteUser(id) {
  return db.prepare('DELETE FROM users WHERE id = ?').run(id).changes > 0;
}

export function verifyPassword(user, password) {
  return bcrypt.compareSync(password, user.passwordHash);
}

function sanitize({ passwordHash, ...rest }) {
  return rest;
}
