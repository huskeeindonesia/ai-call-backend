import { Router } from 'express';
import twilio from 'twilio';
import { env } from '../config/env.js';
import { callRepository } from '../repositories/call-repository.js';
import { supabaseRepository } from '../repositories/supabase-repository.js';
import { logger } from '../utils/logger.js';

const router = Router();
const VoiceResponse = twilio.twiml.VoiceResponse;

/**
 * TwiML endpoint — Twilio fetches this when the outbound call is answered.
 * Returns XML that opens a Media Stream WebSocket to this server.
 * No auth — Twilio is the caller.
 */
router.all('/twilio/twiml/:callId', (req, res) => {
  const { callId } = req.params;

  const wsUrl = env.publicUrl
    .replace(/^https:\/\//, 'wss://')
    .replace(/^http:\/\//, 'ws://') + `/twilio/media-stream/${callId}`;

  const response = new VoiceResponse();
  const connect = response.connect();
  connect.stream({ url: wsUrl });

  logger.info({ callId, wsUrl }, 'TwiML served');
  res.type('text/xml').send(response.toString());
});

/**
 * Status callback — Twilio POSTs call status changes here.
 */
router.post('/twilio/status/:callId', async (req, res) => {
  const { callId } = req.params;
  const { CallStatus, CallSid, CallDuration } = req.body;

  logger.info({ callId, CallStatus, CallSid, CallDuration }, 'Twilio status callback');

  const statusMap = {
    initiated: 'dialing',
    ringing: 'ringing',
    'in-progress': 'in_progress',
    completed: 'completed',
    failed: 'failed',
    busy: 'failed',
    'no-answer': 'failed',
    canceled: 'canceled',
  };

  const newStatus = statusMap[CallStatus];
  if (newStatus) {
    const patch = { status: newStatus };
    if (CallDuration) patch.call_duration_seconds = Number(CallDuration);

    callRepository.update(callId, patch);
    callRepository.addEvent(callId, {
      type: 'TWILIO_STATUS_CALLBACK',
      status: newStatus,
      twilio_status: CallStatus,
      duration_seconds: CallDuration ? Number(CallDuration) : undefined,
    });

    // Persist status update to DB
    await supabaseRepository.updateCall(callId, patch);
    await supabaseRepository.insertEvent(callId, {
      type: 'TWILIO_STATUS_CALLBACK',
      status: newStatus,
      twilio_status: CallStatus,
    });
  }

  res.sendStatus(200);
});

export default router;
