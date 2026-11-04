// Small shared UI primitives.
import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { initials } from "../lib/logic";
import { font, makeStyles, space, useColors } from "../lib/theme";

type ButtonProps = {
  title: string;
  onPress(): void;
  variant?: "primary" | "secondary" | "link" | "danger";
  small?: boolean;
  disabled?: boolean;
  busy?: boolean;
  testID?: string;
  style?: StyleProp<ViewStyle>;
  icon?: ReactNode;
  accessibilityLabel?: string;
  /** "door": the indigo used for approving (primary buttons are ink otherwise). */
  tone?: "door";
};

export function Button({ title, onPress, variant = "primary", small, disabled, busy, testID, style, icon, accessibilityLabel, tone }: ButtonProps) {
  const s = useStyles();
  const c = useColors();
  const textColor =
    variant === "primary" ? (tone === "door" ? c.accentText : c.surface) : variant === "danger" ? c.danger : variant === "link" ? c.accent : c.text;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: !!(disabled || busy) }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        s.btn,
        small && s.btnSmall,
        variant === "primary" && s.primary,
        variant === "primary" && tone === "door" && { backgroundColor: c.accent },
        variant === "secondary" && s.secondary,
        variant === "danger" && s.dangerBtn,
        variant === "link" && s.link,
        (disabled || busy) && s.disabled,
        pressed && s.pressed,
        style,
      ]}
    >
      {busy ? <ActivityIndicator size="small" color={textColor} /> : icon}
      <Text style={[s.btnText, small && s.btnTextSmall, { color: textColor }]}>{title}</Text>
    </Pressable>
  );
}

/** People are circles, agents are squircles; the porch light marks an agent waiting on you. */
export function Avatar({ name, agent, size = 44, attention }: { name: string; agent?: boolean; size?: number; attention?: boolean }) {
  const c = useColors();
  const h = hue(name);
  const dark = c.text !== "#1A2233";
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: size, height: size }}>
      <View
        style={{
          width: size,
          height: size,
          borderRadius: agent ? size * 0.3 : size / 2,
          backgroundColor: agent ? c.accent : `hsl(${h}, ${dark ? 30 : 65}%, ${dark ? 30 : 88}%)`,
          alignItems: "center",
          justifyContent: "center",
          borderWidth: 1,
          borderColor: "rgba(255,255,255,0.6)",
        }}
      >
        <Text
          style={{
            color: agent ? c.accentText : `hsl(${h}, 40%, ${dark ? 85 : 28}%)`,
            fontWeight: "700",
            fontSize: size * 0.38,
            fontFamily: font.display ?? font.family,
          }}
        >
          {initials(name)}
        </Text>
      </View>
      {attention && (
        <View
          style={{
            position: "absolute",
            top: -2,
            right: -2,
            width: 12,
            height: 12,
            borderRadius: 6,
            backgroundColor: c.porch,
            borderWidth: 2,
            borderColor: c.surface,
          }}
        />
      )}
    </View>
  );
}

/** The porch-light dot, for avatars drawn elsewhere (RoomAvatar). */
Avatar.Dot = function AvatarDot() {
  const c = useColors();
  return (
    <View
      style={{
        position: "absolute",
        top: -2,
        right: -2,
        width: 12,
        height: 12,
        borderRadius: 6,
        backgroundColor: c.porch,
        borderWidth: 2,
        borderColor: c.surface,
      }}
    />
  );
};

function hue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 360;
}

export function Badge({ count, testID }: { count: number | string; testID?: string }) {
  const s = useStyles();
  return (
    <View testID={testID} style={s.badge}>
      <Text style={s.badgeText}>{count}</Text>
    </View>
  );
}

/** Large page title under the status bar, like iOS large titles. */
export function ScreenHeader({ title, subtitle, right }: { title: string; subtitle?: string; right?: ReactNode }) {
  const s = useStyles();
  const insets = useSafeAreaInsets();
  return (
    <View style={[s.header, { paddingTop: insets.top + space.md }]}>
      <View style={s.headerRow}>
        <Text accessibilityRole="header" style={s.title}>
          {title}
        </Text>
        {right}
      </View>
      {subtitle ? <Text style={s.muted}>{subtitle}</Text> : null}
    </View>
  );
}

export function Empty({ title, text, children, testID }: { title: string; text: string; children?: ReactNode; testID?: string }) {
  const s = useStyles();
  return (
    <View testID={testID} style={s.empty}>
      <Text style={s.emptyTitle}>{title}</Text>
      <Text style={[s.muted, s.center]}>{text}</Text>
      {children}
    </View>
  );
}

/** A checkbox row. Renders role=checkbox with aria-checked on web. */
export function Checkbox({
  checked,
  onChange,
  label,
  testID,
  children,
}: {
  checked: boolean;
  onChange(v: boolean): void;
  label: string;
  testID?: string;
  children?: ReactNode;
}) {
  const s = useStyles();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked }}
      aria-checked={checked}
      onPress={() => onChange(!checked)}
      style={s.checkRow}
    >
      <View style={[s.box, checked && s.boxOn]}>{checked && <Text style={s.tick}>✓</Text>}</View>
      <View style={s.flex}>{children ?? <Text style={s.body}>{label}</Text>}</View>
    </Pressable>
  );
}

export function ErrorText({ text, testID }: { text: string | null; testID?: string }) {
  const s = useStyles();
  if (!text) return null;
  return (
    <Text testID={testID} accessibilityRole="alert" style={s.error}>
      {text}
    </Text>
  );
}

export const useStyles = makeStyles((c) => ({
  btn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    minHeight: 44,
    paddingHorizontal: space.lg + 2,
    borderRadius: 999,
  },
  btnSmall: { minHeight: 32, paddingHorizontal: space.md + 2, borderRadius: 999 },
  primary: { backgroundColor: c.ink },
  secondary: { backgroundColor: c.surfaceAlt },
  dangerBtn: { backgroundColor: c.surfaceAlt },
  link: { backgroundColor: "transparent", paddingHorizontal: space.sm },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.75 },
  btnText: { fontSize: font.body, fontWeight: "600", fontFamily: font.family },
  btnTextSmall: { fontSize: font.small },
  badge: {
    minWidth: 20,
    height: 20,
    paddingHorizontal: 6,
    borderRadius: 10,
    backgroundColor: c.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: { color: c.accentText, fontSize: font.tiny, fontWeight: "700", fontFamily: font.family },
  header: { paddingHorizontal: space.lg, paddingBottom: space.md, backgroundColor: c.canvas, gap: 2 },
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  title: { fontSize: 30, fontWeight: "700", color: c.text, fontFamily: font.display ?? font.family, letterSpacing: -0.6 },
  muted: { color: c.muted, fontSize: font.small, fontFamily: font.family },
  body: { color: c.text, fontSize: font.body, fontFamily: font.family },
  center: { textAlign: "center" },
  empty: { alignItems: "center", gap: space.sm, padding: space.xl, marginTop: space.xl },
  emptyTitle: { fontSize: 20, fontWeight: "700", color: c.text, fontFamily: font.display ?? font.family, letterSpacing: -0.3 },
  checkRow: { flexDirection: "row", alignItems: "flex-start", gap: space.sm, paddingVertical: 6 },
  box: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: c.border,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 1,
  },
  boxOn: { backgroundColor: c.accent, borderColor: c.accent },
  tick: { color: c.accentText, fontSize: 14, fontWeight: "700" },
  flex: { flex: 1 },
  error: { color: c.danger, fontSize: font.small, fontFamily: font.family },
}));

export const shared = StyleSheet.create({ flex: { flex: 1 } });
