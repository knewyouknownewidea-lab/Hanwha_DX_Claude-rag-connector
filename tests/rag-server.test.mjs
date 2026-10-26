import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { createAppServer } from "../server/index.mjs";

const TOKEN = "test-only-gateway-token-0123456789abcdef";
const JOB = "cb87b92d-3822-4d2a-8d05-7cc553e803ba";
const QUESTION = { question: "수량은?", model: "gemma3:4b", order_id: 1101 };
const ANSWER = { status: "answered", question: "수량은?", answer: "발주 수량은 20개입니다. [E1]", message: "검색 근거로 답변을 생성했습니다.", generation_model: "gemma3:4b", model_called: true, sources: [{ evidence_id: "E1", source: { source_refs: ["purchase_orders:1101"] } }], citation_check: "valid_ids_only" };

function json(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function listen(t, server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return "http://127.0.0.1:" + server.address().port;
}

async function setup(t, handler = (_req, res) => json(res, 202, { job_id: JOB, status: "running" }), options = {}) {
  const gateway = await listen(t, createServer(handler));
  const site = await listen(t, createAppServer({ env: { RAG_ORIGIN: gateway, RAG_GATEWAY_TOKEN: TOKEN }, ragOptions: options }));
  return { site, gateway };
}

function submit(site, body = QUESTION, headers = {}) {
  return fetch(site + "/api/rag/jobs", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
}

test("status reports configuration without contacting gateway or exposing secrets", async (t) => {
  let requests = 0;
  const { site, gateway } = await setup(t, () => { requests++; });
  const response = await fetch(site + "/api/rag/status");
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body, { enabled: true, models: ["qwen3:8b", "gemma3:4b", "llama3.1:8b"] });
  assert.equal(requests, 0);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.ok(!JSON.stringify(body).includes(TOKEN));
  assert.ok(!JSON.stringify(body).includes(gateway));
});

test("unconfigured or unsafe origins disable only RAG and do not disclose configuration", async (t) => {
  for (const env of [
    {},
    { RAG_ORIGIN: "http://example.com", RAG_GATEWAY_TOKEN: TOKEN },
    { RAG_ORIGIN: "https://user:pass@example.com", RAG_GATEWAY_TOKEN: TOKEN },
    { RAG_ORIGIN: "https://example.com/internal", RAG_GATEWAY_TOKEN: TOKEN },
    { RAG_ORIGIN: "https://example.com/?token=secret", RAG_GATEWAY_TOKEN: TOKEN },
    { RAG_ORIGIN: "https://example.com/#secret", RAG_GATEWAY_TOKEN: TOKEN },
    { RAG_ORIGIN: "https://example.com", RAG_GATEWAY_TOKEN: "short" },
    { RAG_ORIGIN: "https://example.com", RAG_GATEWAY_TOKEN: TOKEN + "\n" },
  ]) {
    const site = await listen(t, createAppServer({ env }));
    const response = await fetch(site + "/api/rag/status");
    const body = await response.json();
    assert.equal(body.enabled, false);
    assert.ok(body.message);
    assert.ok(!JSON.stringify(body).includes("example.com"));
    const rejected = await submit(site);
    assert.equal(rejected.status, 503);
    assert.match((await rejected.json()).error, /설정/);
    assert.equal((await fetch(site + "/api/ai/status")).status, 200);
  }
});

test("HTTPS and local IPv6 origins are accepted", async (t) => {
  for (const origin of ["https://example.com", "http://localhost:8400", "http://[::1]:8400"]) {
    const site = await listen(t, createAppServer({ env: { RAG_ORIGIN: origin, RAG_GATEWAY_TOKEN: TOKEN } }));
    assert.equal((await (await fetch(site + "/api/rag/status")).json()).enabled, true);
  }
});

test("submit and poll retain signed cookie visitor and replace browser credentials", async (t) => {
  const requests = [];
  const { site } = await setup(t, async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    requests.push({ url: req.url, method: req.method, headers: req.headers, body: raw && JSON.parse(raw) });
    json(res, req.method === "POST" ? 202 : 200, { job_id: JOB, status: req.method === "POST" ? "running" : "succeeded", ...(req.method === "GET" ? { result: ANSWER, internal: "should not relay" } : {}) });
  });
  const posted = await submit(site, { ...QUESTION, top_k: 3, supplier_id: 22, part_id: 33, document_type: "order" }, { authorization: "Bearer browser-supplied", "x-rag-visitor": "A".repeat(43) });
  assert.equal(posted.status, 202);
  assert.equal(posted.headers.get("location"), "/api/rag/jobs/" + JOB);
  assert.deepEqual(await posted.json(), { job_id: JOB, status: "running" });
  const setCookie = posted.headers.get("set-cookie");
  assert.match(setCookie, /^rag_visitor=[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43};/);
  assert.match(setCookie, /HttpOnly; SameSite=Lax/);
  assert.match(setCookie, /Path=\/api\/rag/);
  const polled = await fetch(site + "/api/rag/jobs/" + JOB, { headers: { cookie: setCookie.split(";", 1)[0], "x-rag-visitor": "B".repeat(43) } });
  assert.equal(polled.status, 200);
  assert.equal(polled.headers.get("set-cookie"), null);
  assert.deepEqual(await polled.json(), { job_id: JOB, status: "succeeded", result: ANSWER });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].headers.authorization, "Bearer " + TOKEN);
  assert.equal(requests[1].headers.authorization, "Bearer " + TOKEN);
  assert.equal(requests[0].headers["x-rag-visitor"], requests[1].headers["x-rag-visitor"]);
  assert.match(requests[0].headers["x-rag-visitor"], /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(requests[0].headers["x-rag-visitor"], "A".repeat(43));
  assert.equal(requests[0].headers.cookie, undefined);
  assert.deepEqual(requests[0].body, { ...QUESTION, top_k: 3, supplier_id: 22, part_id: 33, document_type: "order" });
  assert.equal(requests[1].url, "/jobs/" + JOB);
});

