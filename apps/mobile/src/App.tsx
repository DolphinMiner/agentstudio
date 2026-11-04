import { useEffect, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { Sky } from "./components/Sky";
import "./fonts";
import { useStore } from "./lib/hooks";
import { sessions } from "./lib/services";
import { useColors } from "./lib/theme";
import { SignInScreen } from "./screens/SignIn";
import { Workspace } from "./screens/Workspace";

export function App() {
  const snap = useStore(sessions);
  const c = useColors();
  const [initError, setInitError] = useState<string | null>(null);

  useEffect(() => {
    sessions.init().catch(() => setInitError("Could not read the saved session."));
  }, []);

  let body;
  if (snap.status === "loading") {
    body = (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        {initError ? <Text style={{ color: c.danger }}>{initError}</Text> : <ActivityIndicator color={c.accent} />}
      </View>
    );
  } else if (snap.status === "signed_out" || !snap.session) {
    body = <SignInScreen notice={snap.reason === "revoked" ? "Your session ended. Please sign in again." : null} />;
  } else {
    // A new session (not a token refresh) gets a fresh workspace and Matrix client.
    body = <Workspace key={`${snap.session.session_id}:${snap.session.matrix.device_id}`} session={snap.session} />;
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="auto" />
      <Sky>{body}</Sky>
    </SafeAreaProvider>
  );
}
