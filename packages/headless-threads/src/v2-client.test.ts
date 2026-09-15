import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { test, type TestContext } from "node:test";
import { createNativeV2Client } from "./v2-client.ts";
import { HeadlessThreadError } from "./errors.ts";
import type { HeadlessFetch } from "./v2-types.ts";

const mount = "/workspace/ws_fixture/opencode2/api";
const sid = "ses_fixture";
const selection = { providerID: "fixture", id: "text", variant: "low" };
const usage = { input: 8, output: 3, reasoning: 0, cache: { read: 0, write: 0 } };
const nativeSession = { id: sid, agent: "fixture", model: selection, projectID: "project_fixture", location: { directory: "/fixture" }, cost: 0, tokens: usage, time: { created: 1, updated: 2 } };
const input = { id: "msg_input", type: "user", text: "Only this request" } satisfies Parameters<ReturnType<typeof createNativeV2Client>["admitInput"]>[1];
const delivered = { id: input.id, type: "user", text: input.text, time: { created: 3 } };
const skill = { id: "skill_fixture", name: "Fixture guidance", description: "Local test skill", location: "/fixture/SKILL.md", content: "Frozen fixture skill body" };
// Synthetic HTTP fixtures follow protocol/schema beta-19086, not the client validators.
const assistant = {
  id: "msg_assistant", type: "assistant", agent: "fixture", model: selection, tokens: usage, cost: 0,
  content: [{ type: "tool", id: "call_fixture", name: "fixture_read", state: {
    status: "completed", input: { path: "example.txt" },
    content: [{ type: "text", text: "Observed" }, { type: "file", uri: "file:///fixture/result.png", mime: "image/png" }],
    metadata: { fixture: true },
  }, time: { created: 4, ran: 5, completed: 6 } }],
  finish: "tool-calls", time: { created: 4, streamed: 5, completed: 6 },
};

type BoundaryState = {
  requests: Array<{ method: string; path: string; body: unknown; headers: IncomingHttpHeaders }>;
  pages: unknown[][];
  inbox: unknown[];
  active: unknown;
  interrupted: boolean;
  persist: "inbox" | "history" | "none";
  fail: "none" | "lost" | "malformed";
  overrides: Map<string, { status: number; body?: unknown }>;
  skills: typeof skill[];
};

async function boundary(t: TestContext, prefix = "") {
  const state: BoundaryState = {
    requests: [], pages: [[]], inbox: [], active: {}, interrupted: false,
    persist: "inbox", fail: "none", overrides: new Map(), skills: [skill],
  };
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString("utf8");
      const body: unknown = text ? JSON.parse(text) : undefined;
      const url = new URL(request.url ?? "/", "http://fixture.invalid");
      const method = request.method ?? "GET";
      state.requests.push({ method, path: `${url.pathname}${url.search}`, body, headers: request.headers });
      const send = (value: unknown, status = 200) => {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(status === 204 ? undefined : JSON.stringify(value));
      };
      if (prefix) {
        if (!url.pathname.startsWith(`${prefix}/`)) return send({}, 404);
        url.pathname = url.pathname.slice(prefix.length);
      }
      const override = state.overrides.get(`${method} ${url.pathname}`);
      if (override) {
        if (override.status === 302) response.setHeader("Location", "/must-not-follow");
        return send(override.body, override.status);
      }
      if (url.pathname === `${mount}/session` && method === "POST") return send({ data: nativeSession });
      if (url.pathname === `${mount}/session/${sid}` && method === "GET") return send({ data: nativeSession });
      if (url.pathname === `${mount}/session/${sid}/inbox` && method === "GET") return send({ data: state.inbox });
      if (url.pathname === `${mount}/skill` && method === "GET") return send({ data: state.skills });
      if (url.pathname === `${mount}/session/${sid}/permission`) return send({ data: method === "POST" ? { id: "per_fixture", effect: "allow" } : [] });
      if (url.pathname === `${mount}/session/${sid}/message` && method === "GET") {
        const cursor = url.searchParams.get("cursor");
        const page = cursor === null ? 0 : Number.parseInt(cursor, 10);
        return send({ data: state.pages[page], cursor: page + 1 < state.pages.length ? { next: `${page + 1}:/opaque? +` } : {} });
      }
      if (method === "POST" && [`${mount}/session/${sid}/prompt`, `${mount}/session/${sid}/synthetic`].includes(url.pathname)) {
        assert.ok(body && typeof body === "object" && "id" in body && "text" in body && "delivery" in body);
        const type = url.pathname.endsWith("/prompt") ? "user" : "synthetic";
        const skills = "skills" in body && Array.isArray(body.skills) ? body.skills.map((value: unknown) => {
          assert.ok(value && typeof value === "object" && "id" in value);
          const found = state.skills.find((item) => item.id === value.id);
          assert.ok(found);
          return { id: found.id, name: found.name, text: found.content };
        }) : undefined;
        const payload = { text: body.text, ...(skills ? { skills } : {}), ...("metadata" in body ? { metadata: body.metadata } : {}) };
        const receipt = { id: body.id, sessionID: sid, type, timeCreated: 3, delivery: body.delivery, payload };
        if (state.persist === "inbox") state.inbox.push(receipt);
        if (state.persist === "history") state.pages.push([{ id: body.id, type, ...payload, time: { created: 3 } }]);
        if (state.fail === "lost") return response.destroy();
        return send(state.fail === "malformed" ? { accepted: true } : { data: receipt });
      }
      if (url.pathname === `${mount}/session/${sid}/interrupt` && method === "POST") return send({ interrupted: state.interrupted });
      if (url.pathname === `${mount}/session/${sid}/wait` && method === "POST") return send(undefined, 204);
      if (url.pathname === `${mount}/session/active` && method === "GET") return send({ data: state.active });
      send({ error: "unimplemented_fixture_route" }, 404);
    } catch {
      response.writeHead(500);
      response.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const options = { baseUrl: `http://127.0.0.1:${address.port}${prefix}///`, workspaceId: "ws_fixture", token: "fixture-client-token", requestTimeoutMs: 2_000 };
  return { state, options, client: createNativeV2Client(options) };
}

