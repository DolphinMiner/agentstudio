import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useColors } from "../lib/theme";

/** The evening-sky canvas every screen sits on (docs/design.md). */
export function Sky({ children }: { children: ReactNode }) {
  const c = useColors();
  return (
    <View style={styles.fill}>
      <LinearGradient colors={c.sky} locations={[0, 0.38, 0.7, 1]} style={StyleSheet.absoluteFill} />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
