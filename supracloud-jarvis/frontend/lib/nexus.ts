/**
 * Nexus state layer — the shared stores that drive the Pulse glyph, the
 * execution timeline, the agent activity cards, the permission console and
 * the memory context panel.
 *
 * Everything here is fed by real events (chat stream frames, voice loop
 * state changes, /health polls). Panels render honest empty/idle states when
 * nothing has happened — they never fabricate activity.
 */

import { create } from "zustand";
import { classifyIntent, type DetectedIntent } from "./intent";

// ── Agent registry ──────────────────────────────────────────────────────────

export interface AgentInfo {
  id: string;
  label: string;
  accent: string; // hex color the Pulse adopts during a handoff
}

export const AGENT_REGISTRY: AgentInfo[] = [
  { id: "voice", label: "Voice", accent: "#22d3ee" },
  { id: "router", label: "Intent Router", accent: "#67e8f9" },
  { id: "code", label: "Code", accent: "#34d399" },
  { id: "research", label: "Research", accent: "#60a5fa" },
  { id: "memory", label: "Memory", accent: "#a78bfa" },
  { id: "security", label: "Security", accent: "#fbbf24" },
  { id: "file", label: "File", accent: "#f472b6" },
  { id: "model", label: "Model Router", accent: "#94a3b8" },
];

export function agentById(id: string): AgentInfo | undefined {
  return AGENT_REGISTRY.find((a) => a.id === id);
}

/** Map a backend agent name (free-form string from `data.agent`) to a card. */
export function mapBackendAgent(name: string | undefined): string {
  const n = (name ?? "").toLowerCase();
  if (!n) return "router";
  if (/(code|engineer|architect|dev)/.test(n)) return "code";
  if (/(research|search|web|live)/.test(n)) return "research";
  if (/(memory|recall|note)/.test(n)) return "memory";
  if (/(security|guard)/.test(n)) return "security";
  if (/(file|document|vision)/.test(n)) return "file";
  if (/(voice|speech|tts|stt)/.test(n)) return "voice";
  if (/(model|llm|ollama)/.test(n)) return "model";
  return "router";
}

// ── Pulse (the one living element) ──────────────────────────────────────────

export type PulseState =
  | "idle"
  | "listening"
  | "understanding"
  | "thinking"
  | "acting"
  | "permission"
  | "speaking"
  | "completed"
  | "error";

interface PulseStore {
  state: PulseState;
  /** Active specialist during a handoff; null = IRA core cyan. */
  agent: AgentInfo | null;
  /** Mic analyser shared by the voice loop so the Pulse can react to audio. */
  analyser: AnalyserNode | null;
  setState: (s: PulseState) => void;
  handoff: (agentId: string | null) => void;
  setAnalyser: (a: AnalyserNode | null) => void;
}

export const usePulseStore = create<PulseStore>()((set) => ({
  state: "idle",
  agent: null,
  analyser: null,
  setState: (state) => set({ state }),
  handoff: (agentId) => set({ agent: agentId ? agentById(agentId) ?? null : null }),
  setAnalyser: (analyser) => set({ analyser }),
}));

// ── Execution timeline ──────────────────────────────────────────────────────

export type StageId =
  | "captured"
  | "intent"
  | "agent"
  | "files"
  | "analysis"
  | "permission"
  | "result";

export type StageStatus = "pending" | "active" | "done" | "skipped" | "error";

export interface Stage {
  id: StageId;
  label: string;
  status: StageStatus;
  detail?: string;
  at?: number; // epoch ms of the last status change
}

const STAGE_TEMPLATE: Array<{ id: StageId; label: string }> = [
  { id: "captured", label: "Command captured" },
  { id: "intent", label: "Intent detected" },
  { id: "agent", label: "Agent selected" },
  { id: "files", label: "Files read" },
  { id: "analysis", label: "Analysis running" },
  { id: "permission", label: "Permission required" },
  { id: "result", label: "Result generated" },
];

interface ExecStore {
  runId: number;
  command: string;
  stages: Stage[];
  begin: (command: string) => void;
  setStage: (id: StageId, status: StageStatus, detail?: string) => void;
  reset: () => void;
}

