//go:build !windows

package main

import (
	"fmt"
	"net/url"
)

// systemProxy is Windows-only.
//
// On the other platforms the system proxy **is** an environment variable
// (`HTTPS_PROXY`, read by browsers and programs through the same mechanism), so
// `-via=env` already measures that path and a second implementation would only be
// the same thing under another name.
func systemProxy() (*url.URL, bool, error) {
	return nil, false, fmt.Errorf("reading the system proxy is implemented for Windows only — use -via=env or -via=proxy")
}
