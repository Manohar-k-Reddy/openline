---
title: Concepts
description: Phones, calls, events, streams and keys, in one page.
---

## Phones (devices)

A phone is an Android handset running the OpenLine app and paired with your server. Each has an
id like `phone-7f3a91c2`, which you pass as `deviceId` when placing a call. A phone holds a
WebSocket to the server; while it's open the phone is `connected`. The server pings it every 20
seconds and shows its response time and health (battery, network, signal, call-audio helper).

## Calls

A call has an `id`, a `direction` (`outgoing` or `incoming`), the `remoteNumber`, and a `state`
that moves through `queued → dialing → active → ended` (or `ringing`, `held`, `rejected`,
`failed`). Incoming calls appear on their own as soon as the phone rings. Calls are stored, so
`GET /v1/calls` is your call log. [States and events](../../reference/call-states/).

## Commands are asynchronous

`POST /v1/calls`, `/answer`, `/hangup` and the other actions return `202` when the **phone has
received** the command, not when the carrier has done it. The real outcome arrives as an event:
`call.active` when someone picks up, `call.disconnected` when it ends. Build on events, not on
the `202`.

## Events and webhooks

The phone reports every change as an event (`call.ringing`, `call.active`, ...). The server
updates the call, stores the event, and POSTs it to your webhook: the call's own `webhookUrl`, or
the default one in Settings. Deliveries are signed and retried.
[Webhooks](../../guides/webhooks/).

## Audio

Call audio is 16 kHz mono 16-bit PCM in 20 ms frames. There are two ways to use it:

- **Streams (recommended for agents):** give the call a `stream` URL and the gateway connects to
  your agent's WebSocket when the call is answered, in raw or Twilio format.
  [Connect an AI agent](../../guides/agent-streams/).
- **Media WebSocket:** your code connects to `/v1/calls/{id}/media` itself.
  [Join call audio yourself](../../guides/media/).

## API keys and accounts

Programs authenticate with **API keys** (`Authorization: Bearer gw_...`), created in Settings,
one per app so you can revoke them separately. The key in `server/.env` always works too. People
sign in to the **console** with an email and password; that login isn't used by the API.
