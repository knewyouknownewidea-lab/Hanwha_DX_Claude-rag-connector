"""실제 웹 서버와 모의 게이트웨이 사이의 RAG 연결을 브라우저에서 검증합니다.

실제 모델/외부 서버/비밀 토큰은 사용하지 않습니다.
실행: npm run build 후 python tests/rag-e2e.py [캡처 폴더]
"""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import urlopen
import uuid

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
SHOTS = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(tempfile.mkdtemp(prefix="rag-e2e-"))
TOKEN = "test-only-gateway-token-0123456789abcdef"
posts = []
jobs = {}
checks = []


def check(name, condition):
    checks.append((name, bool(condition)))
    print(("PASS " if condition else "FAIL ") + name)
    if not condition:
        raise AssertionError(name)


class Gateway(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, code, value, **headers):
        data = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        for key, value in headers.items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if self.path != "/jobs" or self.headers.get("Authorization") != "Bearer " + TOKEN:
            return self.reply(401, {"message": "unauthorized"})
        payload = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        visitor = self.headers.get("X-Rag-Visitor", "")
        posts.append({"payload": payload, "visitor": visitor})
        if payload["question"] == "연결 오류 확인":
            return self.reply(503, {"message": "internal " + TOKEN})
        ident = str(uuid.uuid4())
        jobs[ident] = {"payload": payload, "visitor": visitor, "polls": 0}
        self.reply(202, {"job_id": ident, "status": "running"})

    def do_GET(self):
        ident = self.path.removeprefix("/jobs/")
        job = jobs.get(ident)
        if (self.headers.get("Authorization") != "Bearer " + TOKEN or not job
                or self.headers.get("X-Rag-Visitor") != job["visitor"]):
            return self.reply(404, {"message": "not found"})
        job["polls"] += 1
        if job["polls"] == 1 or job["payload"]["question"] == "취소 확인":
            return self.reply(200, {"job_id": ident, "status": "running"})
        question = job["payload"]["question"]
        if question == "실패 상태 확인":
            return self.reply(200, {"job_id": ident, "status": "failed", "message": TOKEN,
                                    "error_status": 503})
        result = {
            "question": question, "generation_model": job["payload"]["model"],
            "status": "answered", "answer": "발주 1101의 기록상 누적 납품 수량은 40개입니다. [E1]",
            "model_called": True, "retrieval_method": "structured_db", "citation_check": "valid_ids_only",
            "sources": [{"evidence_id": "E1", "chunk_id": "order-1101:db", "parent_document_id": "order-1101",
                         "source": {"source_refs": ["orders:1101", "delivery:2024"]}}],
        }
        if question == "근거 부족 확인":
            result.update(status="insufficient_evidence", answer="근거 부족: 현재 DB에서 확인할 수 없습니다.",
                          model_called=False, sources=[])
        if question == "추가 조건 확인":
            result.update(status="clarification_required", answer="조회할 협력사를 지정해 주세요.",
                          model_called=False, sources=[])
        self.reply(200, {"job_id": ident, "status": "succeeded", "result": result})


def free_port():
    with socket.socket() as connection:
        connection.bind(("127.0.0.1", 0))
        return connection.getsockname()[1]


def login(page, url):
    page.goto(url, wait_until="domcontentloaded")
    page.locator("#login-demo").click()
    page.locator(".eval-card").wait_for()
    if page.locator("#ob-skip").count():
        page.locator("#ob-skip").click()
    page.locator(".chat-launcher").click()
    page.locator("#chat-answer-mode").select_option("rag")
    expect(page.locator("#rag-model")).to_be_enabled()


def ask(page, question):
    before = page.locator(".msg-ai:not(:has(.progress))").count()
    page.locator("#chat-input").fill(question)
    page.locator(".send-btn").click()
    page.wait_for_function("""before => !document.querySelector('.progress') &&
        document.querySelectorAll('.msg-ai').length > before""", arg=before, timeout=15000)


SHOTS.mkdir(parents=True, exist_ok=True)
gateway = ThreadingHTTPServer(("127.0.0.1", 0), Gateway)
threading.Thread(target=gateway.serve_forever, daemon=True).start()
port = free_port()
url = f"http://127.0.0.1:{port}"
env = {**os.environ, "PORT": str(port), "RAG_ORIGIN": f"http://127.0.0.1:{gateway.server_port}",
       "RAG_GATEWAY_TOKEN": TOKEN, "ANTHROPIC_API_KEY": ""}
