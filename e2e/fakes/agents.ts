// Fake services for the desktop connector e2e tests (one server, 127.0.0.1:18410):
//
//   /grok/web/loginDeepControl  the browser sign-in page (visiting it "signs in")
//   /grok/api/...               Grok Bot's backend: /auth/poll, /oauth/token and
//                               aiserver.v1.GrokBotService RPCs in protobuf
//   /muse/                      a Muse-like chat page (markup as the Muse driver expects)
//   /dots/                      a ChatGPT-like chat page (classic markup, contenteditable composer)
//
// Each fake is deterministic; see the keyword handling below. Run with
// `node e2e/fakes/agents.ts` (Node strips the types).

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// Real-looking pictures for avatars (any image will do; these ship with the repo).
const IMG = {
  bot: readFileSync(new URL("../../packages/brand/assets/a2a.png", import.meta.url)),
  persona: readFileSync(new URL("../../packages/brand/assets/muse.jpg", import.meta.url)),
};
import { decode, encode, type Schema } from "../../apps/desktop/src/main/connectors/proto.ts";

const PORT = Number(process.env.FAKE_AGENTS_PORT ?? 18410);

// ---- Grok Bot ---------------------------------------------------------------------

const Agent: Schema = [
  { no: 1, name: "id", type: "string" },
  { no: 3, name: "name", type: "string" },
  { no: 6, name: "avatar_shape", type: "string" },
  { no: 7, name: "avatar_color", type: "string" },
  { no: 9, name: "avatar_url", type: "string" },
  { no: 12, name: "agent_id", type: "string" },
  { no: 18, name: "viewer_session_id", type: "string" },
];
const Entry: Schema = [
  { no: 1, name: "seq", type: "int64" },
  { no: 2, name: "entry_kind", type: "string" },
  { no: 3, name: "body", type: "bytes" },
  { no: 5, name: "updated_seq", type: "int64" },
  { no: 6, name: "entry_id", type: "string" },
];
const Send: Schema = [
  { no: 1, name: "agent_id", type: "string" },
  { no: 3, name: "text", type: "string" },
  { no: 15, name: "session_id", type: "string" },
];
const ListEntries: Schema = [{ no: 1, name: "agent_id", type: "string" }];
const Widget: Schema = [
  { no: 1, name: "agent_id", type: "string" },
  { no: 2, name: "entry_id", type: "string" },
  { no: 3, name: "value", type: "string" },
];

const approved = new Map<string, string>(); // uuid -> challenge
const revoked = new Set<string>(); // logins signed out on the service
const transcripts = new Map<string, { seq: number; kind: string; body: object; id: string }[]>();
let seq = 0;

function addEntry(agent: string, kind: string, body: object, delayMs = 0) {
  setTimeout(() => {
    const list = transcripts.get(agent) ?? [];
    seq++;
    list.push({ seq, kind, body, id: `e${seq}` });
    transcripts.set(agent, list);
  }, delayMs);
}

function grokReply(agent: string, text: string) {
  const t = text.toLowerCase();
  if (t.includes("numbered list")) {
    addEntry(agent, "message", { kind: "message", role: "assistant", content: "1. Sounds good to me!\n2. Let me check my calendar.\n3. Can we push to 8?" }, 300);
  } else if (t.includes("report")) {
    addEntry(agent, "message", { kind: "message", role: "assistant", content: "The weekly report is ready." }, 200);
    // Grok Bot's card: a send-message entry carrying a widget.
    addEntry(agent, "send-message", { kind: "send-message", message: { type: "widget", widget: { prompt: "Send the weekly report to the team?", options: [{ value: "send", label: "Send it" }, { value: "hold", label: "Don't send" }] } } }, 400);
  } else if (t.includes("calendar")) {
    addEntry(agent, "message", { kind: "message", role: "assistant", content: "Tomorrow you have:\n\n• 10:00 design review\n• 13:00 lunch with Leo\n• 16:30 dentist\n\nWant me to prepare the weekly report before the review?" }, 600);
  } else if (t.includes("sign me out")) {
    // The account is signed out on Grok Bot's side: every bot of it needs a new sign-in.
    setTimeout(() => revoked.add(agent.split("/")[0]!), 200);
  } else if (t.includes("chart")) {
    // Something AgentStudio can't show yet: it says so instead of dropping it.
    addEntry(agent, "send-message", { kind: "send-message", message: { type: "visualization", spec: {} } }, 300);
  } else if (t.includes("phone")) {
    // The user also writes in Grok Bot's own app.
    addEntry(agent, "message", { kind: "message", role: "user", content: "Sent from the Grok Bot app" }, 300);
  } else {
    addEntry(agent, "message", { kind: "message", role: "assistant", content: `Grok echo: ${text}` }, 300);
  }
}

