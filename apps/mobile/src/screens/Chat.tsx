import { RoomAvatar } from "../components/RoomAvatar";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
  type TextInputKeyPressEvent,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Ionicons from "@expo/vector-icons/Ionicons";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { classifyRoom, roomDisplayName, type ChatMessage } from "@agentstudio/core";
import { ApprovalCard } from "../components/ApprovalCard";
import { DraftsCard } from "../components/DraftsCard";
import { Avatar, Button } from "../components/ui";
import { useStore, useVersion } from "../lib/hooks";
import { tid } from "../lib/testProps";
import { font, makeStyles, space, useColors } from "../lib/theme";
import { useWorkspace } from "../lib/workspace";
import type { InboxParams } from "./Workspace";

type Props = NativeStackScreenProps<InboxParams, "Chat">;

export function ChatScreen({ route, navigation }: Props) {
  const onBack = () => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate("List"));
  // Re-mount when "Use" places a new draft so the composer picks it up.
  return <ChatView key={`${route.params.roomId}:${route.params.nonce ?? 0}`} roomId={route.params.roomId} onBack={onBack} />;
}

function ChatView({ roomId, onBack }: { roomId: string; onBack(): void }) {
  const s = useStyles();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { rt, ask, goTab } = useWorkspace();
  const me = rt.matrix.userId;
  const messages = useStore(useMemo(() => rt.matrix.messagesStore(roomId), [rt, roomId]));
  useVersion(rt.matrix);
  const agents = useStore(rt.agents);
  const room = rt.matrix.getRoom(roomId);
  const cls = room ? classifyRoom(room, me) : null;
  const agent = agents.items.find((a) => a.room_id === roomId);
  const name = agent?.name ?? (room ? roomDisplayName(room, me) : "");
  // Show sender names when more than one other person speaks (bridged DMs
  // also contain the bridge bot, so member counts are misleading).
  const isGroup = useMemo(() => new Set(messages.filter((m) => !m.own).map((m) => m.sender)).size > 1, [messages]);

  // ---- composer (text survives leaving the chat; "Use" can prefill it) ----
  const initial = rt.composer.get(roomId);
  const [text, setText] = useState(initial?.text ?? "");
  const fromDraft = useRef(initial?.fromDraft ?? null);
  useEffect(() => {
    if (text || fromDraft.current) rt.composer.set(roomId, { text, fromDraft: fromDraft.current });
    else rt.composer.delete(roomId);
  }, [rt, roomId, text]);

  async function send() {
    const body = text.trim();
    if (!body) return;
    const draft = fromDraft.current;
    fromDraft.current = null;
    setText("");
    const res = await rt.matrix.sendText(roomId, body);
    // The user sent (possibly edited) agent draft text back to the origin chat.
    if (res.ok && draft) rt.tasks.markSent(draft.taskId, draft.draftIndex).catch(() => undefined);
  }

  // Web: Enter sends, Shift+Enter adds a line.
  function onKeyPress(e: TextInputKeyPressEvent) {
    const ne = e.nativeEvent as { key: string; shiftKey?: boolean; isComposing?: boolean };
    if (Platform.OS === "web" && ne.key === "Enter" && !ne.shiftKey && !ne.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  // ---- read receipts while the chat is open and the app is active ----
  const lastId = messages.at(-1)?.id;
  useEffect(() => {
    const mark = () => {
      if (AppState.currentState === "active") void rt.matrix.markRead(roomId);
    };
    mark();
    const sub = AppState.addEventListener("change", mark);
    return () => sub.remove();
  }, [rt, roomId, lastId]);

  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasOlder, setHasOlder] = useState(true);
  async function loadOlder() {
    setLoadingOlder(true);
    try {
      setHasOlder(await rt.matrix.loadOlder(roomId));
    } finally {
      setLoadingOlder(false);
    }
  }

  const [menuFor, setMenuFor] = useState<ChatMessage | null>(null);
  const reversed = useMemo(() => [...messages].reverse(), [messages]);
  const canAsk = (m: ChatMessage) => !cls?.isAgentRoom && !m.approval && !m.drafts && !!m.body.trim();

  return (
    <KeyboardAvoidingView style={s.root} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={[s.header, { paddingTop: insets.top + space.sm }]}>
        <Pressable testID="chat-back" accessibilityRole="button" accessibilityLabel="Back" onPress={onBack} hitSlop={10} style={s.back}>
          <Ionicons name="chevron-back" size={24} color={c.accent} />
          <Text style={s.backText}>Chats</Text>
        </Pressable>
        <View style={s.identity}>
          <RoomAvatar roomId={roomId} name={name} agent={cls?.isAgentRoom} size={52} attention={!!agent && agent.pending_approvals > 0} />
          <View style={s.namePill}>
            <Text testID="chat-title" numberOfLines={1} style={s.title}>
              {name}
            </Text>
          </View>
          <View style={s.headerSub}>
            <Text testID="chat-network" style={s.network}>
              {cls?.networkLabel ?? ""}
            </Text>
            {agent && (agent.status_text || agent.status === "working") ? (
              <Text numberOfLines={1} style={s.status}>
                {agent.status_text || "Working"}
              </Text>
            ) : null}
          </View>
        </View>
        <View style={s.headerSide}>
          {agent && agent.pending_approvals > 0 && (
            <Pressable accessibilityRole="button" onPress={() => goTab("Approvals")} style={s.porchPill}>
              <Text style={s.porchPillText}>{agent.pending_approvals} waiting</Text>
            </Pressable>
          )}
        </View>
      </View>

      {!room ? (
        <Text style={s.unavailable}>This chat is not available.</Text>
      ) : (
        <FlatList
          testID="timeline"
          inverted
          data={reversed}
          keyExtractor={(m) => m.id}
          contentContainerStyle={s.timeline}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item, index }) => (
            <MessageItem
              m={item}
              // reversed list: the previous (older) message is at index + 1
              showName={isGroup && !item.own && reversed[index + 1]?.sender !== item.sender}
              canAsk={canAsk(item)}
              onAsk={() => ask(roomId, item.id)}
              onLongPress={() => canAsk(item) && setMenuFor(item)}
              onRetry={() => void rt.matrix.retry(roomId, item.id)}
            />
          )}
          ListFooterComponent={
            hasOlder && messages.length >= 20 ? (
              <Button
                variant="link"
                small
                title={loadingOlder ? "Loading…" : "Load earlier messages"}
                disabled={loadingOlder}
                onPress={() => void loadOlder()}
              />
            ) : undefined
          }
        />
      )}

      <View style={[s.composer, { marginBottom: Math.max(insets.bottom, space.sm), paddingBottom: 5 }]}>
        <TextInput
          testID="composer-input"
          style={s.input}
          multiline
          {...(Platform.OS === "web" ? ({ rows: 1 } as object) : {})}
          value={text}
          onChangeText={setText}
          onKeyPress={onKeyPress}
          placeholder={`Message ${name}`}
          placeholderTextColor={c.muted}
        />
        <Pressable
          testID="composer-send"
          accessibilityRole="button"
          accessibilityLabel="Send"
          disabled={!text.trim()}
          onPress={() => void send()}
          style={[s.send, !text.trim() && s.sendDisabled]}
        >
          <Ionicons name="arrow-up" size={20} color={c.accentText} />
        </Pressable>
      </View>

      {/* Long-press menu (native and web). */}
      <Modal visible={!!menuFor} transparent animationType="fade" onRequestClose={() => setMenuFor(null)}>
        <Pressable style={s.menuBackdrop} onPress={() => setMenuFor(null)}>
          <View style={[s.menu, { marginBottom: insets.bottom + space.lg }]}>
            <Text numberOfLines={2} style={s.menuQuote}>
              {menuFor?.body}
            </Text>
            <Button
              testID="message-ask"
              title="Ask an agent"
              icon={<Ionicons name="sparkles" size={16} color={c.accentText} />}
              onPress={() => {
                const m = menuFor;
                setMenuFor(null);
                if (m) ask(roomId, m.id);
              }}
            />
            <Button variant="secondary" title="Cancel" onPress={() => setMenuFor(null)} />
          </View>
        </Pressable>
      </Modal>
    </KeyboardAvoidingView>
  );
}

