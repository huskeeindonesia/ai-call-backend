export class RealtimeOrchestrator {
  async initSession(input) {
    return {
      ai_session_id: `ai_stub_${input.call_id}`,
      model: input.voice_model,
      first_message_rendered: renderTemplate(input.first_message_template, input.variables),
      status: 'initialized'
    };
  }
}

function renderTemplate(template, variables = {}) {
  return template.replace(/{{\s*([\w.-]+)\s*}}/g, (_, key) => {
    const val = variables[key];
    return val == null ? '' : String(val);
  });
}

export const realtimeOrchestrator = new RealtimeOrchestrator();
