// AI 챗봇: 왼쪽 아래 'AI에게 질문하기' 버튼 → 떠 있는 대화창 (이동·크기 조절·투명도, 이 브라우저에 위치 기억)
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as RPointerEvent, type RefObject } from "react";
import { LuArrowUp, LuChevronDown, LuChevronUp, LuDatabase, LuEllipsis, LuEraser, LuEye, LuPanelRight, LuRotateCcw, LuX } from "react-icons/lu";
import { STEPS } from "../ai/agent";
import { SUGGESTED, useStore, type ChatMessage } from "../store/store";
import { useAgent } from "../store/agent";
import { KeywordSearch } from "./KeywordSearch";
import { ConfirmDialog } from "./ConfirmDialog";
import { Chip } from "./ui";
import { templateLabel } from "../templates/registry";
import { readStore, writeStore } from "../platform/storage";
import type { ChatMode, RagModel } from "../ai/rag";

/** 'AI와 대화'임이 바로 보이는 아이콘: 말풍선 + 반짝임 */
export function AiChatIcon({ size = 22 }: { size?: number }) {
  return (
    <svg className="ai-chat-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h8A2.5 2.5 0 0 1 17 5.5V7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path
        d="M3 9.5A2.5 2.5 0 0 1 5.5 7h11A2.5 2.5 0 0 1 19 9.5v6a2.5 2.5 0 0 1-2.5 2.5H10l-4 3v-3h-.5A2.5 2.5 0 0 1 3 15.5z"
        fill="currentColor"
        fillOpacity=".16"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="M11 9.6l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z" fill="currentColor" />
      <path d="M19.6 2.2l.5 1.2 1.2.5-1.2.5-.5 1.2-.5-1.2-1.2-.5 1.2-.5z" fill="currentColor" />
    </svg>
  );
}

// ── 창 위치·크기·투명도 ──
interface Geo {
  x: number;
  y: number;
  w: number;
  h: number;
  opacity: number; // 40~100 (%), 창 전체에 적용
  minimized: boolean;
}
const GEO_KEY = "chat-window.v2"; // v0.3: 기본 위치가 왼쪽 아래로 바뀌어 저장 키를 올림
const NUDGE_KEY = "chat-nudge.v1";
const MIN_W = 320;
const MIN_H = 400;
const MARGIN = 12;
const OPACITY_MIN = 40;

const vw = () => window.innerWidth;
const vh = () => window.innerHeight;

function defaultGeo(): Geo {
  const w = Math.min(460, vw() - MARGIN * 2);
  const h = Math.min(680, Math.round(vh() * 0.72));
  return { w, h, x: 24, y: Math.max(MARGIN, vh() - h - 92), opacity: 100, minimized: false };
}

function clampGeo(g: Geo): Geo {
  const maxW = Math.max(MIN_W, vw() * 0.9);
  const maxH = Math.max(MIN_H, vh() * 0.9);
  const w = Math.min(Math.max(g.w, Math.min(MIN_W, vw() - MARGIN * 2)), maxW);
  const h = Math.min(Math.max(g.h, Math.min(MIN_H, vh() - MARGIN * 2)), maxH);
  const shownH = g.minimized ? 64 : h;
  const x = Math.min(Math.max(g.x, MARGIN), Math.max(MARGIN, vw() - w - MARGIN));
  const y = Math.min(Math.max(g.y, MARGIN), Math.max(MARGIN, vh() - shownH - MARGIN));
  const opacity = Math.min(100, Math.max(OPACITY_MIN, Math.round(g.opacity)));
  return { ...g, x, y, w, h, opacity };
}

function loadGeo(): Geo {
  const s = readStore<Partial<Geo>>(GEO_KEY);
  const d = defaultGeo();
  if (!s) return d;
  return clampGeo({ ...d, ...s, minimized: !!s.minimized });
}

const narrowQuery = () => window.matchMedia("(max-width: 1180px)").matches;

