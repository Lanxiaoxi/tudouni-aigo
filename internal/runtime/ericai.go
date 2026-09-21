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

// Reporter is where the interactive login's instructions go.
//
// **It is a parameter rather than a stream written to directly**, and that is the
// fix for a failure that was invisible: this module used to print the device code
// and the verification URI straight to stderr, which is right for the line REPL
// and wrong for the full-screen interface — there, stderr belongs to the parent
// (and the parent's stderr is the terminal the interface is drawing on), while the
// process that runs this code is a child whose stderr is drained and dropped. The
// result was a login that *could not be completed*: the runtime sat waiting up to
// five minutes for a device code the person was never shown.
//
// So the caller decides. The line REPL passes a reporter that writes to stderr;
// the protocol server passes one that turns each line into a notice the front end
// draws in the transcript.
type Reporter func(line string)

// authReport is the nil-safe form of Reporter.
type authReport struct{ reporter Reporter }

// Report sends one line, and does nothing when nobody is listening. A nil check at
// every call site is a check somebody eventually forgets.
func (r authReport) Report(line string) {
	if r.reporter == nil {
		return
	}
	r.reporter(line)
}

// `--ericai` and the in-session `/ericai`: the built-in EricAI login and token
// refresh.
//
// The provider's key is a JWT issued by an EricSSO (Microsoft MSAL) flow, and it
// expires roughly hourly (measured: about 70 minutes). This module checks it,
// quietly mints a new one when it is close to expiry, and writes it back into the
// config. It exists so a stale token never becomes the user's problem to diagnose
// mid-session.
//
// **Checking it once, at start-up, was not enough**, and the symptom was exact: a
// session left open past the token's lifetime answered every turn with "HTTP 401"
// and the only way forward was to quit and restart with the flag. Two facts made
// that so:
//
//   - writing a new key into the config changes nothing for a process that has
//     already read it. The catalogue is loaded once, at open, and the route's key
//     is copied into the model client; without re-installing it, a refresh on disk
//     is invisible to the requests that are failing;
//   - the interactive half was invisible too, because the instructions went to a
//     stderr that a full-screen front end never shows (see Reporter).
//
// So the module is now callable at any time and reports where the caller says.
// `RefreshEricAI` returns the **new key** as well as the sentence, which is what
// lets the runtime install it on the live client (see Runtime.EnsureAuth and the
// pre-request check the agent runs).
//
// One thing the Python original could do that this one deliberately does not:
// share Microsoft's encrypted token cache with the ericai desktop package. That
// cache is an MSAL-internal format; reimplementing its decryption would couple
// this program to a private file format for a one-time convenience. The Go
// variant keeps its own refresh token (in the user config directory, mode 0600)
// after the first interactive login, so the first login asks for a browser once
// and every later refresh is silent.
//
// That last promise is a chain of two links, and both have to hold: the login
// has to come back with a refresh token (which needs `offline_access` in the
// scope), and that token has to reach the store. Break either one and the
// feature degrades into "log in again every single run" — still working, which
// is why the failure is easy to miss.
//
// The failure posture is unchanged and is the point: **nothing here may take a
// session down**. Whether the old token still works is only truly known when the
// model request fails, so every failure path leaves the old key in place and
// returns an explanation.

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
)

// ericTimeout is how long the device-code poll waits for a person to finish.
//
// A variable rather than a constant, for the same reason the three network calls
// are: a test that walks the "nothing works" path would otherwise spend five real
// minutes waiting for a deadline it can state directly.
var ericTimeout = 300 * time.Second

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

