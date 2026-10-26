// 화면 상태 — 선택 대상, 대화, 분석 결과·이력, 표시 템플릿, 보기 설정, 필터, 관심 목록, 데이터 버전
// 사용자별로 이 브라우저에 저장한다: 대화·분석 이력·보기 설정·관심 목록(localStorage), 업로드 데이터(IndexedDB)
import { createContext, useContext, useEffect, useMemo, useReducer, useRef, type Dispatch, type ReactNode } from "react";
import type { DataMeta, DataSet, DatasetKey, TabKey } from "../data/types";
import { SCHEMAS, pkOf } from "../data/schema";
import { loadSample } from "../data/sampleData";
import type { AnalysisResult, TemplateId } from "../lib/analysisTypes";
import { derive, type Derived } from "../lib/metrics";
import type { FilterValues } from "../lib/filters";
import type { ClarifyOption, Engine, PendingClarify } from "../ai/agent";
import { clone, DEFAULT_SETTINGS, normalizeSettings, type Preset, type ViewSettings } from "../templates/presets";
import { readStore, userKey, writeStore } from "../platform/storage";
import { idbDel, idbGet, idbSet } from "../platform/idb";
import type { User } from "../platform/users";
import type { ChatMode, RagSource } from "../ai/rag";

export type ChatMessage =
  | { id: string; role: "user"; text: string; at: string; mode?: ChatMode }
  | {
      id: string;
      role: "assistant";
      at: string;
      engine: Engine | "system" | "rag";
      engineNote?: string;
      text: string[];
      resultId?: string;
      followup?: boolean;
      shownAs?: TemplateId | null;
      options?: ClarifyOption[];
      need?: PendingClarify["need"];
      answered?: string | null;
      suggestions?: string[];
      ragSources?: RagSource[];
      ragModel?: string;
      ragStatus?: string;
    };

/** 좁은 화면에서 보이는 영역: A = 데이터 관리, C = 분석 결과 */
export type Panel = "A" | "C";

export interface ResultMeta {
  name?: string;
  pinned?: boolean;
}

export interface State {
  user: User;
  data: DataSet;
  meta: DataMeta;
  dataReady: boolean;
  savedAt: string | null; // 업로드 데이터를 이 브라우저에 저장한 시각
  saveError: string | null;
  tab: TabKey;
  subView: Record<TabKey, string>;
  filters: Record<TabKey, FilterValues>;
  queries: Record<TabKey, string>;
  focusTick: number; // 알림·관심 목록 등에서 데이터 관리로 스크롤
  selection: { supplierId: string | null; itemCode: string | null; rowKey: string | null; rowTab: TabKey | null };
  messages: ChatMessage[];
  results: Record<string, AnalysisResult>;
  resultMeta: Record<string, ResultMeta>;
  view: { resultId: string | null; template: TemplateId | null };
  lastResultId: string | null;
  pending: PendingClarify | null;
  busy: boolean;
  progress: number;
  aiMode: "rule" | "llm";
  panel: Panel;
  chatOpen: boolean;
  chatUnread: boolean;
  settings: ViewSettings;
  userPresets: Preset[];
  favorites: { suppliers: string[]; items: string[] };
  pinFav: boolean;
  payChecked: string[];
  importFor: DatasetKey | null;
  onboarding: boolean; // 첫 사용 안내 열림
  detailOpen: boolean; // 분석 결과창 위쪽의 선택 정보(협력사·부품 상세) 펼침
  toast: { id: number; text: string; tone: "ok" | "warn" } | null;
}

