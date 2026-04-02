import { nanoid } from 'nanoid';

import { AppError } from '../core/errors.js';

import { outboundCallSchema } from '../core/schemas.js';

import { canTransition } from '../core/state-machine.js';

import { env } from '../config/env.js';

import { callRepository } from '../repositories/call-repository.js';

import { resolveAdapter } from '../providers/index.js';

import { realtimeOrchestrator } from '../realtime/orchestrator.js';
import { TwilioOpenAIBridge } from '../realtime/bridge.js';

import { supabaseRepository } from '../repositories/supabase-repository.js';

import { callQueueService } from './call-queue-service.js';
import { logger } from '../utils/logger.js';



class CallService {

  constructor() {
    // Register background executor so the queue can pick up parked calls.
    callQueueService.setExecuteCallback((callId, payload) => this._executeCall(callId, payload));
  }

  /**
   * Accept an outbound call request.
   * Always returns immediately (202) — the call either executes right away
   * or is parked in the queue and picked up automatically.
   */
  async createOutboundCall(payload) {

    // ─── Normalise common n8n serialisation quirks ───────────────────────────
    // n8n sometimes serialises missing fields as the literal string "null",
    // "undefined", or an empty/whitespace-only string.  Treat all of these as
    // absent so we can return a clean skip response instead of a 400 error that
    // would abort the entire loop.
    const rawTo = typeof payload?.to === 'string' ? payload.to.trim() : null;
    const FALSY_STRINGS = new Set(['null', 'undefined', 'none', 'n/a', '-', '']);
    if (!rawTo || FALSY_STRINGS.has(rawTo.toLowerCase())) {
      logger.warn({ payload }, 'createOutboundCall: empty/invalid `to` — skipping call gracefully');
      return { status: 'skipped', reason: 'missing_to_number' };
    }
    payload = { ...payload, to: rawTo };

    const parsed = outboundCallSchema.safeParse(payload);

    if (!parsed.success) {

      throw new AppError('INVALID_REQUEST', 'Invalid request payload', 400, parsed.error.flatten());

    }



    const input = parsed.data;

    const userId = String(input.user_id ?? 'default');

    const provider = input.provider || env.defaultProvider;

    const adapter = resolveAdapter(provider);

    if (!adapter) throw new AppError('INVALID_REQUEST', `Unknown provider: ${provider}`, 400);



    // Create call record immediately so the client always gets a call_id back.

    const call_id = `call_${nanoid(12)}`;

    const now = new Date().toISOString();

    const entity = {

      call_id,

      provider,

      provider_call_id: null,

      status: 'queued',

      to_number: input.to,

      from_number: input.from || null,

      language: input.language || env.defaultLanguage,

      voice_model: input.voice_model || env.defaultVoiceModel,

      request_payload_snapshot: input,

      created_at: now,

      updated_at: now,

      call_duration_seconds: null,

      recording_url: null,

      transcript_summary: null,

      structured_output: null,

      hangup_reason: null,

      ai_session_info: null,

      user_id:     input.user_id     ?? null,

      campaign_id: input.campaign_id ?? null,

      leads_id:    input.leads_id    ?? null,

    };



    callRepository.create(entity);

    callRepository.addEvent(call_id, { type: 'CALL_CREATED', status: 'queued' });



    // ─── Concurrency gate ─────────────────────────────────────────────────

    const { immediate, position } = callQueueService.tryAcquire(userId, call_id, input);

    const queueStatus = callQueueService.getStatus(userId);



    if (immediate) {

      // Slot available — execute in background (don't block the HTTP response).

      this._executeCall(call_id, input).catch((err) => {

        logger.error({ callId: call_id, err }, 'Immediate call execution failed');

        callQueueService.release(userId, call_id);

      });



      return {

        call_id,

        status: 'queued',

        message: 'Call is being executed now.',

        queue: queueStatus,

      };

    }



    // Parked — update status so the client knows it's waiting.

    callRepository.update(call_id, { status: 'pending_queue' });

    callRepository.addEvent(call_id, {

      type: 'QUEUED',

      position,

      active: queueStatus.active,

      limit: queueStatus.limit,

    });



    // Persist to Supabase so it's visible in dashboards.

    await supabaseRepository.upsertCall(callRepository.get(call_id));

    await supabaseRepository.insertEvent(call_id, {

      type: 'QUEUED',

      position,

      active: queueStatus.active,

      limit: queueStatus.limit,

    });



    return {

      call_id,

      status: 'pending_queue',

      message: `Call queued at position ${position}. It will be executed automatically when a slot opens.`,

      queue: queueStatus,

    };

  }



