import { useEffect } from "react";
import { Text, View } from "react-native";
import type { DraftsPayload } from "@agentstudio/core";
import { useStore } from "../lib/hooks";
import { font, makeStyles, space } from "../lib/theme";
import { useWorkspace } from "../lib/workspace";
import { Button } from "./ui";

/** Reply drafts from an agent. "Use" puts a draft into the origin chat's composer. */
export function DraftsCard({ payload }: { payload: DraftsPayload }) {
  const s = useStyles();
  const { rt, placeDraft } = useWorkspace();
  const tasks = useStore(rt.tasks);
  const task = tasks.items.find((t) => t.id === payload.task_id);

  useEffect(() => {
    if (!task && !tasks.loading) void rt.tasks.refresh();
    // Only when the task is missing from a finished load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload.task_id, tasks.loading]);

  const origin = task?.origin;
  const n = payload.drafts.length;
  return (
    <View testID="drafts-card" style={s.card}>
      <Text style={s.kicker}>
        {n} {n === 1 ? "draft" : "drafts"}
        {origin ? ` for ${origin.chat_name}` : ""}
      </Text>
      {payload.drafts.map((d, i) => (
        <View key={i} testID="draft-item" style={s.draft}>
          <Text style={s.text}>{d.text}</Text>
          <View style={s.actions}>
            {task?.state === "done" && task.sent_draft_index === i && <Text style={s.sent}>Sent</Text>}
            <Button
              testID="draft-use"
              title="Use"
              small
              disabled={!origin}
              accessibilityLabel={origin ? `Put this draft into ${origin.chat_name}` : "Loading task"}
              onPress={() => origin && placeDraft(origin.room_id, d.text, payload.task_id, i)}
            />
          </View>
        </View>
      ))}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  card: {
    backgroundColor: c.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: c.border,
    padding: space.md,
    gap: space.sm,
    minWidth: 260,
    maxWidth: 360,
  },
  kicker: { color: c.agent, fontSize: font.tiny, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5, fontFamily: font.family },
  draft: { backgroundColor: c.bg, borderRadius: 12, padding: space.md, gap: space.sm },
  text: { color: c.text, fontSize: font.body, lineHeight: 21, fontFamily: font.family },
  actions: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: space.sm },
  sent: { color: c.success, fontSize: font.small, fontWeight: "600", fontFamily: font.family },
}));
