import { describe, expect, it } from "vitest";
import { agentBadge, agentMark } from "../src/renderer/src/lib/logic";

const agent = (name: string, description?: string) => ({ connection_id: "agentstudio-agents:x", name, description });

describe("agent marks", () => {
  it("recognizes well-known protocol agents by name or description", () => {
    expect(agentMark(agent("Hermes Agent"), [])).toBe("hermes");
    expect(agentMark(agent("My helper", "A Hermes agent on my server"), [])).toBe("hermes");
    expect(agentMark(agent("OpenClaw"), [])).toBe("openclaw");
    expect(agentMark(agent("Open Claw gateway"), [])).toBe("openclaw");
    expect(agentBadge(agent("OpenClaw"), [])).toBe("openclaw");
  });
  it("leaves other agents alone", () => {
    expect(agentMark(agent("Concierge"), [])).toBe("concierge");
    expect(agentMark(agent("Hermeszone"), [])).toBeNull();
    expect(agentMark(agent("A2A Echo"), [])).toBeNull();
  });
  it("prefers the local service", () => {
    const local = [{ connectionId: "agentstudio-agents:x", service: "grokbot" }] as Parameters<typeof agentMark>[1];
    expect(agentMark(agent("Hermes"), local)).toBe("grokbot");
  });
});
