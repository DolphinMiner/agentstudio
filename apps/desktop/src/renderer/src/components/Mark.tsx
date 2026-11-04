// Marks: the official image of each service AgentStudio connects to (packages/brand),
// and Lucide icons for AgentStudio's own things (its sample agent, demo network,
// generic agent endpoints).

import a2a from "@agentstudio/brand/assets/a2a.png";
import acp from "@agentstudio/brand/assets/acp.png";
import chatgpt from "@agentstudio/brand/assets/chatgpt.png";
import cue from "@agentstudio/brand/assets/cue.png";
import grokbot from "@agentstudio/brand/assets/grokbot.png";
import hermes from "@agentstudio/brand/assets/hermes.png";
import matrix from "@agentstudio/brand/assets/matrix.png";
import muse from "@agentstudio/brand/assets/muse.jpg";
import museMark from "@agentstudio/brand/assets/muse-mark.png";
import openclaw from "@agentstudio/brand/assets/openclaw.png";
import { ConciergeBell, MessageCircle, Plug, Sparkles, type LucideIcon } from "lucide-react";

export type MarkId =
  | "grokbot"
  | "muse"
  | "muse-mark"
  | "dots"
  | "cue"
  | "hermes"
  | "openclaw"
  | "concierge"
  | "a2a"
  | "acp"
  | "endpoint"
  | "demo"
  | "agents"
  | "matrix";

/** Official images. `fill` images cover the tile; others sit on a white tile. */
const images: Partial<Record<MarkId, { src: string; fill?: boolean }>> = {
  grokbot: { src: grokbot, fill: true },
  muse: { src: muse, fill: true },
  "muse-mark": { src: museMark },
  dots: { src: chatgpt },
  cue: { src: cue },
  hermes: { src: hermes, fill: true },
  openclaw: { src: openclaw },
  a2a: { src: a2a },
  acp: { src: acp },
  matrix: { src: matrix },
};

/** Lucide glyphs on a tinted tile, for AgentStudio's own entries. */
const glyphs: Partial<Record<MarkId, { Icon: LucideIcon; bg: string; fg: string }>> = {
  concierge: { Icon: ConciergeBell, bg: "#f2a93b", fg: "#3b2504" },
  demo: { Icon: MessageCircle, bg: "#2e7d5b", fg: "#ffffff" },
  endpoint: { Icon: Plug, bg: "#e7ebf3", fg: "#3a4458" },
  agents: { Icon: Sparkles, bg: "#3247a8", fg: "#ffffff" },
};

export function Mark({ id, size = 44, src }: { id: MarkId; size?: number; /** A live image (e.g. the agent's own avatar) overrides the mark. */ src?: string | null }) {
  const radius = size * 0.28;
  const img = src ? { src, fill: true } : images[id];
  if (img) {
    return (
      <span className={`mark${img.fill ? " fill" : " tile"}`} style={{ width: size, height: size, borderRadius: radius }} aria-hidden>
        <img src={img.src} alt="" draggable={false} style={img.fill ? undefined : { width: size * 0.66, height: size * 0.66 }} />
      </span>
    );
  }
  const g = glyphs[id] ?? glyphs.agents!;
  return (
    <span className="mark" style={{ width: size, height: size, borderRadius: radius, background: g.bg, color: g.fg }} aria-hidden>
      <g.Icon size={size * 0.52} strokeWidth={1.9} />
    </span>
  );
}

export function markForNetwork(network: string): MarkId | null {
  if (network === "demo") return "demo";
  if (network === "matrix") return "matrix";
  return null;
}
