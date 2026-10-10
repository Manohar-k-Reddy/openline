---
title: Place and control calls
description: Dial, answer, hang up, hold, press keys, and read the call log.
---

All requests need `Authorization: Bearer <api key>`. Full schemas are in the
[API reference](../../api/).

## Place a call

```bash
curl -X POST $OPENLINE_URL/v1/calls \
  -H "Authorization: Bearer $OPENLINE_KEY" -H "content-type: application/json" \
  -d '{
    "deviceId": "phone-7f3a91c2",
    "to": "+919876543210",
    "webhookUrl": "https://example.com/gateway/events",
    "metadata": { "orderId": "A-1009" }
  }'
```

```json
{
  "call": { "id": "8c1d…", "state": "queued", "direction": "outgoing", "remoteNumber": "+919876543210", … },
  "command": { "commandId": "…", "action": "dial" },
  "media": { "path": "/v1/calls/8c1d…/media", "format": { "encoding": "pcm_s16le", "sampleRate": 16000, "channels": 1, "frameMs": 20 } }
}
```

- `to` is dialled as written. Use the full international format.
- `webhookUrl` gets this call's events instead of the default webhook.
- `metadata` is yours; it comes back on reads and webhooks.
- `stream` connects an AI agent: see [Connect an AI agent](../agent-streams/).
- `409 DEVICE_OFFLINE` means the phone isn't connected right now.

## Control a live call

```bash
curl -X POST $OPENLINE_URL/v1/calls/$CALL_ID/hangup  -H "Authorization: Bearer $OPENLINE_KEY"
curl -X POST $OPENLINE_URL/v1/calls/$CALL_ID/hold    -H "Authorization: Bearer $OPENLINE_KEY"
curl -X POST $OPENLINE_URL/v1/calls/$CALL_ID/unhold  -H "Authorization: Bearer $OPENLINE_KEY"
curl -X POST $OPENLINE_URL/v1/calls/$CALL_ID/dtmf    -H "Authorization: Bearer $OPENLINE_KEY" \
  -H "content-type: application/json" -d '{"digits":"1#"}'
```

For ringing incoming calls: `answer` and `reject`.

Each returns `202` once the phone has the command. Wait for the event (`call.disconnected`,
`call.holding`, ...) to know it happened.

## Read calls

```bash
# newest first; filter by state, direction or phone
curl "$OPENLINE_URL/v1/calls?state=ended&direction=incoming&limit=20" -H "Authorization: Bearer $OPENLINE_KEY"

# next page
curl "$OPENLINE_URL/v1/calls?limit=20&before=<nextBefore from the last page>" -H "Authorization: Bearer $OPENLINE_KEY"

# one call, its events, its transcript
curl $OPENLINE_URL/v1/calls/$CALL_ID            -H "Authorization: Bearer $OPENLINE_KEY"
curl $OPENLINE_URL/v1/calls/$CALL_ID/events     -H "Authorization: Bearer $OPENLINE_KEY"
curl $OPENLINE_URL/v1/calls/$CALL_ID/transcript -H "Authorization: Bearer $OPENLINE_KEY"
```

Calls carry `answeredAt` and `endedAt`, so talk time is `endedAt - answeredAt`.

## Pick a phone

`GET /v1/devices` lists phones with `connected` and `health`. Use one that's connected; a phone
handles one call at a time.
