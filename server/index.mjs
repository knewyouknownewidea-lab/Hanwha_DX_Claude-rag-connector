// 로컬 서버: dist/를 제공하고, API 키가 있으면 LLM 질문 해석을 중계한다.
// API 키는 서버 환경변수로만 읽고 브라우저 코드에는 넣지 않는다.
//   ANTHROPIC_API_KEY=... LLM_MODEL=claude-haiku-5-5 PORT=5173 node server/index.mjs
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRagHandler } from "./rag.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");
const PORT = Number(process.env.PORT || 5173);
const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.LLM_MODEL || "claude-haiku-5-5";
const MAX_PROMPT = 60_000;

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".csv": "text/csv; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_PROMPT * 4) throw new Error("요청이 너무 큽니다");
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function interpret(prompt) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 400,
      system: "You convert a Korean procurement question into one JSON object exactly as instructed. Reply with JSON only.",
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.error?.message || `LLM API 응답 ${r.status}`);
  return (body.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
}

export function createAppServer({ env = process.env, ragOptions } = {}) {
  const handleRag = createRagHandler(env, ragOptions);
  return createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    try {
      if (await handleRag(req, res, url)) return;
      if (url.pathname === "/api/ai/status") return send(res, 200, { enabled: !!API_KEY, model: API_KEY ? MODEL : null });
      if (url.pathname === "/api/ai/interpret" && req.method === "POST") {
        if (!API_KEY) return send(res, 503, { error: "ANTHROPIC_API_KEY가 설정되지 않았습니다" });
        const { prompt } = await readBody(req);
        if (typeof prompt !== "string" || !prompt.trim() || prompt.length > MAX_PROMPT) return send(res, 400, { error: "prompt가 비었거나 너무 깁니다" });
        return send(res, 200, { text: await interpret(prompt) });
      }
      let path = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
      if (!path || path.endsWith("/")) path += "index.html";
      const file = join(dist, path);
      if (!file.startsWith(dist)) return send(res, 403, { error: "forbidden" });
      try {
        const data = await readFile(file);
        return send(res, 200, data, TYPES[extname(file)] || "application/octet-stream");
      } catch {
        const html = await readFile(join(dist, "index.html"));
        return send(res, 200, html, TYPES[".html"]);
      }
    } catch (e) {
      return send(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createAppServer().listen(PORT, () => {
    console.log(`[server] http://localhost:${PORT}  ·  LLM ${API_KEY ? `연결 (${MODEL})` : "미연결 → 규칙 기반 데모로 동작"}`);
  });
}
