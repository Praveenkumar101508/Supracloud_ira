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

// ── People / relationships + delegated access (PR #67) ─────────────────────

export interface Person {
  id: string;
  person_name: string;
  relationship: string;
  added_by: string;
  confirmed_by_owner: boolean;
  access_level: string;
  notes: string;
  created_at: string | null;
  updated_at: string | null;
}

export interface ConfirmationDraft {
  status: "confirmation_required";
  action: string;
  token: string;
  preview: string;
  expires_in: number;
}

export type RememberResult =
  | ConfirmationDraft
  | { status: "no_match" | "needs_name"; detail: string; relationship?: string }
  | { saved: Person; detail: string };

export async function rememberPerson(
  token: string,
  statement: string,
  opts?: { personName?: string; confirmToken?: string }
): Promise<RememberResult> {
  const res = await apiFetch(
    "/api/v1/people/remember",
    {
      method: "POST",
      body: JSON.stringify({
        statement,
        person_name: opts?.personName ?? null,
        confirm_token: opts?.confirmToken ?? null,
      }),
    },
    token
  );
  return res.json();
}

export async function listPeople(token: string): Promise<{ people: Person[]; count: number }> {
  const res = await apiFetch("/api/v1/people", {}, token);
  return res.json();
}

export async function updatePersonRelationship(
  token: string,
  personId: string,
  relationship: string
): Promise<Person> {
  const res = await apiFetch(
    `/api/v1/people/${personId}`,
    { method: "PUT", body: JSON.stringify({ relationship }) },
    token
  );
  return res.json();
}

export async function forgetPerson(
  token: string,
  personId: string,
  confirmToken?: string
): Promise<ConfirmationDraft | { deleted: string }> {
  const qs = confirmToken ? `?confirm_token=${encodeURIComponent(confirmToken)}` : "";
  const res = await apiFetch(`/api/v1/people/${personId}${qs}`, { method: "DELETE" }, token);
  return res.json();
}

export interface DelegatedUser {
  id: string;
  username: string;
  role: string;
  person_id: string | null;
  is_primary_owner: boolean;
  active: boolean;
  voice_enrolled: boolean;
  created_at: string | null;
}

export async function listDelegatedUsers(
  token: string
): Promise<{ users: DelegatedUser[]; count: number }> {
  const res = await apiFetch("/api/v1/access/users", {}, token);
  return res.json();
}

export interface GrantAccessBody {
  person_id?: string | null;
  person_name: string;
  role: string;
  new_username: string;
  new_password: string;
  owner_password: string;
  confirm_token?: string | null;
}

export async function grantAccess(
  token: string,
  body: GrantAccessBody
): Promise<ConfirmationDraft | { granted: DelegatedUser; detail: string }> {
  const res = await apiFetch(
    "/api/v1/access/grant",
    { method: "POST", body: JSON.stringify({ channel: "ui", ...body }) },
    token
  );
  return res.json();
}

export async function revokeAccess(
  token: string,
  userId: string,
  ownerPassword: string,
  confirmToken?: string
): Promise<ConfirmationDraft | { revoked: DelegatedUser }> {
  const res = await apiFetch(
    "/api/v1/access/revoke",
    {
      method: "POST",
      body: JSON.stringify({
        user_id: userId,
        owner_password: ownerPassword,
        channel: "ui",
        confirm_token: confirmToken ?? null,
      }),
    },
    token
  );
  return res.json();
}

export interface AccessAuditEntry {
  id: number;
  actor: string;
  action: string;
  target: string;
  details: Record<string, string>;
  created_at: string | null;
}

export async function getAccessAudit(
  token: string
): Promise<{ entries: AccessAuditEntry[]; count: number }> {
  const res = await apiFetch("/api/v1/access/audit", {}, token);
  return res.json();
}

// ── Command Center (PR #68) ─────────────────────────────────────────────────

export interface CommandPlan {
  intent: string;
  target: string;
  steps: string[];
  touches: string[];
  risk: "low" | "medium" | "high" | "critical";
  confirmation_required: boolean;
  password_required: boolean;
  blocked: boolean;
  auto_execute: boolean;
}