const postCount = (state: BoundaryState) => state.requests.filter((request) => request.method === "POST" && /\/(prompt|synthetic)$/.test(request.path)).length;

test("native create binding, workspace mount and existing token headers; no v1 fallback", async (t) => {
  const { state, options } = await boundary(t);
  const client = createNativeV2Client({ ...options, hostToken: "fixture-host-token" });
  const created = await client.createSession({ id: sid, title: "Fixture", agent: "fixture", model: selection });
  assert.deepEqual(created, nativeSession);
  assert.deepEqual(state.requests[0]?.body, { id: sid, title: "Fixture", agent: "fixture", model: selection });
  assert.equal(state.requests[0]?.path, `${mount}/session`);
  assert.equal(state.requests[0]?.headers.authorization, "Bearer fixture-client-token");
  assert.equal(state.requests[0]?.headers["x-openwork-host-token"], "fixture-host-token");
  await client.createSession({ id: sid, agent: "fixture", model: selection });
  assert.deepEqual(state.requests.map((request) => request.method), ["POST", "GET", "GET"]);
  state.overrides.set(`GET ${mount}/session/${sid}`, { status: 200, body: { data: { ...nativeSession, model: { ...selection, id: "different" } } } });
  await assert.rejects(client.createSession({ id: sid, agent: "fixture", model: selection }), { code: "binding_unconfirmed" });
  state.overrides.set(`GET ${mount}/session/${sid}`, { status: 404, body: { error: "missing" } });
  await assert.rejects(client.getSession(sid), { status: 404 });
  // Native create may return an existing foreign ID with the same model/agent.
  // The workspace-scoped GET must authorize it before binding is confirmed.
  state.overrides.set(`GET ${mount}/session/${sid}`, { status: 403, body: { error: "wrong_workspace" } });
  const nextClient = createNativeV2Client(options);
  await assert.rejects(nextClient.createSession({ id: sid, agent: "fixture", model: selection }), { status: 403 });
  const creations = state.requests.filter((request) => request.method === "POST").length;
  await assert.rejects(nextClient.createSession({ id: sid, agent: "fixture", model: selection }), { status: 403 });
  assert.equal(state.requests.filter((request) => request.method === "POST").length, creations);
  state.overrides.set(`GET ${mount}/session`, { status: 200, body: { data: [nativeSession], cursor: { next: null } } });
  assert.deepEqual(await client.listSessions(), [nativeSession]);
  const listing = new URL(state.requests.at(-1)?.path ?? "", options.baseUrl);
  assert.equal(listing.searchParams.get("limit"), "200");
  assert.equal(listing.searchParams.get("order"), "desc");
  assert.ok(state.requests.every((request) => request.path.startsWith(mount)));
});

