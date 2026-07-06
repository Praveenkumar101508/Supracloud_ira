"use client";

/**
 * People & Relationships (PR #67) — a section inside the Memory Vault.
 *
 * Remembering is easy: type "Rahul is my friend", IRA asks "Should I remember
 * Rahul as your friend?", and only your confirmation saves it — always with
 * access_level no_access.
 *
 * Access is a security event: the Grant Access wizard requires the role
 * choice, the new person's OWN username + password, YOUR owner password, and
 * a final confirmation of the backend's exact preview. Nothing here can touch
 * the primary owner, and every change lands in the audit log.
 */

import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import {
  Users,
  UserPlus,
  ShieldCheck,
  ShieldAlert,
  Trash2,
  RefreshCw,
  Check,
  X,
  KeyRound,
} from "lucide-react";
import {
  rememberPerson,
  listPeople,
  forgetPerson,
  listDelegatedUsers,
  grantAccess,
  revokeAccess,
  type Person,
  type DelegatedUser,
  type ConfirmationDraft,
  type RememberResult,
} from "@/lib/api";

const ROLES: { id: string; label: string; desc: string }[] = [
  { id: "viewer", label: "Viewer", desc: "General chat only" },
  { id: "trusted_user", label: "Trusted User", desc: "Chat, voice, shared memory (read)" },
  { id: "family_admin", label: "Family Admin", desc: "Chat, voice, shared memory, request actions" },
  {
    id: "owner_equivalent",
    label: "Owner Equivalent",
    desc: "Almost everything — but can never remove or replace you",
  },
];

