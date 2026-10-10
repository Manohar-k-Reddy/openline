import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { json, parseJson, type Database } from "./db.js";
import type {
  CallDirection,
  CallRecord,
  CallState,
  DeviceEvent,
  DeviceHealth,
  DeviceRecord,
  StreamConfig,
} from "./types.js";

interface DeviceRow {
  id: string;
  name: string | null;
  metadata: string | null;
  token_hash: string | null;
  registered_at: string;
  last_seen_at: string;
  health: string | null;
  health_at: string | null;
}

interface CallRow {
  id: string;
  device_id: string;
  remote_number: string;
  direction: string;
  state: string;
  native_call_id: string | null;
  webhook_url: string | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
  answered_at: string | null;
  ended_at: string | null;
  stream: string | null;
}

export interface CallQuery {
  deviceId?: string;
  state?: CallState;
  direction?: CallDirection;
  /** Only calls created before this ISO time (cursor for paging). */
  before?: string;
  limit?: number;
}

export interface StoredCallEvent {
  event: string;
  eventId: string;
  payload: Record<string, unknown>;
  occurredAt: string;
  receivedAt: string;
}

const ENDED_STATES = new Set<CallState>(["ended", "rejected", "failed"]);

/**
 * Phones, calls and call events, persisted in SQLite. Only the live socket state ("connected") is
 * kept in memory: after a restart every phone is offline until it reconnects.
 */
export class StateStore {
  private readonly connected = new Set<string>();
  private readonly latency = new Map<string, number>();

  constructor(private readonly db: Database) {}

  // ---- devices ----

