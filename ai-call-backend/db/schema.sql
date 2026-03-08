-- Supabase/PostgreSQL schema (initial draft)
create table if not exists calls (
  call_id text primary key,
  provider text not null,
  provider_call_id text,
  status text not null,
  to_number text not null,
  from_number text,
  language text,
  voice_model text,
  request_payload_snapshot jsonb not null,
  final_prompt_snapshot jsonb,
  transcript_summary text,
  structured_output jsonb,
  hangup_reason text,
  ai_session_info jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists call_events (
  id bigserial primary key,
  call_id text not null references calls(call_id) on delete cascade,
  event_type text not null,
  status text,
  payload jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_call_events_call_id_created_at on call_events(call_id, created_at);
