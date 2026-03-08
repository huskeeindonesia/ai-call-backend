import { BaseVoiceAdapter } from './base-adapter.js';

export class TwilioAdapter extends BaseVoiceAdapter {
  constructor(ready) {
    super('twilio');
    this.ready = ready;
  }

  async createOutboundCall(input) {
    return {
      provider: this.name,
      provider_call_id: `twilio_stub_${input.call_id}`,
      status: this.ready ? 'dialing' : 'queued',
      raw: { mode: this.ready ? 'ready' : 'stub', to: input.to, from: input.from }
    };
  }

  async hangup(input) {
    return { provider: this.name, provider_call_id: input.provider_call_id, status: 'canceled' };
  }
}
