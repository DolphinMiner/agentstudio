// Turns what readme.media.ts recorded (e2e/media/out) into the README's media
// in docs/media: four product pictures, the demo video (MP4) and a short GIF
// of it for the README. Needs ffmpeg. Run: node media/render.mjs (from e2e/).
//
// The look: AgentStudio by day. The app's own pale sky (blue at the top, warm
// at the bottom), the window in front, and the porch light (the app's amber,
// #f2a93b) glowing softly behind it.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const OUT = join(HERE, "out");
const SHOTS = join(OUT, "shots");
const TMP = join(OUT, "render");
const DOCS = join(ROOT, "docs", "media");

const asset = (p) => `data:${p.endsWith(".png") ? "image/png" : p.endsWith(".jpg") ? "image/jpeg" : "font/woff2"};base64,${readFileSync(p).toString("base64")}`;
const shot = (name) => asset(join(SHOTS, `${name}.png`));
const brand = (name) => asset(join(ROOT, "packages", "brand", "assets", name));
const FONT = asset(
  join(ROOT, "node_modules", ".pnpm", "node_modules", "@fontsource-variable", "bricolage-grotesque", "files", "bricolage-grotesque-latin-opsz-normal.woff2"),
);

/** The app's icon (packages/brand/assets/agentstudio.png), as on its sign-in screen. */
const ICON = (size) => `<img class="tile" src="${brand("agentstudio.png")}" style="width:${size}px;height:${size}px">`;

const BASE = `
@font-face { font-family: Bricolage; src: url(${FONT}) format("woff2"); font-weight: 200 800; }
* { box-sizing: border-box; margin: 0; }
:root {
  --ink: #1a2233; --soft: #4f5a70; --door: #3247a8; --porch: #f2a93b; --porch-ink: #8a5408;
}
body { font-family: Bricolage, -apple-system, sans-serif; color: var(--ink); -webkit-font-smoothing: antialiased; }
.stage { position: relative; overflow: hidden; background:
  radial-gradient(ellipse 55% 50% at var(--gx, 62%) var(--gy, 92%), rgba(255,196,102,.55), rgba(255,214,150,.18) 45%, transparent 72%),
  radial-gradient(ellipse 70% 60% at 8% 0%, rgba(255,255,255,.9), transparent 62%),
  linear-gradient(180deg, #cfdaf1 0%, #e3e9f6 40%, #f3f1f3 72%, #fbefe1 100%); }
.stage::after { content: ""; position: absolute; inset: 0; pointer-events: none; opacity: .45;
  background-image: radial-gradient(rgba(50,71,168,.16) 1px, transparent 1.3px);
  background-size: 22px 22px;
  -webkit-mask-image: radial-gradient(ellipse 60% 55% at 50% 40%, transparent 40%, #000 100%); }
.window { position: absolute; border-radius: 18px; overflow: hidden; background: #eef0f8;
  box-shadow: 0 0 0 1px rgba(26,34,51,.08), 0 0 0 7px rgba(255,255,255,.55), 0 50px 110px -34px rgba(36,48,92,.45), 0 18px 40px -20px rgba(36,48,92,.35), 0 0 160px -30px rgba(242,169,59,.45); }
.window img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: top left; }
.lights { position: absolute; left: 1.45%; top: 2.2%; display: flex; gap: .62%; width: 100%; }
.lights i { width: 1.05%; aspect-ratio: 1; border-radius: 50%; background: #ff5f57; box-shadow: inset 0 0 0 .5px rgba(0,0,0,.15); }
.lights i:nth-child(2) { background: #febc2e; } .lights i:nth-child(3) { background: #28c840; }
h1 { font-weight: 640; letter-spacing: -.025em; line-height: 1.02; font-variation-settings: "opsz" 96; }
p.lede { color: var(--soft); font-weight: 400; line-height: 1.38; font-variation-settings: "opsz" 14; }
.wordmark { display: flex; align-items: center; gap: 14px; font-weight: 640; letter-spacing: -.02em; }
.wordmark .tile, .tile { display: block; border-radius: 22%; box-shadow: 0 0 0 1px rgba(255,255,255,.6), 0 12px 30px -10px rgba(36,48,92,.5), 0 0 40px -6px rgba(242,169,59,.45); }
.float { position: absolute; border-radius: 22px; overflow: hidden; box-shadow: 0 0 0 1px rgba(26,34,51,.08), 0 0 0 6px rgba(255,255,255,.6), 0 40px 80px -26px rgba(36,48,92,.5); }
.float img { position: absolute; }
`;

