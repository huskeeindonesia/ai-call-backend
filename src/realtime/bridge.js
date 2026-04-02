import WebSocket from 'ws';
import twilio from 'twilio';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';
import { recordingService } from '../services/recording-service.js';
import { supabaseRepository } from '../repositories/supabase-repository.js';
import { callRepository } from '../repositories/call-repository.js';

// Lazy-loaded to avoid circular dependency (call-service → bridge → call-service).
let _CallService;
function getCallService() {
  if (!_CallService) {
    _CallService = import('../services/call-service.js').then(m => m.CallService);
  }
  return _CallService;
}

/**
 * Bridges a Twilio Media Stream WebSocket ↔ OpenAI Realtime API.
 *
 * Audio path (both directions, no transcoding needed):
 *   Caller ──g711_ulaw 8kHz──▶ Twilio ──▶ [this bridge] ──▶ OpenAI Realtime
 *   Caller ◀──g711_ulaw 8kHz── Twilio ◀── [this bridge] ◀── OpenAI Realtime
 *
 * Additionally, all inbound audio chunks (caller → server) are buffered
 * for post-call recording + Whisper transcription.
 */
export class TwilioOpenAIBridge {
  constructor(twilioWs, callId, sessionConfig) {
    this.twilioWs = twilioWs;
    this.callId = callId;
    this.sessionConfig = sessionConfig; // { systemPrompt, firstMessage, language }
    this.openAiWs = null;
    this.streamSid = null;
    this._openAiReady = false;
    this._firstMessageSent = false;
    this._pendingAudio = [];          // buffer before OpenAI is ready
    this._inboundChunks = [];         // caller → server audio (for recording)
    this._outboundChunks = [];        // recording turns: [{ ms, chunks: string[] }]
    this._currentTurnChunks = [];     // delta chunks accumulating for the current AI response turn
    this._currentTurnStartMs = null;  // wall-clock offset (ms from call start) of first delta in turn
    this._prewarmBuffer = [];         // AI audio accumulated during ring time (before Twilio stream opens)
    this._prewarmTimeout = null;      // closes OpenAI if call is never answered
    this._aiIsSpeaking = false;       // true only while AI audio deltas are arriving (used for barge-in guard)
    this._suppressOutbound = false;   // true only during barge-in: drops stray AI deltas already in-flight
    this._bargedIn = false;           // true after barge-in, reset when AI starts new response
    this._bargedInResponseTimer = null; // debounce: wait for user to fully finish before AI responds
    this._callStartTime = Date.now(); // reset to actual call-answer time in 'start' handler

    // ─── Silence detection ──────────────────────────────────────────────────────
    this._lastActivityTime = Date.now();
    this._silenceCheckInterval = null;
    this._silenceThresholdMs = 7_000;       // 7s no speech → hang up
    this._holdGraceUntil = 0;               // pause silence check until this timestamp

    // ─── Voicemail / robot detection (Indonesian telco) ─────────────────────────
    this._voicemailKeywords = [
      'rekam pesan', 'voicemail', 'pesan suara', 'tekan tombol',
      'mailbox', 'tinggalkan pesan', 'nada sela', 'kotak suara',
      'sedang tidak aktif', 'tidak dapat dihubungi', 'di luar jangkauan',
      'nomor yang anda tuju', 'sedang sibuk', 'tidak menjawab',
      'setelah nada', 'silakan tinggalkan', 'meninggalkan pesan',
    ];
    this._holdKeywords = ['tunggu', 'sebentar', 'bentar'];
    this._voicemailWindowMs = 30_000;       // only check voicemail in first 30s
  }

  // ─── OpenAI connection ──────────────────────────────────────────────────────