export type Action =
  | { type: "tab"; tab: TabKey }
  | { type: "subView"; tab: TabKey; view: string }
  | { type: "filters"; tab: TabKey; values: FilterValues }
  | { type: "query"; tab: TabKey; q: string }
  | { type: "kpi"; tab: TabKey; filterKey: string; on: boolean }
  | { type: "goPayments" }
  | { type: "focusData" } // 데이터 관리 탭 영역으로 화면을 옮긴다 (다른 곳에서 협력사·부품으로 이동할 때)
  | { type: "selectRow"; tab: TabKey; rowKey: string; supplierId?: string | null; itemCode?: string | null }
  | { type: "selectSupplier"; supplierId: string }
  | { type: "clearSelection"; what: "item" | "supplier" | "row" }
  | { type: "addMessage"; message: ChatMessage }
  | { type: "patchMessage"; id: string; patch: Partial<Extract<ChatMessage, { role: "assistant" }>> }
  | { type: "addResult"; result: AnalysisResult; asLast?: boolean }
  | { type: "show"; resultId: string; template: TemplateId }
  | { type: "renameResult"; id: string; name: string }
  | { type: "pinResult"; id: string; pinned: boolean }
  | { type: "deleteResult"; id: string }
  | { type: "pending"; pending: PendingClarify | null }
  | { type: "busy"; busy: boolean; progress?: number }
  | { type: "aiMode"; mode: "rule" | "llm" }
  | { type: "panel"; panel: Panel }
  | { type: "chat"; open: boolean }
  | { type: "chatUnread"; unread: boolean }
  | { type: "settings"; settings: ViewSettings }
  | { type: "savePreset"; preset: Preset }
  | { type: "deletePreset"; id: string }
  | { type: "toggleFav"; kind: "suppliers" | "items"; id: string }
  | { type: "pinFav"; on: boolean }
  | { type: "payCheck"; poNo: string; on: boolean }
  | { type: "openImport"; dataset: DatasetKey | null }
  | { type: "onboarding"; open: boolean }
  | { type: "detailOpen"; open: boolean }
  | { type: "replaceData"; dataset: DatasetKey; rows: unknown[]; source: string; mode: "replace" | "merge" }
  | { type: "loadSaved"; data: DataSet; meta: DataMeta; savedAt: string }
  | { type: "dataReady" }
  | { type: "saved"; at: string | null; error?: string | null }
  | { type: "resetSample" }
  | { type: "toast"; text: string; tone?: "ok" | "warn" }
  | { type: "clearToast" }
  | { type: "clearChat" };

const now = () => new Date().toISOString();

export const SUGGESTED = [
  "해당 품목의 과거 거래 협력사를 비교해 줘.",
  "납기 준수율이 낮은 협력사를 찾아줘.",
  "최근 단가가 상승한 품목을 보여줘.",
  "A등급 협력사의 품질 실적을 정리해 줘.",
];

export const WELCOME: ChatMessage = {
  id: "welcome",
  role: "assistant",
  at: now(),
  engine: "system",
  text: [
    "안녕하세요. 구매·협력사 데이터 분석 도우미입니다. 협력사 평가, 과거 거래 이력, 단가 비교, 납기 실적 등을 질문해 주세요.",
    "입력창 위의 추천 질문을 누르거나, 왼쪽 데이터 관리에서 품목·협력사를 고른 뒤 질문하면 그 대상을 기준으로 분석합니다.",
  ],
};

// ── 브라우저 저장 (사용자별) ──
export const MAX_RESULTS = 50;
const MAX_MESSAGES = 80;
const SESSION = "session.v3";
const SETTINGS = "view-settings.v2";
const PREFS = "prefs.v1";
export const UPLOADS = "uploads";
export const ONBOARDED = "onboarded.v1";

interface SavedSession {
  messages: ChatMessage[];
  results: Record<string, AnalysisResult>;
  resultMeta?: Record<string, ResultMeta>;
  view: State["view"];
  lastResultId: string | null;
  pending: PendingClarify | null;
}

interface SavedPrefs {
  favorites?: State["favorites"];
  pinFav?: boolean;
  payChecked?: string[];
}

interface SavedUpload {
  data: DataSet;
  meta: DataMeta;
  savedAt: string;
}

function loadSession(uid: string): SavedSession | null {
  const s = readStore<SavedSession>(userKey(uid, SESSION));
  if (!s || !Array.isArray(s.messages) || typeof s.results !== "object" || !s.results) return null;
  return s;
}

