import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { buttonChoices } from "../src/main/connectors/choices";
import { cursorChecksum, grokHistory, parseEntry, widgetChoices } from "../src/main/connectors/grokbot";
import { callbackToken, historyOf, messageOf, confirmationChoices, CUE_DISMISS, questionChoices } from "../src/main/connectors/cue";
import { ConnectorHost } from "../src/main/connectors/host";
import { RECOVERY, recoveryStep } from "../src/main/connectors/recovery";
import { askPrompt, parseDrafts } from "../src/main/connectors/protocol";
import { decode, encode, type Schema } from "../src/main/connectors/proto";
import { UnknownApprovalError, type Connector } from "../src/main/connectors/types";

const json = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

describe("proto", () => {
  it("round-trips strings, int64, bools, bytes and repeated messages", () => {
    const schema: Schema = [
      { no: 1, name: "s", type: "string" },
      { no: 2, name: "n", type: "int64" },
      { no: 3, name: "b", type: "bool" },
      { no: 4, name: "raw", type: "bytes" },
      { no: 5, name: "items", type: "message", repeated: true, schema: [{ no: 1, name: "id", type: "string" }] },
    ];
    const msg = { s: "héllo 👋", n: 1762100000123, b: true, raw: Uint8Array.from([0, 255, 7]), items: [{ id: "a" }, { id: "b" }] };
    expect(decode(schema, encode(schema, msg))).toEqual(msg);
  });

  it("skips unknown fields", () => {
    const full: Schema = [
      { no: 1, name: "a", type: "string" },
      { no: 9, name: "z", type: "int64" },
    ];
    expect(decode([{ no: 1, name: "a", type: "string" }], encode(full, { a: "x", z: 5 }))).toEqual({ a: "x" });
  });
});

