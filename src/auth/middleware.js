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

export async function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Step 1 — verify JWT signature/expiry (auth failure → 401)
  let payload;
  try {
    payload = verifyToken(auth.slice(7));
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }

  // Step 2 — load user from DB (server failure → 500, not 401)
  try {
    const user = await findById(payload.userId);
    if (!user?.enabled) return res.status(401).json({ error: 'Unauthorized' });
    req.user = { ...payload, ...user };
    next();
  } catch (err) {
    console.error('[Auth] requireAuth DB error:', err.message);
    return res.status(500).json({ error: 'Server error — please try again' });
  }
}

export async function requireAdmin(req, res, next) {
  await requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    next();
  });
}

export async function requireAgent(req, res, next) {
  await requireAuth(req, res, () => {
    if (req.user.role !== 'agent' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Agents only' });
    }
    next();
  });
}
