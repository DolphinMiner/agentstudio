import { useVersion } from "../lib/hooks";
import { useMxcImage } from "../lib/media";
import { useWorkspace } from "../lib/workspace";
import { Mark, type MarkId } from "./Mark";

// Avatars: people are circles, agents are squircles, so the two read apart at a
// glance. A small mark in the corner says which network or service it's on.
// An agent always shows a picture: its own avatar, else its service's icon,
// else AgentStudio's agent icon. Only people fall back to initials.

function hue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

export function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "#";
  return (words[0]![0]! + (words.length > 1 ? words[words.length - 1]![0]! : "")).toUpperCase();
}

export function Avatar({
  name,
  agent = false,
  size = 40,
  badge,
  mark,
  attention = false,
  src,
}: {
  name: string;
  agent?: boolean;
  size?: number;
  /** Small network/service mark in the corner. */
  badge?: MarkId | null;
  /** Show this mark as the avatar itself (known services). */
  mark?: MarkId | null;
  /** The porch light: this agent is waiting on you. */
  attention?: boolean;
  /** A real picture (the person's or agent's own avatar). Wins over the mark (and a person's initials). */
  src?: string | null;
}) {
  const shape = agent ? "squircle" : "circle";
  return (
    <span
      className={`avatar ${shape}${attention ? " attention" : ""}`}
      style={{ width: size, height: size, ["--h" as string]: hue(name), ["--r" as string]: `${size * 0.3}px` }}
      aria-hidden
    >
      {src ? (
        <img data-testid="avatar-image" className="avatar-img" src={src} alt="" draggable={false} />
      ) : mark || agent ? (
        <Mark id={mark ?? "agents"} size={size} />
      ) : (
        <span data-testid="avatar-initials" className="avatar-face" style={{ fontSize: size * 0.38 }}>
          {initials(name)}
        </span>
      )}
      {badge && (
        <span className="avatar-badge">
          <Mark id={badge} size={Math.max(14, Math.round(size * 0.38))} />
        </span>
      )}
    </span>
  );
}

/** Avatar for a chat: its real Matrix avatar when it has one (people, agents), else the mark or initials. */
export function RoomAvatar({
  roomId,
  serviceBadge,
  ...props
}: Parameters<typeof Avatar>[0] & {
  roomId: string | null | undefined;
  /** The service's mark, shown in the corner once a real picture replaces the service image. */
  serviceBadge?: MarkId | null;
}) {
  const { rt } = useWorkspace();
  useVersion(rt.matrix);
  const mxc = roomId ? rt.matrix.avatarMxc(roomId) : null;
  const src = useMxcImage(rt, mxc, props.size ?? 40);
  return <Avatar {...props} src={src} badge={props.badge ?? (src ? serviceBadge : null)} />;
}
