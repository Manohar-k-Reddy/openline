---
title: Set up the phone
description: Install the OpenLine app, pair it, enable call audio and keep it online.
---

The phone is the line. It needs Android 11 or newer, a SIM that can make calls, and the OpenLine
app. Use a spare phone if you can: the app becomes its default phone app.

## Setup steps in the app

1. **Default phone app.** Lets the app place, answer and end calls.
2. **Connect to your gateway.** Scan the QR code from the console's **Connection** page. The app
   exchanges the one-time code for its own credentials and connects to
   `wss://<public address>/v1/device-channel`.
3. **Call audio.** A one-time pairing with Android's Wireless debugging. The app uses it to start
   a small helper with the permissions needed to capture and play call audio, so no root or PC is
   needed. Tap **Set up**, turn on **Wireless debugging**, tap **Pair device with pairing code**,
   and type the 6-digit code into the app's notification.
4. **Stay online in the background.** Allow the app to ignore battery optimisation. On Vivo,
   also set **Battery → Background power consumption → Allow** for OpenLine.

## Wi-Fi and mobile data

Android only runs Wireless debugging while the phone is **connected to a Wi-Fi network**. The
call-audio helper is started through it, so:

- The first start needs Wi-Fi (any network, including another phone's hotspot). The app shows a
  **Connect to a Wi-Fi network** prompt when it needs it.
- On that first start the app also switches Android's debugging to a mode that works on any
  network. After that, calls and call audio work on mobile data until the phone restarts.
- After a reboot, connect to Wi-Fi once more.

The connection to the server itself works on any network, and the app reconnects by itself
when the phone switches between Wi-Fi and mobile data.

## Silent by design

During calls the phone puts the call in "audio processing" mode: the caller hears your agent,
your agent hears the caller, and nothing plays through the phone's speaker or earpiece.

## Health

The console's **Connection** page shows, for each phone: online state, response time, network,
signal and carrier, battery, and whether call audio is ready. The same data is in
`GET /v1/devices` under `health` and `latencyMs`.

## Vendor notes

Call audio depends on Android behaviour that differs between manufacturers. It's tested on a
Vivo V40 with Android 16. Other phones may need tweaks; check
[Troubleshooting](../../self-hosting/troubleshooting/).