test("official requests preserve the prefixed proxy, bearer, body, redirects and both cancellation scopes", { timeout: 2000 }, async (t) => {
  const { state, options } = await boundary(t, "/gateway");
  const client = createNativeV2Client({ ...options, fetch: async (url, init) => {
    assert.equal(init?.redirect, "error");
    if (init?.method !== "GET") assert.equal(init?.keepalive, false);
    return fetch(url, init);
  } });
  const metadata = { marker: "durable", nested: { value: [1, true, null] } };
  await client.admitInput(sid, { ...input, metadata });
  assert.ok(state.requests.every((request) => request.path.startsWith(`/gateway${mount}/`) && request.headers.authorization === "Bearer fixture-client-token"));
  assert.deepEqual(state.requests.find((request) => request.method === "POST")?.body, { id: input.id, text: input.text, delivery: "queue", resume: true, metadata });
  const count = state.requests.length;
  for (const id of ["..", "../session", "https://foreign.invalid/path"]) await assert.rejects(client.getAgent(id), { code: "invalid_request" });
  assert.equal(state.requests.length, count);
  for (const scope of ["client", "call"]) {
    const global = new AbortController(), local = new AbortController();
    const reached = Promise.withResolvers<AbortSignal>();
    const observing = createNativeV2Client({ ...options, signal: global.signal, fetch: async (url, init) => {
      assert.equal(new URL(url).pathname, `/gateway${mount}/session/${sid}`);
      assert.ok(init?.signal);
      const signal = init.signal;
      reached.resolve(signal);
      return new Promise<Response>((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("private transport detail")), { once: true }));
    } }).getSession(sid, local.signal);
    const rejected = assert.rejects(observing, { code: "request_failed", method: "GET", path: `${mount}/session/${sid}`, status: null });
    const signal = await reached.promise;
    assert.equal(signal.aborted, false);
    (scope === "client" ? global : local).abort();
    assert.equal(signal.aborted, true);
    await rejected;
  }
});

test("exact-ID replay is read-only across cursor pages; messages retain native kinds and evidence", async (t) => {
  const { state, client } = await boundary(t);
  const synthetic = { id: "msg_context", type: "synthetic", text: input.text, time: { created: 1 } };
  const system = { id: "msg_system", type: "system", text: "Fixture guidance", time: { created: 2 } };
  state.pages = [[synthetic, system], [delivered, assistant]];
  const result = await client.admitInput(sid, input);
  assert.equal(result.state, "delivered");
  if (result.state === "delivered") assert.deepEqual(result.message, delivered);
  assert.equal(postCount(state), 0);
  const historyRequests = state.requests.filter((request) => request.path.includes("/message?"));
  const [firstRequest, secondRequest] = historyRequests;
  assert.ok(firstRequest && secondRequest);
  assert.equal(new URL(firstRequest.path, "http://fixture.invalid").searchParams.get("order"), "asc");
  const next = new URL(secondRequest.path, "http://fixture.invalid");
  assert.equal(next.searchParams.get("cursor"), "1:/opaque? +");
  assert.equal(next.searchParams.has("order"), false);
  const page = await client.readHistoryPage(sid, { cursor: "1:/opaque? +" });
  const reply = page.data[1];
  assert.ok(reply);
  assert.deepEqual(reply, assistant);
  assert.equal(Object.hasOwn(reply, "parentID"), false);
  await assert.rejects(client.admitInput(sid, { ...input, text: "Different request" }), { code: "input_conflict" });
  for (const attachments of [
    { agents: [{ name: "another-agent" }] },
    { files: [{ data: "", mime: "text/plain", source: { type: "inline" } }] },
  ]) {
    state.pages = [[{ ...delivered, ...attachments }]];
    await assert.rejects(client.admitInput(sid, input), { code: "input_conflict" });
  }
  assert.equal(postCount(state), 0);
});

