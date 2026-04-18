// In-memory stores for TEST_MODE sandbox

export const sessions = new Map();
export const messageLogs = new Map();
export const categoryQueues = new Map();
export const agents = new Map();
export const customers = new Map();
export const sseClients = new Map();

// Seed Haroon (Agent)
agents.set('haroon_923105806053', {
  id: 'haroon_923105806053',
  name: 'Haroon',
  phone: '923105806053',
  category: 'Tech',
  role: 'agent',
  status: 'available',
  current_session_id: null,
  total_sessions_today: 0,
  last_seen_at: null
});

// Seed Test Customer
customers.set('923234758743', {
  phone: '923234758743',
  name: 'Test Customer',
  role: 'customer',
  registered_at: new Date().toISOString()
});

export function generateId(prefix) {
  return `${prefix}${Math.random().toString(36).substring(2, 10)}${Date.now().toString(36).substring(4)}`;
}

export function findOpenSessionByCustomer(phone) {
  for (const sess of sessions.values()) {
    if (sess.customer_phone === phone && (sess.status === 'waiting' || sess.status === 'active')) {
      return sess;
    }
  }
  return null;
}

export function createSession(data) {
  const now = new Date().toISOString();
  sessions.set(data.session_id, {
    ...data,
    message_count: 0,
    updated_at: now
  });
  messageLogs.set(data.session_id, []);
  return sessions.get(data.session_id);
}

export function getSession(sessionId) {
  return sessions.get(sessionId);
}

export function updateSession(sessionId, updates) {
  const sess = sessions.get(sessionId);
  if (!sess) return null;
  Object.assign(sess, updates, { updated_at: new Date().toISOString() });
  return sess;
}

export function logMessage(sessionId, direction, senderId, text, meta = {}) {
  const log = messageLogs.get(sessionId) || [];
  const msg = {
    msg_id: generateId('msg_'),
    session_id: sessionId,
    direction,
    sender_id: senderId,
    text,
    ts: new Date().toISOString(),
    meta
  };
  log.push(msg);
  messageLogs.set(sessionId, log);

  const sess = sessions.get(sessionId);
  if (sess) sess.message_count = log.length;

  return msg;
}

export function getMessages(sessionId) {
  return messageLogs.get(sessionId) || [];
}

export function enqueueSession(category, sessionId, priority = 1) {
  if (!categoryQueues.has(category)) categoryQueues.set(category, []);
  const queue = categoryQueues.get(category);
  if (!queue.find(item => item.session_id === sessionId)) {
    queue.push({ session_id: sessionId, enqueued_at: new Date().toISOString(), priority });
  }
}

export function dequeueSession(category, sessionId) {
  if (!categoryQueues.has(category)) return;
  const queue = categoryQueues.get(category);
  const idx = queue.findIndex(item => item.session_id === sessionId);
  if (idx >= 0) queue.splice(idx, 1);
}

export function peekQueue(category) {
  return categoryQueues.get(category)?.[0] || null;
}

export function getQueue(category) {
  return categoryQueues.get(category) || [];
}

export function getAgent(agentId) {
  return agents.get(agentId);
}

export function updateAgent(agentId, updates) {
  const agent = agents.get(agentId);
  if (!agent) return null;
  Object.assign(agent, updates);
  return agent;
}

export function findAvailableAgentByCategory(category) {
  for (const agent of agents.values()) {
    if (agent.category === category && agent.status === 'available' && agent.role === 'agent') {
      return agent;
    }
  }
  return null;
}

export function getCustomer(phone) {
  return customers.get(phone);
}

export function getAllCustomers() {
  return Array.from(customers.values());
}

export function getAllSessions() {
  return Array.from(sessions.values());
}

// SSE helpers
export function addSseClient(sessionId, res) {
  if (!sseClients.has(sessionId)) sseClients.set(sessionId, new Set());
  sseClients.get(sessionId).add(res);
}

export function removeSseClient(sessionId, res) {
  sseClients.get(sessionId)?.delete(res);
}

export function broadcastToSession(sessionId, data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.get(sessionId)?.forEach(res => {
    try {
      res.write(payload);
    } catch (e) {
      // Client disconnected
    }
  });
}
