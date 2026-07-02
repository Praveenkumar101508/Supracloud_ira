"use client";

/**
 * Memory context — only the memories/files/sources the CURRENT task actually
 * used. Honest empty state; no constellation of unrelated memories.
 */

import { FileText, MessageSquare, Globe, Sparkles } from "lucide-react";
import { useMemoryContextStore, type MemoryItem } from "@/lib/nexus";

const KIND_ICON: Record<MemoryItem["kind"], React.ReactNode> = {
  file: <FileText className="w-3 h-3 text-pink-300" />,
  session: <MessageSquare className="w-3 h-3 text-neutral-500" />,
  source: <Globe className="w-3 h-3 text-blue-300" />,
  memory: <Sparkles className="w-3 h-3 text-violet-300" />,
};

export default function MemoryContextPanel() {
  const items = useMemoryContextStore((s) => s.items);

  return (
    <section className="nx-card p-3.5">
      <h3 className="text-[11px] font-semibold tracking-wide uppercase text-neutral-500 mb-2.5">
        Memory in use
      </h3>
      {items.length === 0 ? (
        <p className="text-[11.5px] text-neutral-600">No memory used in this task yet.</p>
      ) : (
        <ul className="space-y-2">
          {items.map((m, i) => (
            <li key={`${m.kind}-${m.label}-${i}`} className="flex items-start gap-2">
              <span className="mt-0.5 flex-shrink-0">{KIND_ICON[m.kind]}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11.5px] text-neutral-300 truncate">{m.label}</span>
                  {m.relevance !== undefined && (
                    <span className="nx-mono text-[9px] text-violet-300/80 flex-shrink-0">
                      {(m.relevance * 100) | 0}%
                    </span>
                  )}
                </div>
                {m.note && <p className="text-[10px] text-neutral-600 truncate">{m.note}</p>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
