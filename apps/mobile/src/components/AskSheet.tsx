import { RoomAvatar } from "./RoomAvatar";
import { useMemo, useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  DEFAULT_ASK_REQUEST,
  askAgent,
  buildAskQuote,
  classifyRoom,
  roomDisplayName,
  roomMessages,
} from "@agentstudio/core";
import { errorText } from "../lib/errors";
import { useStore } from "../lib/hooks";
import { askableAgents } from "../lib/logic";
import { font, makeStyles, space, useColors } from "../lib/theme";
import { useWorkspace } from "../lib/workspace";
import { Avatar, Button, Checkbox, ErrorText } from "./ui";

/** "Ask an agent" bottom sheet: pick an agent, edit the request, review the quoted context. */
export function AskSheet({
  roomId,
  messageId,
  onClose,
  onSent,
}: {
  roomId: string;
  messageId: string;
  onClose(): void;
  onSent(agentRoomId: string): void;
}) {
  const s = useStyles();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { rt, goTab } = useWorkspace();
  const agentsSnap = useStore(rt.agents);
  const agents = askableAgents(agentsSnap.items);
  const [agentId, setAgentId] = useState<string | null>(null);
  const agent = agents.find((a) => a.id === agentId) ?? agents[0] ?? null;
  const [request, setRequest] = useState(DEFAULT_ASK_REQUEST);
  const [dontAsk, setDontAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Snapshot the context once, when the sheet opens.
  const ctx = useMemo(() => {
    const room = rt.matrix.getRoom(roomId);
    if (!room) return null;
    const me = rt.matrix.userId;
    const messages = roomMessages(room, me);
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx < 0) return null;
    const cls = classifyRoom(room, me);
    return {
      anchor: messages[idx]!,
      lines: buildAskQuote(messages, idx),
      chatName: roomDisplayName(room, me),
      network: cls.network,
      app: cls.networkLabel,
    };
  }, [rt, roomId, messageId]);
  const [included, setIncluded] = useState<boolean[]>(() => ctx?.lines.map(() => true) ?? []);

  const skipPreview = agent?.consent.ask_without_preview ?? false;

  async function send() {
    if (!agent || !ctx) return;
    setBusy(true);
    setError(null);
    try {
      const lines = skipPreview ? ctx.lines : ctx.lines.filter((_, i) => included[i]);
      const { send: sent } = await askAgent(
        { tasks: rt.tasks, matrix: rt.matrix },
        {
          agent,
          request,
          origin: { room_id: roomId, network: ctx.network, chat_name: ctx.chatName, anchor_event_id: ctx.anchor.id },
          app: ctx.app,
          lines,
          title: ctx.anchor.body,
        },
      );
      if (dontAsk && !skipPreview) await rt.agents.setConsent(agent.id, true).catch(() => undefined);
      if (!sent.ok) throw sent.error;
      onSent(agent.room_id!);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={s.backdrop} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <Pressable style={s.flex} accessibilityLabel="Close" onPress={onClose} />
        <View accessibilityViewIsModal style={[s.sheet, { paddingBottom: insets.bottom + space.lg }]}>
          <View style={s.grabber} />
          <Text accessibilityRole="header" style={s.title}>
            Ask an agent
          </Text>
          <ScrollView style={s.scroll} contentContainerStyle={s.scrollBody} keyboardShouldPersistTaps="handled">
            {agents.length === 0 ? (
              <View style={s.emptyBox}>
                <Text style={s.muted}>
                  {agentsSnap.loading ? "Loading agents…" : "No agents connected yet. Connect one to ask for help."}
                </Text>
                {!agentsSnap.loading && (
                  <Button
                    title="Connect an agent"
                    onPress={() => {
                      onClose();
                      goTab("Connect");
                    }}
                  />
                )}
              </View>
            ) : (
              <>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.agents} accessibilityRole="radiogroup">
                  {agents.map((a) => {
                    const on = a.id === agent?.id;
                    return (
                      <Pressable
                        key={a.id}
                        testID={`ask-agent-${a.name}`}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: on }}
                        aria-checked={on}
                        onPress={() => setAgentId(a.id)}
                        style={[s.agent, on && s.agentOn]}
                      >
                        <RoomAvatar roomId={a.room_id} name={a.name} agent size={26} />
                        <Text style={[s.agentName, on && s.agentNameOn]}>{a.name}</Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
                <Text style={s.label}>What should it do?</Text>
                <TextInput
                  testID="ask-request"
                  style={s.input}
                  value={request}
                  onChangeText={setRequest}
                  placeholderTextColor={c.muted}
                />
                {!ctx ? (
                  <Text style={s.error}>This message is no longer available.</Text>
                ) : skipPreview ? (
                  <Text style={s.muted}>
                    {ctx.lines.length} {ctx.lines.length === 1 ? "message" : "messages"} from {ctx.chatName} will be shared.
                  </Text>
                ) : (
                  <>
                    <Text style={s.label}>
                      Shared from {ctx.chatName} in {ctx.app}
                    </Text>
                    <View style={s.lines}>
                      {ctx.lines.map((l, i) => (
                        <View key={i} testID="ask-line" style={!included[i] && s.excluded}>
                          <Checkbox
                            testID="ask-line-toggle"
                            label={`${l.speaker}: ${l.text}`}
                            checked={!!included[i]}
                            onChange={(v) => setIncluded((xs) => xs.map((x, j) => (j === i ? v : x)))}
                          >
                            <Text style={s.lineText}>
                              <Text style={s.speaker}>{l.speaker}: </Text>
                              {l.text}
                            </Text>
                          </Checkbox>
                        </View>
                      ))}
                    </View>
                    <Checkbox testID="ask-dont-ask" label="Don't ask again for this agent" checked={dontAsk} onChange={setDontAsk} />
                  </>
                )}
              </>
            )}
            <ErrorText text={error} />
          </ScrollView>
          <View style={s.actions}>
            <Button testID="ask-cancel" variant="secondary" title="Cancel" onPress={onClose} style={s.flex} />
            <Button
              testID="ask-send"
              title="Send"
              busy={busy}
              disabled={!agent || !ctx || (!skipPreview && !included.some(Boolean))}
              onPress={() => void send()}
              style={s.flex}
            />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const useStyles = makeStyles((c) => ({
  flex: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)" },
  sheet: {
    backgroundColor: c.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    maxHeight: "88%",
    gap: space.md,
  },
  grabber: { alignSelf: "center", width: 36, height: 5, borderRadius: 3, backgroundColor: c.border },
  title: { color: c.text, fontSize: 20, fontWeight: "700", fontFamily: font.family },
  scroll: { flexGrow: 0 },
  scrollBody: { gap: space.md },
  emptyBox: { gap: space.md, alignItems: "stretch" },
  muted: { color: c.muted, fontSize: font.small, fontFamily: font.family },
  agents: { gap: space.sm },
  agent: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingVertical: 6,
    paddingLeft: 6,
    paddingRight: space.md,
    borderRadius: 22,
    borderWidth: 1.5,
    borderColor: c.border,
  },
  agentOn: { borderColor: c.accent, backgroundColor: c.accentSoft },
  agentName: { color: c.text, fontSize: font.body, fontFamily: font.family },
  agentNameOn: { fontWeight: "600" },
  label: { color: c.muted, fontSize: font.small, fontWeight: "600", fontFamily: font.family },
  input: {
    backgroundColor: c.bg,
    borderColor: c.border,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: space.md,
    height: 44,
    fontSize: font.body,
    color: c.text,
    fontFamily: font.family,
  },
  lines: { backgroundColor: c.bg, borderRadius: 12, paddingHorizontal: space.md, paddingVertical: space.xs },
  excluded: { opacity: 0.45 },
  lineText: { color: c.text, fontSize: font.small + 1, lineHeight: 19, fontFamily: font.family },
  speaker: { fontWeight: "600" },
  error: { color: c.danger, fontSize: font.small, fontFamily: font.family },
  actions: { flexDirection: "row", gap: space.sm },
}));
