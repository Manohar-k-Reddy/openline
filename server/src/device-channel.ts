import type { Server as HttpServer, IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { deviceHealthSchema, deviceInboundMessageSchema } from "./schemas.js";
import type { StateStore } from "./state.js";
import type { DeviceAction, DeviceCommand, DeviceEvent } from "./types.js";

export interface DeviceCommandChannel {
  isConnected(deviceId: string): boolean;
  disconnect?(deviceId: string): void;
  send(
    deviceId: string,
    input: { action: DeviceAction; callId: string; payload?: Record<string, unknown> },
  ): DeviceCommand;
}

type EventHandler = (deviceId: string, event: DeviceEvent) => Promise<void>;

export class DeviceOfflineError extends Error {
  constructor(deviceId: string) {
    super(`device ${deviceId} is offline`);
    this.name = "DeviceOfflineError";
  }
}

/** Server pings each phone this often: measures latency, keeps tunnels from idling the socket out. */
const PING_INTERVAL_MS = 20_000;

export class DeviceWebSocketHub implements DeviceCommandChannel {
  private readonly server = new WebSocketServer({ noServer: true });
  private readonly sockets = new Map<string, WebSocket>();

  constructor(
    private readonly state: StateStore,
    private readonly onEvent: EventHandler,
  ) {}

  attach(httpServer: HttpServer): void {
    httpServer.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (url.pathname !== "/v1/device-channel") return;

      const deviceId = url.searchParams.get("deviceId") ?? headerString(request, "x-device-id");
      const deviceToken =
        url.searchParams.get("deviceToken") ?? headerString(request, "x-device-token");

      if (!deviceId || !this.state.verifyDeviceToken(deviceId, deviceToken)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }

      this.server.handleUpgrade(request, socket, head, (ws) => {
        this.handleConnection(ws, deviceId);
      });
    });
  }

  private handleConnection(socket: WebSocket, deviceId: string): void {
      const previous = this.sockets.get(deviceId);
      if (previous && previous !== socket) previous.close(4000, "replaced by newer connection");
      this.sockets.set(deviceId, socket);
      this.state.setDeviceConnected(deviceId, true);

      // A phone that misses two pings in a row is gone (network switch, frozen app): drop it so it
      // shows offline at once instead of whenever TCP notices.
      let pingSentAt = 0;
      let awaitingPong = false;
      const pinger = setInterval(() => {
        if (awaitingPong) {
          socket.terminate();
          return;
        }
        awaitingPong = true;
        pingSentAt = Date.now();
        socket.ping();
      }, PING_INTERVAL_MS);
      pinger.unref();
      socket.on("pong", () => {
        awaitingPong = false;
        this.state.setDeviceLatency(deviceId, Date.now() - pingSentAt);
      });

      socket.on("message", async (raw) => {
        this.state.touchDevice(deviceId);
        let decoded: unknown;
        try {
          decoded = JSON.parse(raw.toString());
        } catch {
          sendJson(socket, { type: "error", code: "INVALID_JSON", message: "message must be JSON" });
          return;
        }

        if ((decoded as { type?: unknown })?.type === "health") {
          const health = deviceHealthSchema.safeParse(decoded);
          if (health.success) {
            const { type: _type, ...report } = health.data;
            this.state.setDeviceHealth(deviceId, report);
          }
          return;
        }

        const parsed = deviceInboundMessageSchema.safeParse(decoded);
        if (!parsed.success) {
          sendJson(socket, {
            type: "error",
            code: "INVALID_EVENT",
            message: "invalid device event",
            issues: parsed.error.issues,
          });
          return;
        }

        if (parsed.data.type === "ack") {
          this.state.touchDevice(deviceId);
          return;
        }

        try {
          await this.onEvent(deviceId, parsed.data);
          sendJson(socket, { type: "event.ack", eventId: parsed.data.eventId });
        } catch (error) {
          sendJson(socket, {
            type: "error",
            code: "EVENT_REJECTED",
            message: error instanceof Error ? error.message : "event rejected",
            eventId: parsed.data.eventId,
          });
        }
      });

      socket.on("close", () => {
        clearInterval(pinger);
        if (this.sockets.get(deviceId) === socket) {
          this.sockets.delete(deviceId);
          this.state.setDeviceConnected(deviceId, false);
        }
      });
  }

  isConnected(deviceId: string): boolean {
    return this.sockets.get(deviceId)?.readyState === WebSocket.OPEN;
  }

  disconnect(deviceId: string): void {
    const socket = this.sockets.get(deviceId);
    if (socket) socket.close(4001, "device credential rotated");
  }

  send(
    deviceId: string,
    input: { action: DeviceAction; callId: string; payload?: Record<string, unknown> },
  ): DeviceCommand {
    const socket = this.sockets.get(deviceId);
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new DeviceOfflineError(deviceId);

    const command: DeviceCommand = {
      type: "command",
      commandId: randomUUID(),
      callId: input.callId,
      action: input.action,
      ...(input.payload ? { payload: input.payload } : {}),
    };
    sendJson(socket, command);
    return command;
  }
}

function headerString(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function sendJson(socket: WebSocket, value: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}