function useNarrow() {
  const [narrow, setNarrow] = useState(() => (typeof window !== "undefined" ? narrowQuery() : false));
  useEffect(() => {
    const on = () => setNarrow(narrowQuery());
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return narrow;
}

// ── 대화 내용 ──
function EngineBadge({ engine }: { engine: string }) {
  if (engine === "rule") return <span className="engine engine-rule">규칙 기반 데모 응답</span>;
  if (engine === "llm") return <span className="engine engine-llm">LLM 해석 · 계산은 코드</span>;
  if (engine === "rag") return <span className="engine engine-rag">구매 DB RAG</span>;
  return null;
}

function Assistant({ m }: { m: Extract<ChatMessage, { role: "assistant" }> }) {
  const { state } = useStore();
  const { ask, choose, chatMode } = useAgent();
  const result = m.resultId ? state.results[m.resultId] : undefined;
  const showing = result && state.view.resultId === result.id;
  return (
    <div className="msg msg-ai">
      <div className="msg-avatar" aria-hidden>
        <AiChatIcon size={18} />
      </div>
      <div className={`msg-body ${m.engine === "rag" ? "msg-body-rag" : ""}`}>
        <EngineBadge engine={m.engine} />
        {m.ragModel && <span className="rag-model-name">모델 · {m.ragModel}</span>}
        {m.text.map((t, i) => (
          <p key={i}>{t}</p>
        ))}
        {!!m.ragSources?.length && (
          <details className="rag-sources">
            <summary>답변 출처 {m.ragSources.length}건</summary>
            <ul>
              {m.ragSources.map((source, i) => (
                <li key={`${source.evidence_id}-${i}`}>
                  <strong>[{source.evidence_id}]</strong>
                  <span>{source.source.source_refs.join(" · ")}</span>
                  <small>{[
                    typeof source.source.source_db === "string" ? `DB: ${source.source.source_db}` : "",
                    source.parent_document_id ? `문서: ${source.parent_document_id}` : "",
                    source.chunk_id ? `조각: ${source.chunk_id}` : "",
                  ].filter(Boolean).join(" · ")}</small>
                </li>
              ))}
            </ul>
          </details>
        )}
        {result && (
          <>
            <p className="msg-sources">
              <LuDatabase aria-hidden />
              <span>
                사용 데이터:{" "}
                {result.sources
                  .filter((s) => s.ids.length)
                  .map((s) => `${s.label} ${s.ids.length}건`)
                  .join(" · ")}{" "}
                · 기준일 {result.asOf} · {result.dataLabel}
              </span>
            </p>
            <div className="msg-result">
              <LuPanelRight aria-hidden />
              <div>
                <p>
                  {m.followup ? "보던 형식" : "추천 형식"} <b>{templateLabel(m.shownAs ?? result.recommended)}</b>
                  {m.followup ? "을 유지해" : "으로"} 분석 결과창에 표시했습니다.
                </p>
                <p className="muted">다른 형식은 분석 결과창 상단에서 선택하세요.</p>
              </div>
              {!showing && (
                <button type="button" className="btn btn-small" onClick={() => choose(result.id, m.shownAs ?? result.recommended)}>
                  <LuEye aria-hidden /> 이 결과 다시 보기
                </button>
              )}
            </div>
          </>
        )}
        {m.options && chatMode === "analysis" && (
          <div className="opt-chips" role="group" aria-label="선택지">
            {m.options.map((o) => (
              <button type="button" key={o.id} className={`opt-chip ${m.answered === o.label ? "is-chosen" : ""}`} onClick={() => ask(o.label, { answeringId: m.id })} disabled={state.busy || !!m.answered}>
                <span>{o.label}</span>
                {o.sub && <small>{o.sub}</small>}
              </button>
            ))}
          </div>
        )}
        {m.suggestions && m.id !== "welcome" && chatMode === "analysis" && (
          <div className="suggest" role="group" aria-label="질문 예시">
            {m.suggestions.map((s) => (
              <button type="button" key={s} className="suggest-chip" onClick={() => ask(s)} disabled={state.busy}>
                {s}
              </button>
            ))}
          </div>
        )}
        {m.engineNote && <p className="msg-note">{m.engineNote}</p>}
      </div>
    </div>
  );
}

function ChatBody({ inputRef }: { inputRef: RefObject<HTMLTextAreaElement | null> }) {
  const { state, derived, dispatch } = useStore();
  const { ask, chatMode, setChatMode, ragModel, setRagModel, ragConfig, ragChecking, ragConfigError, refreshRagConfig } = useAgent();
  const isRag = chatMode === "rag";
  const canSend = !state.busy && (!isRag || (!!ragConfig?.enabled && !!ragModel && !ragChecking));
  const [text, setText] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.messages.length, state.busy]);

  const send = () => {
    if (!text.trim() || !canSend) return;
    const q = text;
    setText("");
    ask(q, { mode: chatMode });
  };
  const item = state.selection.itemCode ? derived.itemsByCode.get(state.selection.itemCode) : null;
  const sup = state.selection.supplierId ? derived.suppliersById.get(state.selection.supplierId) : null;

  // 추천 질문: 기본 4개 + 관심 협력사·부품을 넣은 질문
  const suggestions = useMemo(() => {
    if (isRag) return ["발주 1101 수량은?", "가상 A사 Q 점수", "베어링 완충 포장 민원 찾아줘"];
    const out: string[] = [];
    const fs = state.favorites.suppliers.map((id) => derived.suppliersById.get(id)?.name).filter(Boolean) as string[];
    const fi = state.favorites.items.map((c) => derived.itemsByCode.get(c)?.name).filter(Boolean) as string[];
    if (fs[0]) out.push(`${fs[0]} 평가 근거 보여줘`);
    if (fi[0]) out.push(`${fi[0]} 후보 업체 비교해 줘`);
    else if (fs[1]) out.push(`${fs[0]}랑 ${fs[1]} 비교해줘`);
    return [...out, ...SUGGESTED];
  }, [state.favorites, derived, isRag]);

  const step = Math.min(state.progress, STEPS.length - 1);
  return (
    <>
      {!isRag && <div className="chat-search">
        <KeywordSearch />
      </div>}
      <div className="chat-list" ref={listRef} aria-live="polite">
        {isRag && <p className="rag-intro">별도 구매 DB의 협력사·부품·발주·납품·민원을 질문하세요. 답변과 원본 참조를 이 대화창에 표시합니다.</p>}
        {state.messages.filter((m) => !isRag || m.id !== "welcome").map((m) =>
          m.role === "user" ? (
            <div className="msg msg-user" key={m.id}>
              <p>{m.mode === "rag" && <span className="user-rag-label">구매 DB RAG</span>}{m.text}</p>
            </div>
          ) : (
            <Assistant key={m.id} m={m} />
          ),
        )}
        {state.busy && (
          <div className="msg msg-ai">
            <div className="msg-avatar" aria-hidden>
              <AiChatIcon size={18} />
            </div>
            <div className="progress" role="status" aria-label="분석 진행 상태">
              <span className="typing" aria-hidden>
                <i />
                <i />
                <i />
              </span>
              <span className="progress-step">
                {isRag ? "구매 DB 검색·답변 생성 중" : <>{STEPS[step]} <small>
                  ({step + 1}/{STEPS.length}단계)
                </small></>}
              </span>
            </div>
          </div>
        )}
      </div>
      <div className="composer">
        <div className="chat-mode-controls">
          <label htmlFor="chat-answer-mode">질문 방식
            <select id="chat-answer-mode" value={chatMode} disabled={state.busy} onChange={(e) => setChatMode(e.target.value as ChatMode)}>
              <option value="analysis">웹 데이터 분석</option>
              <option value="rag">구매 DB RAG</option>
            </select>
          </label>
          {isRag && <label htmlFor="rag-model">답변 모델
            <select id="rag-model" value={ragModel} disabled={state.busy || ragChecking || !ragConfig?.enabled} onChange={(e) => setRagModel(e.target.value as RagModel | "")}>
              <option value="">모델 선택</option>
              {(ragConfig?.models ?? []).map((model) => <option key={model} value={model}>{model}</option>)}
            </select>
          </label>}
        </div>
        {isRag && <div className="rag-connection" role="status">
          <p>{ragChecking ? "RAG 연결 설정 확인 중…" : ragConfigError ? ragConfigError : !ragConfig?.enabled ? "RAG 서버 연결 설정이 필요합니다." : "별도 구매 DB 기준 · 화면의 선택·업로드 데이터는 적용되지 않습니다."}</p>
          {!ragChecking && !ragConfig?.enabled && <button type="button" className="link-btn" onClick={refreshRagConfig}>다시 확인</button>}
        </div>}
        <div className="suggest-row" role="group" aria-label="추천 질문">
          {suggestions.map((s) => (
            <button type="button" key={s} className="suggest-chip" onClick={() => ask(s, { mode: chatMode })} disabled={!canSend}>
              {s}
            </button>
          ))}
        </div>
        {!isRag && <div className="ctx-chips" aria-label="질문 문맥">
          <span className="ctx-label">질문 대상</span>
          {item ? (
            <Chip tone="accent" onRemove={() => dispatch({ type: "clearSelection", what: "item" })}>
              품목 · {item.name}
            </Chip>
          ) : (
            <span className="ctx-empty">선택한 품목 없음</span>
          )}
          {sup && (
            <Chip onRemove={() => dispatch({ type: "clearSelection", what: "supplier" })}>
              협력사 · {sup.name}
            </Chip>
          )}
        </div>}
        <form
          className="composer-form"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <label htmlFor="chat-input" className="sr-only">
            {isRag ? "구매 DB RAG 질문" : "분석 질문"}
          </label>
          <textarea
            id="chat-input"
            ref={inputRef}
            rows={2}
            placeholder={isRag ? "구매 DB 질문 · 예: 발주 1101 수량은?" : "분석할 내용을 질문하세요 · 예: 실린더 라이너 후보 업체를 비교해 줘"}
            maxLength={isRag ? 1000 : undefined}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button type="submit" className="send-btn" disabled={!canSend || !text.trim()} aria-label="질문 보내기" title="보내기 (Enter)">
            <LuArrowUp aria-hidden />
          </button>
        </form>
        <p className="composer-hint">Enter 보내기 · Shift+Enter 줄바꿈{isRag ? " · 최대 1000자" : ""}</p>
      </div>
    </>
  );
}

