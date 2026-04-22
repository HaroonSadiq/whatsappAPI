/**
 * auth/users.js
 * Async user store backed by LibSQL (Turso).
 *
 * Call initUsers() once at startup — it seeds the default admin account
 * (admin / admin123) if the table is empty.
 */

import bcrypt      from 'bcryptjs';
import { randomUUID } from 'crypto';
import { db }      from '../db.js';

// ─── Row mapper ───────────────────────────────────────────────────────────────

function toUser(row) {
  if (!row) return null;
  return {
    id:           row.id,
    username:     row.username,
    passwordHash: row.password_hash,
    role:         row.role,
    agentId:      row.agent_id,
    enabled:      Number(row.enabled) === 1,
    createdAt:    row.created_at,
  };
}

function sanitize({ passwordHash, ...rest }) {
  return rest;
}

// ─── Startup seed ─────────────────────────────────────────────────────────────

// Fixed UUID for the built-in admin account.
// Must be stable across cold starts and serverless instances so that JWTs
// issued by one instance remain valid when a different instance handles the
// next request (Vercel ephemeral /tmp scenario).
const ADMIN_ID = '00000000-admin-0000-0000-000000000001';

/**
 * initUsers — seeds the default admin user if no users exist yet.
 * Must be awaited before the server starts accepting requests.
 */
export async function initUsers() {
  const existing = await findByUsername('admin');
  if (!existing) {
    await db.execute({
      sql: `INSERT INTO users (id, username, password_hash, role, agent_id, enabled, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        ADMIN_ID, 'admin',
        bcrypt.hashSync('admin123', 10),
        'admin', null, 1, new Date().toISOString(),
      ],
    });
    console.log('[Users] Default admin seeded (admin / admin123)');
  }
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export async function findByUsername(username) {
  const result = await db.execute({
    sql: 'SELECT * FROM users WHERE username = ?',
    args: [username],
  });
  return toUser(result.rows[0] ?? null);
}

export async function findById(id) {
  const result = await db.execute({
    sql: 'SELECT * FROM users WHERE id = ?',
    args: [id],
  });
  return toUser(result.rows[0] ?? null);
}

export async function getAllUsers() {
  const result = await db.execute('SELECT * FROM users');
  return result.rows.map(toUser).map(sanitize);
}

// ─── Mutations ────────────────────────────────────────────────────────────────

export async function createUser({ username, password, role, agentId = null }) {
  if (await findByUsername(username)) throw new Error('Username already exists');
  const id = randomUUID();
  await db.execute({
    sql: `INSERT INTO users (id, username, password_hash, role, agent_id, enabled, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [id, username, bcrypt.hashSync(password, 10), role, agentId, 1, new Date().toISOString()],
  });
  return sanitize(await findById(id));
}

export async function updateUser(id, updates) {
  if (!(await findById(id))) return null;
  if (updates.password !== undefined) {
    await db.execute({
      sql: 'UPDATE users SET password_hash = ? WHERE id = ?',
      args: [bcrypt.hashSync(updates.password, 10), id],
    });
  }
  if (updates.enabled !== undefined) {
    await db.execute({
      sql: 'UPDATE users SET enabled = ? WHERE id = ?',
      args: [updates.enabled ? 1 : 0, id],
    });
  }
  if (updates.role !== undefined) {
    await db.execute({
      sql: 'UPDATE users SET role = ? WHERE id = ?',
      args: [updates.role, id],
    });
  }
  if (updates.agentId !== undefined) {
    await db.execute({
      sql: 'UPDATE users SET agent_id = ? WHERE id = ?',
      args: [updates.agentId, id],
    });
  }
  return sanitize(await findById(id));
}

export async function deleteUser(id) {
  const result = await db.execute({
    sql: 'DELETE FROM users WHERE id = ?',
    args: [id],
  });
  return result.rowsAffected > 0;
}

export function verifyPassword(user, password) {
  return bcrypt.compareSync(password, user.passwordHash);
}
