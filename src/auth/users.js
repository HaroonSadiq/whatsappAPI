import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';

/**
 * In-memory user store.
 * Schema: { id, username, passwordHash, role: 'admin'|'agent', agentId, enabled, createdAt }
 *
 * Seeded with one admin account (admin / admin123).
 * Replace with a database in production.
 */

const users = new Map();

function seed() {
  const id = randomUUID();
  users.set(id, {
    id,
    username: 'admin',
    passwordHash: bcrypt.hashSync('admin123', 10),
    role: 'admin',
    agentId: null,
    enabled: true,
    createdAt: new Date().toISOString(),
  });
}
seed();

// ─── Queries ──────────────────────────────────────────────────────────────────

export function findByUsername(username) {
  return [...users.values()].find(u => u.username === username);
}

export function findById(id) {
  return users.get(id);
}

export function getAllUsers() {
  return [...users.values()].map(sanitize);
}

// ─── Mutations ────────────────────────────────────────────────────────────────

export function createUser({ username, password, role, agentId = null }) {
  if (findByUsername(username)) throw new Error('Username already exists');
  const id = randomUUID();
  const user = {
    id,
    username,
    passwordHash: bcrypt.hashSync(password, 10),
    role,
    agentId,
    enabled: true,
    createdAt: new Date().toISOString(),
  };
  users.set(id, user);
  return sanitize(user);
}

export function updateUser(id, updates) {
  const user = users.get(id);
  if (!user) return null;
  const updated = { ...user, ...updates };
  if (updates.password) {
    updated.passwordHash = bcrypt.hashSync(updates.password, 10);
    delete updated.password;
  }
  users.set(id, updated);
  return sanitize(updated);
}

export function deleteUser(id) {
  return users.delete(id);
}

export function verifyPassword(user, password) {
  return bcrypt.compareSync(password, user.passwordHash);
}

function sanitize({ passwordHash, ...rest }) {
  return rest;
}