describe("grok bot transcript parsing", () => {
  it("reads assistant and user messages", () => {
    expect(parseEntry("message", json({ kind: "message", role: "assistant", content: "Hi!" }))).toEqual({ kind: "assistant", text: "Hi!" });
    expect(parseEntry("message", json({ kind: "message", role: "user", content: "hello" }))).toEqual({ kind: "user", text: "hello" });
    expect(parseEntry("send-message", json({ kind: "send-message", message: { type: "text", content: "Drafted." } }))).toEqual({
      kind: "assistant",
      text: "Drafted.",
    });
  });

  it("ignores streaming and unknown entries", () => {
    expect(parseEntry("message", json({ kind: "message", role: "assistant", content: "Hal", isStreaming: true })).kind).toBe("other");
    expect(parseEntry("tool-call", json({ kind: "tool-call", name: "browser" })).kind).toBe("other");
    expect(parseEntry("message", undefined).kind).toBe("other");
  });

  it("reads widgets with options", () => {
    const w = parseEntry("widget", json({ kind: "widget-options", prompt: "Send it?", options: [{ value: "y", label: "Send" }, "Later"] }));
    expect(w).toEqual({ kind: "widget", prompt: "Send it?", options: [{ value: "y", label: "Send" }, { value: "Later", label: "Later" }] });
  });

  it("reads the widget card inside a send-message entry", () => {
    const body = json({
      kind: "send-message",
      message: { type: "widget", widget: { prompt: "截哪台电脑的桌面？", options: [{ label: "Mac Mini", value: "mini" }, { label: "MacBook Air", value: "air" }] } },
    });
    expect(parseEntry("send-message", body)).toEqual({
      kind: "widget",
      prompt: "截哪台电脑的桌面？",
      options: [{ value: "mini", label: "Mac Mini" }, { value: "air", label: "MacBook Air" }],
    });
    // A widget without options is just a question in the chat.
    expect(parseEntry("send-message", json({ kind: "send-message", message: { type: "widget", widget: { prompt: "What's the budget?" } } }))).toEqual({
      kind: "assistant",
      text: "What's the budget?",
    });
  });

  it("announces what it can't show, keeps internal entries out, and reads the user's own messages", () => {
    expect(parseEntry("send-message", json({ kind: "send-message", message: { type: "visualization" } }))).toMatchObject({ kind: "notice", text: expect.stringContaining("chart") });
    expect(parseEntry("send-message", json({ kind: "send-message", message: { type: "attachment", name: "q3.pdf" } }))).toMatchObject({ kind: "notice", text: expect.stringContaining("q3.pdf") });
    expect(parseEntry("voice-call", json({ kind: "voice-call" }))).toMatchObject({ kind: "notice" });
    expect(parseEntry("tool-call", json({ kind: "tool-call", name: "search" }))).toEqual({ kind: "other" });
    expect(parseEntry("feedback", json({ kind: "feedback", content: "thumbs up" }))).toEqual({ kind: "other" });
    expect(parseEntry("hologram", json({ kind: "hologram" }))).toMatchObject({ kind: "notice", text: expect.stringContaining("can't show") });
    expect(parseEntry("message", json({ kind: "message", role: "user", content: "from my phone" }))).toEqual({ kind: "user", text: "from my phone" });
  });

  it("reads every kind of entry seen in real transcripts (scrubbed recording)", () => {
    const { entries } = fixture("grok-entries.json") as { entries: { entry_kind: string; body: unknown }[] };
    const kinds = entries.map((e) => {
      const b = e.body as { message?: { type?: string }; role?: string };
      return [`${e.entry_kind}:${b.message?.type ?? b.role}`, parseEntry(e.entry_kind, json(e.body)).kind];
    });
    // Nothing real falls into "AgentStudio can't show this".
    for (const [k, parsed] of kinds) expect([k, parsed]).not.toEqual([k, "notice"]);
    expect(Object.fromEntries(kinds)).toMatchObject({
      "send-message:text": "assistant",
      "message:user": "user",
      // Answered or skipped in Grok Bot already; an "always" permission needs nothing.
      "send-message:widget": "other",
      "send-message:local-tool-permission": "other",
    });
    // A pending permission request is announced; AgentStudio's own message is recognised by its nonce.
    const ask = { kind: "send-message", message: { type: "local-tool-permission", ask: { action: "run a command", status: "pending" } }, timestampMs: 1762200000000 };
    expect(parseEntry("send-message", json(ask))).toMatchObject({ kind: "notice", text: expect.stringContaining("run a command"), ts: 1762200000000 });
    expect(parseEntry("message", json({ kind: "message", role: "user", content: "hi", clientNonce: "n-1" }))).toEqual({ kind: "user", text: "hi", nonce: "n-1" });
  });

  it("imports the last chat entries as history", () => {
    const entries = [
      { seq: 2, entry_kind: "message", body: json({ kind: "message", role: "assistant", content: "Revenue was up 12%." }) },
      { seq: 1, entry_kind: "message", body: json({ kind: "message", role: "user", content: "How did last quarter go?" }) },
      { seq: 3, entry_kind: "tool-call", body: json({ kind: "tool-call" }) },
    ];
    expect(grokHistory(entries)).toEqual([
      { type: "message", text: "How did last quarter go?", from_user: true, via: "Grok Bot", history: true },
      { type: "message", text: "Revenue was up 12%.", history: true },
    ]);
  });

  it("maps widget options to approval choices with a deny", () => {
    expect(widgetChoices([{ value: "send", label: "Send it" }, { value: "hold", label: "Don't send" }])).toEqual([
      { key: "send", label: "Send it", category: "approve" },
      { key: "hold", label: "Don't send", category: "deny" },
    ]);
    const picked = widgetChoices([{ value: "a", label: "Option A" }, { value: "b", label: "Option B" }]);
    expect(picked.map((c) => c.category)).toEqual(["approve", "approve", "deny"]);
    expect(picked[2]!.label).toBe("Dismiss");
  });

  it("builds the client checksum like Grok Bot does", () => {
    const now = 1_762_100_000_000;
    const t = Math.floor(now / 1e6);
    const bytes = [0, 0, (t >>> 24) & 255, (t >>> 16) & 255, (t >>> 8) & 255, t & 255];
    let k = 165;
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = ((bytes[i]! ^ k) + (i % 256)) & 255;
      k = bytes[i]!;
    }
    expect(cursorChecksum("machine", now)).toBe(Buffer.from(bytes).toString("base64url") + "machine");
  });
});

