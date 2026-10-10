---
title: Handle incoming calls
description: Three ways to deal with calls to your phone's number.
---

When someone calls the phone's number, the gateway creates a call with `direction: "incoming"`
and `state: "ringing"`, and sends a `call.ringing` webhook. Then one of three things handles it.

## 1. Stream every call to your agent

Set **Settings → Incoming calls → Stream to your agent** (or `incomingStreamUrl` via
`PUT /v1/settings`). Every call is answered and connected to your agent's WebSocket.
[Details](../agent-streams/#incoming-calls).

## 2. Decide in your code

Leave the stream URL empty and handle the `call.ringing` webhook:

```js
app.post("/gateway/events", async (req, res) => {
  res.sendStatus(200);                       // reply fast; act afterwards
  const { event, call } = req.body;
  if (event !== "call.ringing" || call.direction !== "incoming") return;

  if (isBlocked(call.remoteNumber)) {
    await openline(`/v1/calls/${call.id}/reject`);
    return;
  }
  // answer and hand it to an agent in one step
  await openline(`/v1/calls/${call.id}/stream`, { url: "wss://agent.example.com/ws", format: "raw" });
});

const openline = (path, body) =>
  fetch(process.env.OPENLINE_URL + path, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.OPENLINE_KEY}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
```

`POST /v1/calls/{id}/stream` on a ringing call answers it and connects your agent once it's
active. To answer without an agent, `POST /v1/calls/{id}/answer` and join the audio yourself
([media WebSocket](../media/)).

## 3. The built-in assistant

Turn on **Answer incoming calls for me** in the Playground. A Gemini voice assistant answers,
asks who's calling and why, and leaves you a message. [Built-in AI assistant](../assistant/).

## Which wins

If an incoming stream URL is set, it handles the call and the assistant stays out. Otherwise the
assistant answers if auto-answer is on. Otherwise the call keeps ringing until your code (or the
caller) does something.