async function grok(req: IncomingMessage, res: ServerResponse, path: string, url: URL) {
  if (path === "/web/loginDeepControl") {
    approved.set(url.searchParams.get("uuid") ?? "", url.searchParams.get("challenge") ?? "");
    return html(res, "<h1>Signed in to Grok Bot (fake)</h1><p>You can close this window.</p>");
  }
  if (path === "/api/auth/poll") {
    const challenge = approved.get(url.searchParams.get("uuid") ?? "");
    const verifier = url.searchParams.get("verifier") ?? "";
    if (!challenge) return text(res, 404, "not yet");
    if (createHash("sha256").update(verifier).digest("base64url") !== challenge) return text(res, 403, "bad verifier");
    // Tokens carry the login uuid, so parallel tests never share a transcript.
    const id = url.searchParams.get("uuid");
    return json(res, 200, { accessToken: `fake-access-${id}`, refreshToken: `fake-refresh-${id}`, authId: `user-${id}` });
  }
  if (path === "/api/oauth/token") {
    const b = JSON.parse(new TextDecoder().decode(await readBody(req)) || "{}") as { refresh_token?: string };
    const id = (b.refresh_token ?? "").replace(/^fake-refresh-/, "");
    if (revoked.has(id)) return json(res, 401, { error: "invalid_grant", shouldLogout: true });
    return json(res, 200, { access_token: `fake-access-${id}`, refresh_token: `fake-refresh-${id}` });
  }

  const m = /^\/api\/aiserver\.v1\.GrokBotService\/(\w+)$/.exec(path);
  if (!m || req.method !== "POST") return text(res, 404, "not found");
  const login = /^Bearer fake-access-(.+)$/.exec(req.headers.authorization ?? "")?.[1];
  if (!login || revoked.has(login)) return json(res, 401, { code: "unauthenticated", message: "bad token" });
  if (req.headers["x-cursor-client-type"] !== "sand" || !req.headers["x-cursor-checksum"]) return json(res, 400, { code: "invalid_argument", message: "missing client headers" });
  const body = await readBody(req);
  switch (m[1]) {
    case "ListGrokBotAgents":
      return proto(res, [{ no: 1, name: "agents", type: "message", repeated: true, schema: Agent }], {
        agents: [
          // Like the live service: `id` is shared, agent_id is each bot's own id.
          // The README media (e2e/media) draws this one like Grok Bot does, instead of a photo.
          process.env.FAKE_AGENTS_MEDIA
            ? { id: "4518670", agent_id: "bot-main", name: "Grok Helper", viewer_session_id: "sess-main", avatar_shape: "blob", avatar_color: "orange" }
            : { id: "4518670", agent_id: "bot-main", name: "Grok Helper", viewer_session_id: "sess-main", avatar_url: `http://127.0.0.1:${PORT}/img/bot.png` },
          { id: "4518670", agent_id: "bot-sales", name: "Sales Bot", viewer_session_id: "sess-sales", avatar_shape: "cloud", avatar_color: "violet" },
        ],
      });
    case "SendGrokBotUserMessage": {
      const r = decode(Send, body);
      const agent = `${login}/${String(r.agent_id)}`;
      addEntry(agent, "message", { kind: "message", role: "user", content: String(r.text) });
      grokReply(agent, String(r.text));
      return proto(res, [{ no: 1, name: "dispatched", type: "bool" }], { dispatched: true });
    }
    case "ListGrokBotTranscriptEntries": {
      const r = decode(ListEntries, body);
      const key = `${login}/${String(r.agent_id)}`;
      // Sales Bot already has a conversation: it comes over as history on connect.
      if (!transcripts.has(key) && String(r.agent_id) === "bot-sales") {
        transcripts.set(key, [
          { seq: ++seq, kind: "message", body: { kind: "message", role: "user", content: "How did last quarter go?" }, id: `e${seq}` },
          { seq: ++seq, kind: "message", body: { kind: "message", role: "assistant", content: "Revenue was up 12%." }, id: `e${seq}` },
        ]);
      }
      const list = transcripts.get(key) ?? [];
      return proto(res, [{ no: 1, name: "entries", type: "message", repeated: true, schema: Entry }], {
        entries: list.map((e) => ({ seq: e.seq, entry_kind: e.kind, body: new TextEncoder().encode(JSON.stringify(e.body)), updated_seq: e.seq, entry_id: e.id })),
      });
    }
    case "RespondGrokBotWidget": {
      const r = decode(Widget, body);
      addEntry(`${login}/${String(r.agent_id)}`, "message", { kind: "message", role: "assistant", content: r.value === "send" ? "Sent the report to the team." : "Okay, holding the report." }, 200);
      return proto(res, [{ no: 1, name: "accepted", type: "bool" }], { accepted: true });
    }
    case "DismissGrokBotWidget":
      return proto(res, [], {});
  }
  return json(res, 404, { code: "unimplemented", message: "unknown method" });
}

