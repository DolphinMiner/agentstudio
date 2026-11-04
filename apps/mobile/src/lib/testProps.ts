// Test-id helpers for the e2e contract in docs/clients.md.
//
// RN only has one `testID` (react-native-web renders it as data-testid). The
// extra attributes the contract needs (data-room-name, data-sender, data-own,
// data-step-type, data-network, data-state) go through react-native-web's
// `dataSet`, which renders data-* attributes. Native ignores dataSet.
import { Platform } from "react-native";

export function tid(id: string, data?: Record<string, string>): { testID: string } {
  if (Platform.OS === "web" && data) return { testID: id, dataSet: data } as { testID: string };
  return { testID: id };
}
