import request from "supertest";
import { describe, expect, it } from "vitest";
import { Resampler } from "../src/agent/gemini-call-agent.js";
import { createGatewayServer } from "../src/server.js";

const API_KEY = "test-api-key";

describe("Resampler", () => {
  it("converts 24 kHz to 16 kHz with continuous output across chunks", () => {
    const resampler = new Resampler(24000, 16000);
    const ramp = Int16Array.from({ length: 2400 }, (_, i) => i);
    const chunks = [ramp.subarray(0, 1000), ramp.subarray(1000, 1777), ramp.subarray(1777)];
    const out = chunks.flatMap((chunk) => {
      const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      return [...new Int16Array(new Uint8Array(resampler.process(buffer)).buffer)];
    });
    expect(out.length).toBeGreaterThanOrEqual(1599);
    expect(out.length).toBeLessThanOrEqual(1601);
    // A linear ramp stays a ramp with slope 1.5 after 24k -> 16k (steps of 1 or 2 after rounding).
    for (let i = 2; i < out.length; i++) expect([1, 2]).toContain(out[i]! - out[i - 1]!);
    expect((out.at(-1)! - out[1]!) / (out.length - 2)).toBeCloseTo(1.5, 2);
  });
});

describe("AI assistant API", () => {
  it("exposes settings and refuses to take over without a Gemini key", async () => {
    const { httpServer, state } = createGatewayServer({ apiKey: API_KEY });
    const auth = { "x-api-key": API_KEY };

    const info = await request(httpServer).get("/v1/agent").set(auth);
    expect(info.body).toMatchObject({ configured: false, settings: { autoAnswer: false } });

    const updated = await request(httpServer)
      .put("/v1/agent")
      .set(auth)
      .send({ autoAnswer: true, ownerName: "Manu K" });
    expect(updated.body.settings).toMatchObject({ autoAnswer: true, ownerName: "Manu K" });
    expect((await request(httpServer).put("/v1/agent").set(auth).send({ autoAnswer: "yes" })).status).toBe(400);

    state.upsertDevice({ id: "p1" });
    const call = state.createOutgoingCall({ deviceId: "p1", to: "199" });
    const takeOver = await request(httpServer).post(`/v1/calls/${call.id}/agent`).set(auth);
    expect(takeOver.status).toBe(409);
    expect((await request(httpServer).get(`/v1/calls/${call.id}/agent`).set(auth)).body).toMatchObject({
      status: "off",
      transcript: [],
    });
    expect((await request(httpServer).get("/v1/agent/messages").set(auth)).body).toEqual({ messages: [] });
  });
});
