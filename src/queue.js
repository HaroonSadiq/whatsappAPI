/**
 * queue.js
 * Per-customer async message queue.
 *
 * Prevents race conditions when the same customer sends multiple messages
 * in rapid succession — each customer's messages are processed serially.
 *
 * Usage:
 *   import { enqueueJob } from "./queue.js";
 *   await enqueueJob(customerPhone, async () => { ...handle message... });
 *
 * The promise returned resolves when the job itself finishes.
 * If a job throws, the error is logged but the queue continues.
 */

import { logEvent, EVENT_TYPES } from "./logger.js";

// phone → Promise (tail of the per-customer chain)
const customerQueues = new Map();

// Global stats
let totalEnqueued  = 0;
let totalCompleted = 0;
let totalErrors    = 0;

/**
 * Enqueue a job for a specific customer.
 * Jobs for the same customer run one at a time.
 * Jobs for different customers run in parallel.
 *
 * @param {string}   customerId  — customer phone number
 * @param {Function} jobFn       — async function to execute
 * @returns {Promise}            — resolves when this job finishes
 */
export function enqueueJob(customerId, jobFn) {
  totalEnqueued++;
  const depth = getQueueDepth(customerId);

  logEvent({
    type:       EVENT_TYPES.QUEUE_JOB_START,
    customerId,
    meta:       { depth: depth + 1, totalEnqueued },
  });

  const prev = customerQueues.get(customerId) || Promise.resolve();

  const current = prev.then(async () => {
    const start = Date.now();
    try {
      await jobFn();
      totalCompleted++;
      logEvent({
        type:          EVENT_TYPES.QUEUE_JOB_END,
        customerId,
        responseTimeMs: Date.now() - start,
        status:        "success",
      });
    } catch (err) {
      totalErrors++;
      console.error(`[Queue] Job error for ${customerId}:`, err.message);
      logEvent({
        type:       EVENT_TYPES.ERROR,
        customerId,
        status:     "failure",
        text:       err.message,
        meta:       { stack: err.stack?.slice(0, 300) },
      });
    }
  });

  // Store the tail — next job will chain off this one
  customerQueues.set(customerId, current);

  // Clean up reference once this job's chain position is the tail and it resolves
  current.finally(() => {
    if (customerQueues.get(customerId) === current) {
      customerQueues.delete(customerId);
    }
  });

  return current;
}

/** How many jobs are pending (waiting or running) for a customer. */
export function getQueueDepth(customerId) {
  return customerQueues.has(customerId) ? 1 : 0; // simplified: 1 if active chain
}

/** Stats for admin dashboard. */
export function getQueueStats() {
  return {
    activeCustomers: customerQueues.size,
    totalEnqueued,
    totalCompleted,
    totalErrors,
  };
}
