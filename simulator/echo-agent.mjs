// Minimal agent for gateway streams: says nothing, just echoes the caller back after a delay.
// Shows the shape of both formats; replace the echo with your STT -> LLM -> TTS pipeline.
//
//   node simulator/echo-agent.mjs 9000
//   then expose it (e.g. cloudflared tunnel --url http://localhost:9000) and place a call with
//   "stream": {"url": "wss://<tunnel>/ws", "format": "raw"}   (or "twilio")
import { WebSocketServer } from "../server/node_modules/ws/wrapper.mjs";

const port = Number(process.argv[2] ?? 9000);
const server = new WebSocketServer({ port });
console.log(`echo agent on ws://localhost:${port}`);

server.on("connection", (ws) => {
  let streamSid;
  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      // raw: 20 ms frames of 16 kHz s16le from the caller; send PCM back the same way.
      setTimeout(() => ws.send(data, { binary: true }), 500);
      return;
    }
    const msg = JSON.parse(data.toString());
    if (msg.type === "start") console.log("raw stream started", msg);
    if (msg.event === "start") {
      streamSid = msg.streamSid;
      console.log("twilio stream started", msg.start.customParameters);
    }
    if (msg.event === "media") {
      // twilio: base64 8 kHz mu-law from the caller; reply in the same shape.
      const reply = { event: "media", streamSid, media: { payload: msg.media.payload } };
      setTimeout(() => ws.send(JSON.stringify(reply)), 500);
    }
    if (msg.type === "stop" || msg.event === "stop") console.log("stream stopped");
  });
  // Hang up after 30 s: closing the socket ends the call.
  setTimeout(() => ws.close(), 30_000);
});
