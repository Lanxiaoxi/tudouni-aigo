package runtime

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/config"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/paths"
)

// `--ericai`: the built-in EricAI login and token refresh.
//
// The provider's key is a JWT issued by an EricSSO (Microsoft MSAL) flow, and it
// expires roughly hourly. This module checks it at start-up, quietly mints a new
// one when it is close to expiry, and writes it back into the config. It exists
// so a stale token never becomes the user's problem to diagnose mid-session.
//
// One thing the Python original could do that this one deliberately does not:
// share Microsoft's encrypted token cache with the ericai desktop package. That
// cache is an MSAL-internal format; reimplementing its decryption would couple
// this program to a private file format for a one-time convenience. The Go
// variant keeps its own refresh token (in the user config directory, mode 0600)
// after the first interactive login, so the first `--ericai` asks for a browser
// login once and every later run is silent.
//
// That last promise is a chain of two links, and both have to hold: the login
// has to come back with a refresh token (which needs `offline_access` in the
// scope), and that token has to reach the store. Break either one and the
// feature degrades into "log in again every single run" — still working, which
// is why the failure is easy to miss.
//
// The failure posture is unchanged and is the point: **nothing here may block
// start-up**. Whether the old token still works is only truly known when the
// model request fails, so every failure path returns an explanation and keeps
// the old key in place.

// EricAIProvider is the route whose api_key this module manages.
const EricAIProvider = "ericai"

// RefreshThreshold refreshes the token when less than this much validity remains.
const RefreshThreshold = 600.0

const (
	ericTenantID = "92e84ceb-fbfd-47ab-be52-080c6b87953f"
	ericClientID = "b46aa582-485a-4a7d-b30e-552dbd790b16"
	// The scope is the api:// form of the client id; it is a public constant of
	// the backend, not a secret.
	ericScope = "api://" + ericClientID + "/API"
	// offline_access is what makes Entra hand back a refresh_token at all: the
	// device-code endpoint issues one only when the original `scope` asked for
	// it. Leave it out and every step still succeeds — the login works, the
	// access token gets written — while the store stays empty and the next
	// expiry asks for a browser again.
	ericOfflineAccess = "offline_access"
	// Both requests ask for exactly this: the API, plus the right to come back
	// without a browser. They are kept identical on purpose, so the refresh
	// token minted at login is redeemable later.
	ericScopes = ericScope + " " + ericOfflineAccess

	ericRefreshName = "ericai_refreshtoken"
	ericTimeout     = 300 * time.Second
)

// ── JWT expiry ────────────────────────────────────────────────────────────────

// DecodeExpiry pulls `exp` out of a JWT. No third-party JWT library: the payload
// is base64url JSON and four lines of decoding beat a dependency.
func DecodeExpiry(token string) (float64, bool) {
	text := strings.TrimSpace(token)
	if text == "" {
		return 0, false
	}
	parts := strings.Split(text, ".")
	if len(parts) != 3 {
		return 0, false
	}
	// JWT base64url is unpadded; Go's decoder wants the padding back.
	payload := parts[1]
	payload += strings.Repeat("=", (4-len(payload)%4)%4)
	decoded, err := base64.URLEncoding.DecodeString(payload)
	if err != nil {
		return 0, false
	}
	var claims struct {
		Exp float64 `json:"exp"`
	}
	if err := json.Unmarshal(decoded, &claims); err != nil || claims.Exp <= 0 {
		return 0, false
	}
	return claims.Exp, true
}

// NeedsRefresh reports whether the key should be replaced. An unparseable token
// counts as stale: letting the refresh flow try once beats keeping a token whose
// shape nobody can read.
func NeedsRefresh(token string, now time.Time) bool {
	exp, ok := DecodeExpiry(token)
	if !ok {
		return true
	}
	return exp-float64(now.Unix()) < RefreshThreshold
}

// ── the MSAL device-code flow over plain HTTP ─────────────────────────────────

const (
	ericDeviceCodeURL = "https://login.microsoftonline.com/" + ericTenantID + "/oauth2/v2.0/devicecode"
	ericTokenURL      = "https://login.microsoftonline.com/" + ericTenantID + "/oauth2/v2.0/token"
)

type ericTokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int    `json:"expires_in"`
	Error        string `json:"error"`
	Description  string `json:"error_description"`
}

func ericPostToken(form url.Values) (ericTokenResponse, error) {
	client := &http.Client{Timeout: 30 * time.Second}
	response, err := client.PostForm(ericTokenURL, form)
	if err != nil {
		return ericTokenResponse{}, err
	}
	defer response.Body.Close()
	var payload ericTokenResponse
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return ericTokenResponse{}, err
	}
	if payload.Error != "" {
		return payload, fmt.Errorf("%s: %s", payload.Error, payload.Description)
	}
	return payload, nil
}

