import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Ionicons from "@expo/vector-icons/Ionicons";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { useStore } from "../lib/hooks";
import { badgeText } from "../lib/logic";
import { font, makeStyles, useColors } from "../lib/theme";
import { useWorkspace, type TabName } from "../lib/workspace";
import { Badge } from "./ui";

const TABS: Record<TabName, { label: string; icon: keyof typeof Ionicons.glyphMap; active: keyof typeof Ionicons.glyphMap }> = {
  Inbox: { label: "Inbox", icon: "chatbubbles-outline", active: "chatbubbles" },
  Approvals: { label: "Approvals", icon: "shield-checkmark-outline", active: "shield-checkmark" },
  Tasks: { label: "Tasks", icon: "layers-outline", active: "layers" },
  Connect: { label: "Connect", icon: "add-circle-outline", active: "add-circle" },
  Settings: { label: "Settings", icon: "settings-outline", active: "settings" },
};

/** Bottom tabs with the nav-* test ids and the pending approvals badge. */
export function TabBar({ state, navigation }: BottomTabBarProps) {
  const s = useStyles();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { rt } = useWorkspace();
  const pending = useStore(rt.approvals).items.length;

  return (
    <View accessibilityRole="tablist" style={[s.bar, { paddingBottom: Math.max(insets.bottom, 6) }]}>
      {state.routes.map((route, i) => {
        const name = route.name as TabName;
        const tab = TABS[name];
        const focused = state.index === i;
        const color = focused ? c.accent : c.muted;
        return (
          <Pressable
            key={route.key}
            testID={`nav-${name.toLowerCase()}`}
            accessibilityRole="tab"
            accessibilityLabel={tab.label}
            accessibilityState={{ selected: focused }}
            style={s.tab}
            onPress={() => {
              const ev = navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
              if (!focused && !ev.defaultPrevented) navigation.navigate(route.name);
            }}
          >
            <View>
              <Ionicons name={focused ? tab.active : tab.icon} size={24} color={color} />
              {name === "Approvals" && pending > 0 && (
                <View style={s.badgePos}>
                  <Badge testID="nav-approvals-badge" count={badgeText(pending)} />
                </View>
              )}
            </View>
            <Text style={[s.label, { color }]}>{tab.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  bar: {
    flexDirection: "row",
    backgroundColor: c.surface,
    borderTopWidth: 1,
    borderTopColor: c.border,
    paddingTop: 6,
  },
  tab: { flex: 1, alignItems: "center", gap: 2, paddingVertical: 2 },
  label: { fontSize: font.tiny, fontWeight: "600", fontFamily: font.family },
  badgePos: { position: "absolute", top: -6, right: -14 },
}));
