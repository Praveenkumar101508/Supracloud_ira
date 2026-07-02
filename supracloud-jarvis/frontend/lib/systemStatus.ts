/**
 * Real subsystem probes for the Awakening Gate boot readouts and the Nexus
 * system bar. Every line reflects an actual check — a subsystem that cannot
 * be verified reports STANDBY or OFFLINE instead of a hardcoded positive.
 */

export type ReadoutState = "online" | "ready" | "active" | "standby" | "offline";

export interface Readout {
  key: string;
  label: string;
  state: ReadoutState;
  detail?: string;
}

interface ServiceStatus {
  status: "ok" | "degraded" | "down";
  latency_ms?: number;
}

export interface Health {
  status: string;
  version?: string;
  model?: string;
  services?: Record<string, ServiceStatus>;
}

export async function fetchHealth(timeoutMs = 4000): Promise<Health | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch("/health", { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    return (await res.json()) as Health;
  } catch {
    return null;
  }
}

function findService(health: Health | null, candidates: RegExp): ServiceStatus | null {
  if (!health?.services) return null;
  for (const [name, svc] of Object.entries(health.services)) {
    if (candidates.test(name)) return svc;
  }
  return null;
}

function serviceState(svc: ServiceStatus | null, whenOk: ReadoutState): ReadoutState | null {
  if (!svc) return null;
  if (svc.status === "ok") return whenOk;
  if (svc.status === "degraded") return "standby";
  return "offline";
}

export async function probeSystems(): Promise<Readout[]> {
  const health = await fetchHealth();

  const core: Readout = health
    ? {
        key: "core",
        label: "IRA CORE",
        state: health.status === "ok" ? "online" : "standby",
        detail: health.version ? `v${health.version}` : undefined,
      }
    : { key: "core", label: "IRA CORE", state: "offline", detail: "api unreachable" };

  const memSvc = findService(health, /(memory|vector|qdrant|chroma|store)/i);
  const memory: Readout = {
    key: "memory",
    label: "LOCAL MEMORY",
    state:
      serviceState(memSvc, "online") ??
      (typeof localStorage !== "undefined" ? "standby" : "offline"),
    detail: memSvc ? undefined : "browser store only — core memory unverified",
  };

  const voiceSvc = findService(health, /(voice|whisper|stt|tts|speech)/i);
  const micCapable =
    typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
  const voice: Readout = {
    key: "voice",
    label: "VOICE ENGINE",
    state: serviceState(voiceSvc, "ready") ?? (micCapable ? "standby" : "offline"),
    detail: voiceSvc ? undefined : micCapable ? "mic available — engine unverified" : "no mic",
  };

  const routerSvc = findService(health, /(router|agent|llm|ollama|model|brain)/i);
  const router: Readout = {
    key: "router",
    label: "AGENT ROUTER",
    state: serviceState(routerSvc, "active") ?? (health?.status === "ok" ? "active" : "offline"),
    detail: routerSvc || health ? undefined : "api unreachable",
  };

  // Config truth: same-origin API = local-first; an explicit remote base is not.
  const remoteBase = process.env.NEXT_PUBLIC_API_BASE || "";
  const privacy: Readout = {
    key: "privacy",
    label: "PRIVACY MODE",
    state: remoteBase ? "standby" : "online",
    detail: remoteBase ? `remote api: ${remoteBase}` : "local-first",
  };

  return [core, memory, voice, router, privacy];
}

export const READOUT_TEXT: Record<ReadoutState, string> = {
  online: "ONLINE",
  ready: "READY",
  active: "ACTIVE",
  standby: "STANDBY",
  offline: "OFFLINE",
};