const page = (w, h, body, extra = "") => `<!doctype html><html><head><style>${BASE}${extra}</style></head><body style="width:${w}px;height:${h}px">${body}</body></html>`;
const win = (name, style) => `<div class="window" style="${style}"><img src="${shot(name)}"><div class="lights"><i></i><i></i><i></i></div></div>`;
const mark = (size, text) => `<div class="wordmark" style="font-size:${size * 0.62}px">${ICON(size)}${text}</div>`;

// ---- the product pictures (1600 × 1000) ----

const W = 1600, H = 1000;
const PICTURES = {
  hero: page(W, H, `
    <div class="stage" style="width:${W}px;height:${H}px;--gx:50%;--gy:100%">
      <div style="position:absolute;left:0;right:0;top:64px;text-align:center;display:grid;justify-items:center;gap:22px">
        ${mark(52, "AgentStudio")}
        <h1 style="font-size:66px;max-width:1300px">Your people and your agents, in one inbox</h1>
        <p class="lede" style="font-size:25px;max-width:780px">Chats, Grok Bot, Cue, Muse, ChatGPT and your own agents on one Mac. When an agent needs you, the light comes on.</p>
      </div>
      ${win("muse", `left:${(W - 1240) / 2}px;top:360px;width:1240px;height:775px`)}
    </div>`),

  approvals: page(W, H, `
    <div class="stage" style="width:${W}px;height:${H}px;--gx:80%;--gy:75%">
      <div style="position:absolute;left:96px;top:0;bottom:0;width:470px;display:flex;flex-direction:column;justify-content:center;gap:26px">
        <h1 style="font-size:68px">Agents ask before they act</h1>
        <p class="lede" style="font-size:24px">When an agent wants to book, send or buy, you get a card with the details. Approve or decline it in one tap.</p>
      </div>
      ${win("grok", "left:640px;top:150px;width:1120px;height:700px")}
    </div>`),

  ask: page(W, H, `
    <div class="stage" style="width:${W}px;height:${H}px;--gx:30%;--gy:85%">
      ${win("ask", "left:-160px;top:150px;width:1120px;height:700px")}
      <div class="float" style="left:540px;top:700px;width:458px;height:220px;background:#fff">
        <img src="${shot("drafts")}" style="width:1280px;left:-441px;top:-485px">
      </div>
      <div style="position:absolute;left:1060px;top:0;bottom:0;width:450px;display:flex;flex-direction:column;justify-content:center;gap:26px">
        <h1 style="font-size:66px">Ask an agent about any message</h1>
        <p class="lede" style="font-size:24px">Pick an agent and the lines it may read. Drafts come back to you, and nothing is sent until you send it.</p>
      </div>
    </div>`),

  connect: page(W, H, `
    <div class="stage" style="width:${W}px;height:${H}px;--gx:78%;--gy:80%">
      <div style="position:absolute;left:96px;top:0;bottom:0;width:470px;display:flex;flex-direction:column;justify-content:center;gap:26px">
        <h1 style="font-size:66px">Bring the agents you already use</h1>
        <p class="lede" style="font-size:24px">Sign in to Grok Bot, Cue, Muse and ChatGPT with your own account. They run on your Mac, next to agents on open protocols.</p>
        <div style="display:flex;gap:14px;margin-top:6px">
          ${["grokbot.png", "cue.png", "muse-mark.png", "chatgpt.png", "a2a.png"].map((b) => `<img src="${brand(b)}" style="width:54px;height:54px;border-radius:16px;background:#fff;object-fit:contain;padding:${b === "grokbot.png" ? 0 : 7}px;box-shadow:0 0 0 1px rgba(26,34,51,.08),0 12px 26px -12px rgba(36,48,92,.45)">`).join("")}
        </div>
      </div>
      ${win("connect", "left:640px;top:150px;width:1120px;height:700px")}
      <div class="float" style="left:600px;top:660px;width:558px;height:262px;background:#fff">
        <img src="${shot("connect-sheet")}" style="width:1280px;left:-361px;top:-269px">
      </div>
    </div>`),
};