  connectToOpenAI() {
    const model = env.openAiRealtimeModel || 'gpt-realtime-mini-2025-12-15';
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;

    this.openAiWs = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${env.openAiApiKey}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });

    this.openAiWs.on('open', () => {
      logger.info({ callId: this.callId, model }, 'OpenAI Realtime connected');

      // Configure session — audio and first message are held until session.updated
      // confirms the system prompt is active (see _handleOpenAIMessage).
      const languagePrefix =
        'INSTRUKSI WAJIB BAHASA:\n' +
        'Kamu harus berbicara bahasa Indonesia seperti orang Indonesia asli. WAJIB ikuti aturan ini:\n' +
        '1. Gunakan HANYA bahasa Indonesia. Jangan pernah menyisipkan kata atau frasa bahasa asing kecuali nama produk/merek.\n' +
        '2. Gunakan gaya bicara kasual dan natural seperti orang Indonesia sehari-hari — boleh pakai "gak", "ya", "nih", "sih", "dong", "oke", "nah", "eh", dll.\n' +
        '3. Pelafalan harus seperti orang Indonesia asli: singkat, to the point, tidak kaku.\n' +
        '4. Hindari kalimat yang terlalu formal atau terdengar seperti terjemahan dari bahasa asing.\n' +
        '5. Gunakan sapaan yang wajar seperti "Halo", "Iya", "Baik" — bukan "Tentu saja!", "Dengan senang hati!" atau ungkapan khas bule.\n\n' +
        'INSTRUKSI AKHIRI PANGGILAN:\n' +
        'Kamu WAJIB memanggil fungsi `end_call` untuk menutup telepon jika salah satu kondisi berikut terpenuhi:\n' +
        '1. Lawan bicara bilang "sudah cukup", "terima kasih", "bye", "dadah", "makasih", atau ungkapan penutup lainnya.\n' +
        '2. Percakapan sudah selesai secara natural — semua topik sudah dibahas dan tidak ada lagi yang perlu disampaikan.\n' +
        '3. Lawan bicara menolak dan tidak mau melanjutkan pembicaraan.\n' +
        '4. Lawan bicara diam terlalu lama setelah kamu sudah mencoba bertanya ulang.\n' +
        'Sebelum memanggil `end_call`, SELALU ucapkan penutup yang sopan (misal: "Baik/terima kasih ya") lalu panggil `end_call`.\n\n';

      const instructions = languagePrefix +
        (this.sessionConfig.systemPrompt ||
          'Kamu adalah asisten AI yang ramah dan membantu.');

      this.openAiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions,
          voice: 'coral',
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          input_audio_transcription: { model: 'whisper-1' },
          input_audio_noise_reduction: { type: 'near_field' }, // suppress background noise (cooking, traffic, etc.)
          turn_detection: {
            type: 'server_vad',
            threshold: 0.65,         // higher = less sensitive to background noise; 0.5 was too trigger-happy
            prefix_padding_ms: 300,
            silence_duration_ms: 600,
          },
          temperature: 0.8,
          tools: [
            {
              type: 'function',
              name: 'end_call',
              description: 'Hang up the phone call. Call this when the conversation has naturally concluded — e.g. the caller has said goodbye, thank you, or there is nothing more to discuss.',
              parameters: {
                type: 'object',
                properties: {
                  reason: {
                    type: 'string',
                    description: 'Brief reason why the call is ending (e.g. "conversation complete").',
                  },
                },
                required: [],
              },
            },
          ],
          tool_choice: 'auto',
        },
      }));
      // Safety valve: release the OpenAI session if the call is never answered.
      this._prewarmTimeout = setTimeout(() => {
        if (!this.streamSid) {
          logger.info({ callId: this.callId }, 'Pre-warm timeout — call not answered, closing OpenAI');
          this.openAiWs?.close();
        }
      }, 60_000);

      // _openAiReady is intentionally NOT set here; it is set in session.updated
      // so that buffered caller audio only flows once the session config is applied.
    });

    this.openAiWs.on('message', (raw) => {
      try { this._handleOpenAIMessage(JSON.parse(raw)); }
      catch (err) { logger.error({ callId: this.callId, err }, 'Failed to parse OpenAI message'); }
    });

    this.openAiWs.on('error', (err) =>
      logger.error({ callId: this.callId, err }, 'OpenAI Realtime WS error'));

    this.openAiWs.on('close', (code) => {
      logger.info({ callId: this.callId, code }, 'OpenAI Realtime WS closed');
      this._openAiReady = false;
    });
  }

  _handleOpenAIMessage(msg) {
    switch (msg.type) {
      case 'session.created':
        logger.info({ callId: this.callId, sessionId: msg.session?.id }, 'OpenAI session created');
        break;

      case 'session.updated':
        // Session config (system prompt, audio format, VAD) is now active.
        // IMPORTANT: inject first message + response.create BEFORE flushing
        // buffered caller audio — otherwise VAD fires on the buffered audio and
        // starts an auto-response first, causing "conversation_already_has_active_response".
        if (this.sessionConfig.firstMessage && !this._firstMessageSent) {
          this._firstMessageSent = true;
          this.openAiWs.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: `Please greet the caller by saying: "${this.sessionConfig.firstMessage}"` }],
            },
          }));
          this.openAiWs.send(JSON.stringify({ type: 'response.create' }));
          logger.info({ callId: this.callId }, 'First message injected after session.updated');
        }

        // Open the live audio pipe — discard the _pendingAudio buffer (pre-session audio
        // is just silence/noise from the setup phase on an outbound call; flushing it risks
        // the VAD firing on stale frames and cancelling the greeting response).
        this._openAiReady = true;
        this._pendingAudio = [];   // discard — caller hasn't spoken yet
        break;

      case 'response.audio.delta':
        // Mark AI as speaking (used by barge-in guard below).
        this._aiIsSpeaking = true;
        if (msg.delta && !this._suppressOutbound) {
          if (!this.streamSid) {
            // Pre-warm path: Twilio stream not yet open.
            // Buffer for playback on answer AND seed the current turn for recording.
            this._prewarmBuffer.push(msg.delta);
            this._currentTurnChunks.push(msg.delta);
            if (this._currentTurnStartMs === null) this._currentTurnStartMs = 0; // anchored at call-answer time
          } else {
            // Live path: stream open — forward to Twilio and accumulate for recording.
            if (this._currentTurnStartMs === null) {
              this._currentTurnStartMs = Date.now() - this._callStartTime;
            }
            this._currentTurnChunks.push(msg.delta);
            if (this.twilioWs?.readyState === WebSocket.OPEN) {
              this.twilioWs.send(JSON.stringify({
                event: 'media',
                streamSid: this.streamSid,
                media: { payload: msg.delta },
              }));
            }
          }
        }
        break;

      case 'response.audio.done':
        // AI audio stream for this turn ended (normal completion).
        // Mark not-speaking so a subsequent speech_started is a new turn, not barge-in.
        this._aiIsSpeaking = false;
        this._lastActivityTime = Date.now(); // start silence countdown after AI finishes
        if (this.streamSid && this.twilioWs?.readyState === WebSocket.OPEN) {
          this.twilioWs.send(JSON.stringify({
            event: 'mark',
            streamSid: this.streamSid,
            mark: { name: 'response_done' },
          }));
        }
        break;

      case 'response.done':
        // Response fully finished (completed, cancelled, or failed).
        // Save the accumulated turn audio for recording — this fires for ALL response
        // outcomes including barge-in cancellations (where response.audio.done may NOT fire).
        if (this._currentTurnChunks.length > 0) {
          this._outboundChunks.push({
            ms: this._currentTurnStartMs ?? 0,
            chunks: [...this._currentTurnChunks],
          });
        }
        this._currentTurnChunks = [];
        this._currentTurnStartMs = null;
        this._aiIsSpeaking = false;
        this._suppressOutbound = false;
        break;

      case 'input_audio_buffer.speech_started':
        // Caller started speaking — reset silence timer.
        this._lastActivityTime = Date.now();
        // ONLY treat this as barge-in if the AI is currently streaming audio.
        // If _aiIsSpeaking is false (AI already finished its turn), this is a normal
        // conversational turn — do NOT suppress, or the AI's response will be silently dropped.
        if (this._aiIsSpeaking) {
          this._suppressOutbound = true;
          this._bargedIn = true;
          // Cancel any pending post-barge-in response timer.
          clearTimeout(this._bargedInResponseTimer);
          this._bargedInResponseTimer = null;
          // Disable VAD auto-response so OpenAI does NOT fire on every 600ms pause
          // while the user is still formulating their sentence.
          this._setVadAutoResponse(false);
          // Clear Twilio playback buffer so caller hears silence immediately.
          if (this.streamSid && this.twilioWs.readyState === WebSocket.OPEN) {
            this.twilioWs.send(JSON.stringify({ event: 'clear', streamSid: this.streamSid }));
          }
          // Cancel the in-flight OpenAI response so it stops generating audio.
          if (this.openAiWs?.readyState === WebSocket.OPEN) {
            this.openAiWs.send(JSON.stringify({ type: 'response.cancel' }));
          }
          logger.info({ callId: this.callId }, 'Barge-in: cancelled AI response, listening to customer');
        } else if (this._bargedIn) {
          // User started speaking again while we were waiting to respond post-barge-in.
          // Cancel the pending response timer and keep waiting.
          clearTimeout(this._bargedInResponseTimer);
          this._bargedInResponseTimer = null;
          logger.info({ callId: this.callId }, 'Barge-in: user still speaking — holding AI response');
        }
        break;

      case 'input_audio_buffer.speech_stopped':
        // Customer finished speaking.
        // After a barge-in, use a cancellable debounce before letting the AI respond.
        // server_vad auto-commits the audio buffer on each speech_stopped even when
        // create_response is false — so we don't need manual commit here.
        // If the user starts speaking again before the timer fires (speech_started above),
        // the timer is cancelled, preventing the AI from firing on a mid-sentence pause.
        if (this._bargedIn) {
          clearTimeout(this._bargedInResponseTimer);
          this._bargedInResponseTimer = setTimeout(() => {
            this._bargedIn = false;
            this._bargedInResponseTimer = null;
            logger.info({ callId: this.callId }, 'Barge-in speech ended — re-enabling auto-response and responding');
            // Re-enable VAD auto-response for all subsequent turns.
            this._setVadAutoResponse(true);
            // Manually trigger response for the user's now-committed audio.
            if (this.openAiWs?.readyState === WebSocket.OPEN) {
              this.openAiWs.send(JSON.stringify({ type: 'response.create' }));
            }
          }, 2_000);
          logger.info({ callId: this.callId }, 'Barge-in: user paused — waiting 2s before AI responds');
        }
        break;

      case 'response.function_call_arguments.done':
        if (msg.name === 'end_call') {
          let reason = 'conversation_complete';
          try { reason = JSON.parse(msg.arguments || '{}').reason || reason; } catch {}
          logger.info({ callId: this.callId, reason }, 'AI requested end_call — hanging up');

          // Acknowledge the function call so OpenAI's conversation state stays clean.
          if (this.openAiWs?.readyState === WebSocket.OPEN) {
            this.openAiWs.send(JSON.stringify({
              type: 'conversation.item.create',
              item: {
                type: 'function_call_output',
                call_id: msg.call_id,
                output: JSON.stringify({ ok: true }),
              },
            }));
          }

          // Delay hangup so the AI's goodbye audio finishes playing to the caller.
          setTimeout(() => this._hangupCall(reason), 3000);
        }
        break;

      case 'conversation.item.input_audio_transcription.completed':
        if (msg.transcript && msg.transcript.trim()) {
          this._lastActivityTime = Date.now();
          if (!this._checkVoicemailKeywords(msg.transcript)) {
            this._checkHoldRequest(msg.transcript);
          }
        } else {
          // Empty transcript = VAD triggered on background noise (e.g. pan/clanging), not speech.
          // Cancel regardless of whether the AI has already started speaking or is still
          // generating — both states mean the AI is responding to noise, not a real utterance.
          if (this.openAiWs?.readyState === WebSocket.OPEN) {
            this.openAiWs.send(JSON.stringify({ type: 'response.cancel' }));
          }
          if (this.streamSid && this.twilioWs?.readyState === WebSocket.OPEN) {
            this.twilioWs.send(JSON.stringify({ event: 'clear', streamSid: this.streamSid }));
          }
          logger.info({ callId: this.callId }, 'Empty transcript — background noise triggered VAD, cancelled response');
        }
        break;

      case 'error':
        logger.error({ callId: this.callId, error: msg.error }, 'OpenAI Realtime error event');
        break;
    }
  }

  // ─── VAD helpers ────────────────────────────────────────────────────────────

  // Temporarily enable or disable the server VAD's automatic response creation.
  // When disabled, VAD still detects speech and commits audio buffers, but will
  // NOT auto-fire response.create — giving us manual control after a barge-in.
  _setVadAutoResponse(enabled) {
    if (this.openAiWs?.readyState === WebSocket.OPEN) {
      this.openAiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          turn_detection: {
            type: 'server_vad',
            threshold: 0.65,
            prefix_padding_ms: 300,
            silence_duration_ms: 600,
            create_response: enabled,
          },
        },
      }));
    }
  }

  // ─── Voicemail & silence detection ──────────────────────────────────────────

  _startSilenceDetection() {
    this._lastActivityTime = Date.now();
    this._silenceCheckInterval = setInterval(() => {
      if (this._aiIsSpeaking) return;                       // AI is talking — not silence
      if (Date.now() < this._holdGraceUntil) return;       // customer said "tunggu"
      const silentMs = Date.now() - this._lastActivityTime;
      if (silentMs >= this._silenceThresholdMs) {
        logger.info({ callId: this.callId, silentMs }, 'Silence threshold exceeded — hanging up');
        clearInterval(this._silenceCheckInterval);
        this._silenceCheckInterval = null;
        this._hangupCall('silence_timeout');
      }
    }, 1_000);
  }

  _checkVoicemailKeywords(transcript) {
    if (Date.now() - this._callStartTime > this._voicemailWindowMs) return false;
    const lower = transcript.toLowerCase();
    for (const kw of this._voicemailKeywords) {
      if (lower.includes(kw)) {
        logger.info({ callId: this.callId, keyword: kw, transcript }, 'Voicemail/robot detected — hanging up');
        clearInterval(this._silenceCheckInterval);
        this._silenceCheckInterval = null;
        this._hangupCall('voicemail_detected');
        return true;
      }
    }
    return false;
  }

  _checkHoldRequest(transcript) {
    const lower = transcript.toLowerCase();
    for (const kw of this._holdKeywords) {
      if (lower.includes(kw)) {
        logger.info({ callId: this.callId, keyword: kw }, 'Hold requested — pausing silence detection 30s');
        this._holdGraceUntil = Date.now() + 30_000;
        this._lastActivityTime = Date.now();
        return true;
      }
    }
    return false;
  }

  async _hangupCall(reason = 'ai_ended') {
    const call = callRepository.get(this.callId);
    if (!call?.provider_call_id) return;
    try {
      const client = twilio(env.twilio.accountSid, env.twilio.authToken);
      await client.calls(call.provider_call_id).update({ status: 'completed' });
      callRepository.update(this.callId, { hangup_reason: reason });
      logger.info({ callId: this.callId, reason }, 'Call hung up by AI');
    } catch (err) {
      logger.error({ callId: this.callId, err }, 'Failed to hang up call via Twilio API');
    }
  }

  // ─── Twilio message handler ─────────────────────────────────────────────────

  handleTwilioMessage(rawData) {
    try {
      const msg = JSON.parse(rawData);
      switch (msg.event) {
        case 'connected':
          logger.info({ callId: this.callId }, 'Twilio Media Stream connected');
          break;

        case 'start':
          this.streamSid = msg.start.streamSid;
          this._callStartTime = Date.now(); // anchor recording timestamps to actual call-answer time
          clearTimeout(this._prewarmTimeout);
          logger.info({ callId: this.callId, streamSid: this.streamSid }, 'Twilio stream started');
          if (this.openAiWs && this.openAiWs.readyState === WebSocket.OPEN) {
            // Pre-warmed during ring time — flush buffered greeting audio instantly.
            this._flushPrewarmBuffer();
          } else {
            // Cold start (inbound call or pre-warm failed) — connect now.
            this.connectToOpenAI();
          }
          this._startSilenceDetection();
          break;

        case 'media': {
          const payload = msg.media.payload;
          // Buffer for recording
          this._inboundChunks.push(payload);
          // Forward to OpenAI
          if (this._openAiReady) {
            this._sendAudioToOpenAI(payload);
          } else {
            this._pendingAudio.push(payload);
          }
          break;
        }

        case 'stop':
          logger.info({ callId: this.callId }, 'Twilio stream stopped');
          this.openAiWs?.close();
          this._finalizeCall().catch((err) =>
            logger.error({ callId: this.callId, err }, 'Error during call finalization'));
          break;
      }
    } catch (err) {
      logger.error({ callId: this.callId, err }, 'Failed to handle Twilio message');
    }
  }

  // Called when the Twilio media stream starts and we have a pre-warmed OpenAI session.
  // Sends all buffered AI greeting audio to Twilio immediately so the caller hears
  // the greeting with minimal delay (~0 seconds instead of 5-7 seconds).
  _flushPrewarmBuffer() {
    logger.info({ callId: this.callId, buffered: this._prewarmBuffer.length }, 'Flushing pre-warmed AI greeting to Twilio stream');
    // Forward each buffered chunk to Twilio immediately
    for (const data of this._prewarmBuffer) {
      if (this.twilioWs?.readyState === WebSocket.OPEN) {
        this.twilioWs.send(JSON.stringify({
          event: 'media',
          streamSid: this.streamSid,
          media: { payload: data },
        }));
      }
    }
    this._prewarmBuffer = [];
    // _currentTurnChunks already has the prewarm audio (seeded in response.audio.delta prewarm path)
    // and _currentTurnStartMs=0. If more deltas arrive they will continue into the same turn.
    // response.done will finalize and save the complete turn.
    // Audio pipe is now live for inbound caller audio.
    this._openAiReady = true;
    for (const chunk of this._pendingAudio) this._sendAudioToOpenAI(chunk);
    this._pendingAudio = [];
  }

  _sendAudioToOpenAI(base64Payload) {
    if (this.openAiWs?.readyState === WebSocket.OPEN) {
      this.openAiWs.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: base64Payload,
      }));
    }
  }

  // ─── Post-call finalization ─────────────────────────────────────────────────

  async _finalizeCall() {
    const durationSeconds = Math.round((Date.now() - this._callStartTime) / 1000);
    const call = callRepository.get(this.callId);
    const language = call?.language || 'id';

    // Process recording + transcription
    const { recordingUrl, transcriptSummary } = await recordingService.processRecording(
      this.callId,
      this._inboundChunks,
      language,
      this._outboundChunks,
    );

    // Update in-memory store
    callRepository.update(this.callId, {
      call_duration_seconds: durationSeconds,
      recording_url: recordingUrl,
      transcript_summary: transcriptSummary,
    });

    // Persist to Supabase using targeted PATCH (avoids large-body upsert issues)
    await supabaseRepository.updateCall(this.callId, {
      recording_url: recordingUrl,
      transcript_summary: transcriptSummary || null,
      call_duration_seconds: durationSeconds,
    });
    await supabaseRepository.insertEvent(this.callId, {
      type: 'CALL_FINALIZED',
      duration_seconds: durationSeconds,
      recording_url: recordingUrl,
      has_transcript: Boolean(transcriptSummary),
    });

    logger.info({ callId: this.callId, durationSeconds, hasRecording: Boolean(recordingUrl), hasTranscript: Boolean(transcriptSummary) }, 'Call finalized');

    // Release concurrency slot (safe to call even if already released by status callback)
    try {
      const CS = await getCallService();
      CS.releaseSlot(this.callId);
    } catch (e) {
      logger.warn({ callId: this.callId, err: e }, 'Failed to release slot in finalization');
    }
  }

  close() {
    clearTimeout(this._prewarmTimeout);
    clearTimeout(this._bargedInResponseTimer);
    clearInterval(this._silenceCheckInterval);
    this._silenceCheckInterval = null;
    this._openAiReady = false;
    this.openAiWs?.close();
  }
}