export interface CommandResponse {
  run_id: string;
  plan: CommandPlan;
  status:
    | "executed"
    | "failed"
    | "awaiting_confirmation"
    | "clarification"
    | "needs_wizard"
    | "routed_people_flow"
    | "blocked";
  result?: { ok?: boolean; detail?: string; [k: string]: unknown };
  detail?: string;
  token?: string;
  preview?: string;
  expires_in?: number;
}

export async function runCommand(
  token: string,
  text: string,
  opts?: { confirmToken?: string; ownerPassword?: string }
): Promise<CommandResponse> {
  const res = await apiFetch(
    "/api/v1/command",
    {
      method: "POST",
      body: JSON.stringify({
        text,
        channel: "ui",
        confirm_token: opts?.confirmToken ?? null,
        owner_password: opts?.ownerPassword ?? null,
      }),
    },
    token
  );
  return res.json();
}

export interface CommandRun {
  id: string;
  actor: string;
  raw_text: string;
  intent: string;
  plan: CommandPlan | Record<string, never>;
  risk: string;
  status: string;
  result: { detail?: string; [k: string]: unknown };
  created_at: string | null;
  executed_at: string | null;
}

export async function getCommandHistory(
  token: string
): Promise<{ runs: CommandRun[]; count: number; detail?: string }> {
  const res = await apiFetch("/api/v1/command/history", {}, token);
  return res.json();
}

// ── Owner profile + first-run onboarding (PR #66) ───────────────────────────

export interface OwnerProfile {
  name: string;
  goals: string;
  projects: string;
  preferences: string;
  preferred_title: string;
  wake_word: string;
  role: string;
  first_run_completed: boolean;
  voice_enabled: boolean;
}

export async function getOwnerProfile(token: string): Promise<OwnerProfile> {
  const res = await apiFetch("/api/v1/profile", {}, token);
  return res.json();
}

export async function updateOwnerProfile(
  token: string,
  fields: Partial<Pick<OwnerProfile, "name" | "goals" | "projects" | "preferences" | "preferred_title" | "wake_word" | "voice_enabled">>
): Promise<OwnerProfile> {
  const res = await apiFetch("/api/v1/profile", { method: "PUT", body: JSON.stringify(fields) }, token);
  return res.json();
}

export interface OnboardingStatus {
  first_run_completed: boolean;
  owner_name: string;
  preferred_title: string;
  role: string;
  wake_word: string;
  voice_enabled: boolean;
}

export async function getOnboardingStatus(token: string): Promise<OnboardingStatus> {
  const res = await apiFetch("/api/v1/onboarding/status", {}, token);
  return res.json();
}

export async function completeOnboarding(
  token: string,
  body: { owner_name: string; preferred_title: string; wake_word: string; voice_enabled: boolean }
): Promise<OnboardingStatus> {
  const res = await apiFetch("/api/v1/onboarding/complete", { method: "POST", body: JSON.stringify(body) }, token);
  return res.json();
}

export async function resetOnboarding(token: string): Promise<OnboardingStatus> {
  const res = await apiFetch("/api/v1/onboarding/reset", { method: "POST" }, token);
  return res.json();
}

// ── Wake Mode v1 (PR #66) ───────────────────────────────────────────────────

export interface WakeStatus {
  enabled: boolean;
  enabled_at_boot: boolean;
  state: "off" | "listening" | "awake" | "processing";
  available: boolean;
  reason: string | null;
  model: string;
  wake_word: string;
  local_only: boolean;
}

export async function getWakeStatus(token: string): Promise<WakeStatus> {
  const res = await apiFetch("/api/v1/voice/wake/status", {}, token);
  return res.json();
}

export async function setWakeMode(token: string, enabled: boolean): Promise<WakeStatus> {
  const res = await apiFetch("/api/v1/voice/wake", { method: "POST", body: JSON.stringify({ enabled }) }, token);
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