test("separate visitors and tampered cookies cannot retrieve another visitor's job", async (t) => {
  let owner;
  const { site } = await setup(t, (req, res) => {
    if (req.method === "POST") { owner = req.headers["x-rag-visitor"]; json(res, 202, { job_id: JOB, status: "running" }); }
    else if (req.headers["x-rag-visitor"] === owner) json(res, 200, { job_id: JOB, status: "succeeded", result: ANSWER });
    else json(res, 404, { message: "not owned" });
  });
  const posted = await submit(site);
  const cookie = posted.headers.get("set-cookie").split(";", 1)[0];
  const stranger = await fetch(site + "/api/rag/jobs/" + JOB, { headers: { "x-rag-visitor": owner } });
  assert.equal(stranger.status, 404);
  assert.ok(!JSON.stringify(await stranger.json()).includes(ANSWER.answer));
  const damaged = cookie.slice(0, -1) + (cookie.endsWith("A") ? "B" : "A");
  const tampered = await fetch(site + "/api/rag/jobs/" + JOB, { headers: { cookie: damaged } });
  assert.equal(tampered.status, 404);
  assert.ok(tampered.headers.get("set-cookie"));
  const duplicate = await fetch(site + "/api/rag/jobs/" + JOB, { headers: { cookie: cookie + "; " + cookie } });
  assert.equal(duplicate.status, 404);
  assert.equal((await fetch(site + "/api/rag/jobs/" + JOB, { headers: { cookie } })).status, 200);
});

test("HTTPS proxy requests receive Secure cookies", async (t) => {
  const { site } = await setup(t);
  const response = await submit(site, QUESTION, { "x-forwarded-proto": "https" });
  assert.match(response.headers.get("set-cookie"), /; Secure$/);
});

test("invalid field types, ranges and extra fields never reach gateway", async (t) => {
  let requests = 0;
  const { site } = await setup(t, (_req, res) => { requests++; json(res, 500, {}); });
  const invalid = [null, [], "null", { ...QUESTION, question: " " }, { ...QUESTION, question: "가".repeat(1001) }, { ...QUESTION, model: "arbitrary" }, { ...QUESTION, top_k: "3" }, { ...QUESTION, top_k: 11 }, { ...QUESTION, order_id: "1101" }, { ...QUESTION, supplier_id: true }, { ...QUESTION, part_id: 0 }, { ...QUESTION, part_id: 1.5 }, { ...QUESTION, part_id: Number.MAX_SAFE_INTEGER + 1 }, { ...QUESTION, document_type: "unknown" }, { ...QUESTION, url: "https://attacker.example" }, { ...QUESTION, __protoField: {} }];
  for (const body of invalid) {
    const response = await submit(site, body);
    assert.equal(response.status, 422, JSON.stringify(body));
    assert.match((await response.json()).error, /형식|범위/);
  }
  assert.equal(requests, 0);
});

test("invalid JSON, media type and oversized bodies have explicit errors", async (t) => {
  let requests = 0;
  const { site } = await setup(t, (_req, res) => { requests++; json(res, 500, {}); });
  assert.equal((await submit(site, "{")).status, 400);
  assert.equal((await submit(site, QUESTION, { "content-type": "text/plain" })).status, 415);
  assert.equal((await submit(site, { ...QUESTION, question: "가".repeat(4000) })).status, 413);
  const streamed = await fetch(site + "/api/rag/jobs", {
    method: "POST", headers: { "content-type": "application/json" }, duplex: "half",
    body: (async function* () { yield "{\"question\":\""; yield "a".repeat(9000); yield "\"}"; })(),
  });
  assert.equal(streamed.status, 413);
  assert.equal(requests, 0);
});

