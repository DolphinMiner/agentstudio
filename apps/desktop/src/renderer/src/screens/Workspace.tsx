import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@agentstudio/core";
import { AskModal } from "../components/AskModal";
import { Sidebar } from "../components/Sidebar";
import { desktop } from "../lib/desktop";
import type { View } from "../lib/logic";
import { startNotifications } from "../lib/notifications";
import { Runtime } from "../lib/runtime";
import { api } from "../lib/services";
import { WorkspaceCtx, type Route, type WorkspaceContext } from "../lib/workspace";
import { ApprovalsScreen } from "./Approvals";
import { ConnectScreen } from "./Connect";
import { InboxScreen } from "./Inbox";
import { SettingsScreen } from "./Settings";
import { TasksScreen } from "./Tasks";

export function Workspace({ session }: { session: Session }) {
  const [rt, setRt] = useState<Runtime | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [route, setRoute] = useState<Route>({ view: "inbox", roomId: null });
  const [askFor, setAskFor] = useState<{ roomId: string; messageId: string } | null>(null);
  const [composerNonce, setComposerNonce] = useState(0);

  // One runtime per signed-in session. Created in an effect so StrictMode's
  // double mount does not leak a Matrix client.
  useEffect(() => {
    const r = new Runtime(api, session);
    setRt(r);
    r.start().catch(() => setStartError("Could not connect to the message server. Retrying in the background…"));
    return () => {
      r.dispose();
      setRt(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Notifications and the Dock badge read the route to skip the chat on screen.
  const routeRef = useRef(route);
  routeRef.current = route;
  useEffect(() => (rt ? startNotifications(rt, () => routeRef.current) : undefined), [rt]);

  const openRoom = useCallback((roomId: string) => setRoute({ view: "inbox", roomId }), []);
  // A clicked notification opens its chat, Approvals, or Connect.
  useEffect(
    () =>
      rt
        ? desktop.notifications.onClick((t) => setRoute((r) => (t.view === "inbox" && t.roomId ? { view: "inbox", roomId: t.roomId } : { ...r, view: t.view })))
        : undefined,
    [rt],
  );

  const ctx = useMemo<WorkspaceContext | null>(() => {
    if (!rt) return null;
    return {
      rt,
      session,
      route,
      go: (view: View) => setRoute((r) => ({ ...r, view })),
      openRoom,
      closeRoom: () => setRoute((r) => ({ ...r, roomId: null })),
      placeDraft: (roomId, text, taskId, draftIndex) => {
        rt.composer.set(roomId, { text, fromDraft: { taskId, draftIndex } });
        setComposerNonce((n) => n + 1);
        openRoom(roomId);
      },
      ask: (roomId, messageId) => setAskFor({ roomId, messageId }),
    };
  }, [rt, session, route, openRoom]);

  if (!ctx) return <div className="splash" />;

  return (
    <WorkspaceCtx.Provider value={ctx}>
      <div className="app">
        <Sidebar />
        <main className="main">
          {startError && <div className="banner">{startError}</div>}
          {route.view === "inbox" && <InboxScreen composerNonce={composerNonce} />}
          {route.view === "approvals" && <ApprovalsScreen />}
          {route.view === "tasks" && <TasksScreen />}
          {route.view === "connect" && <ConnectScreen />}
          {route.view === "settings" && <SettingsScreen />}
        </main>
        {askFor && (
          <AskModal
            roomId={askFor.roomId}
            messageId={askFor.messageId}
            onClose={() => setAskFor(null)}
            onSent={(agentRoomId) => {
              setAskFor(null);
              openRoom(agentRoomId);
            }}
          />
        )}
      </div>
    </WorkspaceCtx.Provider>
  );
}
