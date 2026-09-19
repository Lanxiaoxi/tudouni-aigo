//go:build windows

package proxy

import "testing"

// TestAStaleAddressWithTheSwitchOffIsIgnored is the case measured on the machine
// this package was written for: `ProxyEnable=0` while `ProxyServer` still names a
// loopback port, because the proxy client left it behind when it exited.
//
// Following that address would point this program at a port nobody is listening on
// — turning "the browser works" into "this program cannot connect", the inverse of
// the bug being fixed. The switch is therefore read first and absolutely.
func TestAStaleAddressWithTheSwitchOffIsIgnored(t *testing.T) {
	stale := windowsProxy{enable: 0, hasEnable: true, server: "127.0.0.1:7897"}
	resolved, found, err := systemFrom(stale)
	if err != nil {
		t.Fatalf("systemFrom: %v", err)
	}
	if found || resolved != nil {
		t.Fatalf("a disabled proxy was used anyway: %v", resolved)
	}
}

// The switch being absent is the same answer as it being off — a machine that has
// never configured a proxy.
func TestAMissingSwitchIsOff(t *testing.T) {
	resolved, found, err := systemFrom(windowsProxy{server: "127.0.0.1:7897"})
	if err != nil || found || resolved != nil {
		t.Fatalf("found=%v resolved=%v err=%v, want no proxy", found, resolved, err)
	}
}

// And the other direction: with the switch on, the same address is used.
func TestAnEnabledAddressIsUsed(t *testing.T) {
	enabled := windowsProxy{enable: 1, hasEnable: true, server: "127.0.0.1:7897"}
	resolved, found, err := systemFrom(enabled)
	if err != nil || !found {
		t.Fatalf("systemFrom found=%v err=%v, want the configured address", found, err)
	}
	if resolved.String() != "http://127.0.0.1:7897" {
		t.Errorf("resolved = %s", resolved)
	}
}

// A PAC script is refused rather than guessed: evaluating it means running
// JavaScript, and a wrong guess would silently take a different path than the
// browser — the failure this package exists to remove.
func TestAPACIsRefusedRatherThanGuessed(t *testing.T) {
	settings := windowsProxy{enable: 1, hasEnable: true, pac: "http://127.0.0.1:7897/proxy.pac"}
	resolved, found, err := systemFrom(settings)
	if err == nil {
		t.Fatal("a PAC script was accepted silently")
	}
	if found || resolved != nil {
		t.Errorf("a PAC script produced a proxy anyway: %v", resolved)
	}
}

// The per-scheme spelling Windows stores. Taking the http entry for an https
// request would use a path the request never takes.
func TestAPerSchemeListPrefersHTTPS(t *testing.T) {
	resolved, err := parseProxyServer("http=127.0.0.1:1111;https=127.0.0.1:2222")
	if err != nil || resolved == nil {
		t.Fatalf("parseProxyServer: %v %v", resolved, err)
	}
	if resolved.String() != "http://127.0.0.1:2222" {
		t.Errorf("resolved = %s, want the https entry", resolved)
	}

	onlyHTTP, err := parseProxyServer("http=127.0.0.1:1111")
	if err != nil || onlyHTTP == nil || onlyHTTP.String() != "http://127.0.0.1:1111" {
		t.Errorf("an http-only list resolved to %v (%v)", onlyHTTP, err)
	}
}

// An enabled switch with no address is "nothing to use", not an error.
func TestAnEnabledSwitchWithNoAddressIsDirect(t *testing.T) {
	resolved, found, err := systemFrom(windowsProxy{enable: 1, hasEnable: true})
	if err != nil || found || resolved != nil {
		t.Fatalf("found=%v resolved=%v err=%v, want no proxy", found, resolved, err)
	}
}