// ---- Muse and Dots pages ----------------------------------------------------------------

const LOGIN_PAGE = (cookie: string, title: string) => `<!doctype html><html><head><title>${title}</title></head><body>
<h1>${title}</h1><button id="login" onclick="document.cookie='${cookie}=1; path=/'; location.reload()">Log in</button></body></html>`;

const MUSE_PAGE = `<!doctype html><html><head><title>Chat — Black</title>
<style>body{font-family:sans-serif;margin:0} [role=log]{height:600px;overflow:auto;padding:12px} .hatch-chat-groupable-bubble{padding:6px;margin:4px 0;border:1px solid #ccc}</style>
</head><body>
<header><img alt="Black" src="/muse/persona.jpg" width="48" height="48"></header>
<div role="log" aria-label="Chat messages" id="log"></div>
<form id="f" onsubmit="return false"><textarea aria-label="Message" id="t"></textarea><button type="button" aria-label="Send" id="send">Send</button></form>
<script>
let n = 0;
const PAGE_LOAD = Date.now().toString(36);
const log = document.getElementById('log');
function connectionError() {
  const d = document.createElement('div');
  d.setAttribute('role', 'status');
  d.textContent = 'Connection error';
  document.body.prepend(d);
}
{
  const left = Number(localStorage.getItem('fakeDroppedLoads') || 0);
  if (left > 0) { localStorage.setItem('fakeDroppedLoads', String(left - 1)); connectionError(); }
}
function add(role, text, buttons) {
  const item = document.createElement('div');
  item.setAttribute('data-message-item', '');
  item.setAttribute('data-message-id', 'mm' + PAGE_LOAD + '-' + (++n)); // unique across reloads, like real message ids
  item.setAttribute('data-message-role', role);
  const inner = document.createElement('div');
  const bubble = document.createElement('div');
  bubble.className = 'hatch-chat-groupable-bubble';
  const prose = document.createElement('div');
  prose.className = 'prose';
  prose.textContent = text;
  bubble.appendChild(prose);
  inner.appendChild(bubble);
  item.appendChild(inner);
  if (role === 'assistant') {
    // Real Muse puts a message menu on every reply; it is chrome, not a decision.
    const more = document.createElement('button');
    more.setAttribute('aria-label', 'More options');
    more.textContent = '…';
    item.appendChild(more);
  }
  for (const [label, reply] of buttons || []) {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = () => { item.querySelectorAll('button').forEach((x) => x.remove()); later(reply); };
    item.appendChild(b);
  }
  log.appendChild(item);
  return { item, inner, prose };
}
function later(text, buttons) {
  const { inner, prose } = add('assistant', '');
  inner.setAttribute('aria-busy', 'true');
  setTimeout(() => { prose.textContent = text.slice(0, 5); }, 150);
  setTimeout(() => {
    inner.removeAttribute('aria-busy');
    prose.textContent = text;
    const item = inner.parentElement;
    for (const [label, reply] of buttons || []) {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = () => { item.querySelectorAll('button').forEach((x) => x.remove()); later(reply); };
      item.appendChild(b);
    }
  }, 500);
}
document.getElementById('send').onclick = () => {
  const t = document.getElementById('t');
  const text = t.value.trim();
  if (!text) return;
  t.value = '';
  add('user', text);
  const low = text.toLowerCase();
  if (low.includes('numbered list')) later('1. Love that idea!\\n2. Let me think about it.\\n3. Maybe next week?');
  else if (low.includes('weather')) laterHtml('<p>Today: rain, 25°C.</p><ul><li>Tue: showers</li><li>Wed: cold front</li></ul><p>Take an umbrella.</p>');
  else if (low.includes('book')) later('I found a table for 2 at 7:30 at Nopa.', [['Approve', 'Booked! See you at 7:30.'], ['Deny', 'Okay, I won\\'t book it.']]);
  else if (low.includes('drop the connection')) {
    // Like real Muse when its connection to the agent's VM drops: a banner, and no
    // answers. The first reload doesn't fix it yet; the second does.
    localStorage.setItem('fakeDroppedLoads', '1');
    connectionError();
  }
  else later('Muse echo: ' + text);
};
function laterHtml(html) {
  const { prose } = add('assistant', '');
  setTimeout(() => { prose.innerHTML = html; }, 300);
}
add('assistant', 'Hi! I am your Muse.');
// Real Muse loads older history after the page appears; none of it is new.
setTimeout(() => { add('user', 'old question'); add('assistant', 'Old answer from yesterday.'); }, 1200);
</script></body></html>`;