// The three network entry points, behind variables so a test can walk the whole
// decision tree — interactive login, storing the refresh token, silent refresh —
// without a tenant to talk to. Nothing else assigns them.
var (
	ericRequestDeviceCodeFn = ericRequestDeviceCode
	ericPostTokenFn         = ericPostToken
	ericRefreshFn           = ericRefresh
)

// ericDeviceCodeForm is the first request of the interactive flow. Both it and
// the refresh grant send ericScopes; see the constant for why.
func ericDeviceCodeForm() url.Values {
	return url.Values{
		"client_id": {ericClientID},
		"scope":     {ericScopes},
	}
}

// ericPollForm trades the user code's device_code for tokens. No scope here:
// RFC 8628's poll takes grant_type, client_id and device_code, and the scopes
// were fixed by the /devicecode request above.
func ericPollForm(deviceCode string) url.Values {
	return url.Values{
		"grant_type":  {"urn:ietf:params:oauth:grant-type:device_code"},
		"client_id":   {ericClientID},
		"device_code": {deviceCode},
	}
}

// ericRefreshForm redeems a stored refresh token for a new access token.
func ericRefreshForm(refreshToken string) url.Values {
	return url.Values{
		"grant_type":    {"refresh_token"},
		"client_id":     {ericClientID},
		"refresh_token": {refreshToken},
		"scope":         {ericScopes},
	}
}

// ericLoginPrompt is what /devicecode hands back: what to show the user, and
// the code the token poll trades in.
type ericLoginPrompt struct {
	DeviceCode      string `json:"device_code"`
	UserCode        string `json:"user_code"`
	VerificationURI string `json:"verification_uri"`
	ExpiresIn       int    `json:"expires_in"`
	Interval        int    `json:"interval"`
	Message         string `json:"message"`
}

func ericRequestDeviceCode() (ericLoginPrompt, error) {
	client := &http.Client{Timeout: 30 * time.Second}
	response, err := client.PostForm(ericDeviceCodeURL, ericDeviceCodeForm())
	if err != nil {
		return ericLoginPrompt{}, err
	}
	defer response.Body.Close()
	var start ericLoginPrompt
	if err := json.NewDecoder(response.Body).Decode(&start); err != nil {
		return ericLoginPrompt{}, err
	}
	return start, nil
}

// ericDeviceCode runs the device-code flow and prints the instructions to
// stderr, where a plain terminal can see them before the interface starts.
//
// It returns the **whole** token response, not just the access token. The
// refresh_token in there is the entire reason the next run can stay silent, and
// returning only the access token — as this used to — parses that field and then
// throws it away, which is a browser login on every run.
func ericDeviceCode() (ericTokenResponse, error) {
	start, err := ericRequestDeviceCodeFn()
	if err != nil {
		return ericTokenResponse{}, err
	}

	fmt.Fprintf(os.Stderr, "\n[ericai] One Eric AI login is needed (every later run refreshes silently):\n")
	fmt.Fprintf(os.Stderr, "[ericai]   open:  %s\n", start.VerificationURI)
	fmt.Fprintf(os.Stderr, "[ericai]   code:  %s\n", start.UserCode)
	fmt.Fprintf(os.Stderr, "[ericai]   valid for %d s — the run continues on its own once you finish.\n", start.ExpiresIn)

	interval := time.Duration(maxIntE(start.Interval, 1)) * time.Second
	deadline := time.Now().Add(ericTimeout)
	for time.Now().Before(deadline) {
		time.Sleep(interval)
		payload, err := ericPostTokenFn(ericPollForm(start.DeviceCode))
		if err != nil {
			if strings.Contains(payload.Error, "authorization_pending") ||
				strings.Contains(payload.Error, "slow_down") {
				continue
			}
			return ericTokenResponse{}, err
		}
		return payload, nil
	}
	return ericTokenResponse{}, fmt.Errorf("the device code expired before the login finished")
}

// ericRefresh silently mints an access token from a stored refresh token.
func ericRefresh(refreshToken string) (ericTokenResponse, error) {
	return ericPostToken(ericRefreshForm(refreshToken))
}

// ── the refresh-token store ───────────────────────────────────────────────────

// ericRefreshPath is where the silent-refresh secret lives. Mode 0600: it mints
// access tokens, and a secret that world-readable is not a secret.
func ericRefreshPath() string {
	return filepath.Join(paths.UserConfigDir(), ericRefreshName)
}

func ericLoadRefreshToken() string {
	raw, err := os.ReadFile(ericRefreshPath())
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(raw))
}