// ---- the video's pieces (1920 × 1080) ----

const VW = 1920, VH = 1080;
// Where the recording sits in the frame.
const APP = { x: 240, y: 150, w: 1440, h: 900 };
// The video is drawn at twice that (3840 × 2160, 4K), so the app keeps its full Retina detail.
const S = 2;
const VIDEO = {
  backdrop: page(VW, VH, `<div class="stage" style="width:${VW}px;height:${VH}px;--gx:50%;--gy:100%">
    <div class="window" style="left:${APP.x}px;top:${APP.y}px;width:${APP.w}px;height:${APP.h}px"></div></div>`),
  mask: page(VW, VH, `<div style="width:${APP.w}px;height:${APP.h}px;background:#fff;border-radius:18px"></div>`, "body{background:#000}"),
  chrome: page(VW, VH, `<div style="position:absolute;left:${APP.x}px;top:${APP.y}px;width:${APP.w}px;height:${APP.h}px"><div class="lights"><i></i><i></i><i></i></div></div>`, "body{background:transparent}"),
  intro: page(VW, VH, `<div class="stage" style="width:${VW}px;height:${VH}px;--gx:50%;--gy:78%;display:grid;place-items:center">
    <div style="display:grid;justify-items:center;gap:30px;margin-top:-40px">
      ${ICON(140)}
      <h1 style="font-size:104px">AgentStudio</h1>
      <p class="lede" style="font-size:34px">Your people and your agents, in one inbox</p>
    </div></div>`),
  outro: page(VW, VH, `<div class="stage" style="width:${VW}px;height:${VH}px;--gx:50%;--gy:78%;display:grid;place-items:center">
    <div style="display:grid;justify-items:center;gap:28px;margin-top:-40px">
      ${mark(84, `<span style="font-size:76px">AgentStudio</span>`)}
      <p class="lede" style="font-size:34px">We'll leave the light on.</p>
      <p style="font-size:26px;color:var(--porch-ink);font-weight:500;margin-top:18px">Open source, for Mac · github.com/DolphinMiner/agentstudio</p>
    </div></div>`),
};
const caption = (text) => page(VW, 150, `<div style="height:150px;display:grid;place-items:center"><h1 style="font-size:46px;font-weight:600;text-shadow:0 1px 14px rgba(255,255,255,.9)">${text}</h1></div>`, "body{background:transparent}");

// ---- render ----

function ffmpeg(args) {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "inherit" });
}

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
mkdirSync(DOCS, { recursive: true });
const rec = JSON.parse(readFileSync(join(OUT, "scenes.json"), "utf8"));

const browser = await chromium.launch();
async function render(html, file, { w, h, scale = 1, transparent = false, jpeg = false }) {
  const p = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: scale });
  await p.setContent(html, { waitUntil: "load" });
  await p.evaluate(() => document.fonts.ready);
  await p.screenshot({ path: file, omitBackground: transparent, ...(jpeg ? { type: "jpeg", quality: 90 } : {}) });
  await p.close();
}
for (const [name, html] of Object.entries(PICTURES)) await render(html, join(DOCS, `${name}.jpg`), { w: W, h: H, scale: 1.5, jpeg: true });
for (const [name, html] of Object.entries(VIDEO)) {
  await render(html, join(TMP, `${name}.png`), { w: VW, h: VH, scale: S, transparent: name === "chrome" });
}
const scenes = rec.scenes.filter((s) => s.caption !== "AgentStudio");
for (const [i, s] of scenes.entries()) await render(caption(s.caption), join(TMP, `caption${i}.png`), { w: VW, h: 150, scale: S, transparent: true });
await browser.close();

