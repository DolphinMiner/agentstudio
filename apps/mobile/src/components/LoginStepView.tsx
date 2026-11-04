import { useEffect, useState } from "react";
import { Pressable, Text, TextInput, View, type KeyboardTypeOptions } from "react-native";
import type { LoginField, LoginStep } from "@agentstudio/core";
import { errorText } from "../lib/errors";
import { api } from "../lib/services";
import { tid } from "../lib/testProps";
import { font, makeStyles, space, useColors } from "../lib/theme";
import { QrCode } from "./QrCode";
import { Button, ErrorText } from "./ui";

/**
 * Generic renderer for a bridgev2 login step (docs/api.md LoginStep):
 * user_input forms, display_and_wait (QR / code, long-polled), cookies (not
 * supported on mobile in v0.1) and complete.
 */
export function LoginStepView({
  processId,
  step,
  onStep,
  onDone,
}: {
  processId: string;
  step: LoginStep;
  onStep(next: LoginStep): void;
  onDone(): void;
}) {
  const s = useStyles();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <View {...tid("login-step", { stepType: step.type })} style={s.step}>
      {step.instructions && step.type !== "complete" ? <Text style={s.instructions}>{step.instructions}</Text> : null}
      {step.type === "user_input" && (
        <UserInputForm
          step={step}
          busy={busy}
          onSubmit={async (fields) => {
            setBusy(true);
            setError(null);
            try {
              onStep(await api.submitLoginStep(processId, step.step_id, { fields }));
            } catch (e) {
              setError(errorText(e));
            } finally {
              setBusy(false);
            }
          }}
        />
      )}
      {step.type === "display_and_wait" && <DisplayAndWait processId={processId} step={step} onStep={onStep} onError={setError} />}
      {step.type === "cookies" && (
        <Text style={s.muted}>This network signs in with browser cookies, which is not supported on mobile yet (v0.1).</Text>
      )}
      {step.type === "complete" && (
        <View testID="login-complete" style={s.complete}>
          <View style={s.doneMark}>
            <Text style={s.doneTick}>✓</Text>
          </View>
          <View style={s.flex}>
            <Text style={s.strong}>Connected</Text>
            <Text style={s.muted}>{step.instructions || "Your chats will appear in the inbox shortly."}</Text>
          </View>
          <Button small title="Done" onPress={onDone} />
        </View>
      )}
      <ErrorText text={error} />
    </View>
  );
}

function UserInputForm({ step, busy, onSubmit }: { step: LoginStep; busy: boolean; onSubmit(fields: Record<string, string>): void }) {
  const s = useStyles();
  const c = useColors();
  const fields = step.user_input?.fields ?? [];
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.id, f.default_value ?? (f.type === "select" ? (f.options?.[0] ?? "") : "")])),
  );
  const set = (id: string, v: string) => setValues((x) => ({ ...x, [id]: v }));

  return (
    <View style={s.form}>
      {fields.map((f) => (
        <View key={f.id} style={s.field}>
          <Text style={s.label}>{f.name}</Text>
          {f.type === "select" ? (
            <View testID={`login-field-${f.id}`} accessibilityRole="radiogroup" style={s.options}>
              {(f.options ?? []).map((o) => {
                const on = values[f.id] === o;
                return (
                  <Pressable
                    key={o}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: on }}
                    onPress={() => set(f.id, o)}
                    style={[s.option, on && s.optionOn]}
                  >
                    <Text style={[s.optionText, on && s.optionTextOn]}>{o}</Text>
                  </Pressable>
                );
              })}
            </View>
          ) : (
            <TextInput
              testID={`login-field-${f.id}`}
              style={s.input}
              value={values[f.id] ?? ""}
              onChangeText={(v) => set(f.id, v)}
              secureTextEntry={f.type === "password" || f.type === "token"}
              keyboardType={keyboardType(f)}
              autoCapitalize="none"
              autoCorrect={false}
              placeholderTextColor={c.muted}
            />
          )}
          {f.description ? <Text style={s.muted}>{f.description}</Text> : null}
        </View>
      ))}
      <Button testID="login-submit" title={busy ? "Connecting…" : "Continue"} busy={busy} onPress={() => onSubmit(values)} />
    </View>
  );
}

function keyboardType(f: LoginField): KeyboardTypeOptions {
  switch (f.type) {
    case "email":
      return "email-address";
    case "phone_number":
      return "phone-pad";
    case "url":
      return "url";
    default:
      return "default";
  }
}

function DisplayAndWait({
  processId,
  step,
  onStep,
  onError,
}: {
  processId: string;
  step: LoginStep;
  onStep(next: LoginStep): void;
  onError(e: string | null): void;
}) {
  const s = useStyles();
  const d = step.display_and_wait;

  // Long-poll until the step changes (the server returns the same step on timeout).
  useEffect(() => {
    let alive = true;
    const ac = new AbortController();
    const same = (n: LoginStep) =>
      n.step_id === step.step_id && n.type === step.type && n.display_and_wait?.data === step.display_and_wait?.data;
    void (async () => {
      while (alive) {
        try {
          const next = await api.waitLoginStep(processId, step.step_id, ac.signal);
          if (!alive) return;
          onError(null);
          if (!same(next)) {
            onStep(next);
            return;
          }
        } catch (e) {
          if (!alive) return;
          onError(errorText(e));
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    })();
    return () => {
      alive = false;
      ac.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [processId, step]);

  return (
    <View style={s.wait}>
      {d?.type === "qr" && d.data ? <QrCode testID="login-qr" data={d.data} /> : null}
      {(d?.type === "code" || d?.type === "emoji") && (
        <Text testID="login-code" selectable style={s.code}>
          {d.data}
        </Text>
      )}
      <Text style={s.muted}>Waiting for confirmation…</Text>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  flex: { flex: 1 },
  step: { gap: space.md },
  instructions: { color: c.text, fontSize: font.body - 1, lineHeight: 21, fontFamily: font.family },
  muted: { color: c.muted, fontSize: font.small, fontFamily: font.family },
  strong: { color: c.text, fontSize: font.body, fontWeight: "600", fontFamily: font.family },
  form: { gap: space.md },
  field: { gap: 6 },
  label: { color: c.muted, fontSize: font.small, fontWeight: "600", fontFamily: font.family },
  input: {
    backgroundColor: c.bg,
    borderColor: c.border,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: space.md,
    height: 46,
    fontSize: font.body,
    color: c.text,
    fontFamily: font.family,
  },
  options: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  option: { borderWidth: 1.5, borderColor: c.border, borderRadius: 10, paddingHorizontal: space.md, paddingVertical: 8 },
  optionOn: { borderColor: c.accent, backgroundColor: c.accentSoft },
  optionText: { color: c.text, fontSize: font.small + 1, fontFamily: font.family },
  optionTextOn: { fontWeight: "600" },
  complete: { flexDirection: "row", alignItems: "center", gap: space.md },
  doneMark: { width: 36, height: 36, borderRadius: 18, backgroundColor: c.success, alignItems: "center", justifyContent: "center" },
  doneTick: { color: "#fff", fontSize: 18, fontWeight: "700" },
  wait: { alignItems: "center", gap: space.md, paddingVertical: space.sm },
  code: { color: c.text, fontSize: 28, fontWeight: "700", letterSpacing: 4, fontFamily: font.family },
}));
