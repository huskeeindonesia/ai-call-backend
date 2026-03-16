-- ai-call-backend schema
-- Statuses mirror src/core/state-machine.js exactly

-- ─── updated_at auto-trigger ────────────────────────────────────────────────
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ─── calls ──────────────────────────────────────────────────────────────────
create table if not exists calls (
  call_id                  text        primary key,
  direction                text        not null default 'outbound'
                             constraint calls_direction_check
                             check (direction in ('outbound', 'inbound')),
  provider                 text        not null,
  provider_call_id         text,
  status                   text        not null
                             constraint calls_status_check
                             check (status in (
                               'queued', 'dialing', 'ringing', 'answered',
                               'in_progress', 'voicemail',
                               'completed', 'failed', 'canceled'
                             )),
  to_number                text        not null,
  from_number              text,
  language                 text,
  voice_model              text,
  call_duration_seconds    integer,
  request_payload_snapshot jsonb       not null,
  final_prompt_snapshot    jsonb,
  transcript_summary       text,
  structured_output        jsonb,
  hangup_reason            text,
  ai_session_info          jsonb,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create or replace trigger calls_set_updated_at
  before update on calls
  for each row execute function set_updated_at();

-- ─── call_events ─────────────────────────────────────────────────────────────
create table if not exists call_events (
  id         bigserial   primary key,
  call_id    text        not null references calls(call_id) on delete cascade,
  event_type text        not null,
  status     text,
  payload    jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_call_events_call_id_created_at
  on call_events(call_id, created_at);
