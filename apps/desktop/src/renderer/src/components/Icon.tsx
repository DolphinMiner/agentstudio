// UI icons from Lucide (https://lucide.dev, ISC). Names map AgentStudio's uses to
// Lucide components so screens don't depend on the library directly.

import {
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Ellipsis,
  FileText,
  Inbox,
  Laptop,
  ListChecks,
  Plug,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  X,
  type LucideIcon,
} from "lucide-react";

const icons: Record<string, LucideIcon> = {
  inbox: Inbox,
  check: Check,
  approvals: ShieldCheck,
  tasks: ListChecks,
  plug: Plug,
  gear: Settings,
  send: ArrowUp,
  spark: Sparkles,
  back: ChevronLeft,
  search: Search,
  plus: Plus,
  chevron: ChevronRight,
  clock: Clock,
  laptop: Laptop,
  close: X,
  more: Ellipsis,
  file: FileText,
};

export function Icon({ name, size = 18, stroke = 1.75 }: { name: string; size?: number; stroke?: number }) {
  const C = icons[name];
  if (!C) return null;
  return <C className="icon" size={size} strokeWidth={stroke} aria-hidden />;
}
