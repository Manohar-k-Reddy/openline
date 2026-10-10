#!/usr/bin/env node
// Developer-side media client: speaks a WAV into a live call and records the remote party.
//
// Usage: node media-client.mjs [callId] [speak.wav] [out.wav]
//   callId defaults to the most recent active call.
// Env:   HTTP_GATEWAY_BASE_URL (default http://127.0.0.1:8787), HTTP_GATEWAY_API_KEY
// Needs Node 22+ (global WebSocket).

import { readFileSync, writeFileSync } from "node:fs";

const baseUrl = process.env.HTTP_GATEWAY_BASE_URL ?? "http://127.0.0.1:8787";
const apiKey = process.env.HTTP_GATEWAY_API_KEY ?? "dev-api-key";
const [argCallId, speakPath, outPath = "caller.wav"] = process.argv.slice(2);

const RATE = 16000;
const FRAME_BYTES = 640; // 20 ms of 16 kHz mono s16le

const callId = argCallId && argCallId !== "-" ? argCallId : await latestActiveCallId();
const speech = speakPath ? toPcm16kMono(readFileSync(speakPath)) : null;
const received = [];

const wsUrl = `${baseUrl.replace(/^http/, "ws")}/v1/calls/${encodeURIComponent(callId)}/media?apiKey=${encodeURIComponent(apiKey)}`;
const socket = new WebSocket(wsUrl);
socket.binaryType = "arraybuffer";

socket.addEventListener("open", () => console.log(`connected to media for ${callId}; waiting for phone stream...`));
socket.addEventListener("message", (event) => {
  if (typeof event.data !== "string") {
    received.push(Buffer.from(event.data));
    return;
  }
  const message = JSON.parse(event.data);
  console.log("control:", message);
  if (message.type === "start" && speech) speak(speech);
  if (message.type === "stop") socket.close();
});
socket.addEventListener("close", () => {
  const pcm = Buffer.concat(received);
  writeFileSync(outPath, wav(pcm));
  console.log(`saved ${(pcm.length / 2 / RATE).toFixed(1)} s of caller audio to ${outPath}`);
  process.exit(0);
});
socket.addEventListener("error", (event) => {
  console.error("media socket error:", event.message ?? event);
  process.exit(1);
});
process.on("SIGINT", () => socket.close());

/** Sends PCM in real time (20 ms frames) so the phone's playback queue stays short. */
function speak(pcm) {
  console.log(`speaking ${(pcm.length / 2 / RATE).toFixed(1)} s of audio into the call`);
  const started = Date.now();
  let offset = 0;
  const timer = setInterval(() => {
    const due = Math.floor((Date.now() - started) / 20) + 5; // keep ~100 ms ahead
    while (offset < pcm.length && offset / FRAME_BYTES < due) {
      if (socket.readyState !== WebSocket.OPEN) return clearInterval(timer);
      socket.send(pcm.subarray(offset, offset + FRAME_BYTES));
      offset += FRAME_BYTES;
    }
    if (offset >= pcm.length) {
      clearInterval(timer);
      console.log("finished speaking; still recording (Ctrl+C to stop)");
    }
  }, 20);
}

async function latestActiveCallId() {
  const response = await fetch(`${baseUrl}/v1/calls`, { headers: { "x-api-key": apiKey } });
  if (!response.ok) throw new Error(`GET /v1/calls failed: ${response.status}`);
  const { calls } = await response.json();
  const live = calls
    .filter((call) => ["active", "answered", "holding", "dialing", "ringing"].includes(call.state))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (!live.length) throw new Error("no live call found; pass a callId");
  return live[0].id;
}

/** Decodes a PCM16 WAV and converts it to 16 kHz mono (linear resampling). */
function toPcm16kMono(file) {
  let offset = 12;
  let rate = 0;
  let channels = 1;
  let data;
  while (offset + 8 <= file.length) {
    const id = file.toString("ascii", offset, offset + 4);
    const size = file.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      if (file.readUInt16LE(offset + 8) !== 1 || file.readUInt16LE(offset + 22) !== 16) {
        throw new Error("WAV must be 16-bit PCM");
      }
      channels = file.readUInt16LE(offset + 10);
      rate = file.readUInt32LE(offset + 12);
    } else if (id === "data") {
      data = file.subarray(offset + 8, offset + 8 + size);
    }
    offset += 8 + size + (size % 2);
  }
  if (!data || !rate) throw new Error("not a PCM WAV file");

  const frames = Math.floor(data.length / 2 / channels);
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += data.readInt16LE((i * channels + c) * 2);
    mono[i] = sum / channels;
  }
  const outFrames = Math.floor((frames * RATE) / rate);
  const out = Buffer.alloc(outFrames * 2);
  for (let i = 0; i < outFrames; i++) {
    const pos = (i * rate) / RATE;
    const j = Math.floor(pos);
    const next = mono[Math.min(j + 1, frames - 1)];
    const sample = mono[j] + (next - mono[j]) * (pos - j);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample))), i * 2);
  }
  return out;
}

function wav(pcm) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