// The README media (e2e/media) shows Muse's earlier conversation; make it read like one.
const MUSE_MEDIA_PAGE = MUSE_PAGE.replace("add('user', 'old question'); add('assistant', 'Old answer from yesterday.');", "add('user', 'Any good sushi near the office?'); add('assistant', 'Try Ozumo on Mission St. It opens at 5.');");

const DOTS_PAGE = `<!doctype html><html><head><title>ChatGPT Dots (fake)</title>
<style>body{font-family:sans-serif} article{border:1px solid #ddd;margin:6px;padding:6px} [data-message-author-role]{white-space:pre-wrap} #prompt-textarea{border:1px solid #888;min-height:40px}</style>
</head><body>
<main id="thread"></main>
<div id="prompt-textarea" contenteditable="true"></div>
<button data-testid="send-button" id="send">Send</button>
<script>
let n = 0;
const thread = document.getElementById('thread');
function turn(role, text, buttons) {
  const art = document.createElement('article');
  art.setAttribute('data-testid', 'conversation-turn-' + (++n));
  const msg = document.createElement('div');
  msg.setAttribute('data-message-author-role', role);
  msg.setAttribute('data-message-id', 'dm' + n);
  msg.textContent = text;
  art.appendChild(msg);
  for (const [label, reply] of buttons || []) {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = () => { art.querySelectorAll('button').forEach((x) => x.remove()); answer(reply); };
    art.appendChild(b);
  }
  thread.appendChild(art);
  return msg;
}
function answer(text, buttons) {
  const stop = document.createElement('button');
  stop.setAttribute('data-testid', 'stop-button');
  stop.textContent = 'Stop';
  document.body.appendChild(stop);
  const msg = turn('assistant', '');
  const art = msg.parentElement;
  setTimeout(() => { msg.textContent = text.slice(0, 4); }, 150);
  setTimeout(() => {
    stop.remove();
    msg.textContent = text;
    for (const [label, reply] of buttons || []) {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = () => { art.querySelectorAll('button').forEach((x) => x.remove()); answer(reply); };
      art.appendChild(b);
    }
  }, 500);
}
document.getElementById('send').onclick = () => {
  const box = document.getElementById('prompt-textarea');
  const text = box.innerText.trim();
  if (!text) return;
  box.innerText = '';
  turn('user', text);
  const low = text.toLowerCase();
  if (low.includes('numbered list')) answer('1. Absolutely, count me in.\\n2. Let me get back to you.\\n3. Could we do Thursday?');
  else if (low.includes('approve')) answer('The expense report is ready to submit.', [['Allow', 'Submitted the expense report.'], ['Deny', 'Okay, not submitting it.']]);
  else answer('Dots echo: ' + text);
};
</script></body></html>`;