  upsertDevice(input: { id: string; name?: string; metadata?: Record<string, unknown> }): DeviceRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO devices (id, name, metadata, registered_at, last_seen_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           name = COALESCE(excluded.name, devices.name),
           metadata = COALESCE(excluded.metadata, devices.metadata),
           last_seen_at = excluded.last_seen_at`,
      )
      .run(input.id, input.name ?? null, json(input.metadata), now, now);
    return this.getDevice(input.id)!;
  }

  removeDevice(deviceId: string): boolean {
    this.connected.delete(deviceId);
    return Number(this.db.prepare("DELETE FROM devices WHERE id = ?").run(deviceId).changes) > 0;
  }

  setDeviceConnected(deviceId: string, connected: boolean): DeviceRecord {
    if (connected) this.connected.add(deviceId);
    else {
      this.connected.delete(deviceId);
      this.latency.delete(deviceId);
    }
    return this.touchDevice(deviceId);
  }

  touchDevice(deviceId: string): DeviceRecord {
    if (!this.getDevice(deviceId)) return this.upsertDevice({ id: deviceId });
    this.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(new Date().toISOString(), deviceId);
    return this.getDevice(deviceId)!;
  }

  /** Latest health report from the phone (battery, network, signal, audio helper). */
  setDeviceHealth(deviceId: string, health: DeviceHealth): void {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE devices SET health = ?, health_at = ?, last_seen_at = ? WHERE id = ?")
      .run(JSON.stringify(health), now, now, deviceId);
  }

  setDeviceLatency(deviceId: string, latencyMs: number): void {
    this.latency.set(deviceId, latencyMs);
  }

  getDevice(deviceId: string): DeviceRecord | undefined {
    const row = this.db.prepare("SELECT * FROM devices WHERE id = ?").get(deviceId) as DeviceRow | undefined;
    return row ? this.toDevice(row) : undefined;
  }

  listDevices(): DeviceRecord[] {
    const rows = this.db.prepare("SELECT * FROM devices ORDER BY registered_at").all() as unknown as DeviceRow[];
    return rows.map((row) => this.toDevice(row));
  }

  setDeviceToken(deviceId: string, token: string): void {
    this.db.prepare("UPDATE devices SET token_hash = ? WHERE id = ?").run(hashToken(token), deviceId);
  }

  hasDeviceToken(deviceId: string): boolean {
    return Boolean(this.tokenHash(deviceId));
  }

  verifyDeviceToken(deviceId: string | null | undefined, token: string | null | undefined): boolean {
    const expected = deviceId ? this.tokenHash(deviceId) : undefined;
    if (!expected || !token) return false;
    return timingSafeEqual(Buffer.from(hashToken(token)), Buffer.from(expected));
  }

  private tokenHash(deviceId: string): string | undefined {
    const row = this.db.prepare("SELECT token_hash FROM devices WHERE id = ?").get(deviceId) as
      | { token_hash: string | null }
      | undefined;
    return row?.token_hash ?? undefined;
  }

  private toDevice(row: DeviceRow): DeviceRecord {
    const latencyMs = this.latency.get(row.id);
    return {
      id: row.id,
      name: row.name ?? undefined,
      metadata: parseJson(row.metadata),
      connected: this.connected.has(row.id),
      registeredAt: row.registered_at,
      lastSeenAt: row.last_seen_at,
      ...(row.health ? { health: { ...parseJson<DeviceHealth>(row.health)!, reportedAt: row.health_at! } } : {}),
      ...(latencyMs !== undefined ? { latencyMs } : {}),
    };
  }

  // ---- calls ----

  createOutgoingCall(input: {
    deviceId: string;
    to: string;
    webhookUrl?: string;
    metadata?: Record<string, unknown>;
    stream?: StreamConfig;
  }): CallRecord {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO calls (id, device_id, remote_number, direction, state, webhook_url, metadata, stream, created_at, updated_at)
         VALUES (?, ?, ?, 'outgoing', 'queued', ?, ?, ?, ?, ?)`,
      )
      .run(id, input.deviceId, input.to, input.webhookUrl ?? null, json(input.metadata), json(input.stream), now, now);
    return this.getCall(id)!;
  }

  setCallStream(callId: string, stream: StreamConfig | undefined): CallRecord | undefined {
    this.db.prepare("UPDATE calls SET stream = ? WHERE id = ?").run(json(stream), callId);
    return this.getCall(callId);
  }

  getCall(callId: string): CallRecord | undefined {
    const row = this.db.prepare("SELECT * FROM calls WHERE id = ?").get(callId) as CallRow | undefined;
    return row ? toCall(row) : undefined;
  }

  setCallState(callId: string, state: CallState): CallRecord | undefined {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE calls SET state = ?, updated_at = ?,
           ended_at = CASE WHEN ? THEN COALESCE(ended_at, ?) ELSE ended_at END
         WHERE id = ?`,
      )
      .run(state, now, ENDED_STATES.has(state) ? 1 : 0, now, callId);
    return this.getCall(callId);
  }

  listCalls(query: CallQuery | string = {}): CallRecord[] {
    const q = typeof query === "string" ? { deviceId: query } : query;
    const where: string[] = [];
    const params: string[] = [];
    if (q.deviceId) (where.push("device_id = ?"), params.push(q.deviceId));
    if (q.state) (where.push("state = ?"), params.push(q.state));
    if (q.direction) (where.push("direction = ?"), params.push(q.direction));
    if (q.before) (where.push("created_at < ?"), params.push(q.before));
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
    const sql = `SELECT * FROM calls ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
                 ORDER BY created_at DESC LIMIT ${limit}`;
    return (this.db.prepare(sql).all(...params) as unknown as CallRow[]).map(toCall);
  }

  /** Stores the raw event; false when this device already sent this eventId (duplicate). */
  recordEvent(deviceId: string, event: DeviceEvent): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO call_events (call_id, device_id, event_id, event, payload, occurred_at, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.callId,
        deviceId,
        event.eventId,
        event.event,
        JSON.stringify(event.payload ?? {}),
        event.timestamp,
        new Date().toISOString(),
      );
    return Number(result.changes) > 0;
  }

  listCallEvents(callId: string): StoredCallEvent[] {
    const rows = this.db
      .prepare("SELECT event, event_id, payload, occurred_at, received_at FROM call_events WHERE call_id = ? ORDER BY seq")
      .all(callId) as { event: string; event_id: string; payload: string; occurred_at: string; received_at: string }[];
    return rows.map((r) => ({
      event: r.event,
      eventId: r.event_id,
      payload: JSON.parse(r.payload) as Record<string, unknown>,
      occurredAt: r.occurred_at,
      receivedAt: r.received_at,
    }));
  }

  applyDeviceEvent(deviceId: string, event: DeviceEvent): CallRecord | undefined {
    if (event.event === "command.ack" || event.event === "command.completed") {
      return this.getCall(event.callId);
    }

    const candidate = this.getCall(event.callId);
    const current = candidate?.deviceId === deviceId ? candidate : undefined;
    // Device clocks are not guaranteed to be synchronized with the gateway.
    // Use server receive time for projection ordering/updatedAt so a drifting
    // handset cannot move a call backwards in time. The original device
    // timestamp remains available on the event/webhook payload.
    const now = new Date().toISOString();
    const number = typeof event.payload.number === "string" ? event.payload.number : undefined;
    const nativeCallId =
      typeof event.payload.nativeCallId === "string" ? event.payload.nativeCallId : undefined;
    const direction =
      event.payload.direction === "incoming" || event.payload.direction === "outgoing"
        ? event.payload.direction
        : undefined;
    const state = eventToCallState(event.event);
    const answeredAt = state === "active" ? now : null;
    const endedAt = ENDED_STATES.has(state) ? now : null;

    if (current) {
      this.db
        .prepare(
          `UPDATE calls SET state = ?, native_call_id = COALESCE(?, native_call_id),
             remote_number = COALESCE(?, remote_number), direction = COALESCE(?, direction), updated_at = ?,
             answered_at = COALESCE(answered_at, ?), ended_at = COALESCE(ended_at, ?)
           WHERE id = ?`,
        )
        .run(state, nativeCallId ?? null, number ?? null, direction ?? null, now, answeredAt, endedAt, current.id);
      return this.getCall(current.id);
    }

    this.db
      .prepare(
        `INSERT INTO calls (id, device_id, remote_number, direction, state, native_call_id, created_at, updated_at, answered_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.callId,
        deviceId,
        number ?? "unknown",
        direction ?? "incoming",
        state,
        nativeCallId ?? null,
        now,
        now,
        answeredAt,
        endedAt,
      );
    return this.getCall(event.callId);
  }
}

function toCall(row: CallRow): CallRecord {
  return {
    id: row.id,
    deviceId: row.device_id,
    remoteNumber: row.remote_number,
    direction: row.direction as CallDirection,
    state: row.state as CallState,
    nativeCallId: row.native_call_id ?? undefined,
    webhookUrl: row.webhook_url ?? undefined,
    metadata: parseJson(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    answeredAt: row.answered_at ?? undefined,
    endedAt: row.ended_at ?? undefined,
    stream: parseJson<StreamConfig>(row.stream),
  };
}

function eventToCallState(
  event: Exclude<DeviceEvent["event"], "command.ack" | "command.completed">,
): CallState {
  switch (event) {
    case "call.new":
      return "queued";
    case "call.connecting":
    case "call.select_phone_account":
    case "call.pulling":
    case "call.dialing":
      return "dialing";
    case "call.ringing":
    case "call.simulated_ringing":
      return "ringing";
    case "call.active":
    case "call.audio_processing":
      return "active";
    case "call.holding":
      return "held";
    case "call.disconnecting":
    case "call.disconnected":
      return "ended";
    case "call.rejected":
      return "rejected";
    case "call.failed":
      return "failed";
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
