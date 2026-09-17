package security

import "strings"

// RiskLevel is how much damage a tool can do if it does the wrong thing.
//
// Every tool must declare one. There is no default, and that is the point: a tool
// that forgets to declare its risk would silently land on the safest-looking
// value, which is the worst possible failure shape for a permission system.
type RiskLevel string

const (
	RiskLow    RiskLevel = "low"
	RiskMedium RiskLevel = "medium"
	RiskHigh   RiskLevel = "high"
)

// Valid reports whether the value is one of the three levels.
func (r RiskLevel) Valid() bool {
	switch r {
	case RiskLow, RiskMedium, RiskHigh:
		return true
	default:
		return false
	}
}

// Decision is what the policy settled on before any human was involved.
type Decision string

const (
	DecisionAllow Decision = "allow"
	DecisionDeny  Decision = "deny"
	DecisionAsk   Decision = "ask"
)

// Policy is the coarse, declarative layer: risk levels that never need asking,
// and tools that are refused outright.
//
// `auto_approve` holds risk level names. `high` is not among the levels a config
// file may put here — risk is declared per tool, so "auto-approve everything high"
// would silently widen as tools are added. A specific tool can still be named.
type Policy struct {
	AutoApprove []string
	DenyTools   []string
}

// NewPolicy is the default policy: only `low` runs without asking.
func NewPolicy() Policy {
	return Policy{AutoApprove: []string{string(RiskLow)}}
}

// Decide settles a call without asking anyone.
//
// Order, first match wins:
//
//  1. the tool is in the deny list → DENY. The blacklist wins even when the level
//     is auto-approved: "never" beats "usually".
//  2. the risk level is auto-approved → ALLOW.
//  3. otherwise → ASK.
//
// Two empty lists yield ASK for everything. This never fails open.
func (p Policy) Decide(toolName string, risk RiskLevel) Decision {
	for _, denied := range p.DenyTools {
		if denied == toolName {
			return DecisionDeny
		}
	}
	for _, level := range p.AutoApprove {
		if strings.EqualFold(strings.TrimSpace(level), string(risk)) {
			return DecisionAllow
		}
	}
	return DecisionAsk
}

// AutoApproves reports whether this risk level runs without asking. It is what
// the interface renders as `{"risk": "low", "disposition": "auto"}` — the
// disposition is computed here so no front end has to re-derive it.
func (p Policy) AutoApproves(risk RiskLevel) bool {
	return p.Decide("", risk) == DecisionAllow
}

// Disposition is the verdict rendered for one tool: does it ask?
func (p Policy) Disposition(toolName string, risk RiskLevel) string {
	switch p.Decide(toolName, risk) {
	case DecisionAllow:
		return "auto"
	case DecisionDeny:
		return "deny"
	default:
		return "ask"
	}
}
