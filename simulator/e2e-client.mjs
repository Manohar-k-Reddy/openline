#!/usr/bin/env node

import assert from "node:assert/strict";

const baseUrl = process.env.HTTP_GATEWAY_BASE_URL ?? "http://127.0.0.1:8787";
const apiKey = process.env.HTTP_GATEWAY_API_KEY ?? "dev-api-key";
const deviceId = process.env.HTTP_GATEWAY_DEVICE_ID ?? "sim_android_01";

const devices = await request("/v1/devices");
const device = devices.devices.find((item) => item.id === deviceId);
assert.ok(device, `device ${deviceId} was not registered`);
assert.equal(device.connected, true, "mock device must be connected");

const created = await request("/v1/calls", {
  method: "POST",
  body: { deviceId, to: "5550101", metadata: { test: "e2e" } },
});
assert.equal(created.call.state, "queued");
assert.equal(created.command.action, "dial");
const callId = created.call.id;

await waitForState(callId, "active");

const heldCommand = await action(callId, "hold");
assert.equal(heldCommand.command.action, "hold");
await waitForState(callId, "held");

const dtmfCommand = await action(callId, "dtmf", { digits: "12#" });
assert.equal(dtmfCommand.command.action, "dtmf");

const unholdCommand = await action(callId, "unhold");
assert.equal(unholdCommand.command.action, "unhold");
await waitForState(callId, "active");

const hangupCommand = await action(callId, "hangup");
assert.equal(hangupCommand.command.action, "hangup");
const ended = await waitForState(callId, "ended");

console.log(
  JSON.stringify(
    {
      ok: true,
      deviceId,
      callId,
      lifecycle: ["queued", "dialing", "active", "held", "active", "ended"],
      finalState: ended.call.state,
    },
    null,
    2,
  ),
);

async function action(callId, name, body = {}) {
  return request(`/v1/calls/${callId}/actions/${name}`, { method: "POST", body });
}

async function waitForState(callId, expected, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await request(`/v1/calls/${callId}`);
    if (latest.call.state === expected) return latest;
    await delay(30);
  }
  throw new Error(
    `timed out waiting for ${expected}; last state was ${latest?.call?.state ?? "unknown"}`,
  );
}

async function request(path, { method = "GET", body } = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: {
      "x-api-key": apiKey,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`${method} ${path}: HTTP ${response.status} ${JSON.stringify(data)}`);
  }
  return data;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

