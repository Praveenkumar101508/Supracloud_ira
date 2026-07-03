import type { PulseState } from "@/lib/nexus";
import type { OrbState } from "./LivingOrb";

/**
 * Map the app-wide Pulse vocabulary (driven by the voice loop, chat stream
 * and permission console) onto the LivingOrb's visual states.
 */
export function orbStateFromPulse(state: PulseState): OrbState {
  switch (state) {
    case "listening":
      return "listening";
    case "understanding":
    case "thinking":
    case "acting":
      return "thinking";
    case "speaking":
      return "speaking";
    case "permission":
      return "warning";
    case "completed":
      return "success";
    case "error":
      return "error";
    case "idle":
    default:
      return "idle";
  }
}
