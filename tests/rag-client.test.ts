// 외부 모델·인증 정보 없이 구매 RAG 클라이언트 계약과 취소 동작을 확인한다.
import assert from "node:assert/strict";
import { askRag, getRagConfig, type RagQuestion } from "../src/ai/rag";

const id = "11111111-1111-4111-8111-111111111111";
const running = { job_id: id, status: "running" };
const answer = {
  question: "발주 1101 수량은?", status: "answered", answer: "수량은 10개입니다. [E1]",
  message: "검색 근거로 답변을 생성했습니다.", generation_model: "gemma3:4b", model_called: true,
  sources: [{ evidence_id: "E1", chunk_id: "order-1101:db", parent_document_id: "order-1101", similarity: null,
    source: { source_refs: ["orders:1101", "delivery:2024"], source_db: "test.db", source_db_sha256: "test-digest" } }],
};
const succeeded = { job_id: id, status: "succeeded", result: answer };
const question: RagQuestion = { question: "발주 1101 수량은?", model: "gemma3:4b" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function sequence(...steps: (unknown | Response)[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    assert.ok(steps.length, "예상보다 많은 네트워크 요청");
    const next = steps.shift();
    return next instanceof Response ? next : reply(next);
  };
  return { fetcher, calls };
}
let passed = 0;
async function check(name: string, run: () => Promise<void>) {
  await run();
  passed++;
  console.log(`✓ ${name}`);
}
const immediate = { pollIntervalMs: 0 };

await check("연결된 모델 목록만 사용", async () => {
  const mock = sequence({ enabled: true, models: ["gemma3:4b", "qwen3:8b", "gemma3:4b"] });
  assert.deepEqual(await getRagConfig(undefined, mock.fetcher), { enabled: true, models: ["gemma3:4b", "qwen3:8b"] });
});
await check("설정 안 된 서버를 활성으로 간주하지 않음", async () => {
  const mock = sequence({ enabled: false, models: [] });
  assert.equal((await getRagConfig(undefined, mock.fetcher)).enabled, false);
});
await check("활성 서버의 빈 모델 목록 거절", async () => {
  const mock = sequence({ enabled: true, models: [] });
  await assert.rejects(getRagConfig(undefined, mock.fetcher), /응답 형식/);
});
await check("알 수 없는 설정 모델 거절", async () => {
  const mock = sequence({ enabled: true, models: ["unknown"] });
  await assert.rejects(getRagConfig(undefined, mock.fetcher), /응답 형식/);
});
await check("한 번 생성 후 같은 작업 폴링, 출처 메타데이터 보존", async () => {
  const mock = sequence(running, running, succeeded);
  const result = await askRag({ ...question, question: `  ${question.question}  ` }, { ...immediate, fetcher: mock.fetcher });
  assert.equal(result.answer, answer.answer);
  assert.deepEqual(result.sources, answer.sources);
  assert.equal(mock.calls.length, 3);
  assert.equal(mock.calls.filter((c) => c.init?.method === "POST").length, 1);
  assert.equal(mock.calls[1].url, `/api/rag/jobs/${id}`);
  assert.equal(mock.calls[2].url, mock.calls[1].url);
  assert.deepEqual(JSON.parse(String(mock.calls[0].init?.body)), { ...question, top_k: 3 });
  assert.equal(mock.calls[0].init?.credentials, "same-origin");
});
await check("지원하는 명시적 필터만 호출자가 지정한 값으로 전달", async () => {
  const mock = sequence(succeeded);
  await askRag({ ...question, order_id: 1101, document_type: "order" }, { fetcher: mock.fetcher });
  const body = JSON.parse(String(mock.calls[0].init?.body));
  assert.equal(body.order_id, 1101);
  assert.equal(body.document_type, "order");
  assert.ok(!("supplier_id" in body));
});
await check("모델 선택 생략 시 네트워크 호출 없음", async () => {
  const mock = sequence();
  await assert.rejects(askRag({ ...question, model: "" as never }, { fetcher: mock.fetcher }), /모델을 선택/);
  assert.equal(mock.calls.length, 0);
});
await check("빈 질문과 1000자 초과 거절", async () => {
  for (const text of [" ", "가".repeat(1001)]) await assert.rejects(askRag({ ...question, question: text }), /1~1000자/);
});
await check("출처 없는 모델 답변 거절", async () => {
  const mock = sequence({ ...succeeded, result: { ...answer, sources: [] } });
  await assert.rejects(askRag(question, { fetcher: mock.fetcher }), /응답 형식/);
});
await check("존재하지 않는 출처 번호 거절", async () => {
  const mock = sequence({ ...succeeded, result: { ...answer, answer: "수량은 10개입니다. [E2]" } });
  await assert.rejects(askRag(question, { fetcher: mock.fetcher }), /응답 형식/);
});
await check("원본 참조가 비어 있는 출처 거절", async () => {
  const mock = sequence({ ...succeeded, result: { ...answer, sources: [{ evidence_id: "E1", source: { source_refs: [] } }] } });
  await assert.rejects(askRag(question, { fetcher: mock.fetcher }), /응답 형식/);
});
await check("요청과 다른 응답 모델 거절", async () => {
  const mock = sequence({ ...succeeded, result: { ...answer, generation_model: "qwen3:8b" } });
  await assert.rejects(askRag(question, { fetcher: mock.fetcher }), /응답 형식/);
});
await check("근거 부족 답변은 출처나 수치를 만들지 않고 표시", async () => {
  const text = "제공된 문서에서 관련 정보를 찾을 수 없습니다.";
  const mock = sequence({ ...succeeded, result: { ...answer, status: "insufficient_evidence", answer: text, sources: [], model_called: false } });
  const result = await askRag(question, { fetcher: mock.fetcher });
  assert.equal(result.answer, text);
  assert.deepEqual(result.sources, []);
  assert.equal(result.modelCalled, false);
});
await check("생성 보류·검증 실패 메시지를 정상 답변으로 꾸미지 않음", async () => {
  for (const status of ["context_limit_exceeded", "invalid_generation", "clarification_required"]) {
    const mock = sequence({ ...succeeded, result: { ...answer, status, answer: null, message: "질문을 구체화해 주세요.", sources: [] } });
    const result = await askRag(question, { fetcher: mock.fetcher });
    assert.equal(result.answer, "질문을 구체화해 주세요.");
    assert.equal(result.status, status);
  }
});
await check("실패 작업은 재생성하지 않고 오류 전달", async () => {
  const mock = sequence(running, { ...running, status: "failed", message: "Ollama가 실행되지 않았습니다." });
  await assert.rejects(askRag(question, { ...immediate, fetcher: mock.fetcher }), /Ollama/);
  assert.equal(mock.calls.length, 2);
});
await check("서버의 요청 한도 오류 전달", async () => {
  const mock = sequence(reply({ error: "질문 한도에 도달했습니다." }, 429));
  await assert.rejects(askRag(question, { fetcher: mock.fetcher }), /질문 한도/);
  assert.equal(mock.calls.length, 1);
});
await check("잘못된 작업 ID를 URL로 사용하지 않음", async () => {
  const mock = sequence({ job_id: "../private", status: "running" });
  await assert.rejects(askRag(question, { fetcher: mock.fetcher }), /응답 형식/);
  assert.equal(mock.calls.length, 1);
});
await check("다른 작업의 폴링 응답 거절", async () => {
  const mock = sequence(running, { ...succeeded, job_id: "22222222-2222-4222-8222-222222222222" });
  await assert.rejects(askRag(question, { ...immediate, fetcher: mock.fetcher }), /응답 형식/);
});
await check("알 수 없는 작업 상태 거절", async () => {
  const mock = sequence({ ...running, status: "pending" });
  await assert.rejects(askRag(question, { fetcher: mock.fetcher }), /응답 형식/);
});
await check("HTML 응답을 JSON 성공으로 간주하지 않음", async () => {
  const mock = sequence(new Response("<html>offline</html>", { status: 200 }));
  await assert.rejects(askRag(question, { fetcher: mock.fetcher }), /응답 형식/);
});
await check("네트워크 실패는 분석 모드로 대체하지 않음", async () => {
  await assert.rejects(askRag(question, { fetcher: async () => { throw new TypeError("Failed to fetch"); } }), /연결할 수 없습니다/);
});
await check("로그아웃에 해당하는 외부 취소는 다음 폴링을 멈춤", async () => {
  const mock = sequence(running);
  const controller = new AbortController();
  const task = askRag(question, { signal: controller.signal, fetcher: mock.fetcher, pollIntervalMs: 1000 });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(task, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
  assert.equal(mock.calls.length, 1);
});
await check("이미 취소된 요청은 작업을 생성하지 않음", async () => {
  const mock = sequence();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(askRag(question, { signal: controller.signal, fetcher: mock.fetcher }), /abort/i);
  assert.equal(mock.calls.length, 0);
});
await check("전체 대기시간을 넘으면 폴링 중단", async () => {
  const mock = sequence(running);
  await assert.rejects(askRag(question, { timeoutMs: 10, pollIntervalMs: 1000, fetcher: mock.fetcher }), /대기 시간이 초과/);
  assert.equal(mock.calls.length, 1);
});
await check("응답이 멎은 fetch도 전체 제한시간으로 중단", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    calls++;
    return new Promise((_resolve, reject) => { init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }); });
  };
  await assert.rejects(askRag(question, { timeoutMs: 10, fetcher }), /대기 시간이 초과/);
  assert.equal(calls, 1);
});

console.log(`RAG client: ${passed} tests passed`);