function page(req: IncomingMessage, res: ServerResponse, cookie: string, title: string, body: string) {
  const signedIn = (req.headers.cookie ?? "").split(/;\s*/).includes(`${cookie}=1`);
  return html(res, signedIn ? body : LOGIN_PAGE(cookie, title));
}

// ---- server -----------------------------------------------------------------------------

function html(res: ServerResponse, body: string) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}
function text(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { "Content-Type": "text/plain" });
  res.end(body);
}
function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
function proto(res: ServerResponse, schema: Schema, msg: Record<string, unknown>) {
  res.writeHead(200, { "Content-Type": "application/proto" });
  res.end(Buffer.from(encode(schema, msg as never)));
}
async function readBody(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return new Uint8Array(Buffer.concat(chunks));
}


// ---- Cue (the Manus API) ----------------------------------------------------------------
// Keys that start with "cue-key-" are valid; each key is its own account.

type CueEvt = { id: string; type: string; timestamp: number } & Record<string, unknown>;
const cueTasks = new Map<string, CueEvt[]>();
let cueSeq = 0;

function cueAgents(key: string) {
  return {
    im: { id: `${key}-im`, task_id: `${key}-task-im`, nickname: "Cue", about: "Your everyday agent" },
    list: [{ id: `${key}-trip`, task_id: `${key}-task-trip`, nickname: "Trip Planner", about: "Plans trips and books them" }],
  };
}

function cueAdd(task: string, evt: Omit<CueEvt, "id" | "timestamp">, delayMs = 0) {
  setTimeout(() => {
    const list = cueTasks.get(task) ?? [];
    list.push({ id: `evt${++cueSeq}`, timestamp: Date.now(), ...evt } as CueEvt);
    cueTasks.set(task, list);
  }, delayMs);
}
const cueStatus = (agent_status: string, extra: object = {}) => ({ type: "status_update", status_update: { agent_status, ...extra } });

