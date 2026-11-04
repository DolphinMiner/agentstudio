package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
)

// apiError is the single error shape from docs/api.md.
type apiError struct {
	Status  int
	Code    string
	Message string
	Current any // set for 409 version_conflict
}

func (e *apiError) Error() string { return e.Code + ": " + e.Message }

func errBadRequest(msg string) *apiError {
	return &apiError{Status: http.StatusBadRequest, Code: "bad_request", Message: msg}
}

var (
	errUnauthenticated = &apiError{Status: http.StatusUnauthorized, Code: "unauthenticated", Message: "Authentication required"}
	errForbidden       = &apiError{Status: http.StatusForbidden, Code: "forbidden", Message: "Forbidden"}
	errNotFound        = &apiError{Status: http.StatusNotFound, Code: "not_found", Message: "Not found"}
	errExpired         = &apiError{Status: http.StatusGone, Code: "expired", Message: "This has expired"}
	errInvalidCode     = &apiError{Status: http.StatusUnprocessableEntity, Code: "invalid_code", Message: "The code is invalid or has expired"}
	errRateLimited     = &apiError{Status: http.StatusTooManyRequests, Code: "rate_limited", Message: "Please wait before requesting another code"}
)

func errUpstream(msg string) *apiError {
	return &apiError{Status: http.StatusBadGateway, Code: "upstream_error", Message: msg}
}

func errConflict(current any) *apiError {
	return &apiError{Status: http.StatusConflict, Code: "version_conflict", Message: "The object has changed", Current: current}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, err error) {
	var ae *apiError
	if !errors.As(err, &ae) {
		ae = &apiError{Status: http.StatusInternalServerError, Code: "internal", Message: "Internal server error"}
	}
	body := map[string]any{"code": ae.Code, "message": ae.Message}
	if ae.Current != nil {
		body["current"] = ae.Current
	}
	writeJSON(w, ae.Status, map[string]any{"error": body})
}

// decodeJSON reads a JSON body (max 1 MiB) into v.
func decodeJSON(r *http.Request, v any) error {
	dec := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	if err := dec.Decode(v); err != nil {
		return errBadRequest("Invalid JSON body")
	}
	return nil
}
