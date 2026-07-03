"use client";

import { useState, useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import ChatInterface from "@/components/ChatInterface";
import VoiceOrb from "@/components/VoiceOrb";
import VoiceConsole from "@/components/VoiceConsole";
import Sidebar from "@/components/Sidebar";
import ResonanceGate from "@/components/gate/ResonanceGate";
import OrbDock from "@/components/orb/OrbDock";
import SystemBar from "@/components/nexus/SystemBar";
import VoiceCommandPanel from "@/components/nexus/VoiceCommandPanel";
import ExecutionTimeline from "@/components/nexus/ExecutionTimeline";
import AgentActivityPanel from "@/components/nexus/AgentActivityPanel";
import MemoryContextPanel from "@/components/nexus/MemoryContextPanel";
import PermissionConsole from "@/components/nexus/PermissionConsole";
import { useAuthStore, useUIStore, useChatStore } from "@/lib/store";
import { useGateStore } from "@/lib/gate/gateAuth";
import { useExecStore, useMemoryContextStore, useVoicePanelStore } from "@/lib/nexus";

export default function Home() {
  const { token, isAuthenticated, livekitToken, livekitUrl, setLivekitToken, logout } =
    useAuthStore();
  const { mode, setMode } = useUIStore();
  const { newSession, sessionId } = useChatStore();
  const gateUnlocked = useGateStore((s) => s.unlocked);
  const lockGate = useGateStore((s) => s.lock);

  // Fix #101: detect ?mode=voice from the PWA manifest shortcut
  const [autoVoice, setAutoVoice] = useState(false);
  // Gate → workspace handoff: while true the unlocked workspace is already
  // mounted but the gate stays alive on top, dissolving while its orb flies
  // to the OrbDock. Cleared by the gate once the flight lands.
  const [gateHandoff, setGateHandoff] = useState(false);
  // chatKey forces ChatInterface to remount (clears messages) on New Chat
  const [chatKey, setChatKey] = useState(0);
  // Right activity rail (voice / execution / agents / memory panels)
  const [railOpen, setRailOpen] = useState(true);

  useEffect(() => {
    // Fix #101: read ?mode=voice query param set by the PWA manifest shortcut
    // so the voice loop auto-connects when IRA is launched in voice mode.
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      if (params.get("mode") === "voice") setAutoVoice(true);
    }
  }, []);

  const fetchLivekitToken = useCallback(
    async (authToken: string) => {
      try {
        const res = await fetch("/api/v1/voice/token", {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        if (res.ok) {
          const data = await res.json();
          // Fix #97: use the URL returned by the server instead of a hardcoded
          // env var so the frontend works whether pointing at localhost, a LAN
          // IP, or a production domain without a Next.js rebuild.
          setLivekitToken(data.token ?? "", data.livekit_url ?? "");
        }
      } catch {
        console.warn("[IRA] LiveKit token fetch failed — voice disabled");
      }
    },
    [setLivekitToken]
  );

  useEffect(() => {
    // Zustand persist restores the token from sessionStorage on reload.
    if (token) void fetchLivekitToken(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleLogout = () => {
    logout(); // clears Zustand state; persist middleware removes from sessionStorage
    lockGate(); // relock the Awakening Gate
    useExecStore.getState().reset();
    useMemoryContextStore.getState().clear();
    useVoicePanelStore.getState().clear();
  };

  const handleNewChat = () => {
    newSession();
    setChatKey((k) => k + 1);
    useExecStore.getState().reset();
    useMemoryContextStore.getState().clear();
    useVoicePanelStore.getState().clear();
  };

  // The gate blocks everything until a real credential succeeds AND a core
  // session exists. No email/password login page — the gate owns entry.
  // During the unlock handoff both trees render: the workspace fades in
  // beneath while the gate dissolves on top and its orb flies to the dock.
  const showGate = !gateUnlocked || !isAuthenticated;

  const voiceTransport = (process.env.NEXT_PUBLIC_VOICE_TRANSPORT || "browser") === "livekit";
  const micControl = voiceTransport ? (
    <VoiceOrb
      livekitUrl={livekitUrl || process.env.NEXT_PUBLIC_LIVEKIT_URL || "ws://localhost:7880"}
      livekitToken={livekitToken}
      autoConnect={autoVoice}
    />
  ) : (
    <VoiceConsole token={token} sessionId={sessionId} />
  );

  return (
    <>
      {!showGate && (
      <motion.div
        className="h-screen flex overflow-hidden"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.9, ease: "easeOut" }}
      >
        {/* Collapsible sidebar */}
        <Sidebar mode={mode} onModeChange={setMode} onNewChat={handleNewChat} token={token} />

        {/* Main column: system bar + workspace */}
        <div className="flex-1 flex flex-col min-w-0">
          <SystemBar
            token={token}
            onToggleRail={() => setRailOpen((o) => !o)}
            right={
              <>
                {/* Single mount point for the mic transport — it owns the mic stream */}
                {micControl}
                <button
                  onClick={handleLogout}
                  className="text-xs text-neutral-500 hover:text-neutral-300 transition-colors px-2 py-1 rounded-lg hover:bg-white/[0.06]"
                >
                  Lock
                </button>
              </>
            }
          />

          <div className="flex-1 flex min-h-0">
            {/* Results workspace — the conversation and structured outputs */}
            <main className="relative flex-1 overflow-hidden min-w-0">
              <ChatInterface key={chatKey} sessionId={sessionId} token={token} mode={mode} />
              {/* The LivingOrb keeps its presence after the gate — floating
                  over the workspace, still riding the live mic through the
                  shared Pulse analyser. Clicking it focuses the command
                  input; everything around it stays click-through. */}
              <OrbDock size={116} />
            </main>

            {/* Activity rail: voice command, execution timeline, agents, memory */}
            {railOpen && (
              <aside className="hidden lg:flex w-72 xl:w-80 flex-col gap-3 p-3 overflow-y-auto border-l border-nexus-line bg-nexus-base/40 flex-shrink-0">
                <VoiceCommandPanel />
                <ExecutionTimeline />
                <AgentActivityPanel />
                <MemoryContextPanel />
              </aside>
            )}
          </div>
        </div>

        {/* Consent stops side-effecting actions until explicitly allowed */}
        <PermissionConsole />
      </motion.div>
      )}

      {(showGate || gateHandoff) && (
        <ResonanceGate
          onUnlocked={(t) => void fetchLivekitToken(t)}
          onHandoff={() => setGateHandoff(true)}
          onExited={() => setGateHandoff(false)}
        />
      )}
    </>
  );
}
