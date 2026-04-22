/**
 * ws/handler.js
 * Socket.IO connection handler — the real-time bridge between agents and customers.
 *
 * Vercel note: Socket.IO works best with polling transport on serverless.
 * For maximum reliability, the agent dashboard also supports REST polling as fallback.
 *
 * Flow:
 *  1. Agent connects → authenticates with JWT → joins their personal room
 *  2. Orchestrator emits appEvents → handler pushes to correct Socket.IO room
 *  3. Agent accepts chat → session activated, customer notified
 *  4. Agent sends message → WhatsApp API → customer
 *  5. Customer replies → server.js emits appEvents → pushed to agent socket
 *  6. Agent marks done → session closed, rating prompt sent to customer
 *
 * Rooms:
 *  admin           — all admin sockets
 *  agent:<agentId> — that agent's sockets
 *  all             — every authenticated socket
 */

import { verifyToken }      from '../auth/middleware.js';
import { findById }         from '../auth/users.js';
import { appEvents }        from '../events.js';
import {
  getHistory, addToHistory,
  getState,   setState,
  clearSession, getAssignment, releaseAssignment,
  saveRating,
}                           from '../session.js';
import {
  setAgentStatus, releaseConversation, getAgentById,
  AGENT_STATES, getAvailabilitySnapshot,
}                           from '../agents.js';
import {
  getSession, assignSession, closeSession,
  getAllSessions, getSessionByPhone,
  getWaitingSessions, getActiveSessions,
}                           from '../supportSessions.js';
import { sendMessage }      from '../whatsapp.js';
import { logEvent, getEventLog, EVENT_TYPES } from '../logger.js';
import { processNextInQueue } from '../orchestrator.js';

// agentId → Set of socket ids (one agent may have multiple tabs)
const agentSockets  = new Map();
// socketId → { userId, role, agentId, username }
const socketMeta    = new Map();

let _io;
let _logMsg;

