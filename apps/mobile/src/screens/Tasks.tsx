import { useCallback, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import type { Task } from "@agentstudio/core";
import { Button, ErrorText, ScreenHeader } from "../components/ui";
import { errorText } from "../lib/errors";
import { useNow, useStore } from "../lib/hooks";
import { formatTime, groupTasks, type TaskColumn } from "../lib/logic";
import { tid } from "../lib/testProps";
import { font, makeStyles, space, type Colors, useColors } from "../lib/theme";
import { useWorkspace } from "../lib/workspace";

const COLUMNS: { id: TaskColumn; label: string }[] = [
  { id: "pending", label: "Waiting for agent" },
  { id: "answered", label: "Drafts ready" },
  { id: "done", label: "Done" },
];

const STATE_LABEL: Record<Task["state"], string> = {
  pending: "Pending",
  answered: "Answered",
  done: "Sent",
  cancelled: "Cancelled",
  failed: "Failed",
};

/** Tasks board. On a phone the three columns stack vertically as sections. */
export function TasksScreen() {
  const s = useStyles();
  const { rt } = useWorkspace();
  const snap = useStore(rt.tasks);
  const cols = groupTasks(snap.items);
  const now = useNow(60_000);
  useFocusEffect(
    useCallback(() => {
      void rt.tasks.refresh();
    }, [rt]),
  );

  return (
    <View style={s.root}>
      <ScreenHeader title="Tasks" subtitle="Things you asked your agents to help with." />
      <ScrollView testID="tasks-board" contentContainerStyle={s.board}>
        {COLUMNS.map((col) => (
          <View key={col.id} testID={`tasks-col-${col.id}`} style={s.col}>
            <Text style={s.colTitle}>
              {col.label} <Text style={s.count}>{cols[col.id].length}</Text>
            </Text>
            {cols[col.id].map((t) => (
              <TaskCard key={t.id} task={t} now={now} />
            ))}
            {cols[col.id].length === 0 && <Text style={s.muted}>Nothing here.</Text>}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

function pillColor(c: Colors, state: Task["state"]): string {
  if (state === "answered") return c.accent;
  if (state === "done") return c.success;
  if (state === "failed") return c.danger;
  return c.muted;
}

function TaskCard({ task, now }: { task: Task; now: number }) {
  const s = useStyles();
  const c = useColors();
  const { rt, openRoom } = useWorkspace();
  const [error, setError] = useState<string | null>(null);
  const agent = rt.agents.get(task.agent_id);
  const target = task.state === "answered" ? agent?.room_id : task.origin.room_id;
  return (
    <View {...tid("task-card", { state: task.state })} style={s.card}>
      <Pressable accessibilityRole="button" disabled={!target} onPress={() => target && openRoom(target)} style={s.cardMain}>
        <Text numberOfLines={2} style={s.cardTitle}>
          {task.title || task.request_text}
        </Text>
        <Text style={s.muted}>
          {task.agent_name} · {task.origin.chat_name} · {formatTime(Date.parse(task.updated_at), now)}
        </Text>
        <Text numberOfLines={2} style={s.muted}>
          “{task.request_text}”
        </Text>
      </Pressable>
      <View style={s.foot}>
        <Text style={[s.pill, { color: pillColor(c, task.state), borderColor: pillColor(c, task.state) }]}>{STATE_LABEL[task.state]}</Text>
        {(task.state === "pending" || task.state === "answered") && (
          <Button small variant="link" title="Cancel" onPress={() => rt.tasks.cancel(task.id).catch((e) => setError(errorText(e)))} />
        )}
      </View>
      <ErrorText text={error} />
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.canvas },
  board: { paddingHorizontal: space.lg, paddingBottom: space.xl, gap: space.xl },
  col: { gap: space.sm },
  colTitle: { color: c.text, fontSize: font.heading, fontWeight: "600", fontFamily: font.family },
  count: { color: c.muted, fontWeight: "400" },
  muted: { color: c.muted, fontSize: font.small, fontFamily: font.family },
  card: { backgroundColor: c.surface, borderRadius: 14, borderWidth: 1, borderColor: c.border, padding: space.md, gap: space.sm },
  cardMain: { gap: 3 },
  cardTitle: { color: c.text, fontSize: font.body, fontWeight: "600", fontFamily: font.family },
  foot: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  pill: {
    fontSize: font.tiny,
    fontWeight: "700",
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 1,
    overflow: "hidden",
    fontFamily: font.family,
  },
}));
