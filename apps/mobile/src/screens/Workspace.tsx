// Signed-in shell: bottom tabs (Inbox, Approvals, Tasks, Connect, Settings),
// a chat stack screen on top, and the "Ask an agent" sheet.
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, View, useColorScheme } from "react-native";
import {
  DarkTheme,
  DefaultTheme,
  NavigationContainer,
  StackActions,
  createNavigationContainerRef,
  type NavigatorScreenParams,
} from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { Sky } from "../components/Sky";
import type { Session } from "@agentstudio/core";
import { AskSheet } from "../components/AskSheet";
import { TabBar } from "../components/TabBar";
import { Runtime } from "../lib/runtime";
import { api } from "../lib/services";
import { useColors } from "../lib/theme";
import { WorkspaceCtx, type TabName, type WorkspaceContext } from "../lib/workspace";
import { ApprovalsScreen } from "./Approvals";
import { ChatScreen } from "./Chat";
import { ConnectScreen } from "./Connect";
import { InboxScreen } from "./Inbox";
import { SettingsScreen } from "./Settings";
import { TasksScreen } from "./Tasks";

export type InboxParams = {
  List: undefined;
  /** nonce changes when "Use" places a draft, so the chat re-reads its composer. */
  Chat: { roomId: string; nonce?: number };
};
export type TabParams = Omit<{ [K in TabName]: undefined }, "Inbox"> & { Inbox: NavigatorScreenParams<InboxParams> | undefined };

const InboxStack = createNativeStackNavigator<InboxParams>();
const Tab = createBottomTabNavigator<TabParams>();
const nav = createNavigationContainerRef<TabParams>();

/**
 * The chat is a stack screen inside the Inbox tab, so the tab bar (with the
 * approvals badge) stays reachable from a chat. Leaving the tab pops back to
 * the list.
 */
function Inbox() {
  return (
    <InboxStack.Navigator screenOptions={{ headerShown: false }} screenLayout={({ children }) => <Sky>{children}</Sky>}>
      <InboxStack.Screen name="List" component={InboxScreen} />
      <InboxStack.Screen name="Chat" component={ChatScreen} />
    </InboxStack.Navigator>
  );
}

function Tabs() {
  return (
    <Tab.Navigator
      screenOptions={{ headerShown: false }}
      // Each scene paints its own sky: inactive tabs stay mounted underneath.
      screenLayout={({ children }) => <Sky>{children}</Sky>}
      tabBar={(props) => <TabBar {...props} />}
    >
      <Tab.Screen name="Inbox" component={Inbox} options={{ popToTopOnBlur: true }} />
      <Tab.Screen name="Approvals" component={ApprovalsScreen} />
      <Tab.Screen name="Tasks" component={TasksScreen} />
      <Tab.Screen name="Connect" component={ConnectScreen} />
      <Tab.Screen name="Settings" component={SettingsScreen} />
    </Tab.Navigator>
  );
}

export function Workspace({ session }: { session: Session }) {
  const c = useColors();
  const scheme = useColorScheme();
  const [rt, setRt] = useState<Runtime | null>(null);
  const [askFor, setAskFor] = useState<{ roomId: string; messageId: string } | null>(null);

  // One runtime per signed-in session, created in an effect so StrictMode's
  // double mount does not leak a Matrix client.
  useEffect(() => {
    const r = new Runtime(api, session);
    setRt(r);
    r.start().catch(() => undefined); // The SDK keeps retrying; the inbox shows "Loading chats…".
    return () => {
      r.dispose();
      setRt(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ctx = useMemo<WorkspaceContext | null>(() => {
    if (!rt) return null;
    const openRoom = (roomId: string, nonce?: number) => {
      if (!nav.isReady()) return;
      // Keep at most one chat on the stack: chat -> chat replaces.
      if (nav.getCurrentRoute()?.name === "Chat") nav.dispatch(StackActions.replace("Chat", { roomId, nonce }));
      else nav.navigate("Inbox", { screen: "Chat", params: { roomId, nonce }, initial: false });
    };
    return {
      rt,
      session,
      openRoom: (roomId) => openRoom(roomId),
      goTab: (tab) => {
        if (nav.isReady()) nav.navigate(tab);
      },
      placeDraft: (roomId, text, taskId, draftIndex) => {
        rt.composer.set(roomId, { text, fromDraft: { taskId, draftIndex } });
        openRoom(roomId, Date.now());
      },
      ask: (roomId, messageId) => setAskFor({ roomId, messageId }),
    };
  }, [rt, session]);

  const theme = useMemo(() => {
    const base = scheme === "dark" ? DarkTheme : DefaultTheme;
    return {
      ...base,
      colors: { ...base.colors, background: c.canvas, card: c.surface, primary: c.accent, text: c.text, border: c.border },
    };
  }, [c, scheme]);

  if (!ctx) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: c.bg }}>
        <ActivityIndicator color={c.accent} />
      </View>
    );
  }

  return (
    <WorkspaceCtx.Provider value={ctx}>
      <NavigationContainer ref={nav} theme={theme}>
        <Tabs />
      </NavigationContainer>
      {askFor && (
        <AskSheet
          roomId={askFor.roomId}
          messageId={askFor.messageId}
          onClose={() => setAskFor(null)}
          onSent={(agentRoomId) => {
            setAskFor(null);
            ctx.openRoom(agentRoomId);
          }}
        />
      )}
    </WorkspaceCtx.Provider>
  );
}