export function initWsHandler(io, logMsg) {
  _io     = io;
  _logMsg = logMsg;

  // ─── Connection ───────────────────────────────────────────────────────────
  io.on('connection', (socket) => {

    // ── authenticate ─────────────────────────────────────────────────────────
    socket.on('authenticate', async (token, cb) => {
      try {
        const payload = verifyToken(token);
        const user    = await findById(payload.userId);
        if (!user?.enabled) {
          cb?.({ error: 'Unauthorized' });
          return socket.disconnect();
        }

        const meta = { userId: user.id, role: user.role, agentId: user.agentId, username: user.username };
        socketMeta.set(socket.id, meta);

        socket.join('all');

        if (user.role === 'agent' && user.agentId) {
          socket.join(`agent:${user.agentId}`);
          if (!agentSockets.has(user.agentId)) agentSockets.set(user.agentId, new Set());
          agentSockets.get(user.agentId).add(socket.id);
        }
        if (user.role === 'admin') {
          socket.join('admin');
        }

        const sessions = await getAllSessions();

        cb?.({
          ok: true,
          user: { id: user.id, username: user.username, role: user.role, agentId: user.agentId },
          sessions,
          agents: await getAvailabilitySnapshot(),
        });

        console.log(`[WS] ${user.role} "${user.username}" connected (${socket.id})`);
      } catch (err) {
        console.error('[WS] authenticate error:', err.message);
        cb?.({ error: 'Invalid token' });
        socket.disconnect();
      }
    });

    // ── agent:accept — agent accepts a waiting session ────────────────────────
    socket.on('agent:accept', async ({ sessionId }, cb) => {
      const meta = socketMeta.get(socket.id);
      if (!meta?.agentId) return cb?.({ error: 'Not an agent' });

      const session = await getSession(sessionId);
      if (!session) return cb?.({ error: 'Session not found' });
      if (session.state !== 'waiting') return cb?.({ error: 'Session not waiting' });
      if (session.assignedAgentId && session.assignedAgentId !== meta.agentId) {
        return cb?.({ error: 'Session assigned to different agent' });
      }

      const activated = await assignSession(sessionId, meta.agentId);
      if (!activated) return cb?.({ error: 'Could not activate session' });

      const acceptMsg = `Hi! I'm ${session.agentName || 'your support agent'}. I'm here to help. 😊`;
      try {
        await sendMessage(session.customerPhone, acceptMsg);
        await addToHistory(session.customerPhone, 'assistant', acceptMsg);
        _logMsg('outbound', session.customerPhone, session.agentName || 'Agent', acceptMsg, {
          type: 'agent_message', agentId: meta.agentId,
        });
      } catch (err) {
        console.error('[WS] Failed to send acceptance message:', err.message);
      }

      const history = await getHistory(session.customerPhone);
      const messages = history.map(m => ({
        sender:    m.role === 'user' ? 'customer' : (m.role === 'assistant' ? 'agent' : 'bot'),
        text:      m.content,
        timestamp: Date.now(),
      }));

      cb?.({ ok: true, session: activated, messages });

      io.to('admin').emit('session:activated', { session: activated });
      logEvent({ type: EVENT_TYPES.ASSIGNED, customerId: session.customerPhone, agentId: meta.agentId, status: 'success' });
    });

    // ── agent:message — agent sends reply to customer ─────────────────────────
    socket.on('agent:message', async ({ sessionId, text }, cb) => {
      const meta = socketMeta.get(socket.id);
      if (!meta) return cb?.({ error: 'Not authenticated' });

      const session = await getSession(sessionId);
      if (!session) return cb?.({ error: 'Session not found' });
      if (session.state !== 'active') return cb?.({ error: 'Session not active' });
      if (session.agentId !== meta.agentId && meta.role !== 'admin') {
        return cb?.({ error: 'Not your session' });
      }
      if (!text?.trim()) return cb?.({ error: 'Empty message' });

      const trimmed = text.trim();

      try {
        await sendMessage(session.customerPhone, trimmed);
      } catch (err) {
        return cb?.({ error: `WhatsApp send failed: ${err.message}` });
      }

      await addToHistory(session.customerPhone, 'assistant', trimmed);
      _logMsg('outbound', session.customerPhone, session.agentName || 'Agent', trimmed, {
        type: 'agent_message', agentId: meta.agentId, sessionId,
      });
      logEvent({
        type:      EVENT_TYPES.MESSAGE_OUT,
        customerId: session.customerPhone,
        agentId:   meta.agentId,
        status:    'success',
        text:      trimmed,
      });

      const message = {
        sender:    'agent',
        agentId:   meta.agentId,
        agentName: session.agentName,
        text:      trimmed,
        timestamp: Date.now(),
        sessionId,
      };

      cb?.({ ok: true, message });

      io.to('admin').emit('session:message', { sessionId, session, message });
      io.to(`agent:${meta.agentId}`).emit('session:message', { sessionId, session, message });
    });

    // ── agent:done — agent closes a session ───────────────────────────────────
    socket.on('agent:done', async ({ sessionId }, cb) => {
      const meta = socketMeta.get(socket.id);
      if (!meta) return cb?.({ error: 'Not authenticated' });

      const session = await getSession(sessionId);
      if (!session) return cb?.({ error: 'Session not found' });
      if (session.agentId !== meta.agentId && meta.role !== 'admin') {
        return cb?.({ error: 'Not your session' });
      }

      const closed = await closeSession(sessionId);
      if (!closed) return cb?.({ error: 'Could not close session' });

      if (session.agentId) await releaseConversation(session.agentId);
      await releaseAssignment(session.customerPhone);
      await setState(session.customerPhone, 'awaiting_rating');

      const ratingMsg =
        `Your query has been resolved. Thank you for reaching out! 🙏\n\n` +
        `Please rate your experience:\n` +
        `⭐ Reply *1* — Poor\n` +
        `⭐⭐ Reply *2* — Fair\n` +
        `⭐⭐⭐ Reply *3* — Good\n` +
        `⭐⭐⭐⭐ Reply *4* — Very Good\n` +
        `⭐⭐⭐⭐⭐ Reply *5* — Excellent`;

      try {
        await sendMessage(session.customerPhone, ratingMsg);
      } catch (err) {
        console.error('[WS] Failed to send rating prompt:', err.message);
      }

      logEvent({ type: EVENT_TYPES.DONE, customerId: session.customerPhone, agentId: meta.agentId, status: 'success' });
      console.log(`✅ Session ${sessionId} closed by ${meta.username}`);

      cb?.({ ok: true });

      io.to('admin').emit('session:closed', { sessionId, session: closed });
      io.to(`agent:${meta.agentId}`).emit('session:closed', { sessionId, session: closed });

      await processNextInQueue(_logMsg).catch(() => {});
    });

    // ── agent:status — agent toggles their availability ───────────────────────
    socket.on('agent:status', async ({ status }, cb) => {
      const meta = socketMeta.get(socket.id);
      if (!meta?.agentId) return cb?.({ error: 'No agent linked' });
      const valid = Object.values(AGENT_STATES);
      if (!valid.includes(status)) return cb?.({ error: `Invalid status. Valid: ${valid.join(', ')}` });

      const ok = await setAgentStatus(meta.agentId, status);
      cb?.({ ok });
      if (ok) {
        io.to('all').emit('agent:status', { agentId: meta.agentId, status });
      }
    });

    // ── admin:logs — real-time log feed ───────────────────────────────────────
    socket.on('admin:logs', ({ limit = 50 } = {}, cb) => {
      const meta = socketMeta.get(socket.id);
      if (meta?.role !== 'admin') return cb?.({ error: 'Admin only' });
      cb?.({ logs: getEventLog(limit) });
    });

    // ── disconnect ────────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
      const meta = socketMeta.get(socket.id);
      if (meta?.agentId) {
        const set = agentSockets.get(meta.agentId);
        if (set) {
          set.delete(socket.id);
          if (set.size === 0) agentSockets.delete(meta.agentId);
        }
      }
      socketMeta.delete(socket.id);
    });
  });

  // ─── AppEvent relays ──────────────────────────────────────────────────────

  appEvents.on('session:new', ({ session, agentId, messages }) => {
    _io.to('admin').emit('session:new', { session, messages });
    if (agentId) {
      _io.to(`agent:${agentId}`).emit('session:new', { session, messages });
    }
  });

  appEvents.on('session:customer:message', ({ session, message }) => {
    _io.to('admin').emit('session:message', { sessionId: session.id, session, message });
    if (session.agentId) {
      _io.to(`agent:${session.agentId}`).emit('session:message', { sessionId: session.id, session, message });
    }
  });

  appEvents.on('queue:update', (data) => {
    _io.to('admin').emit('queue:update', data);
    _io.to('all').emit('queue:update', data);
  });
}

/** Push a customer's inbound message to the assigned agent's dashboard. */
export async function pushCustomerMessage(phone, name, text) {
  const session = await getSessionByPhone(phone);
  if (!session || !_io) return;

  const message = {
    sender:    'customer',
    phone,
    name,
    text,
    timestamp: Date.now(),
    sessionId: session.id,
  };

  appEvents.emit('session:customer:message', { session, message });
}
