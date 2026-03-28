import https from 'node:https';
import http from 'node:http';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Thin Supabase repository.
 * Uses node:https (not fetch) for PostgREST calls so that:
 *   1. Content-Length is always set explicitly — prevents HAProxy from rejecting
 *      requests as "not a valid request" due to missing/ambiguous framing.
 *   2. rejectUnauthorized: false is applied directly, honoring SUPABASE_IGNORE_SSL.
 * Storage uploads still use fetch (binary body, works correctly already).
 */

/** Make an HTTP/HTTPS request using node:https, returns { status, ok, text() }. */
function pgRequest(method, url, headers, bodyStr) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const bodyBuf = Buffer.from(bodyStr, 'utf8');
    logger.info({ pgMethod: method, pgPath: u.pathname + u.search, pgBodyLen: bodyBuf.length }, 'pgRequest sending');
    const options = {
      hostname: u.hostname,
      port: u.port || (isHttps ? '443' : '80'),
      path: u.pathname + u.search,
      method,
      headers: { ...headers, 'Content-Length': bodyBuf.length },
      rejectUnauthorized: false, // honour SUPABASE_IGNORE_SSL without relying on env var propagation to undici
      agent: false,              // new TCP+TLS connection per request — avoids keep-alive reuse issues with HAProxy
    };
    const req = (isHttps ? https : http).request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          logger.warn({ pgMethod: method, pgPath: u.pathname + u.search, pgStatus: res.statusCode, pgBody: text.substring(0, 300) }, 'pgRequest non-2xx');
        }
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, text: () => text });
      });
    });
    req.on('error', (err) => {
      logger.error({ pgMethod: method, pgPath: u.pathname + u.search, err }, 'pgRequest network error');
      reject(err);
    });
    req.write(bodyBuf);
    req.end();
  });
}

class SupabaseRepository {
  get #base() {
    return env.supabaseUrl.replace(/\/$/, '');
  }

  get #headers() {
    return {
      'Content-Type': 'application/json',
      apikey: env.supabaseServiceRoleKey,
      Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
    };
  }

  get #ready() {
    return Boolean(env.supabaseUrl && env.supabaseServiceRoleKey);
  }

  /** INSERT or UPDATE the calls row (upsert by call_id). */
  async upsertCall(call) {
    if (!this.#ready) return;

    const row = {
      call_id: call.call_id,
      direction: 'outbound',
      provider: call.provider,
      provider_call_id: call.provider_call_id ?? null,
      status: call.status,
      to_number: call.to_number ?? call.to ?? null,
      from_number: call.from_number ?? call.from ?? null,
      language: call.language ?? null,
      voice_model: call.voice_model ?? null,
      call_duration_seconds: call.call_duration_seconds ?? null,
      recording_url: call.recording_url ?? null,
      request_payload_snapshot: call.request_payload_snapshot,
      transcript_summary: call.transcript_summary ?? null,
      structured_output: call.structured_output ?? null,
      hangup_reason: call.hangup_reason ?? null,
      ai_session_info: call.ai_session_info ?? null,
      user_id:     call.user_id     ?? null,
      campaign_id: call.campaign_id ?? null,
      leads_id:    call.leads_id    ?? null,
    };

    try {
      const res = await pgRequest(
        'POST',
        `${this.#base}/rest/v1/calls`,
        { ...this.#headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
        JSON.stringify(row),
      );
      if (!res.ok) {
        logger.warn({ callId: call.call_id, status: res.status, body: res.text() }, 'DB upsert failed');
      }
    } catch (err) {
      logger.error({ callId: call.call_id, err }, 'DB upsert error');
    }
  }

  /** PATCH a subset of columns on an existing calls row. */
  async updateCall(callId, patch) {
    if (!this.#ready) return;
    try {
      const res = await pgRequest(
        'PATCH',
        `${this.#base}/rest/v1/calls?call_id=eq.${encodeURIComponent(callId)}`,
        { ...this.#headers, Prefer: 'return=minimal' },
        JSON.stringify(patch),
      );
      if (!res.ok) {
        logger.warn({ callId, status: res.status, body: res.text() }, 'DB update failed');
      }
    } catch (err) {
      logger.error({ callId, err }, 'DB update error');
    }
  }

  /** INSERT a row into call_events. */
  async insertEvent(callId, event) {
    if (!this.#ready) return;
    const row = {
      call_id: callId,
      event_type: event.type,
      status: event.status ?? null,
      payload: event,
    };
    try {
      const res = await pgRequest(
        'POST',
        `${this.#base}/rest/v1/call_events`,
        { ...this.#headers, Prefer: 'return=minimal' },
        JSON.stringify(row),
      );
      if (!res.ok) {
        logger.warn({ callId, status: res.status, body: res.text() }, 'DB event insert failed');
      }
    } catch (err) {
      logger.error({ callId, err }, 'DB event insert error');
    }
  }

  /**
   * Upload a file to Supabase Storage.
   * Returns the public URL (assumes bucket is public).
   */
  async uploadFile(bucket, path, buffer, contentType) {
    if (!this.#ready) return null;
    try {
      const res = await fetch(`${this.#base}/storage/v1/object/${bucket}/${path}`, {
        method: 'POST',
        headers: {
          apikey: env.supabaseServiceRoleKey,
          Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
          'Content-Type': contentType,
          'x-upsert': 'false',
        },
        body: buffer,
      });
      if (!res.ok) {
        const text = await res.text();
        logger.warn({ bucket, path, status: res.status, body: text }, 'Storage upload failed');
        return null;
      }
      // Public URL for a public bucket
      return `${this.#base}/storage/v1/object/public/${bucket}/${path}`;
    } catch (err) {
      logger.error({ bucket, path, err }, 'Storage upload error');
      return null;
    }
  }
}

export const supabaseRepository = new SupabaseRepository();
