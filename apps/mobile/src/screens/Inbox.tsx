import { RoomAvatar } from "../components/RoomAvatar";
import { useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import type { ChatRow, InboxFilter } from "@agentstudio/core";
import { Avatar, Badge, Button, Empty, ScreenHeader } from "../components/ui";
import { useNow, useStore, useVersion } from "../lib/hooks";
import { badgeText, formatTime, rowPreview } from "../lib/logic";
import { tid } from "../lib/testProps";
import { font, makeStyles, space } from "../lib/theme";
import { useWorkspace } from "../lib/workspace";

const FILTERS: { id: InboxFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "people", label: "People" },
  { id: "agents", label: "Agents" },
];

export function InboxScreen() {
  const s = useStyles();
  const { rt, openRoom, goTab } = useWorkspace();
  const [filter, setFilter] = useState<InboxFilter>("all");
  const rows = useStore(rt.inbox.rows);
  useVersion(rt.matrix);
  const visible = rt.inbox.filtered(filter);
  const synced = rt.matrix.getSyncStatus() === "syncing";
  const now = useNow(60_000);

  return (
    <View style={s.root}>
      <ScreenHeader title="Inbox" />
      <View style={s.segmented} accessibilityRole="tablist">
        {FILTERS.map((f) => (
          <Pressable
            key={f.id}
            testID={`inbox-filter-${f.id}`}
            accessibilityRole="tab"
            accessibilityState={{ selected: filter === f.id }}
            style={[s.segment, filter === f.id && s.segmentOn]}
            onPress={() => setFilter(f.id)}
          >
            <Text style={[s.segmentText, filter === f.id && s.segmentTextOn]}>{f.label}</Text>
          </Pressable>
        ))}
      </View>
      {!synced && rows.length === 0 ? (
        <Text style={s.loading}>Loading chats…</Text>
      ) : rows.length === 0 ? (
        <Empty testID="inbox-empty" title="No chats yet" text="Connect an account or an agent to see your conversations here.">
          <Button testID="inbox-connect" title="Connect an account" onPress={() => goTab("Connect")} style={s.emptyBtn} />
        </Empty>
      ) : (
        <FlatList
          testID="chat-list"
          data={visible}
          keyExtractor={(r) => r.roomId}
          renderItem={({ item }) => <ChatRowItem row={item} now={now} onOpen={() => openRoom(item.roomId)} />}
          ItemSeparatorComponent={() => <View style={s.sep} />}
          ListEmptyComponent={<Text style={s.loading}>Nothing here.</Text>}
        />
      )}
    </View>
  );
}

function ChatRowItem({ row, now, onOpen }: { row: ChatRow; now: number; onOpen(): void }) {
  const s = useStyles();
  const status = row.isAgent ? row.agentStatusText || row.agentStatus : null;
  return (
    <Pressable
      {...tid("chat-row", { roomName: row.name })}
      accessibilityRole="button"
      accessibilityLabel={row.name}
      onPress={onOpen}
      style={({ pressed }) => [s.row, pressed && s.rowPressed]}
    >
      <RoomAvatar roomId={row.roomId} name={row.name} agent={row.isAgent} attention={row.needsYou} />
      <View style={s.rowMain}>
        <View style={s.rowTop}>
          <Text testID="chat-row-name" numberOfLines={1} style={[s.name, row.unread > 0 && s.bold]}>
            {row.name}
          </Text>
          <Text testID="chat-row-network" style={s.network}>
            {row.networkLabel}
          </Text>
          <Text style={s.time}>{row.lastTs ? formatTime(row.lastTs, now) : ""}</Text>
        </View>
        <View style={s.rowBottom}>
          {status ? (
            <Text testID="chat-row-status" style={s.status} numberOfLines={1}>
              {status}
            </Text>
          ) : null}
          <Text numberOfLines={1} style={[s.preview, row.unread > 0 && s.previewUnread]}>
            {rowPreview(row)}
          </Text>
          {row.needsYou && (
            <Text testID="chat-row-needs-you" style={s.needsYou}>
              Needs you
            </Text>
          )}
          {row.unread > 0 && <Badge testID="chat-row-unread" count={badgeText(row.unread)} />}
        </View>
      </View>
    </Pressable>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.canvas },
  segmented: {
    flexDirection: "row",
    marginHorizontal: space.lg,
    marginBottom: space.sm,
    backgroundColor: c.surfaceAlt,
    borderRadius: 10,
    padding: 3,
  },
  segment: { flex: 1, alignItems: "center", paddingVertical: 7, borderRadius: 8 },
  segmentOn: { backgroundColor: c.surface, shadowColor: "#000", shadowOpacity: 0.08, shadowRadius: 3, shadowOffset: { width: 0, height: 1 } },
  segmentText: { color: c.muted, fontSize: font.small, fontWeight: "600", fontFamily: font.family },
  segmentTextOn: { color: c.text },
  loading: { color: c.muted, textAlign: "center", padding: space.xl, fontFamily: font.family },
  emptyBtn: { marginTop: space.md },
  sep: { height: 1, backgroundColor: c.border, marginLeft: 76 },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md, backgroundColor: c.canvas },
  rowPressed: { backgroundColor: c.surfaceAlt },
  rowMain: { flex: 1, minWidth: 0, gap: 3 },
  rowTop: { flexDirection: "row", alignItems: "center", gap: space.sm },
  name: { flexShrink: 1, color: c.text, fontSize: font.body, fontWeight: "500", fontFamily: font.family },
  bold: { fontWeight: "700" },
  network: {
    color: c.muted,
    fontSize: font.tiny,
    fontWeight: "600",
    backgroundColor: c.surfaceAlt,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 5,
    overflow: "hidden",
    fontFamily: font.family,
  },
  time: { marginLeft: "auto", color: c.muted, fontSize: font.small, fontFamily: font.family },
  rowBottom: { flexDirection: "row", alignItems: "center", gap: space.sm },
  status: { color: c.agent, fontSize: font.small, fontWeight: "600", fontFamily: font.family },
  preview: { flex: 1, color: c.muted, fontSize: font.small + 1, fontFamily: font.family },
  previewUnread: { color: c.text },
  needsYou: {
    color: c.warning,
    fontSize: font.tiny,
    fontWeight: "700",
    borderWidth: 1,
    borderColor: c.warning,
    borderRadius: 6,
    paddingHorizontal: 5,
    paddingVertical: 1,
    fontFamily: font.family,
  },
}));
