// 브라우저는 같은 출처의 API만 사용하고, 게이트웨이 주소·토큰은 이 서버에 둡니다.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const RAG_MODELS = Object.freeze(["qwen3:8b", "gemma3:4b", "llama3.1:8b"]);
const DOCUMENT_TYPES = new Set(["supplier", "part", "supplier_part", "order", "complaint"]);
const INPUT_FIELDS = new Set(["question", "model", "top_k", "order_id", "supplier_id", "part_id", "document_type"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COOKIE = "rag_visitor";
const VISITOR = /^[A-Za-z0-9_-]{43}$/;
const MAX_BODY_BYTES = 8192;
const MAX_RESPONSE_BYTES = 256 * 1024;
const OFFLINE = "RAG 연결 설정이 필요합니다. 관리자에게 문의해 주세요.";
const BAD_INPUT = "질문·모델·조회 조건의 형식이나 범위를 확인해 주세요.";
const UNAVAILABLE = "RAG 답변 서비스를 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.";

class RagError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function configuration(env) {
  try {
    const raw = env.RAG_ORIGIN;
    const token = env.RAG_GATEWAY_TOKEN;
    if (typeof raw !== "string" || raw !== raw.trim() || !/^[\x21-\x7e]{32,4096}$/.test(token || "")) return null;
    const url = new URL(raw);
    const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127\.(\d{1,3}\.){2}\d{1,3}$/.test(url.hostname);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return { origin: url.origin, token };
  } catch {
    return null;
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function signature(visitor, token) {
  return createHmac("sha256", token).update("hanwha-rag-visitor-v1:" + visitor).digest("base64url");
}

function identify(req, res, token) {
  // 사용자가 보낸 Authorization/X-Rag-Visitor는 사용하지 않습니다.
  const cookies = (req.headers.cookie || "").split(";").map((value) => value.trim()).filter((value) => value.startsWith(COOKIE + "="));
  if (cookies.length === 1) {
    const [visitor, signed, extra] = cookies[0].slice(COOKIE.length + 1).split(".");
    if (VISITOR.test(visitor || "") && VISITOR.test(signed || "") && extra === undefined) {
      const expected = signature(visitor, token);
      if (timingSafeEqual(Buffer.from(signed), Buffer.from(expected))) return visitor;
    }
  }
  const visitor = randomBytes(32).toString("base64url");
  // TLS 종단 프록시 뒤에서도 HTTPS 쿠키 속성을 유지합니다.
  const secure = req.socket.encrypted || req.headers["x-forwarded-proto"] === "https";
  res.setHeader("set-cookie", `${COOKIE}=${visitor}.${signature(visitor, token)}; Path=/api/rag; HttpOnly; SameSite=Lax; Max-Age=2592000${secure ? "; Secure" : ""}`);
  return visitor;
}

async function readBody(req) {
  if (req.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    req.resume();
    throw new RagError(415, "JSON 형식으로 요청해 주세요.");
  }
  const declared = req.headers["content-length"];
  if (declared !== undefined && (!/^\d{1,10}$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    req.resume();
    throw new RagError(413, "요청 본문이 너무 큽니다.");
  }
  const buffer = await new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const finish = (error) => {
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      req.removeListener("aborted", onError);
      if (error) { req.resume(); reject(error); }
      else resolve(Buffer.concat(chunks));
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) finish(new RagError(413, "요청 본문이 너무 큽니다."));
      else chunks.push(chunk);
    };
    const onEnd = () => finish();
    const onError = () => finish(new RagError(400, "요청을 읽을 수 없습니다."));
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("aborted", onError);
  });
  try { return JSON.parse(buffer.toString("utf8")); }
  catch { throw new RagError(400, "올바른 JSON 형식으로 요청해 주세요."); }
}

function validateInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !INPUT_FIELDS.has(key))) throw new RagError(422, BAD_INPUT);
  if (typeof value.question !== "string" || !value.question.trim() || value.question.length > 1000 || !RAG_MODELS.includes(value.model)) throw new RagError(422, BAD_INPUT);
  const payload = { question: value.question.trim(), model: value.model };
  if (value.top_k !== undefined) {
    if (!Number.isSafeInteger(value.top_k) || value.top_k < 1 || value.top_k > 10) throw new RagError(422, BAD_INPUT);
    payload.top_k = value.top_k;
  }
  for (const key of ["order_id", "supplier_id", "part_id"]) {
    if (value[key] === undefined || value[key] === null) continue;
    if (!Number.isSafeInteger(value[key]) || value[key] <= 0) throw new RagError(422, BAD_INPUT);
    payload[key] = value[key];
  }
  if (value.document_type !== undefined && value.document_type !== null) {
    if (!DOCUMENT_TYPES.has(value.document_type)) throw new RagError(422, BAD_INPUT);
    payload.document_type = value.document_type;
  }
  return payload;
}

function errorMessage(status) {
  if (status === 404) return "작업을 찾을 수 없거나 보관 시간이 지났습니다. 질문을 다시 보내 주세요.";
  if (status === 429) return "다른 질문을 처리 중이거나 질문 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.";
  if (status === 504) return "RAG 응답 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.";
  if ([400, 409, 422].includes(status)) return BAD_INPUT;
  return UNAVAILABLE;
}

