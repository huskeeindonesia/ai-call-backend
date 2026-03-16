import twilio from 'twilio';
import { BaseVoiceAdapter } from './base-adapter.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

export class TwilioAdapter extends BaseVoiceAdapter {
  constructor(ready) {
    super('twilio');
    this.ready = ready;
    if (ready) {
      this.client = twilio(env.twilio.accountSid, env.twilio.authToken);
    }
  }

  async createOutboundCall(input) {
    if (!this.ready || !this.client) {
      logger.warn('Twilio not configured — returning stub response');
      return {
        provider: this.name,
        provider_call_id: `twilio_stub_${input.call_id}`,
        status: 'queued',
        raw: { mode: 'stub', to: input.to }
      };
    }

    const from = input.from || env.twilio.fromNumber;
    const twimlUrl = `${env.publicUrl}/twilio/twiml/${input.call_id}`;
    const statusCallbackUrl = `${env.publicUrl}/twilio/status/${input.call_id}`;

    const call = await this.client.calls.create({
      url: twimlUrl,
      to: input.to,
      from,
      statusCallback: statusCallbackUrl,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed']
    });

    logger.info({ callId: input.call_id, sid: call.sid, to: call.to }, 'Twilio outbound call created');

    return {
      provider: this.name,
      provider_call_id: call.sid,
      status: 'dialing',
      raw: { sid: call.sid, to: call.to, from: call.from, status: call.status }
    };
  }

  async hangup(input) {
    if (this.client && input.provider_call_id) {
      try {
        await this.client.calls(input.provider_call_id).update({ status: 'completed' });
      } catch (err) {
        logger.warn({ err, provider_call_id: input.provider_call_id }, 'Twilio hangup call failed');
      }
    }
    return { provider: this.name, provider_call_id: input.provider_call_id, status: 'canceled' };
  }
}
