import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { approvalStateText, formatExpiry, isApiError, isExpired } from "@agentstudio/core";
import { errorText } from "../lib/errors";
import { useNow, useStore } from "../lib/hooks";
import { tid } from "../lib/testProps";
import { font, makeStyles, space } from "../lib/theme";
import { useWorkspace } from "../lib/workspace";
import { Button, ErrorText } from "./ui";

/**
 * An approval card. Its state always comes from the REST API (via the
 * ApprovalsStore cache), never from the Matrix event.
 */
export function ApprovalCard({ approvalId }: { approvalId: string }) {
  const s = useStyles();
  const { rt } = useWorkspace();
  const cards = useStore(rt.approvals.cards);
  const a = cards[approvalId];
  const now = useNow(15_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    if (!a) rt.approvals.load(approvalId).catch(() => setLoadError(true));
  }, [rt, approvalId, a]);

  if (!a) {
    return (
      <View testID="approval-card" style={s.card}>
        <Text style={s.muted}>{loadError ? "Could not load this approval." : "Loading approval…"}</Text>
      </View>
    );
  }

  const stateText = approvalStateText(a, now);
  const open = a.state === "pending" && !isExpired(a, now);
  const expiry = open ? formatExpiry(a.expires_at, now) : null;

  async function decide(key: string) {
    setBusy(key);
    setError(null);
    try {
      await rt.approvals.decide(approvalId, key);
    } catch (e) {
      // On a conflict or expiry the card already shows the server's state.
      if (!isApiError(e, "version_conflict") && !isApiError(e, "expired")) setError(errorText(e));
    } finally {
      rt.agents.trigger();
      setBusy(null);
    }
  }

  return (
    <View {...tid("approval-card", { approvalId: a.id, state: a.state })} style={[s.card, open && s.cardOpen]}>
      <View style={s.kicker}>
        <Text style={s.kickerText}>{open ? `${a.agent_name} is asking` : a.agent_name}</Text>
        {expiry && (
          <Text testID="approval-expiry" style={s.expiry}>
            {expiry}
          </Text>
        )}
      </View>
      <Text testID="approval-title" style={s.title}>
        {a.title}
      </Text>
      {a.summary ? <Text style={s.summary}>{a.summary}</Text> : null}
      {a.details.length > 0 && (
        <View style={s.details}>
          {a.details.map((d, i) => (
            <View key={i} testID="approval-detail" style={s.detail}>
              <Text style={s.detailLabel}>{d.label}</Text>
              <Text style={s.detailValue}>{d.value}</Text>
            </View>
          ))}
        </View>
      )}
      {open ? (
        <View style={s.choices}>
          {a.choices.map((ch) => (
            <Button
              key={ch.key}
              testID={`approval-choice-${ch.key}`}
              title={ch.label}
              variant={ch.category === "approve" ? "primary" : "secondary"}
              tone={ch.category === "approve" ? "door" : undefined}
              busy={busy === ch.key}
              disabled={busy !== null}
              style={s.choice}
              onPress={() => void decide(ch.key)}
            />
          ))}
        </View>
      ) : stateText ? (
        <Text testID="approval-state" style={[s.state, a.decision ? s.stateDecided : null]}>
          {stateText}
        </Text>
      ) : null}
      {a.state === "decided" && a.delivery_state === "failed" && (
        <Text style={s.muted}>The agent could not be reached. It will see your decision when it is back.</Text>
      )}
      <ErrorText text={error} />
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  card: {
    backgroundColor: c.surface,
    borderRadius: 24,
    padding: space.lg,
    gap: space.sm + 2,
    shadowColor: "#1A2233",
    shadowOpacity: 0.08,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    minWidth: 260,
    maxWidth: 360,
    alignSelf: "stretch",
  },
  // The porch light: a warm ring and glow while it waits on you.
  cardOpen: { borderWidth: 1, borderColor: "rgba(242,169,59,0.45)", shadowColor: c.porch, shadowOpacity: 0.35, shadowRadius: 22 },
  muted: { color: c.muted, fontSize: font.small, fontFamily: font.family },
  kicker: { flexDirection: "row", justifyContent: "space-between", gap: space.sm },
  kickerText: { color: c.muted, fontSize: font.small, fontFamily: font.family },
  expiry: { color: c.porchInk, fontSize: font.small, fontWeight: "700", fontFamily: font.family },
  title: { color: c.text, fontSize: 18, fontWeight: "700", fontFamily: font.display ?? font.family, letterSpacing: -0.3 },
  summary: { color: c.muted, fontSize: font.small + 1, fontFamily: font.family },
  details: { gap: 4, padding: space.md, borderRadius: 16, backgroundColor: c.surfaceAlt },
  detail: { flexDirection: "row", gap: space.md },
  detailLabel: { color: c.muted, fontSize: font.small + 1, width: 64, fontFamily: font.family },
  detailValue: { color: c.text, fontSize: font.small + 1, fontWeight: "600", flexShrink: 1, fontFamily: font.family },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginTop: space.xs },
  choice: { flexGrow: 1 },
  state: {
    alignSelf: "flex-start",
    color: c.muted,
    backgroundColor: c.surfaceAlt,
    overflow: "hidden",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 5,
    fontSize: font.small + 1,
    fontWeight: "700",
    marginTop: space.xs,
    fontFamily: font.family,
  },
  stateDecided: { color: c.success, backgroundColor: c.success + "22" },
}));