function loadSettings(uid: string): { settings: ViewSettings; userPresets: Preset[] } {
  const s = readStore<{ settings: unknown; userPresets: Preset[] }>(userKey(uid, SETTINGS));
  return {
    settings: s ? normalizeSettings(s.settings) : clone(DEFAULT_SETTINGS),
    userPresets: Array.isArray(s?.userPresets) ? s!.userPresets.map((p) => ({ ...p, settings: normalizeSettings(p.settings), builtIn: false })) : [],
  };
}

/** 이력 보관 개수를 넘으면 고정하지 않은 가장 오래된 결과부터 지운다 */
function trimResults(results: Record<string, AnalysisResult>, meta: Record<string, ResultMeta>, keepIds: (string | null)[], max = MAX_RESULTS) {
  const list = Object.values(results).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (list.length <= max) return { results, removed: [] as AnalysisResult[] };
  const keep = new Set(keepIds.filter(Boolean) as string[]);
  const removable = list.filter((r) => !meta[r.id]?.pinned && !keep.has(r.id)).reverse(); // 오래된 순
  const removed = removable.slice(0, list.length - max);
  const gone = new Set(removed.map((r) => r.id));
  return { results: Object.fromEntries(Object.entries(results).filter(([id]) => !gone.has(id))), removed };
}

function compactSession(s: State, maxResults = MAX_RESULTS, maxMessages = MAX_MESSAGES): SavedSession {
  const messages = s.messages.slice(-maxMessages);
  const { results } = trimResults(s.results, s.resultMeta, [s.view.resultId, s.lastResultId], maxResults);
  const resultMeta = Object.fromEntries(Object.entries(s.resultMeta).filter(([id]) => results[id]));
  return {
    messages,
    results,
    resultMeta,
    view: s.view.resultId && results[s.view.resultId] ? s.view : { resultId: null, template: null },
    lastResultId: s.lastResultId && results[s.lastResultId] ? s.lastResultId : null,
    pending: s.pending,
  };
}

const EMPTY_TABS = <T,>(v: () => T): Record<TabKey, T> => ({ suppliers: v(), purchaseOrders: v(), contracts: v(), inventory: v() });

function initial(user: User): State {
  const { data, meta } = loadSample();
  const saved = loadSession(user.id);
  const { settings, userPresets } = loadSettings(user.id);
  const prefs = readStore<SavedPrefs>(userKey(user.id, PREFS)) ?? {};
  return {
    user,
    data,
    meta,
    dataReady: false,
    savedAt: null,
    saveError: null,
    tab: "suppliers",
    subView: EMPTY_TABS(() => "list"),
    filters: EMPTY_TABS(() => ({})),
    queries: EMPTY_TABS(() => ""),
    focusTick: 0,
    selection: { supplierId: data.suppliers[0]?.supplierId ?? null, itemCode: null, rowKey: null, rowTab: null },
    messages: saved?.messages?.length ? saved.messages : [WELCOME],
    results: saved?.results ?? {},
    resultMeta: saved?.resultMeta ?? {},
    view: saved?.view ?? { resultId: null, template: null },
    lastResultId: saved?.lastResultId ?? null,
    pending: saved?.pending ?? null,
    busy: false,
    progress: 0,
    aiMode: "rule",
    panel: "A",
    chatOpen: false,
    chatUnread: false,
    settings,
    userPresets,
    favorites: { suppliers: prefs.favorites?.suppliers ?? [], items: prefs.favorites?.items ?? [] },
    pinFav: !!prefs.pinFav,
    payChecked: prefs.payChecked ?? [],
    importFor: null,
    onboarding: !readStore<boolean>(userKey(user.id, ONBOARDED)),
    detailOpen: false,
    toast: null,
  };
}