test("invalid job IDs, paths, methods and query strings are not forwarded", async (t) => {
  let requests = 0;
  const { site } = await setup(t, (_req, res) => { requests++; json(res, 500, {}); });
  for (const path of ["/api/rag/jobs/not-a-uuid", "/api/rag/jobs/" + JOB.toUpperCase(), "/api/rag/jobs/" + JOB + "?origin=secret"]) {
    assert.equal((await fetch(site + path)).status, 400);
  }
  assert.equal((await fetch(site + "/api/rag/missing")).status, 404);
  const wrongMethod = await fetch(site + "/api/rag/jobs");
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "POST");
  assert.equal((await fetch(site + "/api/rag/status", { method: "POST" })).status, 405);
  assert.equal(requests, 0);
});

test("quota response preserves bounded Retry-After and redacts gateway body and headers", async (t) => {
  const { site, gateway } = await setup(t, (_req, res) => json(res, 429, { message: TOKEN + " private address" }, { "retry-after": "42", "set-cookie": "gateway-secret=yes", location: "https://private.example" }));
  const response = await submit(site);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "42");
  assert.ok(!response.headers.get("set-cookie").includes("gateway-secret"));
  assert.equal(response.headers.get("location"), null);
  const text = await response.text();
  assert.ok(!text.includes(TOKEN));
  assert.ok(!text.includes(gateway));
  assert.match(text, /한도/);
});

test("redirects are never followed or exposed", async (t) => {
  let targetRequests = 0;
  const target = await listen(t, createServer((_req, res) => { targetRequests++; json(res, 202, { job_id: JOB, status: "running" }); }));
  const { site } = await setup(t, (_req, res) => json(res, 307, { message: TOKEN }, { location: target + "/" + TOKEN }));
  const response = await submit(site);
  assert.equal(response.status, 502);
  assert.equal(response.headers.get("location"), null);
  assert.ok(!(await response.text()).includes(TOKEN));
  assert.equal(targetRequests, 0);
});

test("gateway authorization and server errors become safe service errors", async (t) => {
  for (const status of [401, 403, 500, 503, 504]) {
    const { site } = await setup(t, (_req, res) => json(res, status, { message: TOKEN, error: "http://private-backend" }));
    const response = await submit(site);
    assert.equal(response.status, [503, 504].includes(status) ? status : 502);
    const text = await response.text();
    assert.ok(!text.includes(TOKEN));
    assert.ok(!text.includes("private-backend"));
  }
});

test("network errors and request timeouts do not expose private addresses", async (t) => {
  const site = await listen(t, createAppServer({ env: { RAG_ORIGIN: "http://127.0.0.1:1", RAG_GATEWAY_TOKEN: TOKEN } }));
  const unavailable = await submit(site);
  assert.equal(unavailable.status, 503);
  assert.ok(!(await unavailable.text()).includes("127.0.0.1"));
  const delayed = await setup(t, () => {}, { timeoutMs: 30 });
  const timedOut = await submit(delayed.site);
  assert.equal(timedOut.status, 504);
  assert.match((await timedOut.json()).error, /초과/);
});

test("invalid and excessive gateway responses are rejected", async (t) => {
  const responses = [
    [202, { job_id: "not-an-id", status: "running" }],
    [202, { job_id: JOB, status: "succeeded", result: ANSWER }],
    [200, { job_id: JOB, status: "running" }],
    [202, { job_id: JOB, status: "running", secret: "x".repeat(2000) }],
  ];
  for (const [status, data] of responses) {
    const { site } = await setup(t, (_req, res) => json(res, status, data), { maxResponseBytes: 1024 });
    assert.equal((await submit(site)).status, 502);
  }
  const malformed = await setup(t, (_req, res) => { res.writeHead(202); res.end("not JSON " + TOKEN); });
  const response = await submit(malformed.site);
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes(TOKEN));
});

test("failed jobs redact messages and successful results require the result contract", async (t) => {
  const { site } = await setup(t, (_req, res) => json(res, 200, { job_id: JOB, status: "failed", error_status: 504, message: TOKEN }));
  const failed = await fetch(site + "/api/rag/jobs/" + JOB);
  const body = await failed.json();
  assert.equal(body.status, "failed");
  assert.equal(body.error_status, 504);
  assert.match(body.message, /초과/);
  assert.ok(!JSON.stringify(body).includes(TOKEN));
  for (const result of [null, {}, { ...ANSWER, sources: "not-an-array" }, { ...ANSWER, answer: 42 }]) {
    const invalid = await setup(t, (_req, res) => json(res, 200, { job_id: JOB, status: "succeeded", result }));
    assert.equal((await fetch(invalid.site + "/api/rag/jobs/" + JOB)).status, 502);
  }
});
