// Page drivers: JavaScript that runs inside a service's own web page (in an
// isolated world) to read the conversation and to send a message. They are
// strings, not functions, so the bundler can't rewrite them.
//
// Every driver defines the same three entry points on globalThis.__agentstudio:
//   snapshot() -> { signedIn, ready, busy, messages: [{ id, role, text, actions: [label] }], problem }
//     (problem: a connection error the page shows, or null)
//   submit(text) -> { ok, error? }
//   click(messageId, label) -> { ok, error? }
//
// The Muse selectors come from beeper-muse (https://github.com/nishu-builder/beeper-muse,
// MIT, Copyright (c) 2026 nishu-builder), which validated them against live Muse.

const COMMON = String.raw`
const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
// A connection problem the page itself shows ("Connection error", "Reconnecting…").
const PROBLEM = /^(connection error|connection lost|reconnecting|you'?re offline|offline|network error|unable to connect|can'?t connect|something went wrong)\b/i;
const pageProblem = () => {
  const w = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(), i = 0; n && i < 4000; n = w.nextNode(), i++) {
    const t = (n.textContent || '').trim();
    if (t.length > 0 && t.length < 40 && PROBLEM.test(t) && n.parentElement && visible(n.parentElement) && !n.parentElement.closest('[data-message-item],[data-message-author-role],[data-user-message-actions],[data-assistant-message-actions],.prose')) return t;
  }
  return null;
};
const SKIP = 'button,svg,script,style,[aria-hidden="true"],[role="toolbar"],[role="status"],[data-message-actions],.sr-only,textarea,input';
const BLOCK = /^(P|DIV|LI|UL|OL|H[1-6]|PRE|BLOCKQUOTE|TABLE|TR|SECTION|ARTICLE|HR)$/;
// Text with paragraph and list breaks kept. innerText can't be used on a detached
// clone (no layout), so walk the live tree and skip chrome.
const clean = (el) => {
  const out = [];
  const walk = (n, depth) => {
    if (n.nodeType === 3) {
      const ws = n.parentElement ? getComputedStyle(n.parentElement).whiteSpace : 'normal';
      out.push(/pre/.test(ws) ? n.textContent : n.textContent.replace(/[ \t\r\n]+/g, ' '));
      return;
    }
    if (n.nodeType !== 1 || n.matches(SKIP)) return;
    if (n.tagName === 'BR') { out.push('\n'); return; }
    const block = BLOCK.test(n.tagName);
    if (block) out.push('\n');
    if (n.tagName === 'LI') out.push(n.parentElement && n.parentElement.tagName === 'OL' ? (([...n.parentElement.children].indexOf(n) + 1) + '. ') : '• ');
    if (n.tagName === 'PRE') { out.push(n.textContent); out.push('\n'); return; }
    for (const c of n.childNodes) walk(c, depth + 1);
    if (block) out.push('\n');
  };
  walk(el, 0);
  return out.join('').split('\n').map((l) => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
};
// Chat chrome, not decisions.
const CHROME = /^(more options|more|react|reply|copy|copy response|share|like|dislike|good response|bad response|edit|retry|regenerate|try again|read aloud|stop|thumbs up|thumbs down|open generated image.*)$/i;
const buttonsIn = (el) => [...el.querySelectorAll('button,[role="button"]')]
  .filter(visible)
  .filter((b) => !b.closest('[data-message-actions],[role="toolbar"]'))
  .map((b) => (b.getAttribute('aria-label') || b.innerText || '').trim())
  .filter((t) => t && t.length <= 60 && !CHROME.test(t));
const setNative = (field, value) => {
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
};

// The persona's avatar: an <img> labelled with its name (outside the message log),
// or a frame of an animated avatar <video>. Returns its src or a PNG data URL.
const avatarOf = (name, videoSel) => {
  if (!name) return null;
  const labels = new Set([name, name + "'s avatar", name + ' avatar', 'Avatar of ' + name].map((x) => x.toLowerCase()));
  const outside = (el) => visible(el) && !el.closest('[role="log"],[data-message-item],nav,[role="navigation"]');
  const img = [...document.querySelectorAll('img[alt]')].find((i) => outside(i) && labels.has(i.alt.trim().toLowerCase()) && i.naturalWidth >= 24);
  if (img) return { src: img.currentSrc || img.src };
  const video = videoSel ? [...document.querySelectorAll(videoSel)].find((v) => outside(v) && v.readyState >= 2 && v.videoWidth) : null;
  if (video) {
    try {
      const k = Math.min(1, 256 / Math.max(video.videoWidth, video.videoHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(video.videoWidth * k);
      c.height = Math.round(video.videoHeight * k);
      c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
      return { frame: c.toDataURL('image/png') };
    } catch { return null; }
  }
  return null;
};
const clickLabel = (root, label) => {
  const b = [...root.querySelectorAll('button,[role="button"]')].filter(visible)
    .find((x) => ((x.getAttribute('aria-label') || x.innerText || '').trim()) === label);
  if (!b || b.disabled) return { ok: false, error: 'That button is no longer there.' };
  b.click();
  return { ok: true };
};
`;

