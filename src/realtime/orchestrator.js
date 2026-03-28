import { nanoid } from 'nanoid';

export class RealtimeOrchestrator {
  async initSession(input) {
    const systemPrompt = renderTemplate(input.system_prompt_template, input.variables);
    const firstMessage = renderTemplate(input.first_message_template, input.variables);
    return {
      ai_session_id: `ai_${nanoid(8)}`,
      model: input.voice_model,
      system_prompt: systemPrompt,
      first_message: firstMessage,
      language: input.language,
      status: 'pending_connection',
    };
  }
}

function renderTemplate(template = '', variables = {}) {
  return template.replace(/{{\s*([\w.-]+)\s*}}/g, (_, key) => {
    const val = variables[key];
    return val == null ? '' : String(val);
  });
}

export const realtimeOrchestrator = new RealtimeOrchestrator();
