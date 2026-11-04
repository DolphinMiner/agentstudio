// Colors, spacing and type scale, light and dark.
import { useMemo } from "react";
import { Platform, StyleSheet, useColorScheme } from "react-native";

export type Colors = {
  /** Screen roots sit on the sky gradient (see Sky), so they are transparent. */
  canvas: string;
  /** The evening-sky gradient stops, top to bottom. */
  sky: [string, string, string, string];
  bg: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  accentText: string;
  accentSoft: string;
  bubbleOwn: string;
  bubbleOwnText: string;
  bubbleOther: string;
  danger: string;
  success: string;
  warning: string;
  agent: string;
  /** The porch light: only for what waits on the user. */
  porch: string;
  porchSoft: string;
  porchInk: string;
  glass: string;
  ink: string;
};

// AgentStudio's "porch light" palette (docs/design.md).
const light: Colors = {
  canvas: "transparent",
  sky: ["#D9E2F4", "#E6EAF6", "#EFF0F6", "#F6F0EC"],
  bg: "#EEF1F7",
  surface: "#FFFFFF",
  surfaceAlt: "#EEF1F7",
  border: "rgba(26,34,51,0.10)",
  text: "#1A2233",
  muted: "#5A6478",
  accent: "#3247A8",
  accentText: "#FFFFFF",
  accentSoft: "#E3E8F8",
  bubbleOwn: "#3247A8",
  bubbleOwnText: "#FFFFFF",
  bubbleOther: "rgba(255,255,255,0.88)",
  danger: "#B4321F",
  success: "#2E7D5B",
  warning: "#7A4A05",
  agent: "#3247A8",
  porch: "#F2A93B",
  porchSoft: "#FFF1D9",
  porchInk: "#7A4A05",
  glass: "rgba(255,255,255,0.66)",
  ink: "#1A2233",
};

const dark: Colors = {
  canvas: "transparent",
  sky: ["#141A2B", "#161B29", "#18192A", "#1B1A22"],
  bg: "#2A3245",
  surface: "#232A3B",
  surfaceAlt: "#2A3245",
  border: "rgba(255,255,255,0.10)",
  text: "#EEF1F8",
  muted: "#A5AEC2",
  accent: "#7F93F5",
  accentText: "#0F1530",
  accentSoft: "#2C3560",
  bubbleOwn: "#7F93F5",
  bubbleOwnText: "#0F1530",
  bubbleOther: "rgba(42,50,69,0.92)",
  danger: "#FF8A78",
  success: "#6FCF9E",
  warning: "#FFCF85",
  agent: "#7F93F5",
  porch: "#F2A93B",
  porchSoft: "#3A2C14",
  porchInk: "#FFCF85",
  glass: "rgba(30,36,52,0.66)",
  ink: "#EEF1F8",
};

export const font = {
  family: Platform.select({ web: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Segoe UI', Roboto, sans-serif", default: undefined }),
  /** Titles and names. Loaded on web (fonts.web.ts); native falls back to the system font. */
  display: Platform.select({ web: "'Bricolage Grotesque Variable', -apple-system, sans-serif", default: undefined }),
  title: 28,
  heading: 17,
  body: 16,
  small: 13,
  tiny: 11,
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };

export function useColors(): Colors {
  return useColorScheme() === "dark" ? dark : light;
}

type Styles = Parameters<typeof StyleSheet.create>[0];

/** Build a StyleSheet from the current colors, memoized per color scheme. */
export function makeStyles<S extends Styles>(build: (c: Colors) => S & Styles): () => Readonly<S> {
  const cache = new Map<Colors, Readonly<S>>();
  return function useStyles() {
    const c = useColors();
    return useMemo(() => {
      let s = cache.get(c);
      if (!s) {
        s = StyleSheet.create(build(c));
        cache.set(c, s);
      }
      return s;
    }, [c]);
  };
}
