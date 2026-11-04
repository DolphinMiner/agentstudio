import { createContext, useContext } from "react";
import type { Session } from "@agentstudio/core";
import type { View } from "./logic";
import type { Runtime } from "./runtime";

export type Route = { view: View; roomId: string | null };

export type WorkspaceContext = {
  rt: Runtime;
  session: Session;
  route: Route;
  /** Switch screens; roomId selects a chat (implies the inbox). */
  go(view: View): void;
  openRoom(roomId: string): void;
  /** Back to the chat list (narrow windows). */
  closeRoom(): void;
  /** Put text into a room's composer (from a draft's "Use") and open the room. */
  placeDraft(roomId: string, text: string, taskId: string, draftIndex: number): void;
  /** Open the "Ask an agent" sheet for a message. */
  ask(roomId: string, messageId: string): void;
};

export const WorkspaceCtx = createContext<WorkspaceContext | null>(null);

export function useWorkspace(): WorkspaceContext {
  const ctx = useContext(WorkspaceCtx);
  if (!ctx) throw new Error("useWorkspace outside Workspace");
  return ctx;
}
