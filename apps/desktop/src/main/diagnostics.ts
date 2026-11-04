// "Export diagnostics": what helps debug a connector, without secrets. Collects
// the app and OS versions, the connectors' state, and the latest connector
// traces (which already hold no message text or tokens), then scrubs anything
// that looks like a credential once more before writing.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import type { ConnectorSummary } from "./connectors/types";

const SECRET_PATTERNS: [RegExp, string][] = [
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]+/g, "$1[redacted]"],
  [/("(?:token|access_?token|refresh_?token|callback_?token|api_?key|apiKey|accessToken|refreshToken|callbackToken|cookie|authorization|password|secret)"\s*:\s*)"[^"]*"/gi, '$1"[redacted]"'],
  [/([?&](?:token|key|access_token|refresh_token|code|sig|signature|X-Amz-[A-Za-z-]+)=)[^&\s"]+/gi, "$1[redacted]"],
  [/\b(?:sk|pk|cue-key|fake-access|fake-refresh)-[A-Za-z0-9_-]{6,}/g, "[redacted]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, "[redacted-jwt]"],
];

export function scrub(text: string): string {
  return SECRET_PATTERNS.reduce((t, [re, to]) => t.replace(re, to), text);
}

function tail(file: string, lines: number): string[] {
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-lines);
  } catch {
    return [];
  }
}

export function buildDiagnostics(opts: { userData: string; appVersion: string; connectors: ConnectorSummary[] }): string {
  const dir = join(opts.userData, "connector-traces");
  const traces = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .sort()
        .slice(-3)
        .map((f) => ({ file: f, lines: tail(join(dir, f), 400) }))
    : [];
  const report = {
    generatedAt: new Date().toISOString(),
    app: { version: opts.appVersion, electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
    os: { platform: process.platform, release: os.release(), arch: process.arch },
    connectors: opts.connectors.map(({ id, service, name, status, message, connectionId }) => ({ id, service, name, status, message, connectionId })),
    traces,
    note: "Connector traces record only what happened (kinds, sizes, status codes). Turn tracing on with AGENTSTUDIO_CONNECTOR_TRACE=1.",
  };
  return scrub(JSON.stringify(report, null, 2));
}

export function writeDiagnostics(file: string, text: string) {
  writeFileSync(file, text, { mode: 0o600 });
}
