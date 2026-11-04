// Mapping an agent page's buttons to approval choices. Pure, so it is unit-tested.

import type { Choice } from "./protocol";

const APPROVE = /^(approve|allow|yes|book|confirm|accept|continue|send|buy|pay|proceed|ok|go ahead|run)\b/i;
const DENY = /^(deny|reject|no|don'?t|do not|decline|cancel|skip|not now|stop|dismiss)\b/i;
/** Choice key for "open the service so the user can answer there". */
export const OPEN = "__agentstudio_open";

/** Choices for an agent message's buttons, or null when they don't read as a yes/no decision. */
export function buttonChoices(labels: string[]): Choice[] | null {
  const choices: Choice[] = [];
  for (const [i, label] of labels.entries()) {
    const category = APPROVE.test(label) ? "approve" : DENY.test(label) ? "deny" : null;
    if (category) choices.push({ key: `b${i}`, label, category });
  }
  if (!choices.some((c) => c.category === "approve") || !choices.some((c) => c.category === "deny")) return null;
  return choices.slice(0, 4);
}
