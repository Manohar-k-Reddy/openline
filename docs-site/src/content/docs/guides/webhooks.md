---
title: Webhooks
description: 'Receive OpenLine call events as signed webhooks: payload format, HMAC signature verification in Node.js and Python, retries and the delivery log.'
---

The gateway POSTs every call event to a webhook: the call's own `webhookUrl` if it has one,
otherwise the default from **Settings → Server → Default webhook** (or `WEBHOOK_URL` in `.env`).

## Payload

```json
{
  "event": "call.active",
  "eventId": "evt_5f0c…",
  "occurredAt": "2026-10-10T09:41:07.120Z",
  "device": { "id": "phone-7f3a91c2", "name": "Vivo V2348", "connected": true, … },
  "call": {
    "id": "8c1d…",
    "direction": "outgoing",
    "remoteNumber": "+919876543210",
    "state": "active",
    "answeredAt": "2026-10-10T09:41:07.300Z",
    "metadata": { "orderId": "A-1009" },
    …
  },
  "payload": { "direction": "outgoing", "number": "+919876543210", "state": "active" }
}
```

`call` is the call **after** the event. `occurredAt` is the phone's clock; use the call's
timestamps (server clock) for ordering. [All event names](../../reference/call-states/).

## Verify the signature

Each request has two headers:

- `x-openline-timestamp`: Unix seconds.
- `x-openline-signature`: `sha256=` + hex HMAC-SHA256 of `"<timestamp>.<raw body>"`.

The secret is `WEBHOOK_SECRET` from `server/.env`, or `HTTP_GATEWAY_API_KEY` if that isn't set.

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(rawBody, headers, secret) {
  const timestamp = headers["x-openline-timestamp"];
  const expected = "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const given = String(headers["x-openline-signature"] ?? "");
  const fresh = Math.abs(Date.now() / 1000 - Number(timestamp)) < 300;
  return fresh && given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}
```

```python
import hmac, hashlib, time

def verify(raw_body: bytes, headers, secret: str) -> bool:
    ts = headers["x-openline-timestamp"]
    expected = "sha256=" + hmac.new(secret.encode(), f"{ts}.".encode() + raw_body, hashlib.sha256).hexdigest()
    fresh = abs(time.time() - int(ts)) < 300
    return fresh and hmac.compare_digest(expected, headers.get("x-openline-signature", ""))
```

Use the raw request body, before any JSON parsing.

## Retries

Reply with any `2xx` within 5 seconds. Otherwise the gateway retries after 5 seconds, 30 seconds
and 2 minutes (4 attempts in all). Every attempt is logged:

```bash
curl "$OPENLINE_URL/v1/webhook-deliveries?callId=$CALL_ID" -H "Authorization: Bearer $OPENLINE_KEY"
```

Events can arrive more than once and, with retries, out of order. Use `eventId` to de-duplicate
and the call's `state` as the truth.
