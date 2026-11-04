import { useEffect, useState } from "react";
import { useStore } from "./lib/hooks";
import { sessions } from "./lib/services";
import { SignIn } from "./screens/SignIn";
import { Workspace } from "./screens/Workspace";

export function App() {
  const snap = useStore(sessions);
  const [initError, setInitError] = useState<string | null>(null);

  useEffect(() => {
    sessions.init().catch(() => setInitError("Could not read the saved session."));
  }, []);

  if (snap.status === "loading") {
    return <div className="splash">{initError ?? ""}</div>;
  }
  if (snap.status === "signed_out" || !snap.session) {
    return (
      <SignIn
        notice={snap.reason === "revoked" ? "Your session ended. Please sign in again." : null}
        // At startup (not after signing out), a local-mode server signs the person on this Mac straight in.
        autoLocal={snap.reason === "loaded" || snap.reason === null}
      />
    );
  }
  // Re-create the workspace (and its Matrix client) for a new session, not for a token refresh.
  return <Workspace key={`${snap.session.session_id}:${snap.session.matrix.device_id}`} session={snap.session} />;
}
