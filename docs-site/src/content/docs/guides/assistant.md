---
title: Built-in AI assistant
description: A Gemini Live voice assistant that answers calls for you and takes messages.
---

The gateway includes a ready-made assistant on Google's Gemini Live API. It's a personal
receptionist: it answers, says it's your assistant, asks who's calling and why, offers to take
a message, and hangs up politely. For anything custom, use
[your own agent](../agent-streams/) instead.

## Turn it on

1. Get a Gemini API key at aistudio.google.com.
2. Console **Settings → AI assistant**: paste the key and save. (Or `GEMINI_API_KEY` in
   `server/.env`.)
3. Console **Playground → Assistant**: set **Answers on behalf of** to your name, optionally fill
   **About you**, and turn on **Answer incoming calls for me**.

**About you** is what the assistant may tell callers ("Alex is travelling until Monday; for the
bike service, he'll pick it up Saturday"). Write it in the third person and include only what
you're happy for any caller to hear.

## On a single call

```bash
curl -X POST $OPENLINE_URL/v1/calls/$CALL_ID/agent -H "Authorization: Bearer $OPENLINE_KEY"   # hand over
curl -X DELETE $OPENLINE_URL/v1/calls/$CALL_ID/agent -H "Authorization: Bearer $OPENLINE_KEY" # take back
curl $OPENLINE_URL/v1/calls/$CALL_ID/agent -H "Authorization: Bearer $OPENLINE_KEY"           # status + live transcript
```

## Messages

When a caller leaves a message, it's saved with their name, reason, callback number and urgency:

```bash
curl $OPENLINE_URL/v1/agent/messages -H "Authorization: Bearer $OPENLINE_KEY"
```

The full conversation is at `GET /v1/calls/{id}/transcript`.

## Settings

`GET /v1/agent` / `PUT /v1/agent` with `autoAnswer`, `ownerName`, `about` and `voice` (a Gemini
voice name such as `Kore`, `Puck` or `Charon`). The model can be changed in Settings.
