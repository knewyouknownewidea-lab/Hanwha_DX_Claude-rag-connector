// 질문 → 답변 → 템플릿 선택 흐름을 화면 어디서든 쓸 수 있게 묶는다
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { answer } from "../ai/agent";
import { detectProvider, type LLMProvider } from "../ai/llm";
import { runAnalysis } from "../lib/analysis";
import type { AnalysisResult, TemplateId } from "../lib/analysisTypes";
import { uid, useStore } from "./store";
import { askRag, getRagConfig, type ChatMode, type RagConfig, type RagModel } from "../ai/rag";

interface AgentApi {
  ask: (question: string, opts?: { answeringId?: string; mode?: ChatMode }) => Promise<void>;
  choose: (resultId: string, template: TemplateId) => void;
  rerun: (result: AnalysisResult) => void;
  provider: LLMProvider | null;
  providerChecked: boolean;
  chatMode: ChatMode;
  setChatMode: (mode: ChatMode) => void;
  ragModel: RagModel | "";
  setRagModel: (model: RagModel | "") => void;
  ragConfig: RagConfig | null;
  ragChecking: boolean;
  ragConfigError: string | null;
  refreshRagConfig: () => void;
}

const Ctx = createContext<AgentApi | null>(null);

export const isNarrow = () => typeof window !== "undefined" && window.matchMedia("(max-width: 1180px)").matches;

