package runtime

import "fmt"

// UsagePanel is the `ui(usage)` payload: the usage ledger folded into the
// numbers the desktop's usage panel draws.
//
// The answer is built by re-reading the ledger file rather than from any state
// this process holds — the file is the only place that knows what this
// process's predecessors spent, and it is small enough that one read per panel
// open is the whole cost.
func (r *Runtime) UsagePanel() (map[string]any, error) {
	if r.Usage == nil {
		return nil, fmt.Errorf("this runtime has no usage ledger")
	}
	report, err := r.Usage.Report()
	if err != nil {
		return nil, err
	}
	return report.Payload(), nil
}
