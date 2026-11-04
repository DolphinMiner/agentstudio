// Calibration aid (AGENTSTUDIO_CONNECTOR_TRACE_NETWORK=1): records the API calls a
// service's own page makes in the hidden session window, so a connector can
// later call that API directly. Records only the shape of each call: method,
// URL without query values, header names, and JSON bodies reduced to keys and
// value types. No message text, tokens or cookies.

import { appendFileSync } from "node:fs";
import type { WebContents } from "electron";

const STATIC = /\.(js|mjs|css|png|jpe?g|gif|webp|svg|woff2?|ttf|mp4|webm|ico|map)$/i;

/** JSON reduced to its structure. */
export function shapeOf(v: unknown, depth = 0): unknown {
  if (Array.isArray(v)) return v.length ? [shapeOf(v[0], depth + 1)] : [];
  if (v && typeof v === "object") {
    if (depth > 5) return "{…}";
    return Object.fromEntries(Object.entries(v).slice(0, 50).map(([k, x]) => [k, shapeOf(x, depth + 1)]));
  }
  return v === null ? "null" : typeof v;
}

function bodyShape(raw: string | undefined, contentType: string): unknown {
  if (!raw) return undefined;
  try {
    return shapeOf(JSON.parse(raw));
  } catch {
    if (/x-www-form-urlencoded/.test(contentType)) {
      const p = new URLSearchParams(raw);
      // Form fields that carry JSON (GraphQL variables) are shaped too.
      return Object.fromEntries([...p.keys()].map((k) => {
        const v = p.get(k) ?? "";
        try {
          return [k, shapeOf(JSON.parse(v))];
        } catch {
          return [k, /^(doc_id|fb_api_req_friendly_name|operationName|queryName)$/.test(k) ? v : `string(${v.length})`];
        }
      }));
    }
    return `${contentType || "body"} (${raw.length} bytes)`;
  }
}

export function traceNetwork(wc: WebContents, file: string, label: string) {
  const write = (o: object) => {
    try {
      appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), svc: label, ...o }) + "\n", { mode: 0o600 });
    } catch {
      /* best effort */
    }
  };
  const dbg = wc.debugger;
  try {
    dbg.attach("1.3");
  } catch {
    return;
  }
  void dbg.sendCommand("Network.enable");
  const pending = new Map<string, Record<string, unknown>>();
  dbg.on("message", (_e, method: string, p: Record<string, any>) => {
    if (method === "Network.requestWillBeSent") {
      const u = new URL(p.request.url);
      // Scripts are only listed (the page's code is public; this tells which parts it loads).
      if (p.type === "Script") return write({ script: `${u.origin}${u.pathname}` });
      if (STATIC.test(u.pathname) || u.pathname.startsWith("/_next/") || !/^https?:$/.test(u.protocol)) return;
      const headers = p.request.headers as Record<string, string>;
      const ct = headers["Content-Type"] ?? headers["content-type"] ?? "";
      pending.set(p.requestId, {
        method: p.request.method,
        url: `${u.origin}${u.pathname}`,
        query: [...u.searchParams.keys()],
        headers: Object.keys(headers).filter((h) => !/^(accept|user-agent|referer|origin|sec-|content-length|cookie)/i.test(h)),
        body: bodyShape(p.request.postData, ct),
        kind: p.type,
      });
    } else if (method === "Network.responseReceived" && pending.has(p.requestId)) {
      const r = pending.get(p.requestId)!;
      r.status = p.response.status;
      r.mime = p.response.mimeType;
    } else if (method === "Network.loadingFinished" && pending.has(p.requestId)) {
      const r = pending.get(p.requestId)!;
      pending.delete(p.requestId);
      if (!/json|event-stream|text\/plain/.test(String(r.mime))) return write(r);
      void dbg
        .sendCommand("Network.getResponseBody", { requestId: p.requestId })
        .then((b: { body: string }) => {
          const lines = b.body.split("\n").filter(Boolean);
          let res: unknown;
          try {
            res = shapeOf(JSON.parse(b.body));
          } catch {
            // Streams: the shape of the first and last JSON line.
            const json = lines.map((l) => l.replace(/^data:\s*/, "")).filter((l) => l.startsWith("{"));
            res = { lines: lines.length, first: json[0] ? shapeOf(JSON.parse(json[0])) : undefined, last: json.length > 1 ? shapeOf(JSON.parse(json[json.length - 1]!)) : undefined };
          }
          write({ ...r, response: res });
        })
        .catch(() => write(r));
    } else if (method === "Network.webSocketCreated") {
      write({ websocket: String(p.url).split("?")[0] });
    } else if (method === "Network.webSocketFrameSent" || method === "Network.webSocketFrameReceived") {
      const d = String(p.response?.payloadData ?? "");
      let s: unknown;
      try {
        s = shapeOf(JSON.parse(d));
      } catch {
        s = `frame(${d.length})`;
      }
      write({ ws: method.endsWith("Sent") ? "out" : "in", frame: s });
    }
  });
}
