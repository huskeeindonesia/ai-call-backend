import { nanoid } from 'nanoid';
import { AppError } from '../core/errors.js';
import { outboundCallSchema } from '../core/schemas.js';
import { canTransition } from '../core/state-machine.js';
import { env } from '../config/env.js';
import { callRepository } from '../repositories/call-repository.js';
import { resolveAdapter } from '../providers/index.js';
import { realtimeOrchestrator } from '../realtime/orchestrator.js';

class CallService {
  async createOutboundCall(payload) {
    const parsed = outboundCallSchema.safeParse(payload);
    if (!parsed.success) {
      throw new AppError('INVALID_REQUEST', 'Invalid request payload', 400, parsed.error.flatten());
    }

    const input = parsed.data;
    const provider = input.provider || env.defaultProvider;
    const adapter = resolveAdapter(provider);
    if (!adapter) throw new AppError('INVALID_REQUEST', `Unknown provider: ${provider}`, 400);

    const call_id = `call_${nanoid(12)}`;
    const now = new Date().toISOString();
    const entity = {
      call_id,
      provider,
      provider_call_id: null,
      status: 'queued',
      to: input.to,
      from: input.from || null,
      language: input.language || env.defaultLanguage,
      voice_model: input.voice_model || env.defaultVoiceModel,
      request_payload_snapshot: input,
      created_at: now,
      updated_at: now,
      transcript_summary: null,
      structured_output: null,
      hangup_reason: null,
      ai_session_info: null
    };

    callRepository.create(entity);
    callRepository.addEvent(call_id, { type: 'CALL_CREATED', status: 'queued' });

    const providerRes = await adapter.createOutboundCall({ ...input, call_id, from: input.from || null });
    this.#transition(call_id, providerRes.status || 'dialing');

    const aiSession = await realtimeOrchestrator.initSession({ ...input, call_id, voice_model: entity.voice_model });

    const updated = callRepository.update(call_id, {
      provider_call_id: providerRes.provider_call_id,
      ai_session_info: aiSession
    });

    callRepository.addEvent(call_id, {
      type: 'PROVIDER_CALL_CREATED',
      provider,
      provider_call_id: providerRes.provider_call_id,
      provider_raw: providerRes.raw
    });

    callRepository.addEvent(call_id, {
      type: 'AI_SESSION_INITIALIZED',
      ai_session_id: aiSession.ai_session_id,
      first_message_rendered: aiSession.first_message_rendered
    });

    return {
      call_id: updated.call_id,
      status: updated.status,
      provider: updated.provider,
      provider_call_id: updated.provider_call_id
    };
  }

  getCall(callId) {
    const call = callRepository.get(callId);
    if (!call) throw new AppError('NOT_FOUND', 'Call not found', 404);
    return {
      ...call,
      provider_event_summary: callRepository.getEvents(callId).map((e) => ({ at: e.at, type: e.type, status: e.status }))
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
        variables: call.request_payload_snapshot.variables
      },
      call,
      timeline: callRepository.getEvents(callId),
      transcript: [],
      output_extraction: call.structured_output,
      errors_and_warnings: []
    };
  }

  async hangup(callId) {
    const call = callRepository.get(callId);
    if (!call) throw new AppError('NOT_FOUND', 'Call not found', 404);

    const adapter = resolveAdapter(call.provider);
    if (!adapter) throw new AppError('INVALID_REQUEST', `Unknown provider: ${call.provider}`, 400);

    await adapter.hangup({ provider_call_id: call.provider_call_id, call_id: call.call_id });
    this.#transition(callId, 'canceled');

    const updated = callRepository.update(callId, { hangup_reason: 'manual_hangup' });
    callRepository.addEvent(callId, { type: 'MANUAL_HANGUP', status: 'canceled' });
    return { call_id: callId, status: updated.status, hangup_reason: updated.hangup_reason };
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

export const callService = new CallService();