test("lost POST response waits past the first confirmation failure for exact delivered history without resubmission", async (t) => {
  const { state, options } = await boundary(t);
  let now = 0;
  const client = createNativeV2Client({ ...options, admissionTimeoutMs: 60_000, now: () => now,
    sleep: async (ms) => { now += ms; if (now >= 16_000) state.pages = [[delivered]]; },
    fetch: async (url, init) => {
      if (postCount(state) && now < 16_000) throw new Error("First confirmation timed out");
      return fetch(url, init);
    },
  });
  state.fail = "lost";
  state.persist = "none";
  const result = await client.admitInput(sid, input);
  assert.equal(now, 16_000);
  assert.equal(result.state, "delivered");
  if (result.state === "delivered") assert.deepEqual(result.message, delivered);
  await client.admitInput(sid, input);
  assert.equal(postCount(state), 1);
  const posted = state.requests.find((request) => request.method === "POST");
  assert.deepEqual(posted?.body, { id: input.id, text: input.text, delivery: "queue", resume: true });
  assert.equal(posted?.headers["x-openwork-host-token"], undefined);
});

test("malformed acknowledgement reconciles delivered history, including later cursor pages", async (t) => {
  const { state, client } = await boundary(t);
  state.pages = [[{ ...delivered, id: "msg_other" }]];
  state.persist = "history";
  state.fail = "malformed";
  const result = await client.admitInput(sid, input);
  assert.equal(result.state, "delivered");
  await client.admitInput(sid, input);
  assert.equal(postCount(state), 1);
});

test("unobserved ambiguous admission and concurrent same-ID calls never resend", async (t) => {
  const { state, options, client } = await boundary(t);
  state.persist = "none";
  state.fail = "lost";
  const results = await Promise.allSettled([client.admitInput(sid, input), client.admitInput(sid, input)]);
  assert.ok(results.every((result) => result.status === "rejected" && result.reason.code === "admission_unknown"));
  await assert.rejects(client.admitInput(sid, input), { code: "admission_unknown" });
  assert.equal(postCount(state), 1);
  // After restart the durable owner must reconcile its saved ID, not request fresh admission.
  const recovered = await createNativeV2Client(options).reconcileAdmission(sid, input.id);
  assert.deepEqual(recovered, { state: "unobserved", id: input.id });
  assert.equal(postCount(state), 1);
});

test("synthetic context has its own native admission and never becomes user text", async (t) => {
  const { state, client } = await boundary(t);
  const result = await client.admitInput(sid, { type: "synthetic", id: "msg_reference", text: "Untrusted reference data" });
  assert.equal(result.state, "accepted");
  if (result.state === "accepted") assert.equal(result.receipt.type, "synthetic");
  await client.admitInput(sid, input);
  const posts = state.requests.filter((request) => request.method === "POST");
  assert.deepEqual(posts.map((request) => [request.path, request.body]), [
    [`${mount}/session/${sid}/synthetic`, { id: "msg_reference", text: "Untrusted reference data", delivery: "queue", resume: false }],
    [`${mount}/session/${sid}/prompt`, { id: input.id, text: input.text, delivery: "queue", resume: true }],
  ]);
  await assert.rejects(client.admitInput(sid, { ...input, ...{ context: "must not be flattened" } }));
  assert.equal(postCount(state), 2);
});

test("stop distinguishes interrupted work from idle no-op and preserves pending work", async (t) => {
  const { state, client } = await boundary(t);
  const pending = { id: "msg_pending", sessionID: sid, type: "compaction", payload: {}, delivery: "steer", timeCreated: 3 };
  state.inbox = [pending];
  assert.deepEqual(await client.stop(sid), { interrupted: false, idle: true, pending: [pending] });
  state.interrupted = true;
  assert.deepEqual(await client.stop(sid), { interrupted: true, idle: true, pending: [pending] });
  assert.ok(state.requests.filter((request) => request.method === "POST").every((request) => /\/(interrupt\?continue=false|wait)$/.test(request.path)));
  state.active = { [sid]: { type: "running" } };
  await assert.rejects(client.stop(sid), { code: "stop_unconfirmed" });
  state.active = { [sid]: { type: "mystery" } };
  await assert.rejects(client.stop(sid), { code: "invalid_response" });
  state.overrides.set(`GET ${mount}/session/active`, { status: 200, body: {} });
  await assert.rejects(client.stop(sid), { code: "invalid_response" });
  state.overrides.delete(`GET ${mount}/session/active`);
  state.overrides.set(`POST ${mount}/session/${sid}/wait`, { status: 503, body: {} });
  await assert.rejects(client.stop(sid), { status: 503 });
});