  /**
   * Internal: actually execute the Twilio call + OpenAI bridge.
   * Called either immediately (if slot was free) or by the queue drain callback.
   */
  async _executeCall(callId, input) {

    const call = callRepository.get(callId);

    if (!call) throw new AppError('NOT_FOUND', 'Call not found', 404);

    const userId = String(call.user_id ?? 'default');

    const provider = call.provider;

    const adapter = resolveAdapter(provider);



    try {

      // If call was parked, transition status.

      if (call.status === 'pending_queue') {

        callRepository.update(callId, { status: 'queued' });

        callRepository.addEvent(callId, { type: 'QUEUE_PICKED_UP', status: 'queued' });

      }



      const providerRes = await adapter.createOutboundCall({ ...input, call_id: callId, from: input.from || null });

      this.#transition(callId, providerRes.status || 'dialing');



      const aiSession = await realtimeOrchestrator.initSession({ ...input, call_id: callId, voice_model: call.voice_model });



      callRepository.update(callId, {

        provider_call_id: providerRes.provider_call_id,

        ai_session_info: aiSession,

      });

      // Pre-warm the OpenAI Realtime session during ring time.
      const bridge = new TwilioOpenAIBridge(null, callId, {
        systemPrompt: aiSession.system_prompt,
        firstMessage: aiSession.first_message,
        language: aiSession.language || call.language,
      });
      callRepository.storeBridge(callId, bridge);
      bridge.connectToOpenAI();

      callRepository.addEvent(callId, {

        type: 'PROVIDER_CALL_CREATED',

        provider,

        provider_call_id: providerRes.provider_call_id,

        provider_raw: providerRes.raw,

      });



      callRepository.addEvent(callId, {

        type: 'AI_SESSION_INITIALIZED',

        ai_session_id: aiSession.ai_session_id,

        first_message: aiSession.first_message,

      });



      // Persist to Supabase.

      await supabaseRepository.upsertCall(callRepository.get(callId));

      await supabaseRepository.insertEvent(callId, { type: 'CALL_CREATED', status: 'queued' });



      logger.info({ callId, provider, userId }, 'Call execution started successfully');

    } catch (err) {

      // Mark call as failed and release the slot.

      callRepository.update(callId, { status: 'failed', hangup_reason: `execution_error: ${err.message}` });

      callRepository.addEvent(callId, { type: 'EXECUTION_FAILED', error: err.message });

      await supabaseRepository.updateCall(callId, { status: 'failed', hangup_reason: `execution_error: ${err.message}` }).catch(() => {});

      callQueueService.release(userId, callId);

      logger.error({ callId, userId, err }, 'Call execution failed — slot released');

      throw err;

    }

  }



  getCall(callId) {

    const call = callRepository.get(callId);

    if (!call) throw new AppError('NOT_FOUND', 'Call not found', 404);

    return {

      ...call,

      provider_event_summary: callRepository.getEvents(callId).map((e) => ({ at: e.at, type: e.type, status: e.status })),

    };

  }



  getCallDetails(callId) {

    const call = callRepository.get(callId);

    if (!call) throw new AppError('NOT_FOUND', 'Call not found', 404);

    return {

      request_payload_snapshot: call.request_payload_snapshot,

      final_resolved_prompt_snapshot: {

        system_prompt_template: call.request_payload_snapshot.system_prompt_template,

        first_message_template: call.request_payload_snapshot.first_message_template,

        variables: call.request_payload_snapshot.variables,

      },

      call,

      timeline: callRepository.getEvents(callId),

      transcript: call.transcript_summary ? [{ text: call.transcript_summary }] : [],

      recording_url: call.recording_url,

      output_extraction: call.structured_output,

      errors_and_warnings: [],

    };

  }



  async hangup(callId) {

    const call = callRepository.get(callId);

    if (!call) throw new AppError('NOT_FOUND', 'Call not found', 404);

    const userId = String(call.user_id ?? 'default');



    // If still in queue (not yet executing), just remove from queue.

    if (call.status === 'pending_queue') {

      callQueueService.dequeue(userId, callId);

      callRepository.update(callId, { status: 'canceled', hangup_reason: 'manual_hangup_from_queue' });

      callRepository.addEvent(callId, { type: 'MANUAL_HANGUP', status: 'canceled' });

      await supabaseRepository.updateCall(callId, { status: 'canceled', hangup_reason: 'manual_hangup_from_queue' });

      return { call_id: callId, status: 'canceled', hangup_reason: 'manual_hangup_from_queue' };

    }



    const adapter = resolveAdapter(call.provider);

    if (!adapter) throw new AppError('INVALID_REQUEST', `Unknown provider: ${call.provider}`, 400);



    await adapter.hangup({ provider_call_id: call.provider_call_id, call_id: call.call_id });

    this.#transition(callId, 'canceled');



    const updated = callRepository.update(callId, { hangup_reason: 'manual_hangup' });

    callRepository.addEvent(callId, { type: 'MANUAL_HANGUP', status: 'canceled' });



    await supabaseRepository.updateCall(callId, { status: 'canceled', hangup_reason: 'manual_hangup' });

    // Release concurrency slot
    CallService.releaseSlot(callId);

    return { call_id: callId, status: updated.status, hangup_reason: updated.hangup_reason };

  }



  /**
   * Release the concurrency slot held by a call.
   * Safe to call multiple times — second call is a no-op.
   * Should be invoked whenever a call reaches a terminal state
   * (completed, failed, canceled, voicemail_detected, silence_timeout, etc).
   */
  static releaseSlot(callId) {
    const call = callRepository.get(callId);
    const userId = String(call?.user_id ?? 'default');
    callQueueService.release(userId, callId);
  }

  #transition(callId, next) {

    const call = callRepository.get(callId);

    if (!call) throw new AppError('NOT_FOUND', 'Call not found', 404);

    const prev = call.status;

    if (prev === next) return;

    if (!canTransition(prev, next)) {

      throw new AppError('INVALID_REQUEST', `Illegal transition ${prev} -> ${next}`, 400);

    }

    callRepository.update(callId, { status: next });

    callRepository.addEvent(callId, { type: 'STATE_CHANGED', from: prev, status: next });

  }

}

export { CallService };
export const callService = new CallService();