let toastSeq = 0;
const newDataId = () => `upload-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const toast = (text: string, tone: "ok" | "warn" = "ok") => ({ id: ++toastSeq, text, tone });

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "tab":
      return { ...s, tab: a.tab };
    case "subView":
      return { ...s, tab: a.tab, subView: { ...s.subView, [a.tab]: a.view } };
    case "filters":
      return { ...s, filters: { ...s.filters, [a.tab]: a.values } };
    case "query":
      return { ...s, queries: { ...s.queries, [a.tab]: a.q } };
    case "kpi":
      return {
        ...s,
        tab: a.tab,
        subView: { ...s.subView, [a.tab]: "list" },
        filters: { ...s.filters, [a.tab]: a.on ? { [a.filterKey]: true } : {} },
        queries: { ...s.queries, [a.tab]: "" },
        panel: "A",
        focusTick: s.focusTick + 1,
      };
    case "goPayments":
      return { ...s, tab: "purchaseOrders", subView: { ...s.subView, purchaseOrders: "payments" }, panel: "A", focusTick: s.focusTick + 1 };
    case "focusData":
      return { ...s, panel: "A", focusTick: s.focusTick + 1 };
    case "selectRow":
      return {
        ...s,
        detailOpen: true,
        selection: {
          rowKey: a.rowKey,
          rowTab: a.tab,
          supplierId: a.supplierId === undefined ? s.selection.supplierId : a.supplierId,
          itemCode: a.itemCode === undefined ? s.selection.itemCode : a.itemCode,
        },
      };
    case "selectSupplier":
      return { ...s, selection: { ...s.selection, supplierId: a.supplierId } };
    case "clearSelection":
      if (a.what === "item") return { ...s, selection: { ...s.selection, itemCode: null } };
      if (a.what === "supplier") return { ...s, selection: { ...s.selection, supplierId: null } };
      return { ...s, selection: { ...s.selection, rowKey: null, rowTab: null }, detailOpen: false };
    case "addMessage":
      return { ...s, messages: [...s.messages, a.message], chatUnread: !s.chatOpen && a.message.role === "assistant" ? true : s.chatUnread };
    case "patchMessage":
      return { ...s, messages: s.messages.map((m) => (m.id === a.id && m.role === "assistant" ? { ...m, ...a.patch } : m)) };
    case "addResult": {
      const all = { ...s.results, [a.result.id]: a.result };
      const { results, removed } = trimResults(all, s.resultMeta, [a.result.id, s.view.resultId, s.lastResultId]);
      return {
        ...s,
        results,
        lastResultId: a.asLast === false ? s.lastResultId : a.result.id,
        detailOpen: false, // 챗봇 결과가 나오면 선택 정보는 접어 상단 아이콘으로
        toast: removed.length ? toast(`분석 이력이 ${MAX_RESULTS}건을 넘어 가장 오래된 결과 '${s.resultMeta[removed[0].id]?.name ?? removed[0].title}'를 지웠습니다. 남길 결과는 이력에서 고정하세요.`, "warn") : s.toast,
      };
    }
    case "show":
      return { ...s, view: { resultId: a.resultId, template: a.template } };
    case "renameResult":
      return { ...s, resultMeta: { ...s.resultMeta, [a.id]: { ...s.resultMeta[a.id], name: a.name.trim() || undefined } } };
    case "pinResult":
      return { ...s, resultMeta: { ...s.resultMeta, [a.id]: { ...s.resultMeta[a.id], pinned: a.pinned } } };
    case "deleteResult": {
      const results = { ...s.results };
      delete results[a.id];
      const resultMeta = { ...s.resultMeta };
      delete resultMeta[a.id];
      return {
        ...s,
        results,
        resultMeta,
        view: s.view.resultId === a.id ? { resultId: null, template: null } : s.view,
        lastResultId: s.lastResultId === a.id ? null : s.lastResultId,
      };
    }
    case "pending":
      return { ...s, pending: a.pending };
    case "busy":
      return { ...s, busy: a.busy, progress: a.progress ?? (a.busy ? s.progress : 0) };
    case "aiMode":
      return { ...s, aiMode: a.mode };
    case "panel":
      return { ...s, panel: a.panel };
    case "chat":
      return { ...s, chatOpen: a.open, chatUnread: a.open ? false : s.chatUnread };
    case "chatUnread":
      return { ...s, chatUnread: a.unread };
    case "settings":
      return { ...s, settings: a.settings };
    case "savePreset":
      return { ...s, userPresets: [...s.userPresets.filter((p) => p.id !== a.preset.id), a.preset] };
    case "deletePreset":
      return { ...s, userPresets: s.userPresets.filter((p) => p.id !== a.id) };
    case "toggleFav": {
      const list = s.favorites[a.kind];
      const next = list.includes(a.id) ? list.filter((x) => x !== a.id) : [...list, a.id];
      return { ...s, favorites: { ...s.favorites, [a.kind]: next } };
    }
    case "pinFav":
      return { ...s, pinFav: a.on };
    case "payCheck":
      return { ...s, payChecked: a.on ? Array.from(new Set([...s.payChecked, a.poNo])) : s.payChecked.filter((x) => x !== a.poNo) };
    case "openImport":
      return { ...s, importFor: a.dataset };
    case "onboarding":
      return { ...s, onboarding: a.open };
    case "detailOpen":
      return { ...s, detailOpen: a.open };
    case "replaceData": {
      const schema = SCHEMAS[a.dataset];
      const incoming = a.rows as Record<string, unknown>[];
      let next: unknown[];
      if (a.mode === "replace") next = incoming;
      else {
        const map = new Map((s.data[a.dataset] as unknown as Record<string, unknown>[]).map((r) => [pkOf(schema, r), r]));
        for (const r of incoming) map.set(pkOf(schema, r), { ...(map.get(pkOf(schema, r)) || {}), ...r });
        next = [...map.values()];
      }
      const data = { ...s.data, [a.dataset]: next } as DataSet;
      const meta: DataMeta = {
        ...s.meta,
        isSample: false,
        label: "SAMPLE + 업로드 데이터",
        sources: { ...s.meta.sources, [a.dataset]: a.source },
        version: s.meta.version + 1,
        dataId: newDataId(),
        uploaded: Array.from(new Set([...(s.meta.uploaded ?? []), a.dataset])),
      };
      const supplierId = data.suppliers.some((x) => x.supplierId === s.selection.supplierId) ? s.selection.supplierId : data.suppliers[0]?.supplierId ?? null;
      const itemCode = data.items.some((x) => x.itemCode === s.selection.itemCode) ? s.selection.itemCode : null;
      return { ...s, data, meta, selection: { supplierId, itemCode, rowKey: null, rowTab: null } };
    }
    case "loadSaved": {
      const sample = loadSample().data;
      // 예전 형식으로 저장된 데이터에 없는 종류는 샘플로 채운다
      const data = Object.fromEntries((Object.keys(sample) as DatasetKey[]).map((k) => [k, Array.isArray(a.data[k]) ? a.data[k] : sample[k]])) as unknown as DataSet;
      return {
        ...s,
        data,
        meta: { ...a.meta, version: s.meta.version + 1 },
        savedAt: a.savedAt,
        selection: { supplierId: data.suppliers[0]?.supplierId ?? null, itemCode: null, rowKey: null, rowTab: null },
      };
    }
    case "dataReady":
      return { ...s, dataReady: true };
    case "saved":
      return { ...s, savedAt: a.at, saveError: a.error ?? null };
    case "resetSample": {
      const { data, meta } = loadSample();
      return {
        ...s,
        data,
        meta: { ...meta, version: s.meta.version + 1 },
        savedAt: null,
        saveError: null,
        selection: { supplierId: data.suppliers[0]?.supplierId ?? null, itemCode: null, rowKey: null, rowTab: null },
      };
    }
    case "toast":
      return { ...s, toast: toast(a.text, a.tone) };
    case "clearToast":
      return { ...s, toast: null };
    case "clearChat":
      // 대화만 비우고 분석 결과·이력은 남긴다
      return { ...s, messages: [{ ...WELCOME, at: now() }], pending: null, lastResultId: null };
  }
}

interface Store {
  state: State;
  dispatch: Dispatch<Action>;
  derived: Derived;
}

const Ctx = createContext<Store | null>(null);

export function StoreProvider({ user, children }: { user: User; children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, user, initial);
  const derived = useMemo(() => derive(state.data, state.meta.asOf), [state.data, state.meta.asOf]);
  const value = useMemo(() => ({ state, dispatch, derived }), [state, derived]);
  const uid = user.id;

  // 시작할 때: 이 브라우저에 저장한 업로드 데이터가 있으면 불러온다
  const lastSavedId = useRef<string | null>(null);
  useEffect(() => {
    let alive = true;
    idbGet<SavedUpload>(userKey(uid, UPLOADS)).then((saved) => {
      if (!alive) return;
      if (saved && saved.data && saved.meta && saved.meta.dataId) {
        lastSavedId.current = saved.meta.dataId;
        dispatch({ type: "loadSaved", data: saved.data, meta: saved.meta, savedAt: saved.savedAt });
      }
      dispatch({ type: "dataReady" });
    });
    return () => {
      alive = false;
    };
  }, [uid]);

  // 업로드 데이터가 바뀌면 저장, 샘플로 돌아가면 저장본 삭제
  useEffect(() => {
    if (!state.dataReady) return;
    if (state.meta.isSample) {
      if (lastSavedId.current !== "sample") {
        lastSavedId.current = "sample";
        idbDel(userKey(uid, UPLOADS));
      }
      return;
    }
    if (lastSavedId.current === state.meta.dataId) return;
    lastSavedId.current = state.meta.dataId;
    const at = new Date().toISOString();
    idbSet(userKey(uid, UPLOADS), { data: state.data, meta: state.meta, savedAt: at } satisfies SavedUpload).then((ok) => {
      dispatch({ type: "saved", at: ok ? at : null, error: ok ? null : "브라우저에 저장하지 못했습니다" });
      if (!ok) dispatch({ type: "toast", text: "업로드 데이터를 이 브라우저에 저장하지 못했습니다(저장 공간 부족 또는 사생활 보호 모드). 새로고침하면 샘플로 돌아갑니다.", tone: "warn" });
    });
  }, [state.dataReady, state.meta.dataId, state.meta.isSample]); // eslint-disable-line react-hooks/exhaustive-deps

  // 대화·결과·이력 저장: 바뀔 때마다 잠시 모았다가 저장하고, 페이지를 떠날 때 한 번 더 저장
  const latest = useRef(state);
  latest.current = state;
  const warned = useRef(false);
  const saveSession = (s: State) => {
    const key = userKey(uid, SESSION);
    if (writeStore(key, compactSession(s))) return;
    // 저장 공간이 부족하면 이력·대화를 줄여서 다시 시도
    if (writeStore(key, compactSession(s, 20, 40))) {
      if (!warned.current) {
        warned.current = true;
        dispatch({ type: "toast", text: "브라우저 저장 공간이 부족해 최근 분석 20건과 대화 일부만 저장했습니다.", tone: "warn" });
      }
    }
  };
  useEffect(() => {
    if (!state.dataReady) return;
    const t = setTimeout(() => saveSession(state), 150);
    return () => clearTimeout(t);
  }, [state.messages, state.results, state.resultMeta, state.view, state.lastResultId, state.pending]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const flush = () => latest.current.dataReady && saveSession(latest.current);
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    writeStore(userKey(uid, SETTINGS), { settings: state.settings, userPresets: state.userPresets });
  }, [uid, state.settings, state.userPresets]);
  useEffect(() => {
    writeStore(userKey(uid, PREFS), { favorites: state.favorites, pinFav: state.pinFav, payChecked: state.payChecked } satisfies SavedPrefs);
  }, [uid, state.favorites, state.pinFav, state.payChecked]);

  if (!state.dataReady)
    return (
      <div className="boot" role="status">
        <span className="boot-dot" aria-hidden />이 브라우저에 저장된 데이터를 확인하는 중…
      </div>
    );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const v = useContext(Ctx);
  if (!v) throw new Error("StoreProvider가 없습니다");
  return v;
}

export const uid = () => Math.random().toString(36).slice(2, 10);

/** 결과 이름: 사용자가 바꾼 이름이 있으면 그것, 없으면 분석 제목 */
export const resultName = (s: Pick<State, "resultMeta">, r: AnalysisResult) => s.resultMeta[r.id]?.name || r.title;
