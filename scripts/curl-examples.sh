#!/usr/bin/env bash
set -euo pipefail
BASE_URL=${BASE_URL:-http://localhost:8080}
TOKEN=${API_AUTH_TOKEN:-replace-me}

curl -sS "$BASE_URL/health" | jq .

CALL_ID=$(curl -sS -X POST "$BASE_URL/v1/calls/outbound" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "provider":"twilio",
    "to":"+6281234567890",
    "from":"+6200000000000",
    "first_message_template":"Halo {{name}}, ini AI Huskee.",
    "system_prompt_template":"You are a calling assistant",
    "variables":{"name":"Budi"},
    "structured_output_schema":{"type":"object","properties":{"result":{"type":"string"}}},
    "conversation_rules":{},
    "termination_rules":{"max_duration_seconds":180},
    "provider_options":{}
  }' | jq -r '.call_id')

echo "call_id=$CALL_ID"

curl -sS "$BASE_URL/v1/calls/$CALL_ID" -H "Authorization: Bearer $TOKEN" | jq .
curl -sS "$BASE_URL/v1/calls/$CALL_ID/details" -H "Authorization: Bearer $TOKEN" | jq .
curl -sS -X POST "$BASE_URL/v1/calls/$CALL_ID/hangup" -H "Authorization: Bearer $TOKEN" | jq .