function MessageItem({
  m,
  showName,
  canAsk,
  onAsk,
  onLongPress,
  onRetry,
}: {
  m: ChatMessage;
  showName: boolean;
  canAsk: boolean;
  onAsk(): void;
  onLongPress(): void;
  onRetry(): void;
}) {
  const s = useStyles();
  const c = useColors();
  return (
    <View {...tid("message", { sender: m.senderName, own: String(m.own) })} style={[s.msg, m.own ? s.msgOwn : s.msgOther]}>
      {showName && <Text style={s.sender}>{m.senderName}</Text>}
      {m.approval ? (
        <ApprovalCard approvalId={m.approval.approval_id} />
      ) : m.drafts ? (
        <DraftsCard payload={m.drafts} />
      ) : (
        <View style={[s.bubbleRow, m.own && s.bubbleRowOwn]}>
          <Pressable
            style={s.bubbleWrap}
            onLongPress={onLongPress}
            delayLongPress={350}
            accessibilityHint={canAsk ? "Long-press for actions" : undefined}
          >
            <View
              style={[
                s.bubble,
                m.own ? s.bubbleOwn : s.bubbleOther,
                m.msgtype === "m.notice" && s.bubbleNotice,
                m.ask && s.bubbleAsk,
              ]}
            >
              <Text testID="message-body" selectable style={[s.body, m.own && !m.ask && s.bodyOwn]}>
                {m.body}
              </Text>
            </View>
          </Pressable>
          {/* Web has no comfortable long-press, so a small visible action as well. */}
          {canAsk && Platform.OS === "web" && (
            <Pressable
              testID="message-ask"
              accessibilityRole="button"
              accessibilityLabel="Ask an agent"
              onPress={onAsk}
              hitSlop={8}
              style={({ pressed }) => [s.askBtn, pressed && s.askBtnPressed]}
            >
              <Ionicons name="sparkles-outline" size={14} color={c.accent} />
            </Pressable>
          )}
        </View>
      )}
      {m.status === "sending" && <Text style={s.meta}>Sending…</Text>}
      {m.status === "failed" && (
        <Pressable testID="message-failed" accessibilityRole="button" onPress={onRetry} style={s.failed}>
          <Text style={s.failedText}>Not sent. Tap to retry.</Text>
        </Pressable>
      )}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.canvas },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingHorizontal: space.sm,
    paddingBottom: space.sm,
  },
  back: { flexDirection: "row", alignItems: "center", width: 84, paddingTop: 4 },
  backText: { color: c.accent, fontSize: font.body, fontFamily: font.family },
  identity: { flex: 1, alignItems: "center", gap: 5, minWidth: 0 },
  namePill: {
    backgroundColor: c.surface,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 3,
    maxWidth: "100%",
    shadowColor: "#1A2233",
    shadowOpacity: 0.08,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
  },
  title: { color: c.text, fontSize: 15, fontWeight: "700", fontFamily: font.display ?? font.family, letterSpacing: -0.2 },
  headerSub: { flexDirection: "row", gap: space.sm, alignItems: "center" },
  headerSide: { width: 84, alignItems: "flex-end", paddingTop: 4 },
  porchPill: { backgroundColor: c.porchSoft, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 },
  porchPillText: { color: c.porchInk, fontSize: font.tiny + 1, fontWeight: "700", fontFamily: font.family },
  network: { color: c.muted, fontSize: font.small - 1, fontFamily: font.family },
  status: { color: c.success, fontSize: font.small - 1, fontWeight: "600", flexShrink: 1, fontFamily: font.family },
  unavailable: { color: c.muted, textAlign: "center", padding: space.xl, flex: 1, fontFamily: font.family },
  timeline: { paddingHorizontal: space.md, paddingVertical: space.md, gap: 6 },
  msg: { maxWidth: "86%", gap: 3 },
  msgOwn: { alignSelf: "flex-end", alignItems: "flex-end" },
  msgOther: { alignSelf: "flex-start", alignItems: "flex-start" },
  sender: { color: c.muted, fontSize: font.tiny, fontWeight: "600", marginLeft: space.sm, fontFamily: font.family },
  bubble: { borderRadius: 20, paddingHorizontal: 14, paddingVertical: 9 },
  bubbleOwn: { backgroundColor: c.bubbleOwn, borderBottomRightRadius: 6 },
  bubbleOther: { backgroundColor: c.bubbleOther, borderBottomLeftRadius: 6, borderWidth: 1, borderColor: "rgba(255,255,255,0.8)" },
  bubbleNotice: { backgroundColor: c.surfaceAlt, borderColor: c.surfaceAlt },
  bubbleAsk: { backgroundColor: c.accentSoft, borderColor: c.accentSoft },
  body: { color: c.text, fontSize: font.body, lineHeight: 21, fontFamily: font.family },
  bodyOwn: { color: c.bubbleOwnText },
  bubbleRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  bubbleRowOwn: { flexDirection: "row-reverse" },
  bubbleWrap: { flexShrink: 1 },
  askBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  askBtnPressed: { backgroundColor: c.accentSoft },
  meta: { color: c.muted, fontSize: font.tiny, fontFamily: font.family },
  failed: { paddingVertical: 2 },
  failedText: { color: c.danger, fontSize: font.small, fontWeight: "600", fontFamily: font.family },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: space.sm,
    marginHorizontal: space.md,
    marginBottom: space.sm,
    paddingLeft: space.md,
    paddingRight: 5,
    paddingTop: 5,
    borderRadius: 26,
    backgroundColor: c.surface,
    shadowColor: "#1A2233",
    shadowOpacity: 0.1,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    paddingHorizontal: 4,
    // The composer pill is the focus affordance; no inner web outline.
    ...(Platform.OS === "web" ? ({ outlineWidth: 0 } as object) : {}),
    paddingTop: 10,
    paddingBottom: 10,
    fontSize: font.body,
    color: c.text,
    fontFamily: font.family,
  },
  send: { width: 38, height: 38, borderRadius: 19, backgroundColor: c.accent, alignItems: "center", justifyContent: "center" },
  sendDisabled: { opacity: 0.25 },
  menuBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)", justifyContent: "flex-end", paddingHorizontal: space.md },
  menu: { backgroundColor: c.surface, borderRadius: 16, padding: space.lg, gap: space.sm },
  menuQuote: { color: c.muted, fontSize: font.small, marginBottom: space.xs, fontFamily: font.family },
}));
