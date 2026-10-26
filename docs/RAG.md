# 구매 DB RAG 연결

v0.4.0부터 기존 **AI에게 질문하기** 창에서 **질문 방식 → 구매 DB RAG**를 선택할 수 있습니다.
**웹 데이터 분석**은 기존 계산·비교·시각화 기능을 계속 사용합니다.

```text
챗봇 → 같은 웹 서버 /api/rag/jobs → 구매 RAG 게이트웨이 /jobs
     ← 답변·출처                 ← Python RAG + Ollama
```

## 1. 필요한 실행 환경

- 이 저장소의 Node.js 웹 서버: `npm start` 또는 `npm run dev`
- 구매 RAG 저장소의 Python 백엔드(8000), 최초 구축된 검색 인덱스
- 설치된 생성 모델을 제공하는 Ollama(11434)
- 같은 PC의 Python 백엔드에 연결되는 구매 RAG 게이트웨이(8010)

RAG 구현은 `knewyouknownewidea-lab/Hanwha_DX_Claude`의 `purchase-rag/`에 있습니다.
게이트웨이 계약은 해당 저장소의 `purchase-rag/deployment/gateway.py`입니다.
모델은 `qwen3:8b`, `gemma3:4b`, `llama3.1:8b` 중 실제 설치한 모델을 화면에서 명시적으로 고릅니다.
모델을 고르기 전에는 질문을 보내지 않습니다.

`dist/index.html`을 파일로 열거나 정적 파일만 호스팅하면 서버 API가 실행되지 않으므로 RAG를 사용할 수 없습니다.
기존 웹 데이터 분석은 그대로 사용할 수 있습니다.

## 2. RAG 쪽 준비

구매 RAG 저장소의 `purchase-rag/`에서 기존 Python 환경을 사용합니다.
새 환경의 의존성 설치와 모델 준비는 그 저장소의 `README.rst`를 따릅니다.

```powershell
# 구매 RAG 저장소의 purchase-rag 폴더
git pull --ff-only origin main
& ..\work\chunking-venv\Scripts\python.exe -m backend.manage stop
& ..\work\chunking-venv\Scripts\python.exe -m backend.manage start
& ..\work\chunking-venv\Scripts\python.exe -m backend.client status

# 첫 실행으로 인덱스가 없거나 원본 DB를 바꾼 경우에만 구축/갱신
& ..\work\chunking-venv\Scripts\python.exe -m backend.client index
```

서버 규칙 코드만 갱신한 경우에는 재시작하면 적용되며 인덱스를 다시 만들 필요가 없습니다.
Ollama도 실행하고 사용할 모델을 설치합니다. 예를 들어 사용할 모델로 `gemma3:4b`를 선택한 경우:

```powershell
ollama pull gemma3:4b
```

게이트웨이를 실행할 터미널에서 비밀 토큰을 숨김 입력합니다. 같은 토큰을 웹 서버에도 설정합니다.
토큰은 32자 이상이며 저장소·브라우저 코드·공개 로그에 넣지 않습니다.

```powershell
$ragSecret = Read-Host 'RAG 게이트웨이 토큰' -AsSecureString
$ragPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ragSecret)
try { $env:RAG_GATEWAY_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ragPointer) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ragPointer) }
& ..\work\chunking-venv\Scripts\python.exe -m deployment
```

이 터미널은 게이트웨이를 실행한 상태로 유지합니다.

## 3. 웹 서버 설정과 실행

| 서버 환경변수 | 값 |
| --- | --- |
| `RAG_ORIGIN` | 게이트웨이의 **원점 주소**. 같은 PC라면 `http://127.0.0.1:8010`, 외부라면 실제 HTTPS 게이트웨이 주소 |
| `RAG_GATEWAY_TOKEN` | 게이트웨이와 동일한 32자 이상 비밀 토큰 |
| `PORT` | 선택. 기본 5173 |

`RAG_ORIGIN`에 `/jobs` 경로·쿼리·사용자명·비밀번호를 붙이지 않습니다.
HTTPS 또는 루프백 HTTP만 허용합니다. 설정이 없거나 형식이 잘못되면 기존 웹 분석은 유지되고 RAG 전송만 비활성화됩니다.

다른 PowerShell 터미널에서 이 웹 저장소 루트로 이동한 뒤 실행합니다.

```powershell
npm install
$env:RAG_ORIGIN = 'http://127.0.0.1:8010'
$ragSecret = Read-Host '동일한 RAG 게이트웨이 토큰' -AsSecureString
$ragPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ragSecret)
try { $env:RAG_GATEWAY_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ragPointer) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ragPointer) }
npm start
```

`http://localhost:5173`에서 로그인 → **AI에게 질문하기** → **구매 DB RAG** → 설치한 모델을 선택합니다.
첫 확인 질문은 **발주 1101 수량은?**처럼 RAG DB의 ID를 포함한 질문을 사용합니다.
출처 펼침을 누르면 `[E1]`과 `orders:1101` 같은 원본 참조를 확인할 수 있습니다.

외부에 배포한 웹 서버에서 RAG를 호출한다면 `127.0.0.1`은 그 웹 서버 자신을 가리킵니다.
PC의 게이트웨이를 외부 HTTPS 주소로 연결하거나 같은 네트워크의 서버에 배포하고 그 주소를 설정해야 합니다.
Quick Tunnel을 사용하면 재시작 시 주소가 바뀔 수 있으며, 그때 `RAG_ORIGIN` 갱신과 웹 서버 재시작이 필요합니다.
현재 PC에서 RAG를 실행하는 구성은 PC·Ollama·Python·게이트웨이가 실행 중일 때 작동합니다.