describe("page buttons", () => {
  it("needs both a yes and a no", () => {
    expect(buttonChoices(["Approve", "Deny"])).toEqual([
      { key: "b0", label: "Approve", category: "approve" },
      { key: "b1", label: "Deny", category: "deny" },
    ]);
    expect(buttonChoices(["Copy", "Share"])).toBeNull();
    expect(buttonChoices(["Approve"])).toBeNull();
    expect(buttonChoices(["Copy", "Book", "Not now"])).toEqual([
      { key: "b1", label: "Book", category: "approve" },
      { key: "b2", label: "Not now", category: "deny" },
    ]);
  });
});

describe("asks", () => {
  it("prompts for numbered drafts and parses them back", () => {
    const p = askPrompt({ task_id: "t", app: "Demo", chat: "Leo", request: "", lines: [{ speaker: "Leo", own: false, ts: 0, text: "7:15?" }] });
    expect(p).toContain("Draft a reply for this conversation with Leo on Demo");
    expect(p).toContain("Leo: 7:15?");
    expect(parseDrafts('Sure:\n1. "Yes!"\n2) Maybe\n- No')).toEqual(["Yes!", "Maybe", "No"]);
    expect(parseDrafts("Just one.")).toEqual(["Just one."]);
  });
});

describe("connector host", () => {
  let host: ConnectorHost | null = null;
  afterEach(async () => {
    await host?.close();
    host = null;
  });

  it("serves the agent protocol per instance, with its own token", async () => {
    const events: unknown[] = [];
    const sent: string[] = [];
    const connector: Connector = {
      info: () => ({ name: "Fake", capabilities: ["chat"], protocol: "agentstudio-agent/0" }),
      start: async () => {},
      stop: async () => {},
      send: async (m) => {
        sent.push(m.text);
      },
      decide: async (id) => {
        if (id !== "known") throw new UnknownApprovalError();
      },
      state: () => ({ status: "ready" }),
      serialize: () => ({}),
    };
    host = new ConnectorHost(0);
    await host.listen();
    const emitter = host.add({ id: "inst1", token: "secret-token", connector });
    const url = host.urlFor("inst1") + "/agentstudio/v0";
    const auth = { Authorization: "Bearer secret-token", "Content-Type": "application/json" };

    expect((await fetch(url + "/info")).status).toBe(401);
    expect((await fetch(url + "/info", { headers: { Authorization: "Bearer nope" } })).status).toBe(401);
    expect(await (await fetch(url + "/info", { headers: auth })).json()).toMatchObject({ name: "Fake", protocol: "agentstudio-agent/0" });

    // A tiny callback receiver stands in for the agents bridge.
    const { createServer } = await import("node:http");
    const cb = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        events.push({ auth: req.headers.authorization, path: req.url, body: JSON.parse(body) });
        res.end("{}");
      });
    });
    await new Promise<void>((r) => cb.listen(0, "127.0.0.1", () => r()));
    const cbPort = (cb.address() as { port: number }).port;
    try {
      const s = await fetch(url + "/sessions", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ callback_url: `http://127.0.0.1:${cbPort}/cb`, callback_token: "cb-token" }),
      });
      const { session_id } = (await s.json()) as { session_id: string };
      const m = await fetch(url + "/messages", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ session_id, message_id: "m1", text: "hi", sent_at: new Date().toISOString() }),
      });
      expect(m.status).toBe(202);
      // Opening a session sends the agent's current profile (the bridge may hold an old avatar).
      await expect.poll(() => events.length).toBe(1);
      expect(events[0]).toMatchObject({ auth: "Bearer cb-token", path: "/cb/events", body: { type: "profile", name: "Fake" } });
      emitter.emit({ type: "message", text: "hello back" });
      await expect.poll(() => events.length).toBe(2);
      expect(events[1]).toEqual({ auth: "Bearer cb-token", path: "/cb/events", body: { type: "message", text: "hello back" } });
      await expect.poll(() => sent).toEqual(["hi"]);

      const dec = (id: string) =>
        fetch(`${url}/approvals/${id}/decision`, { method: "POST", headers: { ...auth, "X-AgentStudio-Session": session_id }, body: JSON.stringify({ choice: "ok" }) });
      expect((await dec("known")).status).toBe(200);
      expect((await dec("other")).status).toBe(404);
      expect((await fetch(host.urlFor("missing") + "/agentstudio/v0/info", { headers: auth })).status).toBe(404);
    } finally {
      cb.close();
    }
  });

  it("keeps the bridge's session across a restart: events go out without waiting for the bridge", async () => {
    const events: unknown[] = [];
    const { createServer } = await import("node:http");
    const cb = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        events.push({ auth: req.headers.authorization, body: JSON.parse(body) });
        res.end("{}");
      });
    });
    await new Promise<void>((r) => cb.listen(0, "127.0.0.1", () => r()));
    const cbPort = (cb.address() as { port: number }).port;
    const connector: Connector = {
      info: () => ({ name: "Fake", capabilities: ["chat"], protocol: "agentstudio-agent/0" }),
      start: async () => {},
      stop: async () => {},
      send: async () => {},
      decide: async () => {},
      state: () => ({ status: "ready" }),
      serialize: () => ({}),
    };
    const changes: unknown[] = [];
    try {
      host = new ConnectorHost(0, undefined, (id, s) => changes.push([id, s?.id ?? null]));
      await host.listen();
      const saved = { id: "ses_saved", callbackUrl: `http://127.0.0.1:${cbPort}/cb`, callbackToken: "cb-saved" };
      const emitter = host.add({ id: "inst2", token: "t2", connector, session: saved });
      emitter.emit({ type: "message", text: "while you were away" });
      await expect.poll(() => events.length).toBe(1);
      expect(events[0]).toEqual({ auth: "Bearer cb-saved", body: { type: "message", text: "while you were away" } });

      // A new session from the bridge is reported, so the app can keep it; so is its end.
      const auth = { Authorization: "Bearer t2", "Content-Type": "application/json" };
      const url = host.urlFor("inst2") + "/agentstudio/v0";
      await fetch(url + "/sessions", { method: "POST", headers: auth, body: JSON.stringify({ callback_url: saved.callbackUrl, callback_token: "cb-new", session_id: "ses_new" }) });
      await fetch(url + "/sessions/ses_new", { method: "DELETE", headers: auth });
      expect(changes).toEqual([
        ["inst2", "ses_new"],
        ["inst2", null],
      ]);
    } finally {
      cb.close();
    }
  });
});


