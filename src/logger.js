/**
 * logger.js
 * Structured event logger.
 *
 * Every significant system event is recorded with:
 *   type, customerId, agentId, timestamp, intent, category,
 *   assignmentReason, responseTimeMs, status, text, meta
 *
 * Stored in memory (last MAX_EVENTS entries).
 * Exposed via getEventLog() and getConversationLog(customerId).
 */

const MAX_EVENTS = 500;
const events = [];

/**
 * Log a structured event.
 *
 * @param {object} fields
 * @param {string}  fields.type             — event type (see EVENT_TYPES)
 * @param {string}  [fields.customerId]     — customer phone
 * @param {string}  [fields.agentId]
 * @param {string}  [fields.intent]         — faq_answer | escalate
 * @param {string}  [fields.category]       — product category
 * @param {string}  [fields.assignmentReason]
 * @param {number}  [fields.responseTimeMs]
 * @param {string}  [fields.status]         — success | failure | queued | retry
 * @param {string}  [fields.text]           — message text
 * @param {object}  [fields.meta]           — any extra data
 */
export function logEvent(fields) {
  const entry = {
    id:               events.length + 1,
    timestamp:        new Date().toISOString(),
    ts:               Date.now(),
    type:             fields.type || "unknown",
    customerId:       fields.customerId   || null,
    agentId:          fields.agentId      || null,
    intent:           fields.intent       || null,
    category:         fields.category     || null,
    assignmentReason: fields.assignmentReason || null,
    responseTimeMs:   fields.responseTimeMs   || null,
    status:           fields.status       || null,
    text:             fields.text         || null,
    meta:             fields.meta         || {},
  };

  events.push(entry);
  if (events.length > MAX_EVENTS) events.shift();

  // Console output for non-trivial events
  const NOISY = new Set(["agent_chat_complete", "agent_cooldown_done"]);
  if (!NOISY.has(entry.type)) {
    const parts = [
      `[${entry.type}]`,
      entry.customerId && `customer=${entry.customerId}`,
      entry.agentId    && `agent=${entry.agentId}`,
      entry.category   && `cat=${entry.category}`,
      entry.status     && `status=${entry.status}`,
    ].filter(Boolean);
    console.log(parts.join(" "));
  }
}

/** Returns a copy of all events, newest first. */
export function getEventLog(limit = 100) {
  return [...events].reverse().slice(0, limit);
}

/** Returns events for a specific customer (newest first). */
export function getConversationLog(customerId, limit = 50) {
  return [...events]
    .filter((e) => e.customerId === customerId)
    .reverse()
    .slice(0, limit);
}

/** Summary stats for dashboard. */
export function getLogStats() {
  const total       = events.length;
  const escalations = events.filter((e) => e.intent === "escalate").length;
  const faqAnswers  = events.filter((e) => e.intent === "faq_answer").length;
  const failures    = events.filter((e) => e.status === "failure").length;
  const retries     = events.filter((e) => e.status === "retry").length;

  const responseTimes = events
    .filter((e) => e.responseTimeMs != null)
    .map((e) => e.responseTimeMs);
  const avgResponseMs = responseTimes.length
    ? Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length)
    : null;

  return { total, escalations, faqAnswers, failures, retries, avgResponseMs };
}

export const EVENT_TYPES = {
  MESSAGE_IN:          "message_in",
  MESSAGE_OUT:         "message_out",
  CLASSIFIED:          "classified",
  ASSIGNED:            "assigned",
  QUEUED:              "queued",
  DEQUEUED:            "dequeued",
  FALLBACK_AI:         "fallback_ai",
  DONE:                "done",
  RATING:              "rating",
  SEND_RETRY:          "send_retry",
  SEND_FAILED:         "send_failed",
  AGENT_FAILED:        "agent_failed",
  AGENT_RESET:         "agent_reset",
  AGENT_CHAT_COMPLETE: "agent_chat_complete",
  AGENT_COOLDOWN_DONE: "agent_cooldown_done",
  QUEUE_JOB_START:     "queue_job_start",
  QUEUE_JOB_END:       "queue_job_end",
  ERROR:               "error",
};
