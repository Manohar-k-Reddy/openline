---
title: Troubleshooting
description: Fixes for the problems you're most likely to hit.
---

## The phone shows offline

- **Public address down.** Open `https://<public address>/health` from your phone's browser. It
  should say `{"ok":true}`. If not, check the tunnel (`tailscale funnel status`) and that the
  server is running.
- **App frozen in the background.** Allow step 4 in the app (**Stay online in the background**),
  and on Vivo also **Battery → Background power consumption → Allow**. The app keeps a small
  "Connected to your gateway" notification; if it's gone, open the app.
- **Address changed.** Phones keep the address they were paired with. Pair again.

The Connection page shows the last health report, even when the phone is offline.

## "Connect to a Wi-Fi network" keeps appearing

Android only runs Wireless debugging while the phone is connected to a Wi-Fi network. Having Wi-Fi
switched on isn't enough, and the phone's own hotspot doesn't count. Join any network for a
moment, including another phone's hotspot. After that first start, call audio works on mobile
data until the next reboot.

## Calls connect but there's no audio

- The app's **Call audio** step should say **Ready**. If it says **Stopped**, open the app on
  Wi-Fi.
- If pairing was lost (e.g. after clearing app data), tap **Set up** again.
- `GET /v1/calls/{id}` shows `media.streaming: true` while the phone is sending audio.

## Audio plays on the phone's speaker

The app puts calls in "audio processing" mode as soon as they connect, which keeps the handset
silent. If you hear audio on the phone, make sure OpenLine is the default phone app (step 1).

## My agent never gets a connection

- The URL must be `ws://` or `wss://`, reachable **from the server**.
- `GET /v1/calls/{id}/stream` shows the status and, on failure, the error.
- The stream only starts when the call is answered.

## Webhooks don't arrive

`GET /v1/webhook-deliveries` lists every attempt with the HTTP status or error.

## Forgot the console password

Another account holder can remove and re-add you under **Settings → People with access**. If
you're the only account, stop the server and delete the `users` and `sessions` rows from
`server/data/gateway.db` (any SQLite tool), then create the account again.