describe("cue", () => {
  it("turns a question's options into choices, with a way out", () => {
    const c = questionChoices(["Mac Mini", "MacBook Air"]);
    expect(c.map((x) => x.label)).toEqual(["Mac Mini", "MacBook Air", "Answer in Cue"]);
    expect(c[2]).toMatchObject({ key: CUE_DISMISS, category: "deny" });
    expect(questionChoices(["Yes", "No"]).map((x) => x.category)).toEqual(["approve", "deny"]);
  });

  it("maps action confirmations to inputs", () => {
    const gmail = confirmationChoices({
      waiting_for_event_id: "e1",
      waiting_for_event_type: "gmailSendAction",
      confirm_input_schema: { properties: { accept: { type: "boolean" }, save_draft: { type: "boolean" } } },
    })!;
    expect(gmail.choices.map((c) => c.label)).toEqual(["Approve", "Deny"]);
    expect(gmail.inputs).toEqual({ accept: { accept: true }, reject: { accept: false } });

    const credits = confirmationChoices({
      waiting_for_event_id: "e2",
      confirm_input_schema: { properties: { action: { type: "string", enum: ["accept", "reject", "do_not_show_again"] } } },
    })!;
    expect(credits.inputs.reject).toEqual({ action: "reject" });
    expect(credits.choices.find((c) => c.key === "reject")?.category).toBe("deny");

    // A schema AgentStudio can't fill is left for the Cue app.
    expect(confirmationChoices({ waiting_for_event_id: "e3", confirm_input_schema: { properties: { selectedAccountIds: { type: "array" } } } })).toBeNull();
  });

  it("reads the session token from the sign-in callback, for this sign-in only", () => {
    const nonce = "a".repeat(64);
    expect(callbackToken(`cuedev://oauth/desktop-callback?nonce=${nonce}&token=tok123`, nonce)).toEqual({ token: "tok123" });
    expect(callbackToken(`cuedev://oauth/desktop-callback?nonce=${"b".repeat(64)}&token=tok123`, nonce)).toBeNull();
    expect(callbackToken(`cuedev://oauth/desktop-callback?nonce=${nonce}&error=denied`, nonce)).toEqual({ error: true });
    expect(callbackToken(`cuedev://billing/return`, nonce)).toBeNull();
    expect(callbackToken(`https://manus.im/login-success?nonce=${nonce}&token=x`, nonce)).toBeNull();
  });

  it("brings an answer's files over, and shows what the user said in the Cue app", () => {
    const answer = { id: "e1", type: "assistant_message", timestamp: 1, assistant_message: { content: "Here it is.", attachments: [{ type: "image", filename: "chart.png", url: "https://x/c.png", content_type: "image/png" }, { type: "file", url: "file:///nope" }] } };
    expect(messageOf(answer)).toEqual({ type: "message", text: "Here it is.", attachments: [{ url: "https://x/c.png", name: "chart.png", mime_type: "image/png" }] });
    expect(messageOf({ id: "e2", type: "user_message", timestamp: 2, user_message: { content: "from my phone" } })).toEqual({ type: "message", text: "from my phone", from_user: true, via: "Cue" });
    expect(messageOf({ id: "e3", type: "status_update", timestamp: 3, status_update: { agent_status: "running" } })).toBeNull();
  });

  it("imports the last messages as history, with their times", () => {
    const events = Array.from({ length: 30 }, (_, i) => ({ id: `e${i}`, type: i % 2 ? "assistant_message" : "user_message", timestamp: Date.UTC(2026, 10, 1) + i * 1000, [i % 2 ? "assistant_message" : "user_message"]: { content: `m${i}` } }));
    const h = historyOf(events as never);
    expect(h).toHaveLength(20);
    expect(h[0]).toMatchObject({ text: "m10", history: true, from_user: true, ts: new Date(Date.UTC(2026, 10, 1) + 10_000).toISOString() });
    expect(h[19]).toMatchObject({ text: "m29", history: true });
    expect(h[19]!.from_user).toBeUndefined();
  });
});

