import { env, assertBootConfig } from '../config/env.js';
import { TwilioAdapter } from './twilio-adapter.js';
import { TelnyxAdapter } from './telnyx-adapter.js';

const readiness = assertBootConfig();

const adapters = {
  twilio: new TwilioAdapter(readiness.readyForProviderTwilio),
  telnyx: new TelnyxAdapter(readiness.readyForProviderTelnyx)
};

export function resolveAdapter(provider = env.defaultProvider) {
  return adapters[provider] || null;
}

export function adapterReadiness() {
  return readiness;
}