// The screencast's frames, each shown until the next one, as 30 fps video.
const list = rec.frames.map((f, i) => {
  const next = rec.frames[i + 1]?.at ?? rec.duration;
  return `file '${join(OUT, "frames", f.file)}'\nduration ${Math.max(0.001, next - f.at).toFixed(4)}`;
});
writeFileSync(join(TMP, "frames.txt"), `${list.join("\n")}\nfile '${join(OUT, "frames", rec.frames.at(-1).file)}'\n`);
const main = join(TMP, "main.mp4");
const len = rec.duration;
const inputs = ["-loop", "1", "-i", join(TMP, "backdrop.png"), "-f", "concat", "-safe", "0", "-i", join(TMP, "frames.txt"), "-loop", "1", "-i", join(TMP, "mask.png"), "-loop", "1", "-i", join(TMP, "chrome.png")];
let graph =
  `[1:v]fps=30,scale=${APP.w * S}:${APP.h * S}:flags=lanczos,format=rgba[app];` +
  `[2:v]crop=${APP.w * S}:${APP.h * S}:0:0,format=gray[m];[app][m]alphamerge[appm];` +
  `[0:v][appm]overlay=${APP.x * S}:${APP.y * S}:shortest=1[v0];[v0][3:v]overlay=0:0:shortest=1[v1]`;
let last = "v1";
scenes.forEach((s, i) => {
  const end = scenes[i + 1]?.at ?? len - 3;
  const d = Math.max(1, end - s.at - 0.2);
  inputs.push("-loop", "1", "-t", d.toFixed(2), "-i", join(TMP, `caption${i}.png`));
  const n = 4 + i;
  graph += `;[${n}:v]format=rgba,fade=t=in:st=0:d=0.45:alpha=1,fade=t=out:st=${(d - 0.45).toFixed(2)}:d=0.45:alpha=1,setpts=PTS+${s.at.toFixed(2)}/TB[c${i}];[${last}][c${i}]overlay=0:0:eof_action=pass[v${i + 2}]`;
  last = `v${i + 2}`;
});
ffmpeg([...inputs, "-filter_complex", graph, "-map", `[${last}]`, "-t", len.toFixed(2), "-r", "30", "-c:v", "libx264", "-crf", "12", "-preset", "medium", "-pix_fmt", "yuv420p", main]);

// Title, the demo, and the closing card, cross-faded.
const card = (png, file, d) => ffmpeg(["-loop", "1", "-t", String(d), "-i", png, "-r", "30", "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p", file]);
card(join(TMP, "intro.png"), join(TMP, "intro.mp4"), 3);
card(join(TMP, "outro.png"), join(TMP, "outro.mp4"), 4);
const video = join(DOCS, "agentstudio-demo.mp4");
ffmpeg([
  "-i", join(TMP, "intro.mp4"), "-i", main, "-i", join(TMP, "outro.mp4"),
  "-filter_complex", `[0:v][1:v]xfade=transition=fade:duration=0.6:offset=2.4[a];[a][2:v]xfade=transition=fade:duration=0.8:offset=${(2.4 + len - 0.8).toFixed(2)}[v]`,
  "-map", "[v]", "-c:v", "libx264", "-crf", "17", "-preset", "slow", "-tune", "animation", "-pix_fmt", "yuv420p", "-movflags", "+faststart", video,
]);

// The README's preview: the demo itself (no title cards), cropped to the window and its captions so the app reads at README width.
const gif = join(DOCS, "agentstudio-demo.gif");
ffmpeg([
  "-i", main, "-filter_complex",
  `crop=${APP.w * S}:${VH * S}:${APP.x * S}:0,fps=12,scale=1100:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=224:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle`,
  gif,
]);
console.log(`wrote ${DOCS}`);