// ── 떠 있는 창 ──
export function ChatWidget() {
  const { state, dispatch } = useStore();
  const { chatMode } = useAgent();
  const narrow = useNarrow();
  const [geo, setGeo] = useState<Geo>(() => (typeof window !== "undefined" ? loadGeo() : defaultGeo()));
  const [menu, setMenu] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [nudge, setNudge] = useState(() => !readStore<boolean>(NUDGE_KEY));
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const winRef = useRef<HTMLDivElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const open = state.chatOpen;

  const commit = useCallback((g: Geo) => {
    const c = clampGeo(g);
    setGeo(c);
    writeStore(GEO_KEY, c);
  }, []);

  const dismissNudge = useCallback(() => {
    setNudge(false);
    writeStore(NUDGE_KEY, true);
  }, []);

  useEffect(() => {
    const onResize = () => setGeo((g) => clampGeo(g));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (open) {
      if (nudge) dismissNudge();
      if (!geo.minimized) inputRef.current?.focus();
    } else setMenu(false);
  }, [open, geo.minimized]); // eslint-disable-line react-hooks/exhaustive-deps

  // 창 설정 메뉴: 바깥을 누르면 닫힘
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (menuRef.current && !menuRef.current.contains(t) && !t.closest(".chat-menu-btn")) setMenu(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menu]);

  // Esc: 메뉴가 열려 있으면 메뉴부터, 아니면 창 안이나 빈 곳에 초점이 있을 때 창을 닫는다
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || document.querySelector(".modal-backdrop")) return;
      if (menu) {
        e.preventDefault();
        setMenu(false);
        return;
      }
      const a = document.activeElement;
      if (!a || a === document.body || winRef.current?.contains(a) || a === launcherRef.current) {
        e.preventDefault();
        dispatch({ type: "chat", open: false });
        setTimeout(() => launcherRef.current?.focus(), 0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, menu, dispatch]);

  const setOpen = (v: boolean) => {
    dispatch({ type: "chat", open: v });
    if (!v) setTimeout(() => launcherRef.current?.focus(), 0);
  };

  // 머리 부분을 끌어서 이동
  const startMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (narrow || (e.target as HTMLElement).closest("button, input, select, label, .chat-menu")) return;
    e.preventDefault();
    const sx = e.clientX;
    const sy = e.clientY;
    const start = geo;
    const move = (ev: PointerEvent) => setGeo(clampGeo({ ...start, x: start.x + ev.clientX - sx, y: start.y + ev.clientY - sy }));
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      commit({ ...start, x: start.x + ev.clientX - sx, y: start.y + ev.clientY - sy });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  };

  // 모서리를 끌어서 크기 조절
  const startResize = (corner: "nw" | "ne" | "sw" | "se") => (e: RPointerEvent<HTMLSpanElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const sx = e.clientX;
    const sy = e.clientY;
    const start = geo;
    const calc = (ev: PointerEvent): Geo => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      let { x, y, w, h } = start;
      if (corner.includes("e")) w = start.w + dx;
      if (corner.includes("s")) h = start.h + dy;
      if (corner.includes("w")) {
        w = start.w - dx;
        x = start.x + dx;
      }
      if (corner.includes("n")) {
        h = start.h - dy;
        y = start.y + dy;
      }
      const maxW = vw() * 0.9;
      const maxH = vh() * 0.9;
      const cw = Math.min(Math.max(w, MIN_W), maxW);
      const ch = Math.min(Math.max(h, MIN_H), maxH);
      if (corner.includes("w")) x = start.x + start.w - cw;
      if (corner.includes("n")) y = start.y + start.h - ch;
      return clampGeo({ ...start, x, y, w: cw, h: ch });
    };
    const move = (ev: PointerEvent) => setGeo(calc(ev));
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      commit(calc(ev));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  };

  // 키보드: 머리에 초점을 두고 화살표로 이동, Shift+화살표로 크기 조절
  const onHeadKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (narrow || e.target !== e.currentTarget) return;
    const step = 24;
    const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const v = d[e.key];
    if (!v) return;
    e.preventDefault();
    commit(e.shiftKey ? { ...geo, w: geo.w + v[0], h: geo.h + v[1] } : { ...geo, x: geo.x + v[0], y: geo.y + v[1] });
  };

  const style = narrow
    ? { opacity: geo.opacity / 100 }
    : { left: geo.x, top: geo.y, width: geo.w, height: geo.minimized ? undefined : geo.h, opacity: geo.opacity / 100 };

  return (
    <>
      {!open && nudge && (
        <div className="chat-nudge" role="note">
          <span>질문으로 분석을 시작해 보세요</span>
          <button type="button" className="chat-nudge-x" onClick={dismissNudge} aria-label="안내 닫기">
            <LuX aria-hidden />
          </button>
        </div>
      )}
      <button
        ref={launcherRef}
        type="button"
        className={`chat-launcher ${open ? "is-open" : ""}`}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls="chat-window"
        aria-label={open ? "AI 분석 도우미 닫기" : "AI에게 질문하기 (AI 분석 도우미 열기)"}
        title={open ? "AI 분석 도우미 닫기" : "AI 분석 도우미 열기"}
      >
        <span className="chat-launcher-icon">{open ? <LuX aria-hidden /> : <AiChatIcon />}</span>
        {!open && (
          <span className="chat-launcher-label">
            <span className="cl-long">AI에게 질문하기</span>
            <span className="cl-short" aria-hidden>
              AI 질문
            </span>
          </span>
        )}
        {state.chatUnread && !open && <i className="unread-dot" aria-label="새 답변" />}
      </button>

      {open && (
        <div
          id="chat-window"
          ref={winRef}
          className={`chat-window ${narrow ? "is-sheet" : ""} ${geo.minimized ? "is-min" : ""}`}
          style={style}
          role="dialog"
          aria-label="AI 분석 도우미"
        >
          <div className="chat-head" onPointerDown={startMove} onKeyDown={onHeadKey} tabIndex={narrow ? -1 : 0} aria-label="창 머리 · 끌어서 이동, 화살표 키로 이동, Shift+화살표로 크기 조절">
            <div className="chat-title">
              <span className="chat-title-icon" aria-hidden>
                <AiChatIcon size={18} />
              </span>
              <div className="chat-title-text">
                <strong>AI 분석 도우미</strong>
                <span>{chatMode === "rag" ? "구매 DB RAG · 답변과 출처" : `${state.aiMode === "llm" ? "LLM 해석 모드" : "규칙 기반 데모 모드"} · 데이터로 계산`}</span>
              </div>
            </div>
            <div className="chat-tools">
              <button type="button" className={`icon-btn chat-menu-btn ${menu ? "is-on" : ""}`} onClick={() => setMenu((v) => !v)} aria-expanded={menu} aria-haspopup="menu" aria-label="창 설정" title="창 설정 (투명도·위치 초기화·대화 지우기)">
                <LuEllipsis aria-hidden />
              </button>
              {!narrow && (
                <button type="button" className="icon-btn" onClick={() => commit({ ...geo, minimized: !geo.minimized })} title={geo.minimized ? "펼치기" : "최소화"} aria-label={geo.minimized ? "펼치기" : "최소화"}>
                  {geo.minimized ? <LuChevronUp aria-hidden /> : <LuChevronDown aria-hidden />}
                </button>
              )}
              <button type="button" className="icon-btn" onClick={() => setOpen(false)} title="닫기 (Esc)" aria-label="닫기">
                <LuX aria-hidden />
              </button>
            </div>
            {menu && (
              <div className="chat-menu" ref={menuRef} role="menu" aria-label="창 설정">
                <label className="opacity-ctl" title="창 투명도 (창 전체)">
                  <LuEye aria-hidden />
                  <span>투명도</span>
                  <input
                    id="chat-opacity"
                    type="range"
                    min={OPACITY_MIN}
                    max={100}
                    step={5}
                    value={geo.opacity}
                    onChange={(e) => commit({ ...geo, opacity: Number(e.target.value) })}
                    aria-valuetext={`${geo.opacity}%`}
                    aria-label="창 투명도"
                  />
                  <span className="opacity-val">{geo.opacity}%</span>
                </label>
                {!narrow && (
                  <button
                    type="button"
                    role="menuitem"
                    className="menu-item"
                    onClick={() => {
                      commit({ ...defaultGeo(), opacity: 100 });
                      setMenu(false);
                    }}
                    aria-label="위치·크기·투명도 초기화"
                  >
                    <LuRotateCcw aria-hidden /> 위치·크기·투명도 초기화
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item"
                  onClick={() => {
                    setMenu(false);
                    setConfirmClear(true);
                  }}
                  aria-label="대화 지우기"
                >
                  <LuEraser aria-hidden /> 대화 지우기 <small>분석 이력은 남김</small>
                </button>
              </div>
            )}
          </div>
          {!geo.minimized && <ChatBody inputRef={inputRef} />}
          {!narrow && !geo.minimized && (
            <>
              <span className="rz rz-nw" onPointerDown={startResize("nw")} aria-hidden />
              <span className="rz rz-ne" onPointerDown={startResize("ne")} aria-hidden />
              <span className="rz rz-sw" onPointerDown={startResize("sw")} aria-hidden />
              <span className="rz rz-se" onPointerDown={startResize("se")} aria-hidden />
            </>
          )}
        </div>
      )}
      {confirmClear && (
        <ConfirmDialog
          title="대화를 지울까요?"
          confirmLabel="대화 지우기"
          onCancel={() => {
            setConfirmClear(false);
            setTimeout(() => inputRef.current?.focus(), 0);
          }}
          onConfirm={() => {
            dispatch({ type: "clearChat" });
            dispatch({ type: "toast", text: "대화를 지웠습니다. 분석 결과와 이력은 그대로 남아 있습니다." });
            setConfirmClear(false);
            setTimeout(() => inputRef.current?.focus(), 0);
          }}
        >
          <p>지금까지 주고받은 대화가 지워집니다. 분석 결과와 분석 이력은 그대로 남아 오른쪽 위 ‘분석 이력’에서 다시 볼 수 있습니다.</p>
        </ConfirmDialog>
      )}
    </>
  );
}