test("malformed history, cross-session inbox, repeated cursor, redirect and cancellation fail closed", async (t) => {
  const { state, client } = await boundary(t);
  const historyPath = `GET ${mount}/session/${sid}/message`;
  for (const body of [
    { data: [], cursor: { next: 12 } },
    { data: [{ ...delivered, type: "unknown-kind" }], cursor: {} },
    { data: [{ ...assistant, content: [{ type: "tool", id: "call_bad", name: "fixture_read", time: { created: 1 }, state: { status: "mystery" } }] }], cursor: {} },
    { data: [], cursor: { next: "repeated" } },
  ]) {
    state.overrides.set(historyPath, { status: 200, body });
    await assert.rejects(client.admitInput(sid, input), { code: "invalid_response" });
  }
  state.overrides.delete(historyPath);
  state.inbox = [{ id: input.id, sessionID: "ses_other", type: "user", payload: { text: input.text }, delivery: "queue", timeCreated: 3 }];
  await assert.rejects(client.admitInput(sid, input), { code: "invalid_response" });
  assert.equal(postCount(state), 0);
  const controller = new AbortController();
  controller.abort();
  const count = state.requests.length;
  await assert.rejects(client.admitInput(sid, input, controller.signal));
  assert.equal(state.requests.length, count);
  state.overrides.set(`GET ${mount}/session/${sid}`, { status: 302, body: {} });
  await assert.rejects(client.getSession(sid), { code: "request_failed" });
  assert.equal(state.requests.length, count + 1);
  assert.ok(state.requests.every((request) => !request.path.includes("must-not-follow")));
});

test("native errors retain method, path and status without exposing declared bodies or transport causes", async (t) => {
  const { state, client, options } = await boundary(t);
  const privateDetail = "Bearer must-not-escape";
  const safeError = (method: string, path: string, status: number | null, code = "request_failed") => (error: unknown) => {
    assert.ok(error instanceof HeadlessThreadError);
    assert.deepEqual({ method: error.method, path: error.path, status: error.status, code: error.code }, { method, path, status, code });
    assert.equal(error.body, undefined);
    assert.equal(error.cause, undefined);
    assert.equal(`${error.message}${JSON.stringify(error)}`.includes(privateDetail), false);
    return true;
  };
  for (const status of [400, 401, 403, 404, 422, 503]) {
    state.overrides.set(`GET ${mount}/session/${sid}`, { status, body: { _tag: "Unauthorized", message: privateDetail, status: 200 } });
    await assert.rejects(client.getSession(sid), safeError("GET", `${mount}/session/${sid}`, status));
  }
  for (const status of [200, 201]) {
    state.overrides.set(`GET ${mount}/session/${sid}`, { status, body: { data: privateDetail } });
    await assert.rejects(client.getSession(sid), safeError("GET", `${mount}/session/${sid}`, status, "invalid_response"));
  }
  state.overrides.delete(`GET ${mount}/session/${sid}`);
  state.overrides.set(`POST ${mount}/session/${sid}/prompt`, { status: 403, body: { message: privateDetail } });
  await assert.rejects(client.admitInput(sid, input), safeError("POST", `${mount}/session/${sid}/prompt`, 403));
  await assert.rejects(client.admitInput(sid, input), { code: "admission_unknown" });
  assert.equal(postCount(state), 1);
  const failingTransport = createNativeV2Client({ ...options, fetch: async () => {
    throw new HeadlessThreadError({ code: "provider_failure", method: "POST", path: "/private", status: 403, message: privateDetail, body: { token: privateDetail } });
  } });
  await assert.rejects(failingTransport.getSession(sid), safeError("GET", `${mount}/session/${sid}`, null));
});

