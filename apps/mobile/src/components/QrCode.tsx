import { useMemo } from "react";
import { View } from "react-native";
import { create } from "qrcode";

/** A QR code drawn with plain Views (no SVG or canvas), so it works on native and web. */
export function QrCode({ data, size = 220, testID }: { data: string; size?: number; testID?: string }) {
  const rows = useMemo(() => {
    const m = create(data, { errorCorrectionLevel: "M" }).modules;
    // Merge horizontal runs of dark modules to keep the view count low.
    const out: { x: number; w: number }[][] = [];
    for (let y = 0; y < m.size; y++) {
      const runs: { x: number; w: number }[] = [];
      for (let x = 0; x < m.size; x++) {
        if (!m.get(x, y)) continue;
        const last = runs.at(-1);
        if (last && last.x + last.w === x) last.w++;
        else runs.push({ x, w: 1 });
      }
      out.push(runs);
    }
    return out;
  }, [data]);
  const quiet = 2;
  const cell = size / (rows.length + quiet * 2);
  return (
    <View testID={testID} accessibilityLabel="QR code to scan" style={{ width: size, height: size, backgroundColor: "#fff" }}>
      {rows.map((runs, y) =>
        runs.map((r) => (
          <View
            key={`${y}:${r.x}`}
            style={{
              position: "absolute",
              left: (r.x + quiet) * cell,
              top: (y + quiet) * cell,
              width: r.w * cell + 0.5,
              height: cell + 0.5,
              backgroundColor: "#000",
            }}
          />
        )),
      )}
    </View>
  );
}
