import { Router } from 'express';
import {
  findByUsername, verifyPassword,
  createUser, deleteUser, getAllUsers, updateUser,
} from './users.js';
import { generateToken, requireAdmin, requireAuth } from './middleware.js';
import { createAgent, removeAgent, findAgent, agentRegistry } from '../agents.js';

const router = Router();

// ─── Public ───────────────────────────────────────────────────────────────────

/** POST /api/auth/login */
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  const user = findByUsername(username);
  if (!user || !user.enabled || !verifyPassword(user, password)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = generateToken(user);
  res.json({
    token,
    user: { id: user.id, username: user.username, role: user.role, agentId: user.agentId },
  });
});

// ─── Authenticated ────────────────────────────────────────────────────────────

/** GET /api/auth/me */
router.get('/me', requireAuth, (req, res) => {
  const { passwordHash, ...user } = req.user;
  res.json(user);
});

// ─── Admin: user management ───────────────────────────────────────────────────

/** GET /api/auth/users */
router.get('/users', requireAdmin, (_req, res) => {
  res.json(getAllUsers());
});

/**
 * POST /api/auth/users
 * Body: { username, password, role, name, phone, category, skills[], maxConversations }
 * Creates a user account AND (for role=agent) a corresponding agent registry entry.
 */
router.post('/users', requireAdmin, (req, res) => {
  const { username, password, role, name, phone, category, skills, maxConversations } = req.body;
  if (!username || !password || !role) {
    return res.status(400).json({ error: 'username, password, role required' });
  }
  try {
    let agentId = null;
    if (role === 'agent') {
      if (!name || !category) {
        return res.status(400).json({ error: 'name and category required for agent role' });
      }
      const agent = createAgent({
        name,
        number: phone || '',
        category,
        skills: skills || ['general_support'],
        maxConcurrentConversations: maxConversations || 3,
      });
      agentId = agent.id;
    }
    const user = createUser({ username, password, role, agentId });
    res.json({ user, agentId });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** PATCH /api/auth/users/:id — enable/disable or change password */
router.patch('/users/:id', requireAdmin, (req, res) => {
  const user = updateUser(req.params.id, req.body);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

/** DELETE /api/auth/users/:id */
router.delete('/users/:id', requireAdmin, (req, res) => {
  const users = getAllUsers();
  const target = users.find(u => u.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.agentId) removeAgent(target.agentId);
  deleteUser(req.params.id);
  res.json({ ok: true });
});

export default router;
