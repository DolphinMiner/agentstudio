import { useEffect, useState, type FormEvent } from "react";
import QRCode from "qrcode";
import type { LoginStep } from "@agentstudio/core";
import { errorText } from "../lib/errors";
import { api } from "../lib/services";

/**
 * Generic renderer for a bridgev2 login step (docs/api.md LoginStep):
 * user_input forms, display_and_wait (QR / code, long-polled), cookies (not
 * supported on desktop in v0.1) and complete.
 */
export function LoginStepView({
  processId,
  step,
  onStep,
  onDone,
}: {
  processId: string;
  step: LoginStep;
  onStep(next: LoginStep): void;
  onDone(): void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div data-testid="login-step" data-step-type={step.type} className="login-step">
      {step.instructions && step.type !== "complete" && <p className="instructions">{step.instructions}</p>}
      {step.type === "user_input" && (
        <UserInputForm
          step={step}
          busy={busy}
          onSubmit={async (fields) => {
            setBusy(true);
            setError(null);
            try {
              onStep(await api.submitLoginStep(processId, step.step_id, { fields }));
            } catch (e) {
              setError(errorText(e));
            } finally {
              setBusy(false);
            }
          }}
        />
      )}
      {step.type === "display_and_wait" && (
        <DisplayAndWait processId={processId} step={step} onStep={onStep} onError={setError} />
      )}
      {step.type === "cookies" && (
        <p className="muted">
          This network signs in with browser cookies, which is not supported on desktop yet (v0.1).
        </p>
      )}
      {step.type === "complete" && (
        <div data-testid="login-complete" className="login-complete">
          <div className="done-mark" aria-hidden>
            ✓
          </div>
          <div>
            <strong>Connected</strong>
            <p className="muted small">{step.instructions || "Your chats will appear in the inbox shortly."}</p>
          </div>
          <button className="btn primary" onClick={onDone}>
            Done
          </button>
        </div>
      )}
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function UserInputForm({
  step,
  busy,
  onSubmit,
}: {
  step: LoginStep;
  busy: boolean;
  onSubmit(fields: Record<string, string>): void;
}) {
  const fields = step.user_input?.fields ?? [];
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.id, f.default_value ?? (f.type === "select" ? (f.options?.[0] ?? "") : "")])),
  );
  const set = (id: string, v: string) => setValues((s) => ({ ...s, [id]: v }));

  function submit(e: FormEvent) {
    e.preventDefault();
    onSubmit(values);
  }

  return (
    <form onSubmit={submit} className="login-form">
      {fields.map((f) => (
        <label key={f.id} className="field">
          <span>{f.name}</span>
          {f.type === "select" ? (
            <select data-testid={`login-field-${f.id}`} value={values[f.id] ?? ""} onChange={(e) => set(f.id, e.target.value)}>
              {(f.options ?? []).map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : (
            <input
              data-testid={`login-field-${f.id}`}
              type={inputType(f.type)}
              value={values[f.id] ?? ""}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => set(f.id, e.target.value)}
            />
          )}
          {f.description && <small className="muted">{f.description}</small>}
        </label>
      ))}
      <button data-testid="login-submit" className="btn primary" disabled={busy}>
        {busy ? "Connecting…" : "Continue"}
      </button>
    </form>
  );
}

function inputType(t: string): string {
  switch (t) {
    case "password":
    case "token":
      return "password";
    case "email":
      return "email";
    case "phone_number":
      return "tel";
    case "url":
      return "url";
    default:
      return "text";
  }
}

function DisplayAndWait({
  processId,
  step,
  onStep,
  onError,
}: {
  processId: string;
  step: LoginStep;
  onStep(next: LoginStep): void;
  onError(e: string | null): void;
}) {
  const d = step.display_and_wait;
  const [qr, setQr] = useState<string | null>(null);

  useEffect(() => {
    setQr(null);
    if (d?.type === "qr" && d.data) {
      QRCode.toDataURL(d.data, { margin: 1, width: 220 }).then(setQr, () => setQr(null));
    }
  }, [d?.type, d?.data]);

  // Long-poll until the step changes (the server returns the same step on timeout).
  useEffect(() => {
    let alive = true;
    const ac = new AbortController();
    const same = (n: LoginStep) =>
      n.step_id === step.step_id && n.type === step.type && n.display_and_wait?.data === step.display_and_wait?.data;
    void (async () => {
      while (alive) {
        try {
          const next = await api.waitLoginStep(processId, step.step_id, ac.signal);
          if (!alive) return;
          onError(null);
          if (!same(next)) {
            onStep(next);
            return;
          }
        } catch (e) {
          if (!alive) return;
          onError(errorText(e));
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    })();
    return () => {
      alive = false;
      ac.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [processId, step]);

  return (
    <div className="display-wait">
      {d?.type === "qr" &&
        (qr ? <img data-testid="login-qr" src={qr} alt="QR code to scan" width={220} height={220} /> : <div data-testid="login-qr" className="qr-placeholder" />)}
      {(d?.type === "code" || d?.type === "emoji") && (
        <div data-testid="login-code" className="login-code">
          {d.data}
        </div>
      )}
      <p className="muted small">Waiting for confirmation…</p>
    </div>
  );
}