## 4. API 계약

브라우저는 같은 출처의 웹 서버 API만 호출합니다.

| 경로 | 기능 |
| --- | --- |
| `GET /api/rag/status` | `{enabled, models}`. **설정 유효성**이며 모델 설치·서버 접근 가능성을 보장하는 상태 검사는 아님 |
| `POST /api/rag/jobs` | 게이트웨이에 작업을 한 번 생성, 202와 `{job_id, status:"running"}` 반환 |
| `GET /api/rag/jobs/{job_id}` | 2초 간격으로 조회. `running` / `succeeded` / `failed` |

요청 예시:

```json
{
  "question": "수량은?",
  "model": "gemma3:4b",
  "order_id": 1101,
  "top_k": 3
}
```

서버는 `question`, `model`, `top_k`, `order_id`, `supplier_id`, `part_id`, `document_type`만 허용합니다.
완료된 `result.answer`, `result.sources`를 표시합니다. 근거 부족·추가 조건 요청은 그대로 표시하며,
실패하면 RAG 오류를 알려 줍니다. 실패를 웹 분석의 성공 답변으로 바꾸지 않습니다.
작업을 중복 제출하지 않으며 대기 한도는 11분입니다. HTTP 호출 하나의 중계 제한은 10초입니다.

웹 서버가 `Authorization`과 `X-Rag-Visitor`를 추가합니다.
방문자 식별은 서명된 익명 HttpOnly 쿠키로 유지하며, 브라우저가 보낸 인증/방문자 헤더를 신뢰하지 않습니다.
토큰·내부 주소는 상태 응답과 브라우저 번들에 넣지 않습니다.
429는 서버 사용 중/한도 도달이며 잠시 후 다시 시도합니다.
503은 RAG·Ollama·모델 설치 상태, 504는 시간 초과를 확인합니다.

## 5. 데이터 범위

- 웹 화면의 `SUP-001`, `ITM-1001`, 발주 코드와 RAG의 정수 ID는 별개의 데이터입니다.
- 현재 RAG 모드는 질문 본문·선택한 생성 모델만 전송합니다. 웹 화면의 선택·업로드 데이터를 자동으로 보내거나 숫자로 바꾸지 않습니다.
- 화면 데이터와 같은 대상을 조회하려면 실제 업무 데이터로 RAG DB를 맞추거나 검증된 ID 대응 관계를 별도로 구현해야 합니다.
- RAG 답변을 기존 비교표·평가 점수·분석 결과로 자동 변환하지 않습니다. 원본 답변과 출처를 챗봇에 표시합니다.
- 대화 문장은 브라우저에 저장되지만 전체 대화 이력을 RAG에 전달하지 않습니다. 후속 질문에도 조회 대상을 명확히 적습니다.
- 기존 평가 카드·선택 정보의 분석 버튼은 웹 데이터 분석을 사용합니다.

## 6. 검증

```powershell
npm run typecheck
npm run build
npm run test:logic
npm run test:rag
npm run test:e2e:rag
# 기존 전체 화면 회귀 검증: 웹 서버를 실행한 후
python tests/e2e.py http://localhost:5173
```

RAG 서버/클라이언트/브라우저 테스트는 모의 게이트웨이와 가상 응답을 사용합니다.
실제 비밀 토큰·외부 API·모델을 사용하거나 모델을 다운로드하지 않습니다.
브라우저 RAG 테스트는 실제 Node 웹 서버를 거치며 모델 선택, 제출/폴링/방문자, 답변·출처,
근거 부족·추가 조건·실패, 네 해상도와 기존 분석 전환을 확인합니다.
Python Playwright와 해당 Chromium이 필요하며 기존 E2E 환경을 그대로 사용합니다.
실제 배포 환경의 통신·Ollama 응답은 위 3절의 모델 선택 및 확인 질문으로 별도 확인합니다.

### v0.4.0 검증 결과 (2026-10-26)

| 검증 | 결과 |
| --- | --- |
| TypeScript 타입 검사 / 두 브랜드 빌드 | 통과 |
| 기존 분석 smoke / 로직 검사 | 통과 / 46개 통과 |
| 서버 RAG 중계 / 클라이언트 계약 | 15개 / 25개 통과 |
| 실제 웹 서버 + 모의 게이트웨이 RAG 브라우저 검사 | 29개 통과 |
| 기존 전체 화면 E2E | 235개 통과 |
| 1920·1366·900·400px 챗봇 | 가로 넘침·12px 미만 글자 없음, 모드·모델·질문 입력 확인 |

검증 환경은 Windows, Node.js 24, Python 3.11입니다. npm 의존성은 추가하지 않았습니다.
모델 선택, 출처, 실패, 중복 Enter, 방문자 구분, 로그아웃 후 폴링 중단,
기존 평가 버튼과 웹 분석 전환을 확인했습니다. 실제 운영 RAG 통신·모델 생성은 포함하지 않았습니다.
기존 E2E의 프리셋 정렬 확인은 원래 빌드에서도 발생한 렌더 타이밍 문제를 확인하고,
정렬 완료를 기다리도록 테스트만 보완했습니다.
