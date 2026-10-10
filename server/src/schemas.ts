import { z } from "zod";
const metadataSchema = z.record(z.string(), z.unknown()).optional();
const optionalHttpUrl = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "webhookUrl must use http or https");

export const registerDeviceSchema = z.object({
  deviceId: z.string().trim().min(1).max(128),
  name: z.string().trim().min(1).max(128).optional(),
  metadata: metadataSchema,
  rotateToken: z.boolean().optional().default(false),
});

export const streamSchema = z.object({
  url: z.string().trim().url().regex(/^wss?:\/\//, "stream url must be ws:// or wss://"),
  format: z.enum(["raw", "twilio"]).default("raw"),
  parameters: z.record(z.string(), z.string().max(500)).optional(),
});

export const createCallSchema = z.object({
  deviceId: z.string().trim().min(1).max(128),
  to: z.string().trim().min(1).max(64),
  webhookUrl: optionalHttpUrl.optional(),
  metadata: metadataSchema,
  /** Stream the call to your agent's WebSocket once it connects. */
  stream: streamSchema.optional(),
});

export const callActionSchema = z.object({
  action: z.enum(["answer", "reject", "hangup", "hold", "unhold", "dtmf"]),
});

export const dtmfBodySchema = z.object({
  digits: z.string().min(1).max(64).regex(/^[0-9*#]+$/, "invalid DTMF digits"),
});

export const emptyActionBodySchema = z.object({}).passthrough();

export const deviceEventSchema = z.object({
  type: z.literal("event"),
  eventId: z.string().min(1).max(128),
  callId: z.string().min(1).max(128),
  event: z.enum([
    "call.new",
    "call.connecting",
    "call.select_phone_account",
    "call.ringing",
    "call.dialing",
    "call.active",
    "call.holding",
    "call.disconnecting",
    "call.disconnected",
    "call.pulling",
    "call.audio_processing",
    "call.simulated_ringing",
    "call.rejected",
    "call.failed",
    "command.completed",
    "command.ack",
  ]),
  timestamp: z.string().datetime({ offset: true }),
  payload: z.record(z.string(), z.unknown()).default({}),
});

export const deviceAckSchema = z.object({
  type: z.literal("ack"),
  commandId: z.string().min(1).max(128),
  callId: z.string().min(1).max(128),
  ok: z.boolean(),
  error: z.string().max(1000).optional(),
  timestamp: z.string().datetime({ offset: true }),
});

export const deviceInboundMessageSchema = z.discriminatedUnion("type", [
  deviceEventSchema,
  deviceAckSchema,
]);

export const agentSettingsSchema = z
  .object({
    autoAnswer: z.boolean(),
    ownerName: z.string().trim().min(1).max(80),
    about: z.string().max(4000),
    voice: z.string().trim().min(1).max(40),
  })
  .partial();

export const pairSchema = z.object({
  code: z.string().trim().min(4).max(32),
  name: z.string().trim().min(1).max(128).optional(),
});

export const pairingRequestSchema = z.object({
  publicUrl: z.string().trim().url().regex(/^https?:\/\//, "must be http(s)").optional(),
});

export const deviceHealthSchema = z.object({
  type: z.literal("health"),
  battery: z.number().int().min(0).max(100).optional(),
  charging: z.boolean().optional(),
  network: z.string().max(20).optional(),
  signal: z.number().int().min(0).max(4).optional(),
  carrier: z.string().max(64).optional(),
  audio: z.string().max(32).optional(),
  appVersion: z.string().max(32).optional(),
  android: z.string().max(16).optional(),
  model: z.string().max(64).optional(),
});

export const listCallsQuerySchema = z.object({
  deviceId: z.string().max(128).optional(),
  state: z.enum(["queued", "dialing", "ringing", "active", "held", "ended", "rejected", "failed"]).optional(),
  direction: z.enum(["incoming", "outgoing"]).optional(),
  before: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const password = z.string().min(8, "use at least 8 characters").max(200);

const email = z.string().trim().toLowerCase().email("enter a valid email").max(254);

export const setupSchema = z.object({ email, password, setupKey: z.string().max(500).optional() });
export const loginSchema = z.object({ email: z.string().trim().max(254), password: z.string().min(1).max(200) });
export const createUserSchema = z.object({ email, password });
export const changePasswordSchema = z.object({ current: z.string().min(1).max(200), password });
export const createApiKeySchema = z.object({ name: z.string().trim().min(1).max(80) });

const optionalSetting = (schema: z.ZodString) => z.union([z.literal(""), schema]).optional();
export const configSchema = z.object({
  geminiApiKey: optionalSetting(z.string().trim().min(10).max(200)),
  geminiModel: optionalSetting(z.string().trim().min(1).max(100)),
  publicUrl: optionalSetting(z.string().trim().url().regex(/^https?:\/\//, "must be http(s)")),
  webhookUrl: optionalSetting(z.string().trim().url().regex(/^https?:\/\//, "must be http(s)")),
  docsUrl: optionalSetting(z.string().trim().url().regex(/^https?:\/\//, "must be http(s)")),
  incomingStreamUrl: optionalSetting(z.string().trim().url().regex(/^wss?:\/\//, "must be ws:// or wss://")),
  incomingStreamFormat: z.enum(["raw", "twilio"]).optional(),
});
