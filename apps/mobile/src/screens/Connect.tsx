import { useCallback, useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import type { Connection, LoginStep, Network } from "@agentstudio/core";
import { LoginStepView } from "../components/LoginStepView";
import { Button, ErrorText, ScreenHeader } from "../components/ui";
import { errorText } from "../lib/errors";
import { api } from "../lib/services";
import { tid } from "../lib/testProps";
import { font, makeStyles, space } from "../lib/theme";
import { useWorkspace } from "../lib/workspace";

type LoginState = { network: Network; flowName: string; processId: string; step: LoginStep };

const STATE_TEXT: Record<Connection["state"], string> = {
  connecting: "Connecting",
  connected: "Connected",
  bad_credentials: "Sign-in needed",
  transient_disconnect: "Reconnecting",
  logged_out: "Logged out",
};

export function ConnectScreen() {
  const s = useStyles();
  const { rt } = useWorkspace();
  const [networks, setNetworks] = useState<Network[] | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [login, setLogin] = useState<LoginState | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadConnections = useCallback(async () => {
    try {
      setConnections(await api.connections());
    } catch {
      // Keep the last list; the next poll retries.
    }
  }, []);

  useEffect(() => {
    api.networks().then(setNetworks, (e) => setError(errorText(e)));
  }, []);

  // Poll connection states only while this tab is focused.
  useFocusEffect(
    useCallback(() => {
      void loadConnections();
      const t = setInterval(() => void loadConnections(), 5000);
      return () => clearInterval(t);
    }, [loadConnections]),
  );

  const network = networks?.find((n) => n.id === selected) ?? null;

  async function startFlow(n: Network, flowId: string, flowName: string) {
    setStarting(flowId);
    setError(null);
    try {
      const r = await api.startLogin(n.id, flowId);
      setLogin({ network: n, flowName, processId: r.process_id, step: r.step });
      if (r.step.type === "complete") onComplete();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setStarting(null);
    }
  }

  function onComplete() {
    void loadConnections();
    rt.agents.trigger();
  }

  async function remove(c: Connection) {
    setError(null);
    try {
      await api.deleteConnection(c.id);
      await loadConnections();
      rt.agents.trigger();
    } catch (e) {
      setError(errorText(e));
    }
  }

  const visible = connections.filter((c) => c.state !== "logged_out");

  return (
    <KeyboardAvoidingView style={s.root} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScreenHeader title="Connect" subtitle="Bring your chat accounts and AI agents into AgentStudio." />
      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
        <ErrorText text={error} />
        <View style={s.grid}>
          {(networks ?? []).map((n) => (
            <Pressable
              key={n.id}
              testID={`network-${n.id}`}
              accessibilityRole="button"
              accessibilityState={{ selected: selected === n.id }}
              onPress={() => {
                setSelected(n.id);
                setLogin(null);
              }}
              style={[s.network, selected === n.id && s.networkOn]}
            >
              <Text style={s.networkName}>{n.name}</Text>
              <Text style={s.muted}>{n.kind === "agent" ? "AI agents" : "Chat network"}</Text>
              {!n.available && <Text style={s.unavailable}>Unavailable</Text>}
            </Pressable>
          ))}
          {networks === null && !error && <Text style={s.muted}>Loading networks…</Text>}
        </View>

        {network && !login && (
          <View style={s.panel}>
            <Text style={s.panelTitle}>{network.name}</Text>
            {!network.available && <Text style={s.muted}>This network is not reachable right now.</Text>}
            {network.flows.map((f) => (
              <Pressable
                key={f.id}
                testID={`flow-${f.id}`}
                accessibilityRole="button"
                disabled={!network.available || starting !== null}
                onPress={() => void startFlow(network, f.id, f.name)}
                style={({ pressed }) => [s.flow, pressed && s.pressed, (!network.available || starting !== null) && s.disabled]}
              >
                <Text style={s.flowName}>{starting === f.id ? "Starting…" : f.name}</Text>
                {f.description ? <Text style={s.muted}>{f.description}</Text> : null}
              </Pressable>
            ))}
          </View>
        )}

        {login && (
          <View style={s.panel}>
            <View style={s.panelHead}>
              <Text style={s.panelTitle}>
                {login.network.name} · {login.flowName}
              </Text>
              {login.step.type !== "complete" && <Button small variant="link" title="Cancel" onPress={() => setLogin(null)} />}
            </View>
            <LoginStepView
              key={login.step.step_id + login.step.type}
              processId={login.processId}
              step={login.step}
              onStep={(step) => {
                setLogin((l) => (l ? { ...l, step } : l));
                if (step.type === "complete") onComplete();
              }}
              onDone={() => {
                setLogin(null);
                setSelected(null);
              }}
            />
          </View>
        )}

        <View style={s.panel}>
          <Text style={s.panelTitle}>Connected accounts</Text>
          {visible.length === 0 ? (
            <Text style={s.muted}>Nothing connected yet.</Text>
          ) : (
            visible.map((c) => (
              <View key={c.id} {...tid("connection-row", { network: c.network, state: c.state })} style={s.connection}>
                <View style={s.flex}>
                  <Text style={s.connName}>{c.remote_name || c.id}</Text>
                  <Text style={s.muted}>
                    {networks?.find((n) => n.id === c.network)?.name ?? c.network} · {STATE_TEXT[c.state] ?? c.state}
                    {c.state_message ? ` · ${c.state_message}` : ""}
                  </Text>
                </View>
                <Button testID="connection-remove" small variant="secondary" title="Remove" onPress={() => void remove(c)} />
              </View>
            ))
          )}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.canvas },
  flex: { flex: 1 },
  body: { paddingHorizontal: space.lg, paddingBottom: space.xl, gap: space.lg },
  muted: { color: c.muted, fontSize: font.small, fontFamily: font.family },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: space.md },
  network: {
    flexBasis: "47%",
    flexGrow: 1,
    backgroundColor: c.surface,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: c.border,
    padding: space.md,
    gap: 2,
  },
  networkOn: { borderColor: c.accent },
  networkName: { color: c.text, fontSize: font.body, fontWeight: "600", fontFamily: font.family },
  unavailable: { color: c.danger, fontSize: font.tiny, fontWeight: "600", marginTop: 4, fontFamily: font.family },
  panel: { backgroundColor: c.surface, borderRadius: 14, padding: space.lg, gap: space.md, borderWidth: 1, borderColor: c.border },
  panelHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  panelTitle: { color: c.text, fontSize: font.heading, fontWeight: "600", fontFamily: font.family },
  flow: { backgroundColor: c.bg, borderRadius: 12, padding: space.md, gap: 2 },
  flowName: { color: c.text, fontSize: font.body, fontWeight: "600", fontFamily: font.family },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.5 },
  connection: { flexDirection: "row", alignItems: "center", gap: space.md },
  connName: { color: c.text, fontSize: font.body, fontWeight: "500", fontFamily: font.family },
}));
