import { useEffect, useState } from "react";
import type { Runtime } from "./runtime";

// Matrix media is authenticated, so avatars are fetched with the session's
// token and shown from blob: URLs (allowed by the CSP). Cached per mxc+size.

const cache = new Map<string, Promise<string | null>>();

function load(rt: Runtime, mxc: string, size: number): Promise<string | null> {
  const key = `${mxc}@${size}`;
  let p = cache.get(key);
  if (!p) {
    const req = rt.matrix.mediaRequest(mxc, size * 2);
    p = req
      ? fetch(req.url, { headers: req.headers })
          .then((r) => (r.ok ? r.blob() : null))
          .then((b) => (b && b.type.startsWith("image/") ? URL.createObjectURL(b) : null))
          .catch(() => null)
      : Promise.resolve(null);
    // Retry failures later (the bridge may still be uploading the avatar).
    void p.then((url) => {
      if (!url) setTimeout(() => cache.delete(key), 30_000);
    });
    cache.set(key, p);
  }
  return p;
}

/** A blob: URL for an mxc:// image, or null while loading / when there is none. */
export function useMxcImage(rt: Runtime, mxc: string | null | undefined, size: number): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setUrl(null);
    if (mxc) void load(rt, mxc, size).then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, [rt, mxc, size]);
  return url;
}
