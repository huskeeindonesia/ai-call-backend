import { BaseVoiceAdapter } from './base-adapter.js';

export class TelnyxAdapter extends BaseVoiceAdapter {
  constructor(ready) {
    super('telnyx');
    this.ready = ready;
  }

  async createOutboundCall(input) {
    return {
      provider: this.name,
      provider_call_id: `telnyx_stub_${input.call_id}`,
      status: this.ready ? 'dialing' : 'queued',
      raw: { mode: this.ready ? 'ready' : 'stub', to: input.to, from: input.from }
    };
  }

  async hangup(input) {
    return { provider: this.name, provider_call_id: input.provider_call_id, status: 'canceled' };
  }
}
