# Mock Android device

This small Node.js process implements the same WebSocket command/event contract
as the Android gateway. It exists so the server can be integration-tested
without placing a real cellular call.

With the server running on port 8787:

```powershell
$env:HTTP_GATEWAY_API_KEY = "dev-api-key"
node .\simulator\mock-device.mjs
```

The simulator registers itself, connects to `/v1/device-channel`, and simulates:

- outgoing dial -> dialing -> active;
- hold / unhold;
- DTMF validation;
- hangup / reject;
- command acknowledgements.

It deliberately does **not** simulate carrier media/audio.

With both the API server and mock device running, execute the reusable
end-to-end lifecycle assertion:

```powershell
$env:HTTP_GATEWAY_API_KEY = "dev-api-key"
node .\simulator\e2e-client.mjs
```

## Media client

`media-client.mjs` connects to a call's media stream, speaks a 16-bit PCM WAV into the call
(resampled to 16 kHz mono) and records the remote party to a WAV:

```bash
HTTP_GATEWAY_API_KEY=... node media-client.mjs [callId|-] speak.wav caller.wav
```

`callId` defaults to the most recent live call. Requires Node 22+.
