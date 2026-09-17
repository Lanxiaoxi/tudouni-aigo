package builtin

import (
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// NewGetCurrentTime builds the clock tool. It is stateless and read-only, so it is
// parallel-safe and needs no injected state — which is exactly why it takes no
// arguments at all (no field to fill wrong).
func NewGetCurrentTime() tools.Tool {
	return tools.Tool{
		Name:        "get_current_time",
		Description: "获取当前时间（ISO 8601，含时区偏移）",
		Risk:        security.RiskLow,
		Schema:      tools.EmptySchema(),
		Handler: func(args map[string]any) (tools.Result, error) {
			// Local time with its offset, e.g. 2026-09-17T14:03:05+08:00 — the
			// offset makes it a real instant, not a bare "14:03:05" that is
			// uninterpretable on another machine.
			return tools.TextResult(time.Now().Format("2006-01-02T15:04:05-07:00")), nil
		},
		ParallelSafe: true,
		Interactive:  false,
	}
}