describe("web-chat recovery", () => {
  const healthy = { problemSince: null, tickErrors: 0, broken: null, attempts: 0, lastAttemptAt: 0 };
  it("leaves a healthy page alone, and waits out a short problem", () => {
    expect(recoveryStep(healthy, 1_000_000)).toBe("ok");
    expect(recoveryStep({ ...healthy, problemSince: 1_000_000 - RECOVERY.graceMs + 1 }, 1_000_000)).toBe("wait");
    expect(recoveryStep({ ...healthy, tickErrors: RECOVERY.maxTickErrors - 1 }, 1_000_000)).toBe("wait");
  });
  it("reloads once a problem lasts, the page crashed, or it keeps failing", () => {
    expect(recoveryStep({ ...healthy, problemSince: 1_000_000 - RECOVERY.graceMs }, 1_000_000)).toBe("reload");
    expect(recoveryStep({ ...healthy, broken: "page crashed (oom)" }, 1_000_000)).toBe("reload");
    expect(recoveryStep({ ...healthy, tickErrors: RECOVERY.maxTickErrors }, 1_000_000)).toBe("reload");
  });
  it("backs off between reloads", () => {
    const broken = { ...healthy, broken: "page didn't load", attempts: 2, lastAttemptAt: 1_000_000 };
    expect(recoveryStep(broken, 1_000_000 + RECOVERY.backoffMs[1]! - 1)).toBe("wait");
    expect(recoveryStep(broken, 1_000_000 + RECOVERY.backoffMs[1]!)).toBe("reload");
    // Never longer than the last step.
    expect(recoveryStep({ ...broken, attempts: 50 }, 1_000_000 + RECOVERY.backoffMs.at(-1)!)).toBe("reload");
  });
});