test("native permission and form replies use current session-scoped requests and reject stale decisions", async (t) => {
  const { client, state } = await boundary(t);
  const permission = { id: "per_fixture", sessionID: sid, action: "read", resources: ["fixture.txt"] };
  const form = { id: "frm_fixture", sessionID: sid, title: "Choose", fields: [{ key: "choice", type: "string", options: [{ value: "exact-value", label: "Friendly label" }] }] } satisfies Awaited<ReturnType<typeof client.listForms>>[number];
  const permissionPath = `${mount}/session/${sid}/permission/${permission.id}`;
  const formPath = `${mount}/session/${sid}/form/${form.id}`;
  state.overrides.set(`GET ${mount}/session/${sid}/permission`, { status: 200, body: { data: [permission] } });
  state.overrides.set(`GET ${mount}/session/${sid}/form`, { status: 200, body: { data: [form] } });
  assert.deepEqual(await client.listPermissions(sid), [permission]);
  assert.deepEqual(await client.listForms(sid), [form]);
  state.overrides.set(`GET ${permissionPath}`, { status: 200, body: { data: { ...permission, resources: ["changed.txt"] } } });
  state.overrides.set(`GET ${formPath}`, { status: 200, body: { data: { ...form, sessionID: "ses_other" } } });
  await assert.rejects(client.replyPermission(permission, "once"), { code: "stale_request" });
  await assert.rejects(client.replyForm(form, { choice: "exact-value" }), { code: "stale_request" });
  state.overrides.set(`GET ${permissionPath}`, { status: 200, body: { data: permission } });
  state.overrides.set(`GET ${formPath}`, { status: 200, body: { data: form } });
  await assert.rejects(client.replyPermission(permission, "always"), { code: "stale_request" });
  assert.equal(state.requests.filter((request) => request.method === "POST").length, 0);
  for (const path of [`${permissionPath}/reply`, `${formPath}/reply`, `${formPath}/cancel`]) state.overrides.set(`POST ${path}`, { status: 204 });
  assert.equal(await client.replyPermission(permission, "once"), undefined);
  assert.equal(await client.replyForm(form, { choice: "exact-value" }), undefined);
  assert.equal(await client.replyForm(form, null), undefined);
  assert.deepEqual(state.requests.filter((request) => request.method === "POST").map((request) => [request.path, request.body]), [
    [`${permissionPath}/reply`, { reply: "once" }], [`${formPath}/reply`, { answer: { choice: "exact-value" } }], [`${formPath}/cancel`, undefined],
  ]);
  state.overrides.set(`GET ${permissionPath}`, { status: 404, body: {} });
  state.overrides.set(`GET ${formPath}`, { status: 404, body: {} });
  await assert.rejects(client.replyPermission(permission, "reject"), { status: 404, method: "GET" });
  await assert.rejects(client.replyForm(form, null), { status: 404, method: "GET" });
  assert.equal(state.requests.filter((request) => request.method === "POST").length, 3);
});

test("native skill catalog and ID-only inputs validate strictly; missing or revoked IDs never submit", async (t) => {
  const { client, state } = await boundary(t);
  assert.deepEqual(await client.listSkills(), [skill]);
  const source = { type: "openwork-cloud", uri: "skill://fixture-guidance/SKILL.md", scope: "a".repeat(64) };
  const cloudSkill = { ...skill, id: "native_cloud_fixture", source };
  state.overrides.set(`GET ${mount}/skill`, { status: 200, body: { data: [skill, cloudSkill] } });
  const catalog = await client.listSkills();
  assert.equal(catalog.find((item) => item.source?.type === source.type && item.source.uri === source.uri)?.id, cloudSkill.id);
  assert.deepEqual(catalog, [skill, cloudSkill]);
  for (const invalidSource of [
    null, { ...source, type: "other" }, { type: "openwork-cloud" },
    { ...source, uri: "https://fixture.invalid/SKILL.md" },
    { ...source, uri: `skill://${"x".repeat(1024)}` },
    { ...source, path: "/guessed" }, { type: source.type, uri: source.uri },
    { ...source, scope: "A".repeat(64) }, { ...source, scope: "a".repeat(63) },
  ]) {
    state.overrides.set(`GET ${mount}/skill`, { status: 200, body: { data: [{ ...skill, source: invalidSource }] } });
    await assert.rejects(client.listSkills(), { code: "invalid_response" });
  }
  state.overrides.delete(`GET ${mount}/skill`);
  for (const value of [
    { skills: [{ id: "" }] }, { skills: [{ id: " skill_fixture" }] },
    { skills: [{ id: skill.id, name: skill.name }] }, { skills: [{ id: skill.id, text: "Injected" }] },
    { skills: [{ id: skill.id, mention: { start: 0, end: 1, text: "x" } }] },
    { skills: Array.from({ length: 33 }, () => ({ id: skill.id })) },
    { files: [] }, { agents: [] },
  ]) await assert.rejects(client.admitInput(sid, { ...input, ...value }));
  await assert.rejects(client.admitInput(sid, { ...input, type: "synthetic", skills: [{ id: skill.id }] }));
  await assert.rejects(client.admitInput(sid, { ...input, skills: [{ id: skill.name }] }), { code: "skill_unavailable" });
  state.skills = [];
  await assert.rejects(client.admitInput(sid, { ...input, skills: [{ id: skill.id }] }), { code: "skill_unavailable" });
  state.skills = [skill, skill];
  await assert.rejects(client.listSkills(), { code: "invalid_response" });
  state.overrides.set(`GET ${mount}/skill`, { status: 200, body: { data: [{ id: skill.id, name: skill.name }] } });
  await assert.rejects(client.listSkills(), { code: "invalid_response" });
  assert.equal(state.requests.filter((request) => request.method === "POST").length, 0);
});

