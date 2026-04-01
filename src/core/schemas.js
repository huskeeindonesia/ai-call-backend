import { z } from 'zod';

const providerEnum = z.enum(['twilio', 'telnyx']);

export const outboundCallSchema = z.object({
  provider: providerEnum.optional(),
  to: z.string().min(6),
  from: z.string().min(6).optional(),
  language: z.string().optional(),
  voice_model: z.string().optional(),
  first_message_template: z.string().min(1),
  system_prompt_template: z.string().min(1),
  variables: z.record(z.any()).default({}),
  structured_output_schema: z.record(z.any()).optional(),
  conversation_rules: z.record(z.any()).default({}),
  termination_rules: z.record(z.any()).default({}),
  provider_options: z.record(z.any()).default({}),
  user_id:     z.union([z.string(), z.number()]).optional(),
  campaign_id: z.union([z.string(), z.number()]).optional(),
  leads_id:    z.union([z.string(), z.number()]).optional(),
});
