import WebSocket from 'ws';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';

/**
 * Bridges a Twilio Media Stream WebSocket connection to the OpenAI Realtime API.
 *
 * Audio path (both directions):
 *   Twilio  ←→  g711_ulaw 8kHz base64  ←→  OpenAI Realtime
 *
 * No audio transcoding is required because OpenAI Realtime natively supports
 * the g711_ulaw format that Twilio Media Streams send/receive.
 */
export class TwilioOpenAIBridge {
  constructor(twilioWs, callId, sessionConfig) {
    this.twilioWs = twilioWs;
    this.callId = callId;
    this.sessionConfig = sessionConfig; // { systemPrompt, firstMessage }
    this.openAiWs = null;
    this.streamSid = null;
    this._openAiReady = false;
    this._pendingAudio = []; // buffer audio chunks that arrive before OpenAI is ready
  }

  /** Called when Twilio sends the 'start' event with a streamSid. */
  connectToOpenAI() {
    const model = env.openAiRealtimeModel || 'gpt-4o-mini-realtime-preview';
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;

    this.openAiWs = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${env.openAiApiKey}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    });

    this.openAiWs.on('open', () => {
      logger.info({ callId: this.callId, model }, 'Connected to OpenAI Realtime API');

      // Configure the realtime session
      this.openAiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions: this.sessionConfig.systemPrompt ||
            'Kamu adalah asisten AI yang ramah dan membantu. Berbicara dalam bahasa Indonesia.',
          voice: 'alloy',
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          input_audio_transcription: { model: 'whisper-1' },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 800
          },
          temperature: 0.8
        }
      }));

      // Inject the first message as a user turn and trigger a response
      if (this.sessionConfig.firstMessage) {
        this.openAiWs.send(JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [{
              type: 'input_text',
              text: `Please greet the caller by saying: "${this.sessionConfig.firstMessage}"`
            }]
          }
        }));
        this.openAiWs.send(JSON.stringify({ type: 'response.create' }));
      }

      this._openAiReady = true;

      // Flush any audio that arrived before we were ready
      for (const chunk of this._pendingAudio) {
        this._sendAudioToOpenAI(chunk);
      }
      this._pendingAudio = [];
    });

    this.openAiWs.on('message', (rawData) => {
      try {
        this._handleOpenAIMessage(JSON.parse(rawData));
      } catch (err) {
        logger.error({ callId: this.callId, err }, 'Failed to parse OpenAI message');
      }
    });

    this.openAiWs.on('error', (err) => {
      logger.error({ callId: this.callId, err }, 'OpenAI Realtime WS error');
    });

    this.openAiWs.on('close', (code, reason) => {
      logger.info({ callId: this.callId, code }, 'OpenAI Realtime WS closed');
      this._openAiReady = false;
      if (this.twilioWs.readyState === WebSocket.OPEN) {
        this.twilioWs.close();
      }
    });
  }

  _handleOpenAIMessage(msg) {
    switch (msg.type) {
      case 'session.created':
        logger.info({ callId: this.callId, session: msg.session?.id }, 'OpenAI session created');
        break;

      case 'response.audio.delta':
        // Forward audio delta to Twilio
        if (msg.delta && this.streamSid && this.twilioWs.readyState === WebSocket.OPEN) {
          this.twilioWs.send(JSON.stringify({
            event: 'media',
            streamSid: this.streamSid,
            media: { payload: msg.delta }
          }));
        }
        break;

      case 'response.audio.done':
        // Signal Twilio that this audio burst is finished (optional mark)
        if (this.streamSid && this.twilioWs.readyState === WebSocket.OPEN) {
          this.twilioWs.send(JSON.stringify({
            event: 'mark',
            streamSid: this.streamSid,
            mark: { name: 'response_done' }
          }));
        }
        break;

      case 'input_audio_buffer.speech_started':
        // User started speaking — clear Twilio's playback buffer to interrupt AI
        if (this.streamSid && this.twilioWs.readyState === WebSocket.OPEN) {
          this.twilioWs.send(JSON.stringify({
            event: 'clear',
            streamSid: this.streamSid
          }));
        }
        break;

      case 'error':
        logger.error({ callId: this.callId, error: msg.error }, 'OpenAI Realtime error event');
        break;
    }
  }

  /** Handle a raw message received from the Twilio Media Stream WebSocket. */
  handleTwilioMessage(rawData) {
    try {
      const msg = JSON.parse(rawData);
      switch (msg.event) {
        case 'connected':
          logger.info({ callId: this.callId }, 'Twilio Media Stream protocol connected');
          break;

        case 'start':
          this.streamSid = msg.start.streamSid;
          logger.info({ callId: this.callId, streamSid: this.streamSid }, 'Twilio stream started');
          // Now we have a streamSid — open the OpenAI connection
          this.connectToOpenAI();
          break;

        case 'media':
          if (this._openAiReady) {
            this._sendAudioToOpenAI(msg.media.payload);
          } else {
            // Buffer until OpenAI is ready (only a few packets at most)
            this._pendingAudio.push(msg.media.payload);
          }
          break;

        case 'mark':
          // Acknowledgment echo from Twilio — no action needed
          break;

        case 'stop':
          logger.info({ callId: this.callId }, 'Twilio stream stopped');
          this.openAiWs?.close();
          break;
      }
    } catch (err) {
      logger.error({ callId: this.callId, err }, 'Failed to handle Twilio message');
    }
  }

  _sendAudioToOpenAI(base64Payload) {
    if (this.openAiWs?.readyState === WebSocket.OPEN) {
      this.openAiWs.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: base64Payload
      }));
    }
  }

  close() {
    this._openAiReady = false;
    if (this.openAiWs) {
      this.openAiWs.close();
    }
  }
}
