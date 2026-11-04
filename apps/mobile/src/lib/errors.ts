import { isApiError } from "@agentstudio/core";

/** A short human message for an error from @agentstudio/core or the network. */
export function errorText(e: unknown): string {
  if (isApiError(e)) {
    switch (e.code) {
      case "invalid_code":
        return "That code is not valid. Check it and try again.";
      case "rate_limited":
        return "Too many attempts. Wait a moment and try again.";
      case "network_error":
        return "Can't reach the server. Check your connection.";
      case "timeout":
        return "The server took too long to answer.";
      case "expired":
        return "This has expired.";
      case "version_conflict":
        return "This was changed somewhere else.";
      default:
        return e.message || "Something went wrong.";
    }
  }
  if (e instanceof Error && e.message) return e.message;
  return "Something went wrong.";
}
