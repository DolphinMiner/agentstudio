import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, ErrorText } from "../components/ui";
import { errorText } from "../lib/errors";
import { serverUrl, sessions } from "../lib/services";
import { font, makeStyles, space, useColors } from "../lib/theme";

export function SignInScreen({ notice }: { notice: string | null }) {
  const s = useStyles();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(notice);

  async function sendCode() {
    if (!email.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await sessions.startSignIn(email.trim());
      setSent(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    if (!code.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await sessions.verifySignIn(email.trim(), code.trim());
      // App switches to the workspace through the session snapshot.
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={s.root} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView
        contentContainerStyle={[s.scroll, { paddingTop: insets.top + 64, paddingBottom: insets.bottom + space.xl }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={s.mark}>
          <Text style={s.markText}>P</Text>
        </View>
        <Text style={s.title}>AgentStudio</Text>
        <Text style={s.lead}>Your chats and your AI agents, in one inbox.</Text>

        <View style={s.form}>
          <Text style={s.label}>Email</Text>
          <TextInput
            testID="signin-email"
            style={[s.input, sent && s.inputDisabled]}
            value={email}
            onChangeText={setEmail}
            editable={!sent && !busy}
            placeholder="you@example.com"
            placeholderTextColor={c.muted}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            keyboardType="email-address"
            inputMode="email"
            returnKeyType="send"
            onSubmitEditing={() => void sendCode()}
          />
          {!sent ? (
            <Button testID="signin-send" title="Send code" busy={busy} disabled={!email.trim()} onPress={() => void sendCode()} />
          ) : (
            <>
              <Text style={s.label}>6-digit code</Text>
              <TextInput
                testID="signin-code"
                style={s.input}
                value={code}
                onChangeText={setCode}
                editable={!busy}
                placeholder="123456"
                placeholderTextColor={c.muted}
                keyboardType="number-pad"
                inputMode="numeric"
                autoComplete="one-time-code"
                textContentType="oneTimeCode"
                autoFocus
                returnKeyType="go"
                onSubmitEditing={() => void verify()}
              />
              <Button testID="signin-verify" title="Sign in" busy={busy} disabled={!code.trim()} onPress={() => void verify()} />
              <Button
                variant="link"
                title="Use a different email"
                onPress={() => {
                  setSent(false);
                  setCode("");
                  setError(null);
                }}
              />
            </>
          )}
          <ErrorText testID="signin-error" text={error} />
        </View>
        <Text style={s.server}>Server: {serverUrl}</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.canvas },
  scroll: { paddingHorizontal: space.xl, alignItems: "stretch", flexGrow: 1 },
  mark: {
    width: 64,
    height: 64,
    borderRadius: 20,
    backgroundColor: c.accent,
    alignSelf: "center",
    alignItems: "center",
    justifyContent: "center",
  },
  markText: { color: c.accentText, fontSize: 32, fontWeight: "700" },
  title: { fontSize: 32, fontWeight: "700", color: c.text, textAlign: "center", marginTop: space.lg, fontFamily: font.family },
  lead: { color: c.muted, textAlign: "center", fontSize: font.body, marginTop: space.xs, fontFamily: font.family },
  form: { marginTop: 40, gap: space.md },
  label: { color: c.muted, fontSize: font.small, fontWeight: "600", marginBottom: -4, fontFamily: font.family },
  input: {
    backgroundColor: c.surface,
    borderColor: c.border,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: space.md,
    height: 48,
    fontSize: font.body,
    color: c.text,
    fontFamily: font.family,
  },
  inputDisabled: { opacity: 0.6 },
  server: { color: c.muted, fontSize: font.tiny, textAlign: "center", marginTop: "auto", paddingTop: space.xl, fontFamily: font.family },
}));
