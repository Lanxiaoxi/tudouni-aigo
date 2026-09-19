//go:build windows

package proxy

import (
	"fmt"
	"net/url"
	"strings"

	"golang.org/x/sys/windows/registry"
)

// system reads the proxy a browser on this machine would use.
//
// This is the whole point of the package: Go's own resolution never looks here,
// and on Windows this is where the user's decision lives. Two shapes are handled,
// in the order WinINET itself tries them:
//
//  1. `AutoConfigURL` — a PAC script. **Refused, not guessed.** Evaluating PAC
//     means running JavaScript, and a wrong guess would silently measure a
//     different path than the browser takes; the caller is told instead, and the
//     person can set `HTTPS_PROXY` to the address their browser reports.
//  2. `ProxyServer` — either `host:port` for every scheme, or a per-scheme list
//     like `http=host:port;https=host:port`.
//
// `ProxyEnable` is checked **first and absolutely**. A proxy client that exits
// commonly leaves `ProxyServer` behind, so reading that value while the switch is
// off would point this program at a port nobody is listening on — turning "the
// browser works" into "this program cannot connect", which is the opposite of what
// this package is for.
func system() (*url.URL, bool, error) {
	settings, ok, err := readSettings()
	if err != nil {
		return nil, false, err
	}
	if !ok {
		// Not fatal: a machine whose settings cannot be read is one that goes
		// direct, which is what it did before this package existed.
		return nil, false, nil
	}
	return systemFrom(settings)
}

// windowsProxy is the raw registry state, split out from the decision so that the
// decision can be tested without the machine's own settings. The split is not
// cosmetic: the branch worth protecting — "the switch is off, so the address left
// behind by an exited proxy client must be ignored" — is unreachable on a machine
// whose switch happens to be on, and would otherwise only be exercised by whoever
// happened to have it off.
type windowsProxy struct {
	enable    uint64
	pac       string
	server    string
	hasEnable bool
}

// readSettings reads the three values, reporting ok=false when the key itself is
// absent (a machine that has never configured a proxy).
func readSettings() (windowsProxy, bool, error) {
	key, err := registry.OpenKey(registry.CURRENT_USER,
		`Software\Microsoft\Windows\CurrentVersion\Internet Settings`, registry.QUERY_VALUE)
	if err != nil {
		return windowsProxy{}, false, nil
	}
	defer key.Close()

	var settings windowsProxy
	if enable, _, err := key.GetIntegerValue("ProxyEnable"); err == nil {
		settings.enable, settings.hasEnable = enable, true
	}
	settings.pac, _, _ = key.GetStringValue("AutoConfigURL")
	settings.server, _, _ = key.GetStringValue("ProxyServer")
	return settings, true, nil
}

// systemFrom decides what one registry snapshot means.
//
// `ProxyEnable` is checked **first and absolutely**. A proxy client that exits
// commonly leaves `ProxyServer` behind, so reading that value while the switch is
// off would point this program at a port nobody is listening on — turning "the
// browser works" into "this program cannot connect", which is the opposite of what
// this package is for.
func systemFrom(settings windowsProxy) (*url.URL, bool, error) {
	if !settings.hasEnable || settings.enable == 0 {
		return nil, false, nil
	}
	// A PAC is refused, not guessed. Evaluating it means running JavaScript, and a
	// wrong guess would silently take a different path than the browser does; the
	// caller is told instead.
	if strings.TrimSpace(settings.pac) != "" {
		return nil, false, fmt.Errorf("this machine is configured with a PAC script (%s), which is not evaluated — set HTTPS_PROXY to the address your browser reports", settings.pac)
	}
	if strings.TrimSpace(settings.server) == "" {
		return nil, false, nil
	}
	parsed, err := parseProxyServer(settings.server)
	if err != nil {
		return nil, false, err
	}
	if parsed == nil {
		return nil, false, nil
	}
	return parsed, true, nil
}

// parseProxyServer handles both spellings Windows stores.
func parseProxyServer(server string) (*url.URL, error) {
	if !strings.Contains(server, "=") {
		return parse(strings.TrimSpace(server))
	}
	perScheme := map[string]string{}
	for _, piece := range strings.Split(server, ";") {
		name, value, ok := strings.Cut(piece, "=")
		if ok {
			perScheme[strings.ToLower(strings.TrimSpace(name))] = strings.TrimSpace(value)
		}
	}
	// https first: this program speaks TLS, and a machine that lists the two
	// separately usually lists them the same way — but taking the http entry for an
	// https request would use a path the request never takes.
	for _, scheme := range []string{"https", "http"} {
		if value := perScheme[scheme]; value != "" {
			return parse(value)
		}
	}
	return nil, nil
}