export const useExecStore = create<ExecStore>()((set) => ({
  runId: 0,
  command: "",
  stages: [],
  begin: (command) =>
    set((s) => ({
      runId: s.runId + 1,
      command,
      stages: STAGE_TEMPLATE.map((t) => ({ ...t, status: "pending" as StageStatus })),
    })),
  setStage: (id, status, detail) =>
    set((s) => ({
      stages: s.stages.map((st) =>
        st.id === id ? { ...st, status, detail: detail ?? st.detail, at: Date.now() } : st
      ),
    })),
  reset: () => set({ command: "", stages: [] }),
}));

// ── Agent activity ──────────────────────────────────────────────────────────

export type AgentStatus = "ready" | "active" | "running" | "waiting" | "completed" | "error";

interface AgentActivityStore {
  status: Record<string, { state: AgentStatus; note?: string }>;
  setAgent: (id: string, state: AgentStatus, note?: string) => void;
  settle: () => void; // running/active/waiting -> ready between runs
}

const initialAgents = Object.fromEntries(
  AGENT_REGISTRY.map((a) => [a.id, { state: "ready" as AgentStatus }])
);

export const useAgentStore = create<AgentActivityStore>()((set) => ({
  status: initialAgents,
  setAgent: (id, state, note) =>
    set((s) => ({ status: { ...s.status, [id]: { state, note } } })),
  settle: () =>
    set((s) => ({
      status: Object.fromEntries(
        Object.entries(s.status).map(([id, v]) => [
          id,
          ["running", "active", "waiting"].includes(v.state) ? { state: "ready" as AgentStatus } : v,
        ])
      ),
    })),
}));

// ── Permission console ──────────────────────────────────────────────────────

export type PermissionDecision = "allow-once" | "allow-scope" | "deny";

export interface PermissionRequest {
  title: string;
  description: string;
  /** Exactly what IRA wants to access or modify — shown verbatim. */
  access: string[];
  risk: "low" | "medium" | "high";
  /** Scope key for "Allow for this scope" (e.g. "architect-apply"). */
  scope: string;
  scopeLabel: string;
}

interface PendingPermission extends PermissionRequest {
  id: string;
  resolve: (d: PermissionDecision) => void;
}

interface PermissionStore {
  queue: PendingPermission[];
  /** Scopes the user granted for this session. */
  grants: Record<string, string>; // scope -> scopeLabel
  request: (req: PermissionRequest) => Promise<PermissionDecision>;
  decide: (id: string, d: PermissionDecision) => void;
  revokeAll: () => void;
}

export const usePermissionStore = create<PermissionStore>()((set, get) => ({
  queue: [],
  grants: {},
  request: (req) => {
    // A standing session grant for this scope resolves without prompting.
    if (get().grants[req.scope]) return Promise.resolve("allow-scope");
    return new Promise<PermissionDecision>((resolve) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      usePulseStore.getState().setState("permission");
      set((s) => ({ queue: [...s.queue, { ...req, id, resolve }] }));
    });
  },
  decide: (id, d) => {
    const item = get().queue.find((q) => q.id === id);
    if (!item) return;
    if (d === "allow-scope") {
      set((s) => ({ grants: { ...s.grants, [item.scope]: item.scopeLabel } }));
    }
    set((s) => ({ queue: s.queue.filter((q) => q.id !== id) }));
    if (get().queue.length === 0 && usePulseStore.getState().state === "permission") {
      usePulseStore.getState().setState("idle");
    }
    item.resolve(d);
  },
  revokeAll: () => set({ grants: {} }),
}));

/** Gate a side-effecting action behind explicit consent. */
export function requestPermission(req: PermissionRequest): Promise<PermissionDecision> {
  return usePermissionStore.getState().request(req);
}

// ── Voice / command telemetry panel ─────────────────────────────────────────

interface VoicePanelStore {
  transcript: string;
  origin: "voice" | "typed" | null;
  intent: DetectedIntent | null;
  setCommand: (text: string, origin: "voice" | "typed") => void;
  clear: () => void;
}

export const useVoicePanelStore = create<VoicePanelStore>()((set) => ({
  transcript: "",
  origin: null,
  intent: null,
  setCommand: (text, origin) =>
    set({ transcript: text, origin, intent: text ? classifyIntent(text) : null }),
  clear: () => set({ transcript: "", origin: null, intent: null }),
}));

// ── Memory context (only what the current task actually used) ──────────────

export interface MemoryItem {
  kind: "file" | "session" | "source" | "memory";
  label: string;
  note?: string;
  /** 0..1 when a real relevance signal exists; omitted otherwise. */
  relevance?: number;
}

