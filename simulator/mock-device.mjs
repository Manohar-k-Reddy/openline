#!/usr/bin/env node

const baseUrl = process.env.HTTP_GATEWAY_BASE_URL ?? "http://127.0.0.1:8787";
const apiKey = process.env.HTTP_GATEWAY_API_KEY ?? "dev-api-key";
const deviceId = process.env.HTTP_GATEWAY_DEVICE_ID ?? "sim_android_01";
const deviceName = process.env.HTTP_GATEWAY_DEVICE_NAME ?? "Mock Android Phone";

const registration = await request("/v1/devices", {
  method: "POST",
  body: {
    deviceId,
    name: deviceName,
    metadata: { simulator: true, platform: "node" },
    rotateToken: true,
  },
});

const deviceToken = registration.deviceToken;
if (!deviceToken) {
  throw new Error("server did not return a deviceToken while rotateToken=true");
}

const wsUrl = new URL(baseUrl);
wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
wsUrl.pathname = registration.deviceChannel?.path ?? "/v1/device-channel";
wsUrl.search = new URLSearchParams({ deviceId, deviceToken }).toString();

const calls = new Map();
const socket = new WebSocket(wsUrl);

socket.addEventListener("open", () => {
  console.log(`MOCK_DEVICE_READY ${deviceId} ${wsUrl.origin}`);
});

socket.addEventListener("message", async (event) => {
  let message;
  try {
    message = JSON.parse(String(event.data));
  } catch {
    console.error("mock-device: ignored invalid JSON from server");
    return;
  }

  if (message.type !== "command") return;
  console.log(`COMMAND ${message.action} ${message.callId}`);

  try {
    await handleCommand(message);
    emit(message.callId, "command.ack", {
      commandId: message.commandId,
      ok: "true",
    });
  } catch (error) {
    emit(message.callId, "command.ack", {
      commandId: message.commandId,
      ok: "false",
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

socket.addEventListener("close", (event) => {
  console.log(`MOCK_DEVICE_CLOSED ${event.code} ${event.reason}`);
});

socket.addEventListener("error", () => {
  console.error("mock-device websocket error");
});

async function handleCommand(command) {
  switch (command.action) {
    case "dial": {
      const number = command.payload?.to;
      if (typeof number !== "string" || !number) throw new Error("number_required");
      calls.set(command.callId, { number, direction: "outgoing", state: "dialing" });
      emitCallState(command.callId, "call.dialing");
      await delay(100);
      const call = requireCall(command.callId);
      call.state = "active";
      emitCallState(command.callId, "call.active");
      break;
    }
    case "answer": {
      const call = requireCall(command.callId);
      call.state = "active";
      emitCallState(command.callId, "call.active");
      break;
    }
    case "reject": {
      const call = requireCall(command.callId);
      call.state = "rejected";
      emitCallState(command.callId, "call.rejected");
      calls.delete(command.callId);
      break;
    }
    case "hangup": {
      const call = requireCall(command.callId);
      call.state = "disconnected";
      emitCallState(command.callId, "call.disconnected");
      calls.delete(command.callId);
      break;
    }
    case "hold": {
      const call = requireCall(command.callId);
      call.state = "holding";
      emitCallState(command.callId, "call.holding");
      break;
    }
    case "unhold": {
      const call = requireCall(command.callId);
      call.state = "active";
      emitCallState(command.callId, "call.active");
      break;
    }
    case "dtmf": {
      requireCall(command.callId);
      const digits = command.payload?.digits;
      if (typeof digits !== "string" || !/^[0-9A-D*#,]+$/i.test(digits)) {
        throw new Error("invalid_dtmf_digits");
      }
      console.log(`DTMF ${command.callId} ${digits}`);
      break;
    }
    default:
      throw new Error(`unsupported_action:${command.action}`);
  }
}

function requireCall(callId) {
  const call = calls.get(callId);
  if (!call) throw new Error("call_not_found");
  return call;
}

function emitCallState(callId, event) {
  const call = requireCall(callId);
  emit(callId, event, {
    number: call.number,
    direction: call.direction,
    nativeCallId: `sim_${callId}`,
  });
}

function emit(callId, event, payload = {}) {
  socket.send(
    JSON.stringify({
      type: "event",
      eventId: crypto.randomUUID(),
      callId,
      event,
      timestamp: new Date().toISOString(),
      payload,
    }),
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
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

process.on("SIGINT", () => socket.close(1000, "shutdown"));
process.on("SIGTERM", () => socket.close(1000, "shutdown"));