// ericDeviceCode runs the device-code flow and reports the instructions through
// the caller's reporter.
//
// The lines go somewhere a person can see them — the line REPL's stderr, or the
// interface's notice channel — and **which** one is not this module's business.
// See Reporter for what writing to stderr here cost.
//
// It returns the **whole** token response, not just the access token. The
// refresh_token in there is the entire reason the next run can stay silent, and
// returning only the access token — as this used to — parses that field and then
// throws it away, which is a browser login on every run.
func ericDeviceCode(report authReport) (ericTokenResponse, error) {
	start, err := ericRequestDeviceCodeFn()
	if err != nil {
		return ericTokenResponse{}, err
	}

	report.Report("\n[ericai] One Eric AI login is needed (later logins refresh silently):")
	report.Report(fmt.Sprintf("[ericai]   open:  %s", start.VerificationURI))
	report.Report(fmt.Sprintf("[ericai]   code:  %s", start.UserCode))
	report.Report(fmt.Sprintf("[ericai]   valid for %d s — the run continues on its own once you finish.", start.ExpiresIn))

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

// ── refreshing on demand, from inside a running session ───────────────────────

// RefreshOptions configures one refresh.
type RefreshOptions struct {
	// Path is the configuration file to read and write. Empty means the user's
	// own config, which is what `--ericai` has always managed.
	Path string
	// Force refreshes even when the token is not near expiry. The command uses it:
	// "the endpoint just told me 401" is a fact that outranks the clock in the
	// token, and a check that answers "still valid" would refuse the one request
	// that knows better.
	Force bool
	// Reporter receives the interactive login's instructions, one line at a time.
	// Nil means nobody is listening, and the flow still completes.
	Reporter Reporter
}

// RefreshResult is what one refresh learned.
//
// It carries the new key as well as the sentence, because writing it back to the
// config is only half the job: a **running** session holds its route in memory —
// the catalogue is read once, at open — so the process that just minted the token
// has to install it on its own client. Returning only a string is how the token
// got refreshed on disk while every request kept carrying the old one.
type RefreshResult struct {
	// Status is the sentence for a human. Empty means nothing happened and there
	// is nothing to say — a token that did not need refreshing.
	Status string
	// Key is the new access token, or "" when the token was left alone.
	Key string
	// ExpiresAt and Minutes describe Key, and are only meaningful when Key is set.
	ExpiresAt time.Time
	Minutes   int
}

// RefreshEricAI checks the EricAI token, refreshes it when it is near expiry
// (silently, or with one browser login), and writes it back.
//
// Every failure path **still writes back nothing** and leaves the old key in
// place, but unlike the start-up action it *does* return the error: a caller that
// asked for a refresh and did not get one has to be able to say so, and the
// interactive login's instructions — which used to go to a stream nobody was
// reading — travel through RefreshOptions.Reporter.
func RefreshEricAI(options RefreshOptions) (RefreshResult, error) {
	configPath := options.Path
	if configPath == "" {
		configPath = config.ConfigFile()
	}
	report := authReport{reporter: options.Reporter}

	raw, err := config.ReadJSONObject(configPath)
	if err != nil {
		return RefreshResult{}, fmt.Errorf("could not read the config (%w)", err)
	}
	providers, _ := raw["providers"].(map[string]any)
	if len(providers) == 0 {
		return RefreshResult{}, fmt.Errorf("the config has no providers section — configure providers.%s first", EricAIProvider)
	}
	item, ok := providers[EricAIProvider].(map[string]any)
	if !ok {
		return RefreshResult{}, fmt.Errorf("no %s route in providers", EricAIProvider)
	}
	key, _ := item["api_key"].(string)

	now := time.Now()
	if !options.Force && !NeedsRefresh(key, now) {
		return RefreshResult{}, nil
	}

	// Silent first: a stored refresh token means no browser round trip.
	var payload ericTokenResponse
	if stored := ericLoadRefreshToken(); stored != "" {
		payload, err = ericRefreshFn(stored)
	}
	if err != nil || payload.AccessToken == "" {
		// No store, or the refresh token died. Interactive login; a new refresh
		// token comes back with it, so this happens once per machine.
		payload, err = ericDeviceCode(report)
		if err != nil {
			return RefreshResult{}, err
		}
		if payload.RefreshToken == "" {
			// Say it out loud rather than let the user discover it at the next
			// expiry: this login bought one access token and no silence.
			report.Report("[ericai] the login returned no refresh token — the next login may ask you to use a browser again")
		}
	}

	exp, ok := DecodeExpiry(payload.AccessToken)
	if !ok {
		// Not refusing to store an unparseable key is how a dead token ends up
		// in the config with no way to diagnose it.
		return RefreshResult{}, fmt.Errorf("the new token carries no exp — not written back, the old token stays")
	}
	if exp <= float64(now.Unix()) {
		return RefreshResult{}, fmt.Errorf("the new token is already expired — not written back, the old token stays")
	}

	if payload.RefreshToken != "" {
		if err := ericSaveRefreshToken(payload.RefreshToken); err != nil {
			// Not fatal: the next run just logs in again.
			report.Report(fmt.Sprintf("[ericai] could not store the refresh token: %v", err))
		}
	}
	if err := ericWriteBack(configPath, payload.AccessToken); err != nil {
		return RefreshResult{}, fmt.Errorf("got the token but could not write it back (%w) — the old token stays", err)
	}
	expiresAt := time.Unix(int64(exp), 0)
	minutes := int(time.Until(expiresAt).Minutes())
	return RefreshResult{
		Status:    fmt.Sprintf("[ericai] token refreshed (valid for about %d min)", minutes),
		Key:       payload.AccessToken,
		ExpiresAt: expiresAt,
		Minutes:   minutes,
	}, nil
}

func maxIntE(a, b int) int {
	if a > b {
		return a
	}
	return b
}
