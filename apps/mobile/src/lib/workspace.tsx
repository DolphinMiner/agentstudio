import { createContext, useContext } from "react";
import type { Session } from "@agentstudio/core";
import type { Runtime } from "./runtime";

export type TabName = "Inbox" | "Approvals" | "Tasks" | "Connect" | "Settings";

export type WorkspaceContext = {
  rt: Runtime;
  session: Session;
  openRoom(roomId: string): void;
  goTab(tab: TabName): void;
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