function cueReply(task: string, text: string) {
  cueAdd(task, cueStatus("running", { brief: "Thinking" }), 100);
  const t = text.toLowerCase();
  if (t.includes("photo")) {
    cueAdd(task, { type: "assistant_message", assistant_message: { content: "Here's the photo.", attachments: [{ type: "image", filename: "photo.png", url: `http://127.0.0.1:${PORT}/img/bot.png`, content_type: "image/png" }] } }, 250);
    cueAdd(task, cueStatus("stopped"), 300);
  } else if (t.includes("phone")) {
    cueAdd(task, { type: "user_message", user_message: { content: "Sent from the Cue app", message_type: "text" } }, 250);
  } else if (t.includes("screenshot")) {
    cueAdd(task, { type: "assistant_message", assistant_message: { content: "Which computer?", question_expectation: { options: ["Mac Mini", "MacBook Air"], selection_mode: "single", response_method: "send_message" } } }, 250);
    cueAdd(task, cueStatus("waiting", { status_detail: { waiting_for_event_type: "messageAskUser" } }), 300);
  } else if (t === "macbook air" || t === "mac mini") {
    cueAdd(task, { type: "assistant_message", assistant_message: { content: `Took a screenshot of the ${text}.` } }, 250);
    cueAdd(task, cueStatus("stopped"), 300);
  } else if (t.includes("email")) {
    cueAdd(task, cueStatus("waiting", {
      status_detail: {
        waiting_for_event_id: `confirm-${task}`,
        waiting_for_event_type: "gmailSendAction",
        waiting_description: "Send email to sam@example.com",
        confirm_input_schema: { type: "object", properties: { accept: { type: "boolean" }, save_draft: { type: "boolean" } }, required: ["accept"] },
      },
    }), 250);
  } else {
    cueAdd(task, { type: "assistant_message", assistant_message: { content: `Cue echo: ${text}` } }, 250);
    cueAdd(task, cueStatus("stopped"), 300);
  }
}

async function cue(req: IncomingMessage, res: ServerResponse, path: string, url: URL) {
  const key = String(req.headers["x-manus-api-key"] ?? "");
  if (!key.startsWith("cue-key-")) return json(res, 401, { ok: false, error: { code: "unauthenticated", message: "invalid api key" } });
  const body = req.method === "POST" ? (JSON.parse(new TextDecoder().decode(await readBody(req)) || "{}") as Record<string, unknown>) : {};
  const agents = cueAgents(key);
  const ownTask = (t: unknown) => [agents.im, ...agents.list].some((a) => a.task_id === t);
  switch (path) {
    case "/v2/user.me":
      return json(res, 200, { ok: true, user_id: key, name: "Test User", email: "test@example.com" });
    case "/v2/agent.list":
      return json(res, 200, { ok: true, data: agents.list });
    case "/v2/agent.detail":
      return url.searchParams.get("agent_id") === "agent-default"
        ? json(res, 200, { ok: true, agent: agents.im })
        : json(res, 404, { ok: false, error: { code: "not_found", message: "no such agent" } });
    case "/v2/task.listMessages": {
      const task = url.searchParams.get("task_id");
      if (!ownTask(task)) return json(res, 404, { ok: false, error: { code: "not_found", message: "no such task" } });
      // Trip Planner already has a conversation: it comes over as history on connect.
      if (!cueTasks.has(task!) && task === agents.list[0]!.task_id) {
        const at = Date.now() - 3_600_000;
        cueTasks.set(task!, [
          { id: `evt${++cueSeq}`, timestamp: at, type: "user_message", user_message: { content: "Plan a weekend in Kyoto" } },
          { id: `evt${++cueSeq}`, timestamp: at + 1000, type: "assistant_message", assistant_message: { content: "Here's a two-day Kyoto plan." } },
        ]);
      }
      const limit = Number(url.searchParams.get("limit") ?? 20);
      const events = [...(cueTasks.get(task!) ?? [])].reverse().slice(0, limit);
      return json(res, 200, { ok: true, task_id: task, messages: events, has_more: false });
    }
    case "/v2/task.sendMessage": {
      const task = body.task_id;
      if (!ownTask(task)) return json(res, 404, { ok: false, error: { code: "not_found", message: "no such task" } });
      const content = String((body.message as { content?: unknown } | undefined)?.content ?? "");
      cueAdd(String(task), { type: "user_message", user_message: { content, message_type: "text" } });
      cueReply(String(task), content);
      return json(res, 200, { ok: true, task_id: task });
    }
    case "/v2/task.confirmAction": {
      const task = String(body.task_id);
      const accept = (body.input as { accept?: unknown } | undefined)?.accept === true;
      cueAdd(task, cueStatus("running"), 50);
      cueAdd(task, { type: "assistant_message", assistant_message: { content: accept ? "Sent the email to Sam." : "OK, I won't send it." } }, 200);
      cueAdd(task, cueStatus("stopped"), 250);
      return json(res, 200, { ok: true, task_id: task, confirmed: true });
    }
  }
  return json(res, 404, { ok: false, error: { code: "not_found", message: path } });
}


