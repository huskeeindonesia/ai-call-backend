import { Router } from 'express';
import twilio from 'twilio';
import { env } from '../config/env.js';
import { callRepository } from '../repositories/call-repository.js';
import { logger } from '../utils/logger.js';

const router = Router();
const VoiceResponse = twilio.twiml.VoiceResponse;

/**
 * TwiML endpoint — Twilio fetches this when the outbound call is answered.
 * Returns XML instructing Twilio to open a Media Stream to our WebSocket server.
 */
router.all('/twilio/twiml/:callId', (req, res) => {
  const { callId } = req.params;

  // Build the WebSocket URL from PUBLIC_URL
  const wsUrl = env.publicUrl
    .replace(/^https:\/\//, 'wss://')
    .replace(/^http:\/\//, 'ws://') + `/twilio/media-stream/${callId}`;

  const response = new VoiceResponse();
  const connect = response.connect();
  connect.stream({ url: wsUrl });

  logger.info({ callId, wsUrl }, 'TwiML served — media stream connecting');
  res.type('text/xml').send(response.toString());
});

/**
 * Status callback — Twilio POSTs call status updates here.
 * Keeps the call entity in sync with Twilio's view.
 */
router.post('/twilio/status/:callId', (req, res) => {
  const { callId } = req.params;
  const { CallStatus, CallSid, CallDuration } = req.body;

  logger.info({ callId, CallStatus, CallSid, CallDuration }, 'Twilio status callback');

  const statusMap = {
    initiated: 'dialing',
    ringing: 'dialing',
    'in-progress': 'in-progress',
    completed: 'completed',
    failed: 'failed',
    busy: 'failed',
    'no-answer': 'failed',
    canceled: 'canceled'
  };

  const newStatus = statusMap[CallStatus];
  if (newStatus) {
    callRepository.update(callId, { status: newStatus });
    callRepository.addEvent(callId, {
      type: 'TWILIO_STATUS_CALLBACK',
      status: newStatus,
      twilio_status: CallStatus
    });
  }

  res.sendStatus(200);
});

export default router;
