# ai-call-backend

Backend-only project for AI outbound calling (TRD-aligned scaffold).

## Current build status
Night sprint **build-first** completed for infrastructure skeleton:
- Express API + auth middleware
- Provider-agnostic adapter interface (Twilio/Telnyx stubs)
- Realtime orchestrator skeleton
- Call state manager + event timeline
- Core endpoints ready
- Supabase schema draft (`db/schema.sql`)
- Dockerfile + `.env.example`

> Integrasi credentialed provider/OpenAI/Supabase akan diaktifkan setelah `.env` diisi.

## Endpoints
- `GET /health`
- `POST /v1/calls/outbound`
- `GET /v1/calls/:callId`
- `GET /v1/calls/:callId/details`
- `POST /v1/calls/:callId/hangup`

## Quick start
```bash
cp .env.example .env
npm install
npm start
```

## Smoke test
```bash
PORT=18080 API_AUTH_TOKEN=replace-me node src/index.js
# terminal lain
BASE_URL=http://localhost:18080 API_AUTH_TOKEN=replace-me node scripts/smoke.js
```

## cURL samples
See `scripts/curl-examples.sh`.

## Architecture folders
- `src/routes` HTTP routes
- `src/services` business logic
- `src/providers` voice adapters
- `src/realtime` AI realtime orchestration
- `src/repositories` persistence abstraction (in-memory for now)
- `db` SQL schema draft
