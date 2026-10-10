import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createGatewayServer } from "../src/server.js";
import { openDatabase } from "../src/db.js";
import { StateStore } from "../src/state.js";

const API_KEY = "test-api-key";

describe("QR pairing", () => {
  it("exchanges a one-time code for device credentials that survive a restart", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "gw-pair-"));
    const { httpServer } = createGatewayServer({ apiKey: API_KEY, dataDir, publicUrl: "https://gw.example.ts.net/" });

    expect((await request(httpServer).post("/v1/pairing")).status).toBe(401);
    const pairing = await request(httpServer).post("/v1/pairing").set("x-api-key", API_KEY).send({});
    expect(pairing.status).toBe(201);
    expect(pairing.body.publicUrl).toBe("https://gw.example.ts.net");
    expect(pairing.body.pairUri).toBe(
      `httpgateway://pair?url=${encodeURIComponent("https://gw.example.ts.net")}&code=${pairing.body.code}`,
    );
    expect(pairing.body.qrSvg).toContain("<svg");

    const paired = await request(httpServer)
      .post("/v1/pair")
      .send({ code: pairing.body.code.toLowerCase(), name: "Vivo V40" });
    expect(paired.status).toBe(201);
    expect(paired.body).toMatchObject({ device: { name: "Vivo V40" }, deviceChannelPath: "/v1/device-channel" });
    expect((await request(httpServer).post("/v1/pair").send({ code: pairing.body.code })).status).toBe(401);

    // Restart: a new store loads the device and accepts its token (stored only as a hash).
    const reloaded = new StateStore(openDatabase(dataDir));
    expect(reloaded.getDevice(paired.body.device.id)?.name).toBe("Vivo V40");
    expect(reloaded.verifyDeviceToken(paired.body.device.id, paired.body.deviceToken)).toBe(true);
    expect(reloaded.verifyDeviceToken(paired.body.device.id, "wrong")).toBe(false);

    const removed = await request(httpServer)
      .delete(`/v1/devices/${paired.body.device.id}`)
      .set("x-api-key", API_KEY);
    expect(removed.status).toBe(204);
  });

  it("uses the request origin when no public URL is configured and rejects unknown codes", async () => {
    const { httpServer } = createGatewayServer({ apiKey: API_KEY });
    const pairing = await request(httpServer)
      .post("/v1/pairing")
      .set("x-api-key", API_KEY)
      .set("x-forwarded-proto", "https")
      .set("x-forwarded-host", "abc.trycloudflare.com")
      .send({});
    expect(pairing.body.publicUrl).toBe("https://abc.trycloudflare.com");
    expect((await request(httpServer).post("/v1/pair").send({ code: "AAAAAAAA" })).status).toBe(401);
  });
});
