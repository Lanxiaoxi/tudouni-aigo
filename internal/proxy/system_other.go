//go:build !windows

package proxy

import "net/url"

// system finds nothing outside Windows, and that is correct rather than a gap.
//
// On the other platforms the system proxy **is** an environment variable: macOS
// and the Linux desktops hand `HTTPS_PROXY` (or the variables the desktop tooling
// writes from its own settings) to every process. So `environment` above already
// reads the same decision a browser there reads, and a second implementation would
// be the same answer under another name.
func system() (*url.URL, bool, error) { return nil, false, nil }