async function readResponse(response, maxBytes) {
  const chunks = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (!reader) throw new RagError(502, UNAVAILABLE);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new RagError(502, "RAG 응답 크기가 한도를 넘었습니다. 질문 범위를 좁혀 주세요.");
      }
      chunks.push(Buffer.from(value));
    }
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("object required");
    return data;
  } catch (error) {
    if (error instanceof RagError) throw error;
    throw new RagError(502, UNAVAILABLE);
  } finally { reader.releaseLock(); }
}

function publicJob(data, jobId, submit) {
  if (!UUID.test(data.job_id || "") || (jobId && data.job_id !== jobId) || !["running", "succeeded", "failed"].includes(data.status) || (submit && data.status !== "running")) throw new RagError(502, UNAVAILABLE);
  const job = { job_id: data.job_id, status: data.status };
  if (data.status === "failed") {
    job.error_status = [400, 404, 409, 422, 429, 502, 503, 504].includes(data.error_status) ? data.error_status : 502;
    job.message = errorMessage(job.error_status);
  }
  if (data.status === "succeeded") {
    const result = data.result;
    if (!result || typeof result !== "object" || Array.isArray(result) || typeof result.status !== "string" || (typeof result.answer !== "string" && result.answer !== null) || !Array.isArray(result.sources)) throw new RagError(502, UNAVAILABLE);
    // 게이트웨이 작업 메타데이터는 넘기지 않고, 공개 답변 계약만 전달합니다.
    job.result = {};
    for (const key of ["question", "status", "answer", "message", "generation_model", "model_called", "retrieval_method", "sources", "citation_check", "note"]) {
      if (Object.hasOwn(result, key)) job.result[key] = result[key];
    }
  }
  return job;
}

export function createRagHandler(env = process.env, { fetchImpl = fetch, timeoutMs = 10_000, maxResponseBytes = MAX_RESPONSE_BYTES } = {}) {
  const config = configuration(env);
  return async function handleRag(req, res, url) {
    if (url.pathname !== "/api/rag" && !url.pathname.startsWith("/api/rag/")) return false;
    try {
      if (url.pathname === "/api/rag/status") {
        if (req.method !== "GET") { send(res, 405, { error: "지원하지 않는 요청 방식입니다." }, { allow: "GET" }); return true; }
        send(res, 200, { enabled: !!config, models: RAG_MODELS, ...(!config ? { message: OFFLINE } : {}) });
        return true;
      }
      const submit = url.pathname === "/api/rag/jobs";
      const poll = /^\/api\/rag\/jobs\/([^/]+)$/.exec(url.pathname);
      if (!submit && !poll) throw new RagError(404, "지원하지 않는 RAG 요청입니다.");
      const method = submit ? "POST" : "GET";
      if (req.method !== method) { send(res, 405, { error: "지원하지 않는 요청 방식입니다." }, { allow: method }); return true; }
      if (url.search || (poll && !UUID.test(poll[1]))) throw new RagError(400, BAD_INPUT);
      if (!config) throw new RagError(503, OFFLINE);
      const payload = submit ? validateInput(await readBody(req)) : undefined;
      const visitor = identify(req, res, config.token);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(config.origin + (submit ? "/jobs" : "/jobs/" + poll[1]), {
          method,
          headers: { "content-type": "application/json", authorization: "Bearer " + config.token, "x-rag-visitor": visitor },
          ...(payload ? { body: JSON.stringify(payload) } : {}),
          redirect: "manual",
          signal: controller.signal,
        });
        if (!response.ok) {
          // 인증 오류/리다이렉트/내부 오류 내용·헤더에는 비밀 값이 있을 수 있습니다.
          const status = [400, 404, 409, 422, 429, 503, 504].includes(response.status) ? response.status : 502;
          const retry = response.headers.get("retry-after");
          const headers = status === 429 && /^\d{1,6}$/.test(retry || "") ? { "retry-after": String(Math.max(1, Math.min(86400, Number(retry)))) } : {};
          await response.body?.cancel();
          send(res, status, { error: errorMessage(status) }, headers);
          return true;
        }
        if (response.status !== (submit ? 202 : 200)) { await response.body?.cancel(); throw new RagError(502, UNAVAILABLE); }
        const data = publicJob(await readResponse(response, maxResponseBytes), poll?.[1], submit);
        send(res, submit ? 202 : 200, data, submit ? { location: "/api/rag/jobs/" + data.job_id } : {});
      } catch (error) {
        if (controller.signal.aborted) throw new RagError(504, errorMessage(504));
        if (error instanceof RagError) throw error;
        throw new RagError(503, UNAVAILABLE);
      } finally { clearTimeout(timer); }
    } catch (error) {
      if (!req.readableEnded && req.method === "POST") req.resume();
      send(res, error instanceof RagError ? error.status : 502, { error: error instanceof RagError ? error.message : UNAVAILABLE });
    }
    return true;
  };
}