func ericSaveRefreshToken(token string) error {
	if err := os.MkdirAll(paths.UserConfigDir(), 0o700); err != nil {
		return err
	}
	return os.WriteFile(ericRefreshPath(), []byte(token+"\n"), 0o600)
}

// ── writing the key back: one field, atomic ───────────────────────────────────

// ericWriteBack replaces `providers.ericai.api_key` and nothing else.
//
// It reads the **original JSON** — not the parsed subset — so `$comment` and
// every other top-level key survive untouched. Atomicity: a temp file in the
// same directory, then a rename, which is atomic within one filesystem. Half a
// config file is data loss, because this file holds keys.
func ericWriteBack(configPath, newKey string) error {
	raw, err := config.ReadJSONObject(configPath)
	if err != nil {
		return err
	}
	providers, _ := raw["providers"].(map[string]any)
	if providers == nil {
		providers = map[string]any{}
		raw["providers"] = providers
	}
	item, _ := providers[EricAIProvider].(map[string]any)
	if item == nil {
		item = map[string]any{}
		providers[EricAIProvider] = item
	}
	item["api_key"] = newKey

	encoded, err := json.MarshalIndent(raw, "", "  ")
	if err != nil {
		return err
	}
	encoded = append(encoded, '\n')

	tmp := configPath + ".tmp"
	if err := os.WriteFile(tmp, encoded, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, configPath)
}

// ── the start-up action ───────────────────────────────────────────────────────

// EnsureEricAI is `--ericai`: check, refresh when needed (silently, or with one
// browser login), write back. It returns a sentence for a human. **No failure
// path returns an error** — the old token stays in place and start-up continues,
// because whether the old token truly works is decided by the next model request,
// not here.
func EnsureEricAI() string {
	configPath := config.ConfigFile()
	raw, err := config.ReadJSONObject(configPath)
	if err != nil {
		return fmt.Sprintf("[ericai] could not read the config (%v) — refresh skipped", err)
	}
	providers, _ := raw["providers"].(map[string]any)
	if len(providers) == 0 {
		return "[ericai] the config has no providers section — configure providers.ericai first"
	}
	item, ok := providers[EricAIProvider].(map[string]any)
	if !ok {
		return fmt.Sprintf("[ericai] no %s route in providers — --ericai has nothing to manage", EricAIProvider)
	}
	key, _ := item["api_key"].(string)

	now := time.Now()
	if !NeedsRefresh(key, now) {
		exp, _ := DecodeExpiry(key)
		minutes := int((exp - float64(now.Unix())) / 60)
		return fmt.Sprintf("[ericai] token still valid for about %d min — no refresh", minutes)
	}

	// Silent first: a stored refresh token means no browser round trip.
	var payload ericTokenResponse
	if stored := ericLoadRefreshToken(); stored != "" {
		payload, err = ericRefreshFn(stored)
	}
	if err != nil || payload.AccessToken == "" {
		// No store, or the refresh token died. Interactive login; a new refresh
		// token comes back with it, so this happens once per machine.
		var loginErr error
		payload, loginErr = ericDeviceCode()
		if loginErr != nil {
			return fmt.Sprintf("[ericai] login/refresh failed: %v (the old token stays; rerun to try again)", loginErr)
		}
		if payload.RefreshToken == "" {
			// Say it out loud rather than let the user discover it at the next
			// expiry: this login bought one access token and no silence.
			fmt.Fprintln(os.Stderr, "[ericai] the login returned no refresh token — the next run may ask you to log in again")
		}
	}

	exp, ok := DecodeExpiry(payload.AccessToken)
	if !ok {
		// Not refusing to store an unparseable key is how a dead token ends up
		// in the config with no way to diagnose it.
		return "[ericai] the new token carries no exp — not written back, the old token stays"
	}
	if exp <= float64(now.Unix()) {
		return "[ericai] the new token is already expired — not written back, the old token stays"
	}

	if payload.RefreshToken != "" {
		if err := ericSaveRefreshToken(payload.RefreshToken); err != nil {
			// Not fatal: the next run just logs in again.
			fmt.Fprintf(os.Stderr, "[ericai] could not store the refresh token: %v\n", err)
		}
	}
	if err := ericWriteBack(configPath, payload.AccessToken); err != nil {
		return fmt.Sprintf("[ericai] got the token but could not write it back: %v (the old token stays)", err)
	}
	minutes := int((exp - float64(now.Unix())) / 60)
	return fmt.Sprintf("[ericai] token refreshed (valid for about %d min)", minutes)
}

func maxIntE(a, b int) int {
	if a > b {
		return a
	}
	return b
}
