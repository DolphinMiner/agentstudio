import { ScrollView, Text, TextInput, View } from "react-native";
import { Button, ScreenHeader } from "../components/ui";
import { APP_VERSION } from "../lib/config";
import { serverUrl, sessions } from "../lib/services";
import { font, makeStyles, space } from "../lib/theme";
import { useWorkspace } from "../lib/workspace";

export function SettingsScreen() {
  const s = useStyles();
  const { session } = useWorkspace();
  return (
    <View style={s.root}>
      <ScreenHeader title="Settings" />
      <ScrollView contentContainerStyle={s.body}>
        <View style={s.group}>
          <Row label="Account">
            <Text testID="settings-email" selectable style={s.value}>
              {session.user.email}
            </Text>
          </Row>
          <View style={s.sep} />
          <Row label="Server">
            {/* Read-only input, like desktop, so tests can read it with toHaveValue. */}
            <TextInput testID="settings-server" value={serverUrl} editable={false} style={[s.value, s.input]} />
          </Row>
          <View style={s.sep} />
          <Row label="Version">
            <Text testID="settings-version" style={s.value}>
              {APP_VERSION}
            </Text>
          </Row>
        </View>
        <Text style={s.note}>The server is set at build time with EXPO_PUBLIC_AGENTSTUDIO_SERVER_URL.</Text>
        <Button testID="settings-signout" variant="danger" title="Sign out" onPress={() => void sessions.logout()} />
      </ScrollView>
    </View>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  const s = useStyles();
  return (
    <View style={s.row}>
      <Text style={s.label}>{label}</Text>
      <View style={s.rowValue}>{children}</View>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.canvas },
  body: { paddingHorizontal: space.lg, paddingBottom: space.xl, gap: space.lg },
  group: { backgroundColor: c.surface, borderRadius: 14, borderWidth: 1, borderColor: c.border },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, minHeight: 50 },
  rowValue: { flex: 1, alignItems: "flex-end" },
  label: { color: c.text, fontSize: font.body, fontFamily: font.family },
  value: { color: c.muted, fontSize: font.body, fontFamily: font.family },
  input: { textAlign: "right", alignSelf: "stretch", padding: 0 },
  sep: { height: 1, backgroundColor: c.border, marginLeft: space.lg },
  note: { color: c.muted, fontSize: font.small, paddingHorizontal: space.xs, fontFamily: font.family },
}));