export const MUSE_DRIVER = String.raw`(() => {
${COMMON}
const composer = () => [...document.querySelectorAll('textarea[aria-label="Message"]')].filter(visible)[0] || null;
const log = () => [...document.querySelectorAll('[role="log"][aria-label="Chat messages"]')].filter(visible)[0] || null;
const items = () => { const l = log(); return l ? [...l.querySelectorAll('[data-message-item][data-message-id]')] : []; };
const busy = () => {
  const stop = [...document.querySelectorAll('button[aria-label]')].some((b) => visible(b) && !b.closest('[role="log"],[data-message-item]') && /^stop(?: generating(?: response)?| response)?$/i.test(b.getAttribute('aria-label').trim()));
  const f = composer();
  const composerBusy = !!(f && f.closest('[aria-busy="true"]'));
  const all = items();
  const last = all[all.length - 1];
  const assistantBusy = !!(last && last.getAttribute('data-message-role') === 'assistant' &&
    [...last.querySelectorAll(':scope > [aria-busy="true"], :scope > div > [aria-busy="true"]')].some(visible));
  return stop || composerBusy || assistantBusy;
};
globalThis.__agentstudio = {
  snapshot() {
    const f = composer();
    const signedIn = !!f;
    const messages = items().flatMap((e) => {
      const id = e.getAttribute('data-message-id');
      const role = e.getAttribute('data-message-role');
      if (!id || (role !== 'user' && role !== 'assistant')) return [];
      const bubbles = [...e.querySelectorAll('.hatch-chat-groupable-bubble')].filter((n) => n.closest('[data-message-item]') === e && !n.parentElement.closest('.hatch-chat-groupable-bubble'));
      let text = bubbles.length ? bubbles.map(clean).join('\n').trim() : clean(e);
      const surrogate = e.querySelector('[data-message-accessibility-surrogate="true"]');
      if (!text && surrogate) text = (surrogate.textContent || '').replace(/^(User|Assistant) message: /, '').trim();
      const widget = e.getAttribute('data-message-has-presentation') === 'true' && !e.querySelector('.prose');
      return [{ id, role, text, widget, actions: role === 'assistant' ? buttonsIn(e) : [] }];
    });
    return { signedIn, ready: signedIn && !!log(), busy: busy(), messages, problem: pageProblem() };
  },
  submit(text) {
    const f = composer();
    if (!f || f.disabled || f.readOnly) return { ok: false, error: 'Muse is not ready (open muse.ai and finish signing in).' };
    if (busy()) return { ok: false, error: 'Muse is still working on the last message.' };
    f.focus();
    setNative(f, text);
    const send = [...document.querySelectorAll('button[aria-label="Send"]')].filter(visible);
    if (send.length === 1 && !send[0].disabled) { send[0].click(); return { ok: true }; }
    return { ok: true, pressEnter: true };
  },
  profile() {
    const name = (/^Chat\s+[–—-]\s+(.+)$/.exec(document.title) || [])[1];
    return { name: name ? name.trim() : null, avatar: avatarOf(name && name.trim(), '[data-hatch-avatar-interaction="true"] video[data-hatch-avatar-layer="ready"][data-hatch-avatar-slot="current"]') };
  },
  click(messageId, label) {
    const e = [...document.querySelectorAll('[data-message-item][data-message-id]')].find((x) => x.getAttribute('data-message-id') === messageId);
    return e ? clickLabel(e, label) : { ok: false, error: 'That message is no longer on the page.' };
  },
};
return true;
})()`;

