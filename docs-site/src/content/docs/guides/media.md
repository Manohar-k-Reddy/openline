---
title: Join call audio yourself
description: Connect your own code to a call's audio over the media WebSocket.
---

Instead of the gateway connecting to your agent ([streams](../agent-streams/)), your code can
connect to the gateway and exchange the call's audio directly. Useful for scripts, testing, and
agents that can't accept incoming connections.

## Connect

```text
wss://<gateway>/v1/calls/{callId}/media
Authorization: Bearer <api key>        (or ?apiKey=<key> where headers aren't possible)
```

You can connect before the call is answered. Audio starts when the phone starts streaming:

```json
{"type":"start","callId":"8c1d…","format":{"encoding":"pcm_s16le","sampleRate":16000,"channels":1,"frameMs":20}}
```

## Audio

- **From the gateway:** binary frames of the other person's voice, 16 kHz mono 16-bit
  little-endian PCM, 20 ms (640 bytes) each.
- **To the gateway:** binary PCM in the same format. Any length works; it's played in order.
- **Interrupt:** send `{"type":"clear"}` to drop audio that hasn't played yet.
- **End:** `{"type":"stop","callId":"…","reason":"device_media_closed"}` when the phone stops
  streaming. Hang up with `POST /v1/calls/{id}/hangup`.

Only one talking client per call; a new one replaces the old.

```python
import asyncio, json, websockets

async def main(call_id):
    url = f"wss://your-openline/v1/calls/{call_id}/media"
    async with websockets.connect(url, additional_headers={"Authorization": "Bearer gw_..."}) as ws:
        async for msg in ws:
            if isinstance(msg, bytes):
                await ws.send(msg)            # echo the caller back to them
            else:
                print(json.loads(msg))

asyncio.run(main("8c1d..."))
```

## Listen only

Add `?mode=listen` to hear both sides without being able to talk (as many listeners as you
like). Each binary frame starts with one byte saying whose audio it is:

| First byte | Audio |
|---|---|
| `0x01` | The other person on the call |
| `0x02` | What your agent or code is sending into the call |

The rest of the frame is 16 kHz PCM. Listeners also get `start`, `stop` and `clear` messages.
The console's **Listen in** button uses this.
