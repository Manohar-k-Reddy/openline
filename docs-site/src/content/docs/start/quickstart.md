---
title: Quickstart
description: Run the OpenLine server, pair an Android phone and place your first API phone call in about 15 minutes.
---

You need a Windows, macOS or Linux machine with **Node.js 22.13 or newer**, and an Android phone
(Android 11+) with a SIM that can make calls.

## 1. Run the server

```bash
git clone <your fork of this repo>
cd openline/server
cp .env.example .env
```

Edit `.env` and set `HTTP_GATEWAY_API_KEY` to a long random string. Then:

```bash
npm install
npm run build
npm start
```

On Windows you can double-click `run-server.bat` instead: it does all of the above and also opens
Tailscale Funnel.

Open `http://localhost:8787/`. Create your account (email and password). This is the console.

## 2. Give it a public address

The phone has to reach the server from mobile data, so the server needs an `https://` address.
The quickest is Tailscale Funnel:

```bash
tailscale funnel --bg 8787
```

Copy the address it prints (like `https://your-pc.your-tailnet.ts.net`) into the console under
**Settings → Server → Public address**. [Other options](../../self-hosting/tunnels/).

## 3. Pair the phone

1. Install the OpenLine APK on the phone.
2. In the console, open **Connection**. A QR code appears.
3. In the app, work through the setup steps:
   1. **Default phone app.** Tap **Set**.
   2. **Connect to your gateway.** Tap **Scan QR** and scan the code.
   3. **Call audio.** Tap **Set up**, turn on Wireless debugging, tap **Pair device with pairing
      code**, and type the code into the app's notification. This needs Wi-Fi.
   4. **Stay online in the background.** Tap **Allow**.

The phone appears on the Connection page as online. [More on phone setup](../../guides/phone/).

## 4. Place a call

Create an API key under **Settings → API keys**, then:

```bash
export OPENLINE_URL=https://your-pc.your-tailnet.ts.net
export OPENLINE_KEY=gw_...

# find your phone's id
curl -s $OPENLINE_URL/v1/devices -H "Authorization: Bearer $OPENLINE_KEY"

curl -X POST $OPENLINE_URL/v1/calls \
  -H "Authorization: Bearer $OPENLINE_KEY" -H "content-type: application/json" \
  -d '{"deviceId":"phone-7f3a91c2","to":"+919876543210"}'
```

The phone dials. Watch the call in the console's **Playground**, where you can also talk from
your laptop. End it with:

```bash
curl -X POST $OPENLINE_URL/v1/calls/<call id>/hangup -H "Authorization: Bearer $OPENLINE_KEY"
```

## Next

- [Connect an AI agent](../../guides/agent-streams/) to the call.
- [Get webhooks](../../guides/webhooks/) for call events.
