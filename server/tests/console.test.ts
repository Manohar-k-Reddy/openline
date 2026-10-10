import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createGatewayServer } from "../src/server.js";

const API_KEY = "test-api-key";

describe("console accounts", () => {
  it("creates the first account, signs in with email and password, and manages users", async () => {
    const { httpServer } = createGatewayServer({ apiKey: API_KEY });
    const agent = request.agent(httpServer);
    const tunnel = { "x-forwarded-for": "203.0.113.9" }; // what Funnel / Cloudflare add

    expect((await agent.get("/v1/auth/status")).body).toMatchObject({
      setupRequired: true,
      setupKeyRequired: false,
      authenticated: false,
    });
    expect((await agent.get("/v1/auth/status").set(tunnel)).body.setupKeyRequired).toBe(true);
    expect((await agent.get("/v1/devices")).status).toBe(401);

    const owner = { email: "Manu@Example.com", password: "long-password" };
    // Through a tunnel the first account needs the setup key.
    expect((await agent.post("/v1/auth/setup").set(tunnel).send(owner)).status).toBe(401);
    expect((await agent.post("/v1/auth/setup").send({ ...owner, password: "short" })).status).toBe(400);
    expect((await agent.post("/v1/auth/setup").send({ ...owner, email: "nope" })).status).toBe(400);

    const setup = await agent.post("/v1/auth/setup").send(owner);
    expect(setup.status).toBe(200);
    expect(setup.headers["set-cookie"]?.[0]).toMatch(/gw_session=.+HttpOnly.+SameSite=Strict/);
    expect((await agent.get("/v1/devices")).status).toBe(200);
    expect((await agent.get("/v1/auth/status")).body.user).toMatchObject({ email: "manu@example.com" });
    expect((await agent.post("/v1/auth/setup").set(tunnel).send({ ...owner, setupKey: API_KEY })).status).toBe(409);

    await agent.post("/v1/auth/logout");
    expect((await agent.get("/v1/devices")).status).toBe(401);
    expect((await agent.post("/v1/auth/login").send({ ...owner, password: "wrong-password" })).status).toBe(401);
    expect((await agent.post("/v1/auth/login").send(owner)).status).toBe(200);

    const added = await agent.post("/v1/users").send({ email: "friend@example.com", password: "friend-password" });
    expect(added.status).toBe(201);
    expect((await agent.post("/v1/users").send({ email: "friend@example.com", password: "friend-password" })).status).toBe(409);
    expect((await agent.get("/v1/users")).body.users.map((u: { email: string }) => u.email)).toEqual([
      "manu@example.com",
      "friend@example.com",
    ]);

    expect((await agent.post("/v1/auth/password").send({ current: "wrong-password", password: "new-password-1" })).status).toBe(401);
    expect((await agent.post("/v1/auth/password").send({ current: owner.password, password: "new-password-1" })).status).toBe(204);
    expect((await agent.get("/v1/devices")).status).toBe(200); // this browser stays signed in

    expect((await agent.delete(`/v1/users/${added.body.user.id}`)).status).toBe(204);
    const me = (await agent.get("/v1/auth/status")).body.user;
    expect((await agent.delete(`/v1/users/${me.id}`)).status).toBe(409);
  });
});

describe("API keys and settings", () => {
  it("creates and revokes API keys, and never returns the Gemini key", async () => {
    const { httpServer } = createGatewayServer({ apiKey: API_KEY });
    const root = { "x-api-key": API_KEY };

    const created = await request(httpServer).post("/v1/api-keys").set(root).send({ name: "voice bot" });
    expect(created.status).toBe(201);
    const { key, id } = created.body.apiKey;
    expect(key).toMatch(/^gw_/);
    expect((await request(httpServer).get("/v1/devices").set("authorization", `Bearer ${key}`)).status).toBe(200);
    const listed = await request(httpServer).get("/v1/api-keys").set(root);
    expect(listed.body.apiKeys).toEqual([expect.objectContaining({ id, name: "voice bot", prefix: key.slice(0, 7) })]);
    expect(JSON.stringify(listed.body)).not.toContain(key);
    expect((await request(httpServer).delete(`/v1/api-keys/${id}`).set(root)).status).toBe(204);
    expect((await request(httpServer).get("/v1/devices").set("x-api-key", key)).status).toBe(401);

    const saved = await request(httpServer)
      .put("/v1/settings")
      .set(root)
      .send({ geminiApiKey: "AIzaSyTest-secret-1234", publicUrl: "https://gw.example.ts.net" });
    expect(saved.status).toBe(200);
    expect(saved.body.settings).toMatchObject({
      publicUrl: "https://gw.example.ts.net",
      geminiApiKey: { configured: true, hint: "…1234", source: "console" },
    });
    expect(JSON.stringify(saved.body)).not.toContain("secret");
    expect((await request(httpServer).get("/v1/agent").set(root)).body.configured).toBe(true);
    expect((await request(httpServer).put("/v1/settings").set(root).send({ publicUrl: "ftp://x" })).status).toBe(400);
  });
});

describe("persistence", () => {
  it("keeps calls, events, settings and the password across a restart", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "gw-db-"));
    const first = createGatewayServer({ apiKey: API_KEY, dataDir });
    first.state.upsertDevice({ id: "p1", name: "Phone" });
    const call = first.state.createOutgoingCall({ deviceId: "p1", to: "+911234567890" });
    await first.events.ingest("p1", {
      type: "event",
      eventId: "e1",
      callId: call.id,
      event: "call.active",
      timestamp: new Date().toISOString(),
      payload: {},
    });
    await first.events.ingest("p1", {
      type: "event",
      eventId: "e1",
      callId: call.id,
      event: "call.active",
      timestamp: new Date().toISOString(),
      payload: {},
    });
    first.auth.setup({ email: "manu@example.com", password: "long-password" }, true);
    first.config.update({ docsUrl: "https://docs.example.com" });
    first.agents.updateSettings({ ownerName: "Manu K" });

    const second = createGatewayServer({ apiKey: API_KEY, dataDir });
    const root = { "x-api-key": API_KEY };
    const calls = await request(second.httpServer).get("/v1/calls?limit=1").set(root);
    expect(calls.body.calls).toEqual([expect.objectContaining({ id: call.id, state: "active", answeredAt: expect.any(String) })]);
    expect(calls.body.nextBefore).toBe(calls.body.calls[0].createdAt);
    const events = await request(second.httpServer).get(`/v1/calls/${call.id}/events`).set(root);
    expect(events.body.events.map((e: { event: string }) => e.event)).toEqual(["call.active"]);
    expect(second.auth.setupRequired).toBe(false);
    expect(second.auth.login("manu@example.com", "long-password")).toHaveProperty("token");
    expect(second.config.get("docsUrl")).toBe("https://docs.example.com");
    expect(second.agents.settings.ownerName).toBe("Manu K");
    expect(second.state.getDevice("p1")).toMatchObject({ name: "Phone", connected: false });
  });
});