with tempfile.TemporaryFile() as log:
    server = subprocess.Popen(["node", "server/index.mjs"], cwd=ROOT, env=env, stdout=log, stderr=log,
                              creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    try:
        for attempt in range(100):
            try:
                with urlopen(url + "/api/rag/status", timeout=1) as response:
                    if json.load(response)["enabled"]:
                        break
            except OSError:
                if server.poll() is not None:
                    raise RuntimeError("테스트 웹 서버가 종료되었습니다.")
                time.sleep(.05)
        else:
            raise RuntimeError("테스트 웹 서버 시작 시간 초과")
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            context = browser.new_context(viewport={"width": 1366, "height": 768})
            page = context.new_page()
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            login(page, url)
            page.locator("#chat-input").fill("발주 1101 수량은?")
            check("모델을 명시적으로 선택하기 전에는 질문을 보내지 않음", page.locator(".send-btn").is_disabled() and not posts)
            page.locator("#rag-model").select_option("gemma3:4b")
            check("RAG 모드에 웹 데이터 선택 필터를 표시하지 않음", page.locator(".ctx-chips").count() == 0)
            ask(page, "발주 1101 수량은?")
            expect(page.locator(".engine-rag")).to_have_count(1)
            expect(page.locator(".chat-list")).to_contain_text("40개")
            page.locator(".rag-sources summary").click()
            expect(page.locator(".rag-sources")).to_contain_text("orders:1101")
            check("실제 중계 API를 거쳐 답변과 출처 표시", "delivery:2024" in page.locator(".rag-sources").inner_text())
            check("웹 샘플 ID를 임의로 RAG ID로 변환하지 않음", set(posts[0]["payload"]) == {"question", "model", "top_k"})
            check("방문자 ID가 게이트웨이의 43자 형식", len(posts[0]["visitor"]) == 43)
            visitor = posts[0]["visitor"]
            ask(page, "근거 부족 확인")
            expect(page.locator(".chat-list")).to_contain_text("근거 부족: 현재 DB에서 확인할 수 없습니다.")
            check("근거 부족을 분석 데모로 대체하지 않음", page.locator(".engine-rule").count() == 0)
            ask(page, "추가 조건 확인")
            expect(page.locator(".chat-list")).to_contain_text("조회할 협력사를 지정해 주세요.")
            check("후속 질문과 폴링에 같은 방문자 유지", all(p["visitor"] == visitor for p in posts))
            ask(page, "실패 상태 확인")
            check("작업 실패 후 입력을 다시 사용할 수 있음", not page.locator("#chat-input").is_disabled())
            ask(page, "연결 오류 확인")
            check("내부 토큰이 화면/HTML에 노출되지 않음", TOKEN not in page.content())
            check("에러가 나도 대기 상태 해제", page.locator(".progress").count() == 0)
            check("RAG 응답으로 기존 분석 결과를 지어내지 않음", page.locator(".msg-result").count() == 0)
            before = len(posts)
            page.locator("#chat-input").fill("발주 1101 수량은?")
            page.locator("#chat-input").press("Enter")
            page.locator("#chat-input").press("Enter")
            page.locator(".progress").wait_for(state="detached", timeout=15000)
            check("Enter를 연속 눌러도 작업은 한 번만 생성", len(posts) == before + 1)
            for width, height in [(1920, 1080), (1366, 768), (900, 900), (400, 860)]:
                page.set_viewport_size({"width": width, "height": height})
                page.wait_for_timeout(150)
                check(f"{width}px: 페이지 가로 넘침 없음", page.evaluate("document.documentElement.scrollWidth <= innerWidth"))
                check(f"{width}px: 모드·모델·질문 입력 사용 가능", all(page.locator(s).is_visible() for s in
                       ["#chat-answer-mode", "#rag-model", "#chat-input"]))
                too_small = page.locator("#chat-window").evaluate("""root => [...root.querySelectorAll('*')].filter(e => {
                    const r=e.getBoundingClientRect(); return r.width && r.height &&
                    [...e.childNodes].some(n=>n.nodeType===3&&n.textContent.trim()) && parseFloat(getComputedStyle(e).fontSize)<12;
                }).map(e=>e.className)""")
                check(f"{width}px: 새 챗봇 글자 12px 이상", not too_small)
                page.screenshot(path=str(SHOTS / f"rag_{width}.png"))
            check("브라우저 JavaScript 오류 없음", not errors)
            other = browser.new_context()
            other_page = other.new_page()
            login(other_page, url)
            other_page.locator("#rag-model").select_option("gemma3:4b")
            ask(other_page, "발주 1101 수량은?")
            check("다른 브라우저의 방문자 구분", posts[-1]["visitor"] != visitor)
            page.set_viewport_size({"width": 1366, "height": 768})
            page.locator("#chat-answer-mode").select_option("analysis")
            ask(page, "업체 A랑 업체 C 비교해줘")
            expect(page.locator(".msg-result")).to_have_count(1)
            check("기존 웹 데이터 분석으로 전환 가능", page.locator(".ctx-chips").count() == 1)
            page.locator("#chat-answer-mode").select_option("rag")
            before = len(posts)
            page.locator(".eval-head .eval-basis-btn").click()
            page.locator("#basis-popover .pop-foot button").click()
            expect(page.locator("#chat-answer-mode")).to_have_value("analysis")
            page.locator(".progress").wait_for(state="detached", timeout=15000)
            check("기존 평가 카드 버튼은 RAG 모드에서도 웹 데이터 분석 사용", len(posts) == before)
            page.locator("#chat-answer-mode").select_option("rag")
            page.locator("#chat-input").fill("취소 확인")
            page.locator(".send-btn").click()
            page.locator(".progress").wait_for()
            page.locator(".user-btn").click()
            page.locator(".user-pop [role='menuitem']", has_text="로그아웃").click()
            page.locator(".modal-backdrop button", has_text="로그아웃").click()
            page.locator("#login-demo").wait_for()
            page.wait_for_timeout(150)
            cancel_job = next(job for job in jobs.values() if job["payload"]["question"] == "취소 확인")
            polls = cancel_job["polls"]
            page.wait_for_timeout(2500)
            check("로그아웃 후에는 RAG 폴링 중단", cancel_job["polls"] == polls)
            browser.close()
    finally:
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait()
        gateway.shutdown()
        gateway.server_close()

print(f"\n{sum(ok for _, ok in checks)}/{len(checks)} RAG E2E 통과 · 모의 게이트웨이 사용 · 캡처: {SHOTS}")