export default function PeopleSection({ token }: { token: string }) {
  const [people, setPeople] = useState<Person[]>([]);
  const [users, setUsers] = useState<DelegatedUser[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);

  // Remember flow
  const [statement, setStatement] = useState("");
  const [nameInput, setNameInput] = useState("");
  const [needsName, setNeedsName] = useState<string | null>(null); // relationship awaiting a name
  const [rememberDraft, setRememberDraft] = useState<ConfirmationDraft | null>(null);

  // Forget flow
  const [forgetDraft, setForgetDraft] = useState<{ personId: string; draft: ConfirmationDraft } | null>(null);

  // Grant wizard
  const [wizardFor, setWizardFor] = useState<Person | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [p, u] = await Promise.all([
        listPeople(token),
        listDelegatedUsers(token).catch(() => ({ users: [], count: 0 })),
      ]);
      setPeople(p.people);
      setUsers(u.users);
    } catch (e) {
      setError(e instanceof Error ? e.message : "People list unavailable");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const submitStatement = async (confirmToken?: string) => {
    setError("");
    setNotice("");
    try {
      const res: RememberResult = await rememberPerson(token, statement, {
        personName: nameInput || undefined,
        confirmToken,
      });
      if ("status" in res && res.status === "confirmation_required") {
        setRememberDraft(res);
        setNeedsName(null);
      } else if ("status" in res && res.status === "needs_name") {
        setNeedsName(res.relationship ?? "");
        setRememberDraft(null);
      } else if ("status" in res && res.status === "no_match") {
        setError(res.detail);
      } else if ("saved" in res) {
        setNotice(res.detail);
        setStatement("");
        setNameInput("");
        setNeedsName(null);
        setRememberDraft(null);
        await load();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not process that statement");
    }
  };

  const startForget = async (p: Person) => {
    setError("");
    try {
      const res = await forgetPerson(token, p.id);
      if ("status" in res && res.status === "confirmation_required") {
        setForgetDraft({ personId: p.id, draft: res });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Forget failed");
    }
  };

  const confirmForget = async () => {
    if (!forgetDraft) return;
    try {
      await forgetPerson(token, forgetDraft.personId, forgetDraft.draft.token);
      setForgetDraft(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Forget failed — the draft may have expired");
      setForgetDraft(null);
    }
  };

  const accountFor = (p: Person) =>
    users.find((u) => u.person_id === p.id && u.active);

  return (
    <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <Users className="w-4 h-4 text-cyan-400" />
          People &amp; Relationships
          <span className="text-[10px] font-medium text-amber-300 border border-amber-400/30 bg-amber-400/[0.07] rounded px-1.5 py-0.5">
            BETA
          </span>
        </h3>
        <button
          onClick={() => void load()}
          disabled={loading}
          className="flex items-center gap-1.5 text-xs text-neutral-400 hover:text-white px-2 py-1 rounded-lg border border-white/10 hover:bg-white/[0.06] disabled:opacity-40"
        >
          <RefreshCw className={clsx("w-3 h-3", loading && "animate-spin")} />
        </button>
      </div>

      <p className="text-[11px] text-neutral-500 leading-relaxed">
        Tell IRA who people are — &ldquo;Rahul is my friend&rdquo;, &ldquo;remember Anitha is my
        wife&rdquo;. IRA confirms before saving, stores it as data only, and{" "}
        <span className="text-neutral-300">nobody gets system access from being remembered</span>.
        Granting access is a separate, password-protected step.
      </p>

      {error && (
        <div className="rounded-xl border border-rose-400/25 bg-rose-400/[0.06] px-3 py-2 text-xs text-rose-300">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-xl border border-emerald-400/25 bg-emerald-400/[0.06] px-3 py-2 text-xs text-emerald-300">
          {notice}
        </div>
      )}

      {/* Remember input */}
      <div className="space-y-2">
        <div className="flex gap-2">
          <input
            value={statement}
            onChange={(e) => setStatement(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && statement.trim() && void submitStatement()}
            placeholder='e.g. "Remember Rahul is my cousin"'
            maxLength={400}
            className="flex-1 rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-2 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-cyan-400/40 focus:outline-none"
          />
          <button
            onClick={() => void submitStatement()}
            disabled={!statement.trim()}
            className="text-xs font-medium text-cyan-300 px-3.5 py-2 rounded-xl border border-cyan-400/25 bg-cyan-400/[0.08] hover:bg-cyan-400/[0.15] disabled:opacity-40"
          >
            Remember
          </button>
        </div>

        {needsName !== null && (
          <div className="flex gap-2 items-center">
            <span className="text-xs text-neutral-400">
              Who is your {needsName || "…"}?
            </span>
            <input
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              placeholder="Their name"
              maxLength={60}
              autoFocus
              className="flex-1 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-neutral-200 focus:border-cyan-400/40 focus:outline-none"
            />
            <button
              onClick={() => void submitStatement()}
              disabled={!nameInput.trim()}
              className="text-xs text-cyan-300 px-3 py-1.5 rounded-lg border border-cyan-400/25 bg-cyan-400/[0.08] disabled:opacity-40"
            >
              OK
            </button>
          </div>
        )}

        {rememberDraft && (
          <div className="rounded-xl border border-cyan-400/25 bg-cyan-400/[0.05] px-3.5 py-3 space-y-2">
            <p className="text-xs text-cyan-200">{rememberDraft.preview}</p>
            <div className="flex gap-2">
              <button
                onClick={() => void submitStatement(rememberDraft.token)}
                className="flex items-center gap-1.5 text-xs font-medium text-emerald-300 px-3 py-1.5 rounded-lg border border-emerald-400/25 bg-emerald-400/[0.1]"
              >
                <Check className="w-3 h-3" /> Yes, remember it
              </button>
              <button
                onClick={() => setRememberDraft(null)}
                className="flex items-center gap-1.5 text-xs text-neutral-400 px-3 py-1.5 rounded-lg border border-white/10"
              >
                <X className="w-3 h-3" /> No
              </button>
            </div>
          </div>
        )}
      </div>

      {/* People list */}
      {people.length === 0 ? (
        <p className="text-xs text-neutral-600 italic px-1">No people remembered yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {people.map((p) => {
            const account = accountFor(p);
            return (
              <li
                key={p.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.05] bg-white/[0.02] px-3.5 py-2.5"
              >
                <div className="min-w-0">
                  <p className="text-sm text-neutral-200 truncate">
                    {p.person_name}
                    <span className="text-neutral-500"> — {p.relationship}</span>
                  </p>
                  <p className="text-[10.5px] flex items-center gap-1 mt-0.5">
                    {p.access_level === "no_access" && !account ? (
                      <>
                        <ShieldCheck className="w-3 h-3 text-emerald-400" />
                        <span className="text-neutral-500">no system access</span>
                      </>
                    ) : (
                      <>
                        <ShieldAlert className="w-3 h-3 text-amber-400" />
                        <span className="text-amber-300">
                          access: {account?.role ?? p.access_level}
                          {account ? ` (@${account.username})` : ""}
                        </span>
                      </>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <button
                    onClick={() => setWizardFor(p)}
                    title="Grant access (requires your owner password)"
                    className="flex items-center gap-1 text-[11px] text-neutral-400 hover:text-cyan-300 px-2 py-1.5 rounded-lg border border-white/10 hover:border-cyan-400/30"
                  >
                    <UserPlus className="w-3 h-3" /> Access
                  </button>
                  <button
                    onClick={() => void startForget(p)}
                    title="Forget this person (asks for confirmation)"
                    className="text-neutral-600 hover:text-rose-400 p-1.5"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {forgetDraft && (
        <div className="rounded-xl border border-rose-400/25 bg-rose-400/[0.05] px-3.5 py-3 space-y-2">
          <p className="text-xs text-rose-200">{forgetDraft.draft.preview}</p>
          <div className="flex gap-2">
            <button
              onClick={() => void confirmForget()}
              className="text-xs font-medium text-rose-300 px-3 py-1.5 rounded-lg border border-rose-400/30 bg-rose-400/[0.1]"
            >
              Confirm forget
            </button>
            <button
              onClick={() => setForgetDraft(null)}
              className="text-xs text-neutral-400 px-3 py-1.5 rounded-lg border border-white/10"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Delegated accounts (active) */}
      {users.filter((u) => u.active).length > 0 && (
        <div className="pt-1">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-neutral-600 px-1 mb-1.5">
            Delegated accounts
          </p>
          <ul className="space-y-1.5">
            {users.filter((u) => u.active).map((u) => (
              <DelegatedUserRow key={u.id} user={u} token={token} onChanged={load} />
            ))}
          </ul>
        </div>
      )}

      {wizardFor && (
        <GrantWizard
          person={wizardFor}
          token={token}
          onClose={() => setWizardFor(null)}
          onDone={async () => {
            setWizardFor(null);
            await load();
          }}
        />
      )}
    </div>
  );
}

function DelegatedUserRow({
  user,
  token,
  onChanged,
}: {
  user: DelegatedUser;
  token: string;
  onChanged: () => Promise<void>;
}) {
  const [revoking, setRevoking] = useState(false);
  const [ownerPassword, setOwnerPassword] = useState("");
  const [draft, setDraft] = useState<ConfirmationDraft | null>(null);
  const [err, setErr] = useState("");

  const doRevoke = async (confirmToken?: string) => {
    setErr("");
    try {
      const res = await revokeAccess(token, user.id, ownerPassword, confirmToken);
      if ("status" in res && res.status === "confirmation_required") {
        setDraft(res);
      } else {
        setRevoking(false);
        setDraft(null);
        setOwnerPassword("");
        await onChanged();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Revoke failed");
    }
  };

  return (
    <li className="rounded-xl border border-white/[0.05] bg-white/[0.02] px-3.5 py-2.5 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-neutral-300 truncate">
          @{user.username} <span className="text-neutral-500">· {user.role}</span>
          {user.is_primary_owner && (
            <span className="text-cyan-300 ml-1">(primary owner — protected)</span>
          )}
        </p>
        {!user.is_primary_owner && (
          <button
            onClick={() => setRevoking((v) => !v)}
            className="text-[11px] text-neutral-500 hover:text-rose-400"
          >
            Revoke…
          </button>
        )}
      </div>
      {revoking && !draft && (
        <div className="flex gap-2 items-center">
          <KeyRound className="w-3 h-3 text-neutral-500" />
          <input
            type="password"
            value={ownerPassword}
            onChange={(e) => setOwnerPassword(e.target.value)}
            placeholder="Your owner password"
            className="flex-1 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-neutral-200 focus:border-rose-400/40 focus:outline-none"
          />
          <button
            onClick={() => void doRevoke()}
            disabled={!ownerPassword}
            className="text-xs text-rose-300 px-3 py-1.5 rounded-lg border border-rose-400/30 bg-rose-400/[0.08] disabled:opacity-40"
          >
            Continue
          </button>
        </div>
      )}
      {draft && (
        <div className="space-y-2">
          <p className="text-xs text-rose-200">{draft.preview}</p>
          <div className="flex gap-2">
            <button
              onClick={() => void doRevoke(draft.token)}
              className="text-xs font-medium text-rose-300 px-3 py-1.5 rounded-lg border border-rose-400/30 bg-rose-400/[0.1]"
            >
              Confirm revoke
            </button>
            <button
              onClick={() => {
                setDraft(null);
                setRevoking(false);
              }}
              className="text-xs text-neutral-400 px-3 py-1.5 rounded-lg border border-white/10"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {err && <p className="text-[11px] text-rose-300">{err}</p>}
    </li>
  );
}

function GrantWizard({
  person,
  token,
  onClose,
  onDone,
}: {
  person: Person;
  token: string;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [role, setRole] = useState("trusted_user");
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [ownerPassword, setOwnerPassword] = useState("");
  const [draft, setDraft] = useState<ConfirmationDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async (confirmToken?: string) => {
    setBusy(true);
    setErr("");
    try {
      const res = await grantAccess(token, {
        person_id: person.id,
        person_name: person.person_name,
        role,
        new_username: newUsername.trim().toLowerCase(),
        new_password: newPassword,
        owner_password: ownerPassword,
        confirm_token: confirmToken ?? null,
      });
      if ("status" in res && res.status === "confirmation_required") {
        setDraft(res);
      } else if ("granted" in res) {
        await onDone();
      }
    } catch (e) {
      setErr(
        e instanceof Error
          ? `${e.message} — check your owner password and the new account details.`
          : "Grant failed"
      );
      setDraft(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl border border-white/[0.1] bg-neutral-950 p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-amber-400" />
            Grant access — {person.person_name}
          </h4>
          <button onClick={onClose} className="text-neutral-600 hover:text-neutral-300">
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-[11px] text-neutral-500 leading-relaxed">
          This creates a <span className="text-neutral-300">separate account</span> with its own
          password. It requires <span className="text-neutral-300">your owner password</span> and a
          final confirmation. No role can remove or replace you, and risky actions stay
          confirmation-gated for everyone.
        </p>

        {!draft ? (
          <>
            <div className="space-y-1.5">
              {ROLES.map((r) => (
                <label
                  key={r.id}
                  className={clsx(
                    "flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 cursor-pointer",
                    role === r.id
                      ? "border-cyan-400/40 bg-cyan-400/[0.06]"
                      : "border-white/[0.07] bg-white/[0.02] hover:border-white/[0.15]"
                  )}
                >
                  <input
                    type="radio"
                    name="role"
                    checked={role === r.id}
                    onChange={() => setRole(r.id)}
                    className="mt-0.5 accent-cyan-400"
                  />
                  <span>
                    <span className="block text-xs text-neutral-200">{r.label}</span>
                    <span className="block text-[10.5px] text-neutral-600">{r.desc}</span>
                  </span>
                </label>
              ))}
            </div>

            <input
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              placeholder="New username (theirs)"
              maxLength={32}
              className="w-full rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-2 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-cyan-400/40 focus:outline-none"
            />
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="New password (set by them, min 8 chars)"
              maxLength={128}
              className="w-full rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-2 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-cyan-400/40 focus:outline-none"
            />
            <div className="pt-1 border-t border-white/[0.06]">
              <p className="text-[10.5px] text-neutral-500 mb-1.5 flex items-center gap-1">
                <KeyRound className="w-3 h-3" /> Security check — your owner password:
              </p>
              <input
                type="password"
                value={ownerPassword}
                onChange={(e) => setOwnerPassword(e.target.value)}
                placeholder="Owner password"
                className="w-full rounded-xl border border-amber-400/25 bg-amber-400/[0.03] px-3.5 py-2 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-amber-400/50 focus:outline-none"
              />
            </div>
            <button
              onClick={() => void submit()}
              disabled={busy || !newUsername.trim() || newPassword.length < 8 || !ownerPassword}
              className="w-full text-xs font-medium text-cyan-300 px-3.5 py-2.5 rounded-xl border border-cyan-400/25 bg-cyan-400/[0.08] hover:bg-cyan-400/[0.15] disabled:opacity-40"
            >
              {busy ? "Checking…" : "Review grant"}
            </button>
          </>
        ) : (
          <div className="space-y-2">
            <div className="rounded-xl border border-amber-400/25 bg-amber-400/[0.05] px-3.5 py-3">
              <p className="text-xs text-amber-200 leading-relaxed">{draft.preview}</p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => void submit(draft.token)}
                disabled={busy}
                className="flex-1 text-xs font-medium text-emerald-300 px-3.5 py-2 rounded-xl border border-emerald-400/25 bg-emerald-400/[0.1] disabled:opacity-40"
              >
                {busy ? "Granting…" : "Confirm — grant access"}
              </button>
              <button
                onClick={() => setDraft(null)}
                className="text-xs text-neutral-400 px-3.5 py-2 rounded-xl border border-white/10"
              >
                Back
              </button>
            </div>
          </div>
        )}

        {err && <p className="text-[11px] text-rose-300 leading-relaxed">{err}</p>}
      </div>
    </div>
  );
}