interface MemoryContextStore {
  items: MemoryItem[];
  add: (item: MemoryItem) => void;
  clear: () => void;
}

export const useMemoryContextStore = create<MemoryContextStore>()((set) => ({
  items: [],
  add: (item) =>
    set((s) => ({
      items: s.items.some((i) => i.kind === item.kind && i.label === item.label)
        ? s.items
        : [...s.items, item],
    })),
  clear: () => set({ items: [] }),
}));

// ── Run orchestration helpers (called from ChatInterface / VoiceConsole) ────

/** Start a run: timeline, intent readout, router card, pulse. */
export function nexusBeginRun(command: string, opts: { origin: "voice" | "typed"; attachedFile?: string }) {
  const exec = useExecStore.getState();
  const agents = useAgentStore.getState();
  const pulse = usePulseStore.getState();
  const memory = useMemoryContextStore.getState();

  memory.clear();
  exec.begin(command);
  exec.setStage("captured", "done", opts.origin === "voice" ? "voice command" : "typed command");

  useVoicePanelStore.getState().setCommand(command, opts.origin);
  const intent = classifyIntent(command);
  exec.setStage("intent", "done", `${intent.label} · ${(intent.confidence * 100) | 0}% (heuristic)`);
  agents.setAgent("router", "active", intent.label);

  if (opts.attachedFile) {
    exec.setStage("files", "active", opts.attachedFile);
    agents.setAgent("file", "running", opts.attachedFile);
    memory.add({ kind: "file", label: opts.attachedFile, note: "attached to this task", relevance: 1 });
  } else {
    exec.setStage("files", "skipped", "no files in this task");
  }

  pulse.setState("understanding");
  memory.add({ kind: "session", label: "Current session", note: "conversation context" });
}

/** First streamed token arrived — analysis is genuinely running. */
export function nexusAnalysisStarted() {
  useExecStore.getState().setStage("analysis", "active");
  const p = usePulseStore.getState();
  if (p.state !== "permission") p.setState("thinking");
}

/** Stream finished: mark the run done and settle the boards. */
export function nexusRunCompleted(info: {
  backendAgent?: string;
  latencyMs?: number;
  pendingApply?: boolean;
  deepSearchRounds?: number;
  usedLiveSearch?: boolean;
}) {
  const exec = useExecStore.getState();
  const agents = useAgentStore.getState();
  const memory = useMemoryContextStore.getState();

  const cardId = mapBackendAgent(info.backendAgent);
  const card = agentById(cardId);
  exec.setStage("agent", "done", card ? card.label : cardId);
  agents.setAgent("router", "completed");
  agents.setAgent(cardId, "completed", info.latencyMs ? `${(info.latencyMs / 1000).toFixed(1)}s` : undefined);
  usePulseStore.getState().handoff(cardId === "router" ? null : cardId);

  if (useExecStore.getState().stages.find((s) => s.id === "files")?.status === "active") {
    exec.setStage("files", "done");
    agents.setAgent("file", "completed");
  }
  exec.setStage("analysis", "done");

  if (info.pendingApply) {
    exec.setStage("permission", "active", "apply requires your approval");
    usePulseStore.getState().setState("permission");
  } else {
    exec.setStage("permission", "skipped", "no side effects");
    usePulseStore.getState().setState("completed");
  }
  exec.setStage("result", "done", info.latencyMs ? `${(info.latencyMs / 1000).toFixed(1)}s` : undefined);

  if (info.deepSearchRounds) {
    memory.add({
      kind: "source",
      label: `Live web research × ${info.deepSearchRounds} rounds`,
      note: "fetched during this task",
    });
    agents.setAgent("research", "completed", `${info.deepSearchRounds} rounds`);
  } else if (info.usedLiveSearch) {
    memory.add({ kind: "source", label: "Live search", note: "fetched during this task" });
    agents.setAgent("research", "completed");
  }

  // Handoff accent and completion flash decay back to core idle.
  window.setTimeout(() => {
    usePulseStore.getState().handoff(null);
    useAgentStore.getState().settle();
  }, 2600);
}

/** Stream failed. */
export function nexusRunFailed(detail: string) {
  const exec = useExecStore.getState();
  const active = exec.stages.find((s) => s.status === "active");
  exec.setStage(active?.id ?? "analysis", "error", detail);
  exec.setStage("result", "error", detail);
  usePulseStore.getState().setState("error");
  useAgentStore.getState().settle();
}
