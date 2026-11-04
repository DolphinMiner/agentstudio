import { useCallback, useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { ApprovalCard } from "../components/ApprovalCard";
import { Empty, ScreenHeader } from "../components/ui";
import { useStore } from "../lib/hooks";
import { font, makeStyles, space } from "../lib/theme";
import { useWorkspace } from "../lib/workspace";

export function ApprovalsScreen() {
  const s = useStyles();
  const { rt } = useWorkspace();
  const snap = useStore(rt.approvals);
  // Cards decided here stay visible (showing their new state) until the user
  // leaves the tab; new pending approvals go on top.
  const [shown, setShown] = useState<string[]>([]);
  useEffect(() => {
    setShown((prev) => {
      const fresh = snap.items.map((a) => a.id).filter((id) => !prev.includes(id));
      return fresh.length ? [...fresh, ...prev] : prev;
    });
  }, [snap.items]);
  useFocusEffect(
    useCallback(() => {
      void rt.approvals.refresh();
      return () => setShown(rt.approvals.items.map((a) => a.id));
    }, [rt]),
  );

  return (
    <View style={s.root}>
      <ScreenHeader title="Approvals" subtitle="Decisions your agents are waiting for." />
      {shown.length === 0 ? (
        snap.loading ? (
          <Text style={s.loading}>Loading…</Text>
        ) : (
          <Empty testID="approvals-empty" title="All caught up" text="When an agent needs a decision, it shows up here." />
        )
      ) : (
        <ScrollView testID="approvals-list" contentContainerStyle={s.list}>
          {shown.map((id) => (
            <ApprovalCard key={id} approvalId={id} />
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.canvas },
  loading: { color: c.muted, textAlign: "center", padding: space.xl, fontSize: font.body, fontFamily: font.family },
  list: { paddingHorizontal: space.lg, paddingBottom: space.xl, gap: space.md, alignItems: "stretch" },
}));
