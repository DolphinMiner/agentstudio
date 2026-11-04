import { useEffect, useState } from "react";
import { Image, Platform, View } from "react-native";
import { useVersion } from "../lib/hooks";
import { useWorkspace } from "../lib/workspace";
import { Avatar } from "./ui";

// Matrix media is authenticated. Native Image can send the token as a header;
// on web an <img> can't, so the picture is fetched and shown from a blob: URL.

const webCache = new Map<string, Promise<string | null>>();

function webBlobUrl(url: string, headers: Record<string, string>): Promise<string | null> {
  let p = webCache.get(url);
  if (!p) {
    p = fetch(url, { headers })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => (b && b.type.startsWith("image/") ? URL.createObjectURL(b) : null))
      .catch(() => null);
    void p.then((u) => {
      if (!u) setTimeout(() => webCache.delete(url), 30_000);
    });
    webCache.set(url, p);
  }
  return p;
}

/** A chat's real avatar (the person's or agent's own picture), falling back to initials. */
export function RoomAvatar({
  roomId,
  name,
  agent,
  size = 44,
  attention,
}: {
  roomId: string | null | undefined;
  name: string;
  agent?: boolean;
  size?: number;
  attention?: boolean;
}) {
  const { rt } = useWorkspace();
  useVersion(rt.matrix);
  const mxc = roomId ? rt.matrix.avatarMxc(roomId) : null;
  const req = mxc ? rt.matrix.mediaRequest(mxc, size * 2) : null;
  const [webUrl, setWebUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setWebUrl(null);
    if (req && Platform.OS === "web") void webBlobUrl(req.url, req.headers).then((u) => live && setWebUrl(u));
    return () => {
      live = false;
    };
    // req is derived from mxc and size.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mxc, size]);

  const source = !req ? null : Platform.OS === "web" ? (webUrl ? { uri: webUrl } : null) : { uri: req.url, headers: req.headers };
  if (!source) return <Avatar name={name} agent={agent} size={size} attention={attention} />;
  return (
    <View style={{ width: size, height: size }}>
      <Image
        testID="avatar-image"
        source={source}
        style={{ width: size, height: size, borderRadius: agent ? size * 0.3 : size / 2 }}
        accessibilityIgnoresInvertColors
      />
      {attention && <Avatar.Dot />}
    </View>
  );
}
