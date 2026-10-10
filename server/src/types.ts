export const CALL_STATES = [
  "queued",
  "dialing",
  "ringing",
  "active",
  "held",
  "ended",
  "rejected",
  "failed",
] as const;

export type CallState = (typeof CALL_STATES)[number];
export type CallDirection = "outgoing" | "incoming";

export interface DeviceRecord {
  id: string;
  name?: string;
  metadata?: Record<string, unknown>;
  connected: boolean;
  registeredAt: string;
  lastSeenAt: string;
  health?: DeviceHealth;
  /** Round trip to the phone over its channel, measured by the server. */
  latencyMs?: number;
}

/** What the phone reports about itself every so often. All fields optional; older apps send none. */
export interface DeviceHealth {
  battery?: number;
  charging?: boolean;
  /** "wifi" | "cellular" | "ethernet" | "none" */
  network?: string;
  /** 0 (none) to 4 (great). */
  signal?: number;
  carrier?: string;
  /** Call-audio helper: "running" | "stopped" | "pairing_required" | "unsupported" */
  audio?: string;
  appVersion?: string;
  android?: string;
  model?: string;
  reportedAt?: string;
}

export type StreamFormat = "raw" | "twilio";

/** Where the server streams a call's audio: an external agent's WebSocket. */
export interface StreamConfig {
  url: string;
  format: StreamFormat;
  /** Passed to the agent in the start message (Twilio: start.customParameters). */
  parameters?: Record<string, string>;
}

export interface CallRecord {
  id: string;
  deviceId: string;
  remoteNumber: string;
  direction: CallDirection;
  state: CallState;
  nativeCallId?: string;
  webhookUrl?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  answeredAt?: string;
  endedAt?: string;
  stream?: StreamConfig;
}

export type DeviceAction =
  | "dial"
  | "answer"
  | "reject"
  | "hangup"
  | "hold"
  | "unhold"
  | "dtmf";

export interface DeviceCommand {
  type: "command";
  commandId: string;
  callId: string;
  action: DeviceAction;
  payload?: Record<string, unknown>;
}

export type DeviceEventName =
  | "call.new"
  | "call.connecting"
  | "call.select_phone_account"
  | "call.ringing"
  | "call.dialing"
  | "call.active"
  | "call.holding"
  | "call.disconnecting"
  | "call.disconnected"
  | "call.pulling"
  | "call.audio_processing"
  | "call.simulated_ringing"
  | "call.rejected"
  | "call.failed"
  | "command.completed"
  | "command.ack";

export interface DeviceEvent {
  type: "event";
  eventId: string;
  callId: string;
  event: DeviceEventName;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface DeviceAck {
  type: "ack";
  commandId: string;
  callId: string;
  ok: boolean;
  error?: string;
  timestamp: string;
}

export interface WebhookPayload {
  event: DeviceEventName;
  eventId: string;
  occurredAt: string;
  device: DeviceRecord;
  call: CallRecord;
  payload: Record<string, unknown>;
}
