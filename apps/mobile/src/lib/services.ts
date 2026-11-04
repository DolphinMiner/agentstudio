// App-wide singletons: the REST client and the session manager.
import { Platform } from "react-native";
import { ApiClient, SessionManager } from "@agentstudio/core";
import { SERVER_URL } from "./config";
import { createSessionStore } from "./sessionStore";

export const serverUrl = SERVER_URL;

export const api = new ApiClient({ baseUrl: serverUrl });

export const sessions = new SessionManager({
  api,
  store: createSessionStore(),
  deviceName: Platform.OS === "web" ? "AgentStudio Mobile (Web)" : `AgentStudio Mobile (${Platform.OS === "ios" ? "iOS" : "Android"})`,
});
