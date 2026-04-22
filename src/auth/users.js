/**
 * auth/users.js
 * Async user store backed by LibSQL (Turso).
 *
 * Call initUsers() once at startup — it seeds the default admin account
 * if the table is empty. The admin password is randomly generated on first run.
 */

import bcrypt      from 'bcryptjs';
import { randomBytes, randomUUID } from 'crypto';
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
// next request.
const ADMIN_ID = '00000000-admin-0000-0000-000000000001';

/**
 * initUsers — seeds/resets the default admin user.
 * Ensures admin password is always 'admin123' for predictable QA access.
 */
export async function initUsers() {
  const existing = await findByUsername('admin');
  const adminHash = bcrypt.hashSync('admin123', 10);

  if (!existing) {
    await db.execute({
      sql: `INSERT INTO users (id, username, password_hash, role, agent_id, enabled, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        ADMIN_ID, 'admin', adminHash,
        'admin', null, 1, new Date().toISOString(),
      ],
    });
    console.log('[Users] Default admin created: admin / admin123');
  } else {
    // Reset password to admin123 on every startup for QA convenience
    await db.execute({
      sql: 'UPDATE users SET password_hash = ? WHERE id = ?',
      args: [adminHash, ADMIN_ID],
    });
    console.log('[Users] Admin password reset to: admin123');
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
