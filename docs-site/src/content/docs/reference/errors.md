---
title: Errors
description: Error format and codes.
---

Every error has the same shape:

```json
{ "error": { "code": "DEVICE_OFFLINE", "message": "device is offline" } }
```

Validation errors add `issues` with the field-level details.

| HTTP | Code | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR` | The body or query didn't validate. See `issues`. |
| 400 | `INVALID_JSON` | The body isn't valid JSON. |
| 401 | `UNAUTHORIZED` | Missing or invalid API key. |
| 404 | `NOT_FOUND` | No such call, phone, key or route. |
| 409 | `DEVICE_OFFLINE` | The phone isn't connected; it can't take commands right now. |
| 409 | `CALL_NOT_LIVE` | Streams can only be attached to live calls. |
| 409 | `AGENT_UNAVAILABLE` | The assistant can't join (no Gemini key, or the call isn't live). |
| 429 | `TOO_MANY_ATTEMPTS` | Too many wrong pairing codes or passwords; wait a minute. |
| 500 | `INTERNAL_ERROR` | A bug. The server log has details. |

Retry `DEVICE_OFFLINE` after the phone reconnects (`GET /v1/devices`). Don't retry `4xx`
errors unchanged.
