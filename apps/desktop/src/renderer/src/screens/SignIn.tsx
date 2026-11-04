import appIcon from "@agentstudio/brand/assets/agentstudio.png";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { desktop } from "../lib/desktop";
import { errorText } from "../lib/errors";
import { serverUrl, sessions } from "../lib/services";

// Sign-in. Against a local-mode server (the default: everything runs on this
// Mac) there is no account to sign in to: the app goes straight in at startup,
// and after signing out offers "Continue on this Mac". Email codes are for a
// shared server, or for local mode when someone prefers them.

export function SignIn({
  notice,
  autoLocal,
}: {
  notice: string | null;
  autoLocal: boolean;
}) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(notice);
  // null until the server answers; true when it runs in local mode.
  const [local, setLocal] = useState<boolean | null>(null);
  const [useEmail, setUseEmail] = useState(false);
  const autoTried = useRef(false);

  async function continueLocal() {
    setBusy(true);
    setError(null);
    try {
      await sessions.signInLocal();
      // App switches to the workspace through the session snapshot.
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  useEffect(() => {
    if (desktop.emailSignInOnly()) {
      setLocal(false);
      return;
    }
    let live = true;
    sessions
      .isLocalServer()
      .then((isLocal) => {
        if (!live) return;
        setLocal(isLocal);
        if (isLocal && autoLocal && !notice && !autoTried.current) {
          autoTried.current = true;
          void continueLocal();
        }
      })
      .catch(() => live && setLocal(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function sendCode(e: FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await sessions.startSignIn(email);
      setSent(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    if (!code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await sessions.verifySignIn(email, code);
      // App switches to the workspace through the session snapshot.
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <div className="signin">
      <div className="drag-strip" />
      <div className="signin-card">
        <img className="brand-mark" src={appIcon} alt="" aria-hidden draggable={false} />
        <h1 className="display">AgentStudio</h1>
        <p className="muted">
          Your people and your agents, in one inbox. We'll leave the light on.
        </p>
        {local === null && !error && (
          <p className="muted" data-testid="signin-checking">
            Starting…
          </p>
        )}
        {local && !useEmail && (
          <div className="signin-form">
            <button
              data-testid="signin-local"
              className="btn primary wide"
              disabled={busy}
              onClick={() => void continueLocal()}
            >
              {busy ? "Starting…" : "Continue on this Mac"}
            </button>
            <p className="muted small">
              Everything runs on this Mac, so there's no account to create.
            </p>
            <button
              type="button"
              data-testid="signin-use-email"
              className="btn link"
              disabled={busy}
              onClick={() => setUseEmail(true)}
            >
              Sign in with email instead
            </button>
            {error && (
              <p data-testid="signin-error" className="error" role="alert">
                {error}
              </p>
            )}
          </div>
        )}
        {local === false || useEmail ? (
          <form onSubmit={sent ? verify : sendCode} className="signin-form">
            <label className="field">
              <span>Email</span>
              <input
                data-testid="signin-email"
                type="email"
                autoFocus
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                disabled={sent || busy}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            {!sent && (
              <button
                data-testid="signin-send"
                className="btn primary wide"
                disabled={busy || !email.trim()}
              >
                {busy ? "Sending…" : "Send code"}
              </button>
            )}
            {sent && (
              <>
                <label className="field">
                  <span>6-digit code</span>
                  <input
                    data-testid="signin-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    autoFocus
                    placeholder="123456"
                    value={code}
                    disabled={busy}
                    onChange={(e) => setCode(e.target.value)}
                  />
                </label>
                <button
                  data-testid="signin-verify"
                  className="btn primary wide"
                  disabled={busy || !code.trim()}
                >
                  {busy ? "Signing in…" : "Sign in"}
                </button>
                <button
                  type="button"
                  className="btn link"
                  onClick={() => {
                    setSent(false);
                    setCode("");
                  }}
                >
                  Use a different email
                </button>
              </>
            )}
            {error && (
              <p data-testid="signin-error" className="error" role="alert">
                {error}
              </p>
            )}
          </form>
        ) : null}
        <p className="server-note">{serverUrl}</p>
      </div>
    </div>
  );
}