// Manus sign-in (what Cue's desktop app uses) and the one internal call AgentStudio makes.
function cueWeb(req: IncomingMessage, res: ServerResponse, path: string, url: URL) {
  if (path === "/login") {
    const next = url.searchParams.get("redirectUrl") ?? "";
    return html(res, `<!doctype html><title>Manus (fake)</title><h1>Sign in to Manus</h1>
      <button id="login" onclick="location.href=${JSON.stringify(next).replace(/"/g, "&quot;")}">Log in</button>`);
  }
  if (path === "/login-success") {
    // Like manus.im: only cue:// and cuedev:// are allowed.
    const nonce = url.searchParams.get("nonce") ?? "";
    const scheme = url.searchParams.get("agentsScheme") === "cuedev" ? "cuedev" : "cue";
    res.writeHead(302, { Location: `${scheme}://oauth/desktop-callback?nonce=${nonce}&token=web-token-${Date.now()}` });
    return void res.end();
  }
  text(res, 404, "not found");
}

async function cueRpc(req: IncomingMessage, res: ServerResponse, path: string) {
  const auth = String(req.headers.authorization ?? "");
  if (path !== "/openapi.v1.OpenapiService/CreateAPIKey") return json(res, 404, { code: "not_found", message: path });
  if (!auth.startsWith("Bearer web-token-")) return json(res, 401, { code: "unauthenticated", message: "sign in first" });
  const body = JSON.parse(new TextDecoder().decode(await readBody(req)) || "{}") as { name?: string };
  json(res, 200, { apiKeyData: { name: body.name ?? "", apiKey: `cue-key-web-${Date.now()}`, apiKeyId: "k1" } });
}

createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const p = url.pathname;
  if (p === "/health") return json(res, 200, { ok: true });
  if (p === "/img/bot.png") return void res.writeHead(200, { "Content-Type": "image/png" }).end(IMG.bot);
  if (p === "/muse/persona.jpg") return void res.writeHead(200, { "Content-Type": "image/jpeg" }).end(IMG.persona);
  if (p.startsWith("/grok/")) return void grok(req, res, p.slice(5), url).catch((e) => text(res, 500, String(e)));
  if (p.startsWith("/cue/")) return void cue(req, res, p.slice(4), url).catch((e) => text(res, 500, String(e)));
  if (p.startsWith("/cue-web/")) return cueWeb(req, res, p.slice(8), url);
  if (p.startsWith("/cue-rpc/")) return void cueRpc(req, res, p.slice(8)).catch((e) => text(res, 500, String(e)));
  if (p.startsWith("/muse")) return page(req, res, "fake_muse", "Muse (fake)", process.env.FAKE_AGENTS_MEDIA ? MUSE_MEDIA_PAGE : MUSE_PAGE);
  if (p.startsWith("/dots")) return page(req, res, "fake_dots", "ChatGPT Dots (fake)", DOTS_PAGE);
  text(res, 404, "not found");
}).listen(PORT, "127.0.0.1", () => console.log(`fake agents on http://127.0.0.1:${PORT}`));
