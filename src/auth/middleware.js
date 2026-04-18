import jwt from 'jsonwebtoken';
import { findById } from './users.js';

export const JWT_SECRET = process.env.JWT_SECRET || 'wa_router_dev_secret_change_in_prod';

export function generateToken(user) {
  return jwt.sign(
    { userId: user.id, role: user.role, agentId: user.agentId },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
}

export function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

// ─── Express middleware ───────────────────────────────────────────────────────

export function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const payload = verifyToken(auth.slice(7));
    const user    = findById(payload.userId);
    if (!user?.enabled) return res.status(401).json({ error: 'Unauthorized' });
    req.user = { ...payload, ...user };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

export function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    next();
  });
}

export function requireAgent(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'agent' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Agents only' });
    }
    next();
  });
}
