/**
 * Local intent heuristic for the Nexus voice/command panel.
 *
 * This runs entirely in the browser and is deliberately labeled "heuristic"
 * in the UI: it is a keyword classifier for display and routing hints, not
 * the backend router's decision. Confidence is the normalized keyword-match
 * weight, so a 0.9 here means "strong keyword signal", never a model score.
 */

export interface DetectedIntent {
  label: string;
  agentId: string; // matches AGENT_REGISTRY ids in lib/nexus.ts
  confidence: number; // 0..1, heuristic keyword weight
  suggestion: string;
  source: "heuristic";
}

interface Rule {
  label: string;
  agentId: string;
  suggestion: string;
  strong: RegExp; // weight 1.0 signals
  weak: RegExp; // weight 0.5 signals
}

const RULES: Rule[] = [
  {
    label: "Code task",
    agentId: "code",
    suggestion: "Route to the Code agent and open the results workspace",
    strong: /\b(refactor|debug|stack ?trace|compile|unit test|pull request|typescript|python|function|repo(sitory)?)\b/i,
    weak: /\b(code|bug|fix|build|error|file|script)\b/i,
  },
  {
    label: "Research query",
    agentId: "research",
    suggestion: "Run web research and return sources with confidence",
    strong: /\b(research|latest news|look up|search the web|deep ?search|compare sources)\b/i,
    weak: /\b(who|what is|when did|why|find|news|search)\b/i,
  },
  {
    label: "Memory recall",
    agentId: "memory",
    suggestion: "Query local memory for matching context",
    strong: /\b(remember|recall|what did i|last time|my notes?)\b/i,
    weak: /\b(note|memory|history|earlier|before)\b/i,
  },
  {
    label: "File operation",
    agentId: "file",
    suggestion: "Read the referenced file and summarize it",
    strong: /\b(open|read|summari[sz]e)\b.*\b(file|pdf|docx?|document)\b/i,
    weak: /\b(file|document|pdf|folder|attachment)\b/i,
  },
  {
    label: "Task / schedule",
    agentId: "router",
    suggestion: "Create a task — confirmation required before scheduling",
    strong: /\b(remind me|schedule|add (a )?task|calendar|tomorrow at)\b/i,
    weak: /\b(task|todo|deadline|meeting)\b/i,
  },
  {
    label: "Security check",
    agentId: "security",
    suggestion: "Run a read-only security review",
    strong: /\b(vulnerab|security scan|cve|exploit|audit)\b/i,
    weak: /\b(secure|password|leak|permission)\b/i,
  },
];

export function classifyIntent(text: string): DetectedIntent {
  const t = text.trim();
  let best: { rule: Rule; score: number } | null = null;
  for (const rule of RULES) {
    let score = 0;
    if (rule.strong.test(t)) score += 1;
    if (rule.weak.test(t)) score += 0.5;
    if (score > 0 && (!best || score > best.score)) best = { rule, score };
  }
  if (!best) {
    return {
      label: "General conversation",
      agentId: "router",
      confidence: 0.4,
      suggestion: "Answer directly with the local model",
      source: "heuristic",
    };
  }
  return {
    label: best.rule.label,
    agentId: best.rule.agentId,
    confidence: Math.min(0.95, 0.45 + best.score * 0.33),
    suggestion: best.rule.suggestion,
    source: "heuristic",
  };
}
