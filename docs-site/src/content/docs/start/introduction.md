---
title: Introduction
description: 'What OpenLine is: an open-source, self-hosted voice API that turns an Android phone into a programmable phone line for AI voice agents. How it works and its limits.'
---

OpenLine turns an Android phone with a SIM card into a programmable phone line. Your code places
and answers real calls through a REST API, receives call events by webhook, and streams call
audio over WebSockets. It's a small, self-hosted alternative to Twilio Voice, built for putting
AI voice agents on real phone calls.

## How it works

```text
 Caller's phone ── mobile network ──  Android phone (OpenLine app)
                                            │  WebSocket (commands, events, audio)
                                            ▼
                                     OpenLine server  ── webhooks ──▶ your backend
                                            │
                          REST + WebSocket  ▼
                         your code  /  your AI agent (Pipecat, LiveKit worker, custom)
```

- **The phone** runs the OpenLine app. It's the default phone app, so it can dial, answer and
  hang up. It captures the call's audio and plays your audio into the call, and stays silent
  itself.
- **The server** runs on your machine. It exposes the API, relays audio, sends webhooks and stores
  everything in SQLite. A tunnel (Tailscale Funnel or Cloudflare Tunnel) gives it a public
  `https://` address so the phone can reach it from any network.
- **Your code** uses the API, or lets the server connect calls straight to your agent's
  WebSocket.

## What you can build

- AI agents that make outbound calls (reminders, follow-ups, surveys) and hang up when done.
- An AI receptionist that answers your number, asks why people are calling and takes messages.
- Call automation in plain code: dial, press menu keys, listen, hang up.
- Testing voice agents against real phone lines.

## What it isn't

OpenLine is a v1. It does calls well and leaves out the rest:

- **One line per phone.** Each phone handles one call at a time on its own number. For more
  parallel calls, pair more phones.
- **No SMS, recording, conferencing or call flows (TwiML).** Not yet.
- **Not carrier scale.** It's built for one person or a small team, not thousands of calls.
- **Calls cost what your SIM plan charges.** There's no billing layer.
- **Tested on Android 16 (Vivo).** Call audio relies on Android behaviour that varies by vendor.
  See [Set up the phone](../../guides/phone/).

## Next

- [Quickstart](../quickstart/): run the server, pair a phone and place your first call.
- [Connect an AI agent](../../guides/agent-streams/): the main use case.