test("selected skills use the actual session agent; deny and ask preserve native permission without a prompt", async (t) => {
  const { client, state } = await boundary(t);
  const selected = { ...input, skills: [{ id: skill.id }] };
  const path = `${mount}/session/${sid}/permission`;
  for (const effect of ["deny", "ask"]) {
    state.overrides.set(`POST ${path}`, { status: 200, body: { data: { id: "per_fixture", effect } } });
    await assert.rejects(client.admitInput(sid, selected), { code: effect === "ask" ? "skill_permission_required" : "skill_denied" });
  }
  const pending = { id: "per_fixture", sessionID: sid, action: "skill", resources: [skill.id], save: [skill.id] };
  state.overrides.set(`GET ${path}`, { status: 200, body: { data: [pending] } });
  await assert.rejects(client.admitInput(sid, selected), { code: "skill_permission_required" });
  assert.deepEqual(await client.listPermissions(sid), [pending]);
  assert.deepEqual(state.requests.filter((request) => request.method === "POST").map((request) => request.body), [
    { action: "skill", resources: [skill.id], save: [skill.id], agent: "fixture" },
    { action: "skill", resources: [skill.id], save: [skill.id], agent: "fixture" },
  ]);
  assert.equal(postCount(state), 0);
});

test("selected Cloud prompts preserve the caller's pinned scope header instead of rebinding current catalog scope", async (t) => {
  const { state, options } = await boundary(t);
  const pinnedScope = "a".repeat(64);
  const cloudSkill = { ...skill, id: "openwork-cloud-fixture", source: { type: "openwork-cloud", uri: "skill://fixture/SKILL.md", scope: pinnedScope } };
  state.skills = [cloudSkill];
  const scopedFetch: HeadlessFetch = (url, init) => globalThis.fetch(url, {
    ...init,
    headers: { ...init?.headers, ...(new URL(url).pathname.endsWith("/prompt") ? { "x-openwork-native-skills-scope": pinnedScope } : {}) },
  });
  const client = createNativeV2Client({ ...options, fetch: scopedFetch });
  assert.equal((await client.listSkills())[0]?.source?.scope, pinnedScope);
  await client.admitInput(sid, { ...input, skills: [{ id: cloudSkill.id }] });
  const first = state.requests.find((request) => request.path.endsWith("/prompt")); assert.ok(first);
  assert.equal(first.headers["x-openwork-native-skills-scope"], pinnedScope);
  assert.deepEqual(first.body, { id: input.id, text: input.text, delivery: "queue", resume: true, skills: [{ id: cloudSkill.id }] });
  cloudSkill.source.scope = "b".repeat(64);
  state.overrides.set(`POST ${mount}/session/${sid}/prompt`, { status: 403, body: { code: "cloud_skill_scope_changed" } });
  await assert.rejects(client.admitInput(sid, { ...input, id: "msg_scope_changed", skills: [{ id: cloudSkill.id }] }), { status: 403 });
  const prompts = state.requests.filter((request) => request.path.endsWith("/prompt"));
  assert.equal(prompts.length, 2);
  assert.ok(prompts.every((request) => request.headers["x-openwork-native-skills-scope"] === pinnedScope));
});

