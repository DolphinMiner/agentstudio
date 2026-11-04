// App-wide singletons: the REST client and the session manager.

import { ApiClient, SessionManager } from "@agentstudio/core";
import { desktop } from "./desktop";

export const serverUrl = desktop.getServerUrl();

export const api = new ApiClient({ baseUrl: serverUrl });

export const sessions = new SessionManager({
  api,
  store: desktop.session,
  deviceName: "AgentStudio Desktop (Mac)",
});
