import dotenv from 'dotenv';

dotenv.config();

function required(name, fallback = '') {
  const val = process.env[name] ?? fallback;
  return val;
}

export const env = {
  port: Number(process.env.PORT || 8080),
  apiAuthToken: required('API_AUTH_TOKEN', 'replace-me'),
  defaultProvider: required('DEFAULT_PROVIDER', 'twilio'),
  defaultLanguage: required('DEFAULT_LANGUAGE', 'id'),
  defaultVoiceModel: required('DEFAULT_VOICE_MODEL', 'gpt-realtime-mini'),
  openAiApiKey: required('OPENAI_API_KEY', ''),
  openAiRealtimeModel: required('OPENAI_REALTIME_MODEL', 'gpt-realtime-mini'),
  supabaseUrl: required('SUPABASE_URL', ''),
  supabaseServiceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY', ''),
  twilio: {
    accountSid: required('TWILIO_ACCOUNT_SID', ''),
    authToken: required('TWILIO_AUTH_TOKEN', ''),
    fromNumber: required('TWILIO_FROM_NUMBER', '')
  },
  telnyx: {
    apiKey: required('TELNYX_API_KEY', ''),
    fromNumber: required('TELNYX_FROM_NUMBER', '')
  },
  publicUrl: required('PUBLIC_URL', `http://localhost:${process.env.PORT || 8080}`)
};

export function assertBootConfig() {
  return {
    readyForProviderTwilio: Boolean(env.twilio.accountSid && env.twilio.authToken),
    readyForProviderTelnyx: Boolean(env.telnyx.apiKey),
    readyForOpenAI: Boolean(env.openAiApiKey),
    readyForSupabase: Boolean(env.supabaseUrl && env.supabaseServiceRoleKey)
  };
}
