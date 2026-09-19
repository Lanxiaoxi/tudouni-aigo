//go:build windows

package main

import (
	"net/url"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/proxy"
)

// systemProxy reports the proxy a browser on this machine would use.
//
// It delegates rather than reimplementing: the decision belongs to
// `internal/proxy`, which is the code the program itself uses, and a second copy
// here could disagree with it. A probe that measures a different path than the
// program takes is worse than no probe — it produces a confident wrong answer,
// which is exactly what this tool was written to avoid.
//
// The wrapper exists for `-via=system`, which is a **measurement** of one path and
// must therefore refuse rather than fall back: `Transport()` would already have
// applied the loopback fallback, so asking it here would make the lane
// indistinguishable from `direct` and the comparison meaningless.
func systemProxy() (*url.URL, bool, error) { return proxy.System() }
