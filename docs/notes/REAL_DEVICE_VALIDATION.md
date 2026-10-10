# Physical Device Validation — Vivo V40

Date: 2026-09-07

Device: **Vivo V40**

Purpose: validate that the Android gateway works with a real SIM/carrier after the Android emulator/proxy-SIM tests passed.

## Test environment

During the validation session:

```text
Gateway host Wi-Fi IPv4: 10.29.38.219
Gateway TCP port:        8787
Gateway bind address:    0.0.0.0
Android device ID:       vivo-v40
Device WebSocket:        ws://10.29.38.219:8787/v1/device-channel
```

The LAN IP is historical and is expected to change between networks/sessions.

API keys, device tokens, and the real destination phone number used during the test are intentionally omitted.

## Setup observations

The APK was sideloaded. Vivo/Android initially displayed restricted-settings protection when the app attempted to become the default Phone app. Selecting the app manually under Default Apps also initially hit the same platform restriction.

Once the phone was configured with HTTP Gateway Dialer as the active dialer and the device credentials were entered, the gateway connection succeeded.

The Windows host showed a live established TCP connection from the phone to local port `8787`.

## Outgoing real SIM call

The outgoing call was created from the server REST API rather than from the phone UI.

```text
POST /v1/calls
    |
    v
Gateway server
    |
    v
Authenticated WebSocket
    |
    v
Vivo V40 Android client
    |
    v
TelecomManager.placeCall
    |
    v
Physical SIM / carrier
    |
    v
Remote phone rang
```

The remote party answered the call.

Result: **PASS**.

## Remote hangup of outgoing call

Action:

```text
POST /v1/calls/:callId/hangup
```

The phone disconnected the real carrier call.

Result: **PASS**.

## Incoming call discovery

A second phone placed a real call to the Vivo V40.

The Android client reported the call to the gateway and the server exposed an incoming ID of the form:

```text
call_<uuid>
```

The current call could be discovered through:

```text
GET /v1/calls?deviceId=vivo-v40
```

Result: **PASS**.

## Hold

Action:

```text
POST /v1/calls/:callId/hold
```

The server returned `accepted: true`, and the user confirmed the real call was held.

Result: **PASS**.

## Unhold

Action:

```text
POST /v1/calls/:callId/unhold
```

The server returned `accepted: true`, and the user confirmed the real call resumed.

Result: **PASS**.

## DTMF

Action:

```text
POST /v1/calls/:callId/dtmf
Content-Type: application/json

{"digits":"12#"}
```

The server returned `accepted: true`, so the command was delivered to the Android client and accepted by the local call-control path.

No IVR or other controlled remote endpoint was available during this test, so remote carrier/IVR reception of those digits was not independently observed.

Result: **PARTIAL PASS** — local command delivery proven; end-to-end remote DTMF receipt still needs an IVR test.

## Hangup of incoming call

Action:

```text
POST /v1/calls/:callId/hangup
```

The real incoming carrier call disconnected.

Result: **PASS**.

## Features not independently re-tested on the physical Vivo

These were already proven on the Android emulator/proxy-SIM but were not yet repeated as explicit remote REST actions on the Vivo during this session:

- answer ringing call;
- reject ringing call.

They remain on the physical-device regression checklist.

## Summary matrix

| Capability | Vivo V40 result |
| --- | --- |
| WebSocket device connection | PASS |
| Incoming call discovery | PASS |
| REST -> outgoing SIM call | PASS |
| Remote party answers outgoing call | PASS |
| Remote hold | PASS |
| Remote unhold | PASS |
| Remote hangup | PASS |
| DTMF command reaches Android | PASS |
| DTMF verified by remote IVR | NOT YET VERIFIED |
| Remote answer action | NOT YET RE-TESTED ON VIVO |
| Remote reject action | NOT YET RE-TESTED ON VIVO |
| Raw call-audio streaming | NOT SUPPORTED ON STOCK ANDROID |

## PowerShell templates used

### Create outgoing call

```powershell
$c=Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8787/v1/calls" -Headers @{"X-API-Key"="<API_KEY>";"Content-Type"="application/json"} -Body '{"deviceId":"vivo-v40","to":"<TEST_NUMBER>"}'; $id=$c.call.id; "Call ID: $id"
```

### Find active/ringing call automatically

```powershell
$id=((Invoke-RestMethod -Uri "http://127.0.0.1:8787/v1/calls?deviceId=vivo-v40" -Headers @{"X-API-Key"="<API_KEY>"}).calls | Where-Object {$_.state -in @("ringing","active","held","dialing")} | Sort-Object {[datetime]$_.updatedAt} -Descending | Select-Object -First 1).id; "Call ID: $id"
```

### Hold

```powershell
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8787/v1/calls/$id/hold" -Headers @{"X-API-Key"="<API_KEY>"}
```

### Unhold

```powershell
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8787/v1/calls/$id/unhold" -Headers @{"X-API-Key"="<API_KEY>"}
```

### DTMF

```powershell
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8787/v1/calls/$id/dtmf" -Headers @{"X-API-Key"="<API_KEY>";"Content-Type"="application/json"} -Body '{"digits":"12#"}'
```

### Hangup

```powershell
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8787/v1/calls/$id/hangup" -Headers @{"X-API-Key"="<API_KEY>"}
```

## Security cleanup recommendation

The local API key and device token were displayed interactively during testing. Before exposing this gateway beyond the trusted LAN, rotate both credentials and run the service behind TLS/WSS.