test("lost skill acknowledgement reconciles frozen resolved inbox/history attachments without catalog reads or resend", async (t) => {
  for (const persist of ["inbox", "history"] satisfies BoundaryState["persist"][]) {
    const { client, state, options } = await boundary(t);
    state.persist = persist; state.fail = "lost";
    const selected = { ...input, skills: [{ id: skill.id }, { id: skill.id }] };
    const result = await client.admitInput(sid, selected);
    assert.equal(result.state, persist === "inbox" ? "queued" : "delivered");
    const prompt = state.requests.find((request) => request.path.endsWith("/prompt"));
    assert.ok(prompt);
    assert.equal(prompt.headers["x-openwork-native-skills-scope"], undefined, "local skill inputs do not invent a Cloud scope");
    assert.deepEqual(prompt?.body, { id: input.id, text: input.text, delivery: "queue", resume: true, skills: [{ id: skill.id }] });
    assert.ok(state.requests.findIndex((request) => request.method === "POST" && request.path.endsWith("/permission")) < state.requests.indexOf(prompt));
    const reads = state.requests.filter((request) => request.path.endsWith("/skill")).length;
    state.skills = [];
    const recovered = await createNativeV2Client(options).reconcileInput(sid, selected);
    const payload = recovered.state === "delivered" ? recovered.message : recovered.state === "queued" ? recovered.receipt.payload : null;
    assert.ok(payload && "skills" in payload);
    assert.deepEqual(payload.skills, [{ id: skill.id, name: skill.name, text: skill.content }]);
    await client.admitInput(sid, selected);
    for (const skills of [[], [{ id: "different" }]]) await assert.rejects(client.admitInput(sid, { ...input, skills }), { code: "input_conflict" });
    assert.equal(state.requests.filter((request) => request.path.endsWith("/skill")).length, reads);
    assert.equal(postCount(state), 1);
  }
});

test("official events share one lazy stream, dispose pending readers and reconnect only on a later subscription without replay", { timeout: 2000 }, async () => {
  let connections = 0;
  let opened = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
  const cancelled = Promise.withResolvers<void>();
  const client = createNativeV2Client({ baseUrl: "http://fixture.invalid/gateway", workspaceId: "ws_fixture", token: "fixture", fetch: async (url, init) => {
    connections++;
    assert.equal(new URL(url).pathname, `/gateway${mount}/event`);
    assert.equal(init?.headers?.Authorization, "Bearer fixture");
    assert.equal(new Headers(init?.headers).get("accept"), "text/event-stream");
    assert.equal(new Headers(init?.headers).has("last-event-id"), false);
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { opened.resolve(controller); }, cancel() { cancelled.resolve(); } }), { headers: { "content-type": "text/event-stream" } });
  } });
  const emit = (source: ReadableStreamDefaultController<Uint8Array>, id: string) => {
    source.enqueue(new TextEncoder().encode(`: keepalive\r\ndata: {"id":"${id}",\r`));
    source.enqueue(new TextEncoder().encode('\ndata: "type":"session.updated","data":{}}\r\n\r\n'));
  };
  const first = client.events();
  assert.equal(connections, 0);
  const firstRead = first.next();
  const source = await opened.promise;
  emit(source, "evt_prior");
  assert.equal((await firstRead).value?.id, "evt_prior");
  const second = client.events();
  const nextFirst = first.next(), nextSecond = second.next();
  emit(source, "evt_shared");
  assert.deepEqual((await Promise.all([nextFirst, nextSecond])).map((item) => item.value?.id), ["evt_shared", "evt_shared"]);
  assert.equal(connections, 1);
  const pendingFirst = first.next();
  await first.return();
  assert.equal((await pendingFirst).done, true);
  const pendingSecond = second.next();
  source.close();
  assert.equal((await pendingSecond).done, true);
  assert.equal(connections, 1);
  opened = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
  const abort = new AbortController();
  const later = client.events(abort.signal);
  const laterRead = later.next();
  const laterSource = await opened.promise;
  emit(laterSource, "evt_fresh");
  assert.equal((await laterRead).value?.id, "evt_fresh");
  assert.equal(connections, 2);
  const pending = later.next();
  abort.abort();
  assert.equal((await pending).done, true);
  await cancelled.promise;
});

test("official stream decoding errors are sanitized and terminate without automatic reconnect", { timeout: 2000 }, async () => {
  let connections = 0;
  const client = createNativeV2Client({ baseUrl: "http://fixture.invalid", workspaceId: "ws_fixture", token: "fixture", fetch: async () => {
    connections++;
    return new Response('data: Bearer private-stream-detail\n\n', { headers: { "content-type": "text/event-stream" } });
  } });
  await assert.rejects(client.events().next(), (error: unknown) => {
    assert.ok(error instanceof HeadlessThreadError);
    assert.deepEqual({ code: error.code, method: error.method, path: error.path, status: error.status }, { code: "invalid_response", method: "GET", path: `${mount}/event`, status: 200 });
    assert.equal(error.cause, undefined);
    assert.equal(error.body, undefined);
    assert.equal(error.message.includes("private-stream-detail"), false);
    return true;
  });
  assert.equal(connections, 1);
});
