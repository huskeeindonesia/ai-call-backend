const base = process.env.BASE_URL || 'http://localhost:8080';
const token = process.env.API_AUTH_TOKEN || 'replace-me';

async function run() {
  const health = await fetch(`${base}/health`);
  console.log('health', health.status, await health.text());

  const payload = {
    provider: 'twilio',
    to: '+6281234567890',
    from: '+6200000000000',
    first_message_template: 'Halo {{name}}, ini AI agent Huskee.',
    system_prompt_template: 'You are helpful call assistant',
    variables: { name: 'Budi' },
    structured_output_schema: { type: 'object', properties: { result: { type: 'string' } } },
    conversation_rules: {},
    termination_rules: { max_duration_seconds: 180 }
  };

  const res = await fetch(`${base}/v1/calls/outbound`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(payload)
  });

  console.log('outbound', res.status, await res.text());
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
