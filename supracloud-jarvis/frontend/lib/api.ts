/**
 * Thin API client for the IRA backend.
 * Browser calls go through the same origin (nginx proxies /api/ → ira-api).
 * Server-side calls use IRA_API_INTERNAL_URL for direct container-to-container
 * routing (bypasses nginx, lower latency).
 */

// L7: SSR uses IRA_API_INTERNAL_URL (set to http://localhost:8000 in .env.local
// for native/no-Docker dev; "ira-api:8000" remains the Docker default). The
// browser uses same-origin ("") -> next.config.js rewrites /api,/auth,/health
// to the local API, so no nginx is needed in local mode.
// Browser: same-origin ("") by default — `tailscale serve` path-routes /api,/auth,
// /health to the backend, so the phone PWA needs no rewrite. Set NEXT_PUBLIC_API_BASE
// only if the API is served from a different host than the frontend.
const INTERNAL =
  typeof window === "undefined"
    ? process.env.IRA_API_INTERNAL_URL || "http://ira-api:8000"
    : process.env.NEXT_PUBLIC_API_BASE || "";

function base() {
  return INTERNAL;
}

export async function apiFetch(
  path: string,
  init?: RequestInit,
  token?: string
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(init?.headers as Record<string, string> | undefined),
  };
  const res = await fetch(`${base()}${path}`, { ...init, headers });
  if (!res.ok) {
    throw new Error(`IRA API error ${res.status} on ${path}`);
  }
  return res;
}

export async function getToken(
  username: string,
  password: string
): Promise<string> {
  const form = new FormData();
  form.append("username", username);
  form.append("password", password);
  const res = await fetch(`${base()}/auth/token`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error("Authentication failed");
  const data = await res.json();
  return data.access_token as string;
}

export async function getHealth() {
  const res = await fetch(`${base()}/health`);
  return res.json();
}

export async function getTasks(token: string, status?: string) {
  const qs = status ? `?status=${status}` : "";
  const res = await apiFetch(`/api/v1/tasks${qs}`, {}, token);
  return res.json();
}

export async function createTask(
  token: string,
  title: string,
  options?: { description?: string; priority?: string; due_at?: string }
) {
  const res = await apiFetch(
    "/api/v1/tasks",
    { method: "POST", body: JSON.stringify({ title, ...options }) },
    token
  );
  return res.json();
}

// ── Trust Console ───────────────────────────────────────────────────────────

export interface TrustStatus {
  status: "local_only" | "attention";
  privacy: {
    mode: string;
    external_api_allowed: boolean;
    api_consent_required: boolean;
    web_search_enabled: boolean;
  };
  model: { backend: string; base_url: string; local: boolean; profile: string };
  database: { host: string; local: boolean };
  memory: { store: string; local: boolean; embedding_model: string; embedding_device: string };
  voice_profile: { enrolled: boolean | null };
  pending_actions: number | null;
  last_login: string | null;
  security_warnings: string[];
}

export async function getTrustStatus(token: string): Promise<TrustStatus> {
  const res = await apiFetch("/api/v1/trust/status", {}, token);
  return res.json();
}

// ── Memory Vault ────────────────────────────────────────────────────────────

export interface VaultMemory {
  id: string;
  content: string;
  kind: string;
  pinned: boolean;
  created_at: string | null;
}

export async function listMemories(
  token: string,
  opts?: { kind?: string; q?: string }
): Promise<{ memories: VaultMemory[]; count: number }> {
  const params = new URLSearchParams();
  if (opts?.kind) params.set("kind", opts.kind);
  if (opts?.q) params.set("q", opts.q);
  const qs = params.toString();
  const res = await apiFetch(`/api/v1/memory${qs ? `?${qs}` : ""}`, {}, token);
  return res.json();
}

export async function createMemory(
  token: string,
  content: string,
  kind: string,
  pinned = false
): Promise<VaultMemory> {
  const res = await apiFetch(
    "/api/v1/memory",
    { method: "POST", body: JSON.stringify({ content, kind, pinned }) },
    token
  );
  return res.json();
}

export async function updateMemory(token: string, id: string, content: string): Promise<VaultMemory> {
  const res = await apiFetch(
    `/api/v1/memory/${id}`,
    { method: "PUT", body: JSON.stringify({ content }) },
    token
  );
  return res.json();
}

export async function pinMemory(token: string, id: string, pinned: boolean): Promise<VaultMemory> {
  const res = await apiFetch(
    `/api/v1/memory/${id}/pin`,
    { method: "POST", body: JSON.stringify({ pinned }) },
    token
  );
  return res.json();
}

/**
 * Two-step forget. Without a token the backend NEVER deletes — it returns a
 * confirmation draft {status:"confirmation_required", token, preview,
 * expires_in}. Passing that token back executes the delete.
 */
export interface ForgetDraft {
  status: "confirmation_required";
  action: string;
  token: string;
  preview: string;
  expires_in: number;
}

export async function forgetMemory(
  token: string,
  id: string,
  confirmToken?: string
): Promise<ForgetDraft | { deleted: string }> {
  const qs = confirmToken ? `?confirm_token=${encodeURIComponent(confirmToken)}` : "";
  const res = await apiFetch(`/api/v1/memory/${id}${qs}`, { method: "DELETE" }, token);
  return res.json();
}

// ── Voice profile ───────────────────────────────────────────────────────────

export interface VoiceProfileStatus {
  enrolled: boolean;
  owner?: string;
  enrolled_at?: string;
  last_updated?: string;
  message?: string;
  error?: string;
}

export async function getVoiceProfileStatus(token: string): Promise<VoiceProfileStatus> {
  const res = await apiFetch("/api/v1/voice/profile/status", {}, token);
  return res.json();
}

export interface VoiceChallenge {
  challenge_id: string;
  phrase: string;
  expires_in: number;
}

export async function getVoiceChallenge(token: string): Promise<VoiceChallenge> {
  const res = await apiFetch("/api/v1/voice/challenge", {}, token);
  return res.json();
}

/** Multipart enrolment: 3–10 WAV blobs (16 kHz mono PCM) + one-time challenge. */
export async function enrollVoice(
  token: string,
  clips: Blob[],
  challengeId: string
): Promise<{ status: string; segments_processed: number; message: string }> {
  const form = new FormData();
  clips.forEach((blob, i) => form.append("audio_files", blob, `segment-${i + 1}.wav`));
  form.append("challenge_id", challengeId);
  const res = await fetch(`${base()}/api/v1/voice/enroll`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }));
    throw new Error(err.detail ?? `Enrolment failed (${res.status})`);
  }
  return res.json();
}

// ── Health detail (dashboard readiness) ─────────────────────────────────────

export async function getHealthDetail(): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${base()}/health/detail`);
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export async function getLatestBriefing(token: string) {
  const res = await apiFetch("/api/v1/briefing/latest", {}, token);
  return res.json();
}

export async function triggerBriefing(token: string, type = "morning") {
  const res = await apiFetch(
    `/api/v1/briefing/now?briefing_type=${type}`,
    { method: "POST" },
    token
  );
  return res.json();
}