export const DOTS_DRIVER = String.raw`(() => {
${COMMON}
const COMPOSERS = ['#prompt-textarea', 'textarea[name="prompt"]', '[contenteditable="true"][role="textbox"]', 'div.ProseMirror[contenteditable="true"]', 'textarea[aria-label*="Chat" i]', 'textarea[aria-label*="Message" i]'];
const composer = () => { for (const s of COMPOSERS) { const el = [...document.querySelectorAll(s)].filter(visible)[0]; if (el) return el; } return null; };
const SUBMITS = ['button[data-composer-submit]', '[data-testid="send-button"]', 'button[aria-label="Send message"]', 'button[aria-label="Send prompt"]', 'button[aria-label="Send"]'];
const submitButton = () => { for (const s of SUBMITS) { const el = [...document.querySelectorAll(s)].filter(visible)[0]; if (el) return el; } return null; };
const loginVisible = () => !!document.querySelector('[data-testid="login-button"],button[data-login-button],[data-mobile-auth-entry-action="login"]') || /auth\.openai\.com|\/auth\/login/.test(location.href);
const busy = () => !![...document.querySelectorAll('[data-testid="stop-button"],button[aria-label^="Stop" i]')].find(visible) ||
  (() => { const b = submitButton(); return !!(b && (b.getAttribute('data-state') === 'stop' || /stop/i.test(b.getAttribute('aria-label') || ''))); })();
const classic = () => [...document.querySelectorAll('[data-message-author-role]')].map((e, i) => {
  const role = e.getAttribute('data-message-author-role') === 'user' ? 'user' : 'assistant';
  const turn = e.closest('[data-testid^="conversation-turn"],article') || e;
  return { id: e.getAttribute('data-message-id') || 'm' + i, role, text: clean(e), actions: role === 'assistant' ? buttonsIn(turn) : [] };
});
const octane = () => {
  const turns = [...document.querySelectorAll('[data-user-message-actions],[data-assistant-message-actions]')];
  return turns.map((actions, i) => {
    const role = actions.hasAttribute('data-user-message-actions') ? 'user' : 'assistant';
    const turn = actions.parentElement;
    return { id: turn.getAttribute('data-message-id') || turn.getAttribute('data-turn-id') || 't' + i, role, text: clean(turn), actions: role === 'assistant' ? buttonsIn(turn) : [] };
  }).filter((m) => m.text);
};
globalThis.__agentstudio = {
  snapshot() {
    const c = composer();
    const signedIn = !!c && !loginVisible();
    let messages = classic();
    if (messages.length === 0) messages = octane();
    return { signedIn, ready: signedIn, busy: busy(), messages, url: location.pathname, problem: pageProblem() };
  },
  submit(text) {
    const c = composer();
    if (!c) return { ok: false, error: 'Dots is not ready (open ChatGPT and finish signing in).' };
    if (busy()) return { ok: false, error: 'Dots is still working on the last message.' };
    c.focus();
    if (c instanceof HTMLTextAreaElement || c instanceof HTMLInputElement) setNative(c, text);
    else { document.execCommand('selectAll', false); document.execCommand('insertText', false, text); }
    const b = submitButton();
    if (b && !b.disabled && b.getAttribute('aria-disabled') !== 'true') { b.click(); return { ok: true }; }
    return { ok: true, pressEnter: true };
  },
  profile() {
    const h = [...document.querySelectorAll('h1,[data-testid*="dot-name"]')].find(visible);
    const name = h ? (h.textContent || '').trim().slice(0, 60) : null;
    return { name, avatar: avatarOf(name, null) };
  },
  click(messageId, label) {
    const m = [...document.querySelectorAll('[data-message-id],[data-turn-id]')].find((x) => (x.getAttribute('data-message-id') || x.getAttribute('data-turn-id')) === messageId);
    if (m) return clickLabel(m.closest('[data-testid^="conversation-turn"],article') || m.parentElement || m, label);
    const idx = /^t(\d+)$/.exec(messageId);
    const turn = idx && [...document.querySelectorAll('[data-user-message-actions],[data-assistant-message-actions]')][Number(idx[1])];
    return turn ? clickLabel(turn.parentElement, label) : { ok: false, error: 'That message is no longer on the page.' };
  },
};
return true;
})()`;