export function AgentProvider({ children }: { children: ReactNode }) {
  const store = useStore();
  const ref = useRef(store);
  ref.current = store;
  const [provider, setProvider] = useState<LLMProvider | null>(null);
  const [checked, setChecked] = useState(false);
  const [chatMode, setChatMode] = useState<ChatMode>("analysis");
  const [ragModel, setRagModel] = useState<RagModel | "">("");
  const [ragConfig, setRagConfig] = useState<RagConfig | null>(null);
  const [ragChecking, setRagChecking] = useState(false);
  const [ragConfigError, setRagConfigError] = useState<string | null>(null);
  const alive = useRef(true);
  const submitting = useRef(false);
  const ragRequest = useRef<AbortController | null>(null);
  const configRequest = useRef<AbortController | null>(null);

  const refreshRagConfig = useCallback(() => {
    configRequest.current?.abort();
    if (window.location.protocol === "file:") {
      setRagConfigError("구매 DB RAG는 웹 서버를 통해 열어야 사용할 수 있습니다.");
      return;
    }
    const controller = new AbortController();
    configRequest.current = controller;
    setRagChecking(true);
    setRagConfigError(null);
    const timer = setTimeout(() => controller.abort(), 8000);
    getRagConfig(controller.signal).then((config) => {
      if (!alive.current || configRequest.current !== controller) return;
      setRagConfig(config);
      setRagModel((current) => current && !config.models.includes(current) ? "" : current);
    }).catch(() => {
      if (!alive.current || configRequest.current !== controller) return;
      setRagConfig(null);
      setRagConfigError("RAG 연결 설정을 확인하지 못했습니다. 웹 서버 상태를 확인해 주세요.");
    }).finally(() => {
      clearTimeout(timer);
      if (alive.current && configRequest.current === controller) setRagChecking(false);
    });
  }, []);

  useEffect(() => {
    alive.current = true;
    refreshRagConfig();
    return () => {
      alive.current = false;
      configRequest.current?.abort();
      ragRequest.current?.abort();
    };
  }, [refreshRagConfig]);

  useEffect(() => {
    let alive = true;
    detectProvider().then((p) => {
      if (!alive) return;
      setProvider(p);
      setChecked(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  const ask = useCallback(
    async (question: string, opts?: { answeringId?: string; mode?: ChatMode }) => {
      const { state, dispatch, derived } = ref.current;
      const q = question.trim();
      // 기존 평가 카드·선택 정보의 분석 버튼은 계속 웹 데이터 분석을 사용한다.
      const mode = opts?.mode ?? "analysis";
      if (!q || state.busy || submitting.current) return;
      if (mode === "rag" && (!ragConfig?.enabled || !ragModel || ragChecking)) {
        dispatch({ type: "toast", text: !ragConfig?.enabled ? "RAG 서버 연결 설정을 확인해 주세요." : "사용할 RAG 모델을 선택해 주세요.", tone: "warn" });
        return;
      }
      submitting.current = true;
      setChatMode(mode);
      if (opts?.answeringId) dispatch({ type: "patchMessage", id: opts.answeringId, patch: { answered: q } });
      dispatch({ type: "addMessage", message: { id: uid(), role: "user", text: q, at: new Date().toISOString(), mode } });
      dispatch({ type: "busy", busy: true, progress: 0 });
      try {
        if (mode === "rag") {
          const controller = new AbortController();
          ragRequest.current = controller;
          // 웹 화면의 SUP-/ITM-/PO- 샘플 ID와 선택 문맥은 별도 구매 DB에 전달하지 않는다.
          const reply = await askRag({ question: q, model: ragModel as RagModel }, { signal: controller.signal });
          if (!alive.current) return;
          dispatch({ type: "addMessage", message: {
            id: uid(), role: "assistant", at: new Date().toISOString(), engine: "rag", text: [reply.answer],
            ragSources: reply.sources, ragModel: reply.model, ragStatus: reply.status,
            engineNote: ["별도 구매 DB 기준 · 최종 판단은 담당자", reply.note].filter(Boolean).join(" · "),
          } });
          if (!ref.current.state.chatOpen) dispatch({ type: "chat", open: true });
          return;
        }
        const reply = await answer(
          q,
          {
            data: state.data,
            derived,
            meta: state.meta,
            selection: state.selection,
            lastResult: state.lastResultId ? state.results[state.lastResultId] : null,
            pending: state.pending,
          },
          state.aiMode === "llm" ? provider : null,
          (i) => { if (alive.current) dispatch({ type: "busy", busy: true, progress: i }); },
        );
        if (!alive.current) return;
        const base = { id: uid(), role: "assistant" as const, at: new Date().toISOString(), engine: reply.engine, engineNote: reply.engineNote, text: reply.text };
        if (reply.type === "analysis") {
          // b 방식: 분석이 끝나면 바로 결과창에 그린다. 후속 질문이면 보던 형식을 유지한다.
          const r = reply.result;
          const current = ref.current.state.view.template;
          const shownAs = reply.followup && current && r.templates.includes(current) ? current : r.recommended;
          dispatch({ type: "addResult", result: r });
          dispatch({ type: "pending", pending: null });
          dispatch({ type: "show", resultId: r.id, template: shownAs });
          dispatch({ type: "addMessage", message: { ...base, resultId: r.id, followup: reply.followup, shownAs } });
          if (isNarrow()) dispatch({ type: "panel", panel: "C" });
        } else if (reply.type === "clarify") {
          dispatch({ type: "pending", pending: reply.pending });
          dispatch({ type: "addMessage", message: { ...base, options: reply.options, need: reply.pending.need, answered: null } });
          if (!ref.current.state.chatOpen) dispatch({ type: "chat", open: true });
        } else {
          dispatch({ type: "addMessage", message: { ...base, suggestions: reply.suggestions } });
          if (!ref.current.state.chatOpen) dispatch({ type: "chat", open: true });
        }
      } catch (e) {
        if (!alive.current || ragRequest.current?.signal.aborted) return;
        dispatch({
          type: "addMessage",
          message: { id: uid(), role: "assistant", at: new Date().toISOString(), engine: mode === "rag" ? "rag" : "system", text: [mode === "rag" ? `RAG 요청을 완료하지 못했습니다: ${(e as Error).message}` : `분석 중 오류가 났습니다: ${(e as Error).message}. 데이터 형식을 확인한 뒤 다시 질문해 주세요.`] },
        });
      } finally {
        submitting.current = false;
        ragRequest.current = null;
        if (alive.current) dispatch({ type: "busy", busy: false });
      }
    },
    [provider, ragConfig, ragModel, ragChecking],
  );

  const choose = useCallback((resultId: string, template: TemplateId) => {
    const { dispatch } = ref.current;
    dispatch({ type: "show", resultId, template });
    if (isNarrow()) dispatch({ type: "panel", panel: "C" });
  }, []);

  const rerun = useCallback((result: AnalysisResult) => {
    const { state, dispatch, derived } = ref.current;
    try {
      const next = runAnalysis(result.params, state.data, derived, state.meta, result.question);
      dispatch({ type: "addResult", result: next, asLast: state.lastResultId === result.id });
      dispatch({ type: "show", resultId: next.id, template: state.view.template ?? next.recommended });
      dispatch({ type: "toast", text: next.empty ? `다시 분석했지만 결과가 없습니다: ${next.empty}` : "현재 데이터로 다시 분석했습니다", tone: next.empty ? "warn" : "ok" });
    } catch (e) {
      dispatch({ type: "toast", text: `다시 분석하지 못했습니다: ${(e as Error).message}`, tone: "warn" });
    }
  }, []);

  const value = useMemo(() => ({ ask, choose, rerun, provider, providerChecked: checked, chatMode, setChatMode, ragModel, setRagModel, ragConfig, ragChecking, ragConfigError, refreshRagConfig }), [ask, choose, rerun, provider, checked, chatMode, ragModel, ragConfig, ragChecking, ragConfigError, refreshRagConfig]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAgent(): AgentApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("AgentProvider가 없습니다");
  return v;
}
