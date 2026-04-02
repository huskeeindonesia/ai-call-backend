import { nanoid } from 'nanoid';
import { logger } from '../utils/logger.js';

/**
 * Fire-and-forget per-user concurrency queue for outbound calls.
 *
 * Design:
 *   • n8n (or any client) POSTs /v1/calls/outbound → gets 202 immediately
 *   • If the user has a free slot → call executes right away (status: 'queued')
 *   • If the user is at capacity → call is parked (status: 'pending_queue')
 *     and auto-picked-up when a slot opens
 *
 * Each user_id has independent limits (default 10).
 * No HTTP connection is held open — everything is non-blocking.
 */

const DEFAULT_CONCURRENCY = 10;

/** @type {Map<string, UserQueue>} */
const queues = new Map();

class UserQueue {
  constructor(userId, limit) {
    this.userId = userId;
    this.limit = limit;
    this.active = new Set();       // call_ids currently executing
    this.waiting = [];             // { callId, payload, enqueuedAt }
  }

  get available() { return Math.max(0, this.limit - this.active.size); }
  get queueLength() { return this.waiting.length; }
}

class CallQueueService {
  constructor() {
    /** @type {Map<string, number>} override limits per user_id */
    this._userLimits = new Map();
    this._defaultLimit = DEFAULT_CONCURRENCY;
    /** @type {((callId: string, payload: object) => Promise<void>) | null} */
    this._executeCallback = null;
  }

  /**
   * Register the function that actually executes a call.
   * Called by call-service on startup to avoid circular deps.
   */
  setExecuteCallback(fn) {
    this._executeCallback = fn;
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Try to acquire a slot and execute immediately.
   * Returns { immediate: true } if a slot was available,
   *         { immediate: false, position } if queued.
   */
  tryAcquire(userId, callId, payload) {
    const uq = this._getOrCreate(userId);

    if (uq.active.size < uq.limit) {
      // Slot available — mark active immediately
      uq.active.add(callId);
      logger.info({
        userId, callId,
        active: uq.active.size, limit: uq.limit,
        available: uq.available, waiting: uq.queueLength,
      }, 'Call slot acquired immediately');
      return { immediate: true, position: 0 };
    }

    // No slot — park in queue
    const position = uq.waiting.length + 1;
    uq.waiting.push({ callId, payload, enqueuedAt: Date.now() });

    logger.info({
      userId, callId, position,
      active: uq.active.size, limit: uq.limit,
      waiting: uq.queueLength,
    }, 'Call queued — waiting for slot');

    return { immediate: false, position };
  }

  /**
   * Release a concurrency slot for userId/callId.
   * Automatically picks up the next queued call if any.
   * Safe to call multiple times (idempotent).
   */
  release(userId, callId) {
    const key = String(userId);
    const uq = queues.get(key);
    if (!uq) return;

    if (!uq.active.delete(callId)) return; // was not active — no-op

    logger.info({
      userId, callId,
      active: uq.active.size, limit: uq.limit,
      available: uq.available, waiting: uq.queueLength,
    }, 'Call slot released');

    this._drainQueue(uq);

    if (uq.active.size === 0 && uq.queueLength === 0) {
      queues.delete(key);
    }
  }

  /**
   * Remove a call from the waiting queue (before it's picked up).
   * Returns true if the call was found and removed.
   */
  dequeue(userId, callId) {
    const key = String(userId);
    const uq = queues.get(key);
    if (!uq) return false;
    const idx = uq.waiting.findIndex(w => w.callId === callId);
    if (idx === -1) return false;
    uq.waiting.splice(idx, 1);
    logger.info({ userId, callId, waiting: uq.queueLength }, 'Call removed from queue');
    return true;
  }

  /**
   * Get queue status for a specific user.
   */
  getStatus(userId) {
    const uq = queues.get(String(userId));
    if (!uq) {
      const limit = this._userLimits.get(String(userId)) ?? this._defaultLimit;
      return { user_id: userId, limit, active: 0, available: limit, queued: 0, queued_call_ids: [] };
    }
    return {
      user_id: uq.userId,
      limit: uq.limit,
      active: uq.active.size,
      available: uq.available,
      queued: uq.queueLength,
      queued_call_ids: uq.waiting.map(w => w.callId),
    };
  }

  /**
   * Get queue status across all users.
   */
  getAllStatus() {
    const result = [];
    for (const uq of queues.values()) {
      result.push({
        user_id: uq.userId,
        limit: uq.limit,
        active: uq.active.size,
        available: uq.available,
        queued: uq.queueLength,
      });
    }
    return result;
  }

  /**
   * Update concurrency limit for a user. Takes effect immediately.
   * If the new limit is higher, queued calls will be drained.
   */
  setUserLimit(userId, limit) {
    const key = String(userId);
    this._userLimits.set(key, limit);
    const uq = queues.get(key);
    if (uq) {
      uq.limit = limit;
      this._drainQueue(uq);
    }
    logger.info({ userId, limit }, 'User concurrency limit updated');
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  _getOrCreate(userId) {
    const key = String(userId);
    let uq = queues.get(key);
    if (!uq) {
      const limit = this._userLimits.get(key) ?? this._defaultLimit;
      uq = new UserQueue(key, limit);
      queues.set(key, uq);
    }
    return uq;
  }

  _drainQueue(uq) {
    while (uq.active.size < uq.limit && uq.waiting.length > 0) {
      const entry = uq.waiting.shift();
      const waitedMs = Date.now() - entry.enqueuedAt;
      uq.active.add(entry.callId);

      logger.info({
        userId: uq.userId, callId: entry.callId, waitedMs,
        active: uq.active.size, limit: uq.limit,
        available: uq.available, waiting: uq.queueLength,
      }, 'Queued call picked up — executing now');

      // Fire-and-forget: execute in background
      if (this._executeCallback) {
        this._executeCallback(entry.callId, entry.payload).catch((err) => {
          logger.error({ userId: uq.userId, callId: entry.callId, err }, 'Background call execution failed');
          // Release the slot so other queued calls can proceed
          this.release(uq.userId, entry.callId);
        });
      }
    }
  }
}

export const callQueueService = new CallQueueService();
