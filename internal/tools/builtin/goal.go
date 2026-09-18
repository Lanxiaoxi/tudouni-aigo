package builtin

import (
	"fmt"
	"strings"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// The goal tools: the model's half of the goal feature.
//
// A goal is one long-running completion objective that outlives the turn that
// created it. The state lives in `internal/state/goal.go`; these three tools are
// the only way the model may read or move it, and their job is to make the two
// things that go wrong impossible:
//
//   - **The model acting on a goal that has moved.** Every change carries the id
//     and revision the model last read, and a stale pair is refused rather than
//     applied. That is why the guidance says to call get_goal first: the refusal
//     is only useful if the model can retry with the current numbers.
//   - **The model authorizing itself.** `create`, `edit`, `pause` and `resume`
//     require the turn in progress to be the person's. Reading and *ending* a goal
//     stay available inside an autonomous round — a round that finds the objective
//     unreachable must be able to say so, or the loop could only ever stop by
//     exhausting its budget.
//
// There is deliberately no tool that spends a round. Round numbers are the loop's
// budget and the driver's business; a number the model could set would make "this
// goal gets N rounds" a claim the runtime cannot keep.

// GoalBoard binds the goal to a session's metadata.
//
// The metadata map is shared with the runtime, so a committed change is visible to
// everything holding the same reference; persistence is the injected function's
// job, which is the runtime's checkpoint.
type GoalBoard struct {
	Metadata map[string]any
	// Session is read for "was this turn started by a person". Nil means nobody
	// can prove it, which the authorization treats as "not a person" — the safe
	// direction.
	Session *state.Session
	// Commit persists what was just written. It is called **inside** the tool call
	// rather than left to the next step boundary, so a turn killed by Ctrl+C right
	// after a goal change does not lose the change. Nil is legal (tests, one-shot
	// use) and means "the metadata is in memory only".
	Commit func()
}

// NewGoalBoard builds a board over the live session metadata.
func NewGoalBoard(metadata map[string]any, session *state.Session, commit func()) *GoalBoard {
	return &GoalBoard{Metadata: metadata, Session: session, Commit: commit}
}

// GoalTools is the three goal tools plus the board they share.
type GoalTools struct {
	Board *GoalBoard
	All   []tools.Tool
}

// NewGoalTools builds get_goal, create_goal and update_goal over one board.
//
// The struct exists for its `Board` field: the runtime renders the payload tail
// from the same object the tools write through, so "what the model is told" and
// "what the tools report" cannot become two answers.
func NewGoalTools(metadata map[string]any, session *state.Session, commit func()) GoalTools {
	board := NewGoalBoard(metadata, session, commit)
	return GoalTools{
		Board: board,
		All:   []tools.Tool{newGetGoal(board), newCreateGoal(board), newUpdateGoal(board)},
	}
}

// human reports whether the turn in progress was started by a person.
func (b *GoalBoard) human() bool {
	if b.Session == nil {
		return false
	}
	return b.Session.IsHumanTurn()
}

// commitIfNeeded persists a change that just landed.
func (b *GoalBoard) commitIfNeeded() {
	if b.Commit != nil {
		b.Commit()
	}
}

// --- tools ------------------------------------------------------------------

func newGetGoal(board *GoalBoard) tools.Tool {
	return tools.Tool{
		Name: "get_goal",
		Description: `读取当前会话的长期目标（goal）：目标文本、阶段、已用轮次/上限、阻塞原因，以及续行是否已启用。
没有目标时它明确回答"没有目标" —— 这是正常状态，不要为了显得在做事而创建一个。
**在 update_goal 之前必须先调用它**，并把返回的 goal_id 与 revision 原样抄进参数：两者只要有一个不是当前的，更新就会被拒绝（另一个轮次可能刚改过它）。
只读，不改变任何状态。`,
		Risk:         security.RiskLow,
		Schema:       tools.EmptySchema(),
		ParallelSafe: true,
		Interactive:  false,
		Handler: func(map[string]any) (tools.Result, error) {
			return tools.Result{Text: board.GetText(), Audit: board.auditFields()}, nil
		},
	}
}

func newCreateGoal(board *GoalBoard) tools.Tool {
	return tools.Tool{
		Name: "create_goal",
		Description: `为**当前会话**创建一个长期目标，让它在后续轮次里持续存在（跨 compaction、跨 /resume）。
**只用于"一次会话里要持续完成的单一长期目标"。** 只要用户是用自然语言提了这样一件事 —— 任何语言、任何说法 —— 你就可以**从这句话里推断出目标**并创建它，不需要用户说"建一个 goal"这种话。
反过来：**日常的单轮任务、一次问答、一个单步修改，不要建 goal**。建了它会占用后续轮次自动推进；你顺手想多做点事，也不是理由。
只有在用户直接发起的轮次里才能创建：在一轮自动续行里调用它会被拒绝。
objective 用一句话说清"什么状态算完成"（从用户的话里推断，不要自己加戏）；max_goal_rounds 是自动续行的轮次上限（默认 256，最大 1000），不确定就不要传。`,
		Risk: security.RiskLow,
		Schema: tools.ObjectSchema(map[string]any{
			"objective": tools.StringSchema(
				"从用户这次直接请求里推断出的、具体的完成目标，一句话。不要写成计划或步骤列表",
				tools.MinLength(1),
			),
			"max_goal_rounds": tools.IntSchema(
				fmt.Sprintf("自动续行的轮次上限，默认 %d，最大 %d",
					state.DefaultMaxGoalRounds, state.MaxGoalRoundsCeiling),
				tools.Minimum(1),
				tools.Maximum(state.MaxGoalRoundsCeiling),
			),
		}, "objective"),
		ParallelSafe: false,
		Interactive:  false,
		Handler: func(args map[string]any) (tools.Result, error) {
			return board.Create(args), nil
		},
	}
}

func newUpdateGoal(board *GoalBoard) tools.Tool {
	return tools.Tool{
		Name: "update_goal",
		Description: `改变当前目标：edit（改目标/轮次上限）、pause（暂停续行）、resume（恢复续行）、complete（目标达成）、blocked（确实卡住）。
必须先调用 get_goal，并把返回的 goal_id 与 revision 原样抄进来 —— 两者只要有一个不是当前的就会被拒绝，这是为了防止你按一个已经不存在的目标做决定。
edit / pause / resume 只能在用户直接发起的轮次里调用；complete 和 blocked 在自动续行里也可以调用。
- complete：**只有在你已经拿到证据、能证明整个目标达成时才用**；"我觉得差不多了""计划做完了"都不算。部分完成不是完成，没做完的留在目标里。
- blocked：**只有在同一个阻塞连续几轮都没有变化、而且你自己解决不了时才用**；blocked_reason 要写清具体是什么在挡路（哪一步、什么工具、什么错误）。难度大、还没做完、还有有价值的工作剩着，都不算阻塞。
- 确实需要用户补一个只有他知道的信息时，用 ask_user，不要用 blocked 代替提问。`,
		Risk: security.RiskLow,
		Schema: tools.ObjectSchema(map[string]any{
			"goal_id":  tools.StringSchema("get_goal 返回的 id，原样抄", tools.MinLength(1)),
			"revision": tools.IntSchema("get_goal 返回的 revision，原样抄", tools.Minimum(1)),
			"action": tools.StringSchema(
				"edit 改目标 / pause 暂停续行 / resume 恢复续行 / complete 目标达成 / blocked 卡住",
				tools.Enum(state.GoalOpEdit, state.GoalOpPause, state.GoalOpResume,
					state.GoalOpComplete, state.GoalOpBlock),
			),
			"objective": tools.StringSchema("仅 action=edit：新的目标文本（替换原文）", tools.MinLength(1)),
			"max_goal_rounds": tools.IntSchema(
				fmt.Sprintf("仅 action=edit：新的轮次上限，最大 %d", state.MaxGoalRoundsCeiling),
				tools.Minimum(1),
				tools.Maximum(state.MaxGoalRoundsCeiling),
			),
			"blocked_reason": tools.StringSchema("仅 action=blocked：具体是什么在挡路，必填", tools.MinLength(1)),
		}, "goal_id", "revision", "action"),
		ParallelSafe: false,
		Interactive:  false,
		Handler: func(args map[string]any) (tools.Result, error) {
			return board.Update(args), nil
		},
	}
}

// --- handlers ---------------------------------------------------------------

// GetText renders the goal as every goal tool answers it.
//
// One shape for three tools on purpose: the model reads them in the same turn, and
// a "no goal" that looks different from a goal is the kind of difference that gets
// misread as an error.
//
// It is written as named lines rather than compact JSON even though the model
// parses either. This rendering is the **only** place the goal is shown to the
// model at the moment it decides, and a value named only by position would have it
// guessing which number is the revision — guessing wrong is exactly what the
// revision fence refuses.
//
// `turn` is not a fact about the goal: it says whether this turn was started by a
// person, which is what decides whether create/edit/pause/resume will be accepted.
// Stating it here means the model does not have to attempt a refused change to find
// out why it was refused.
func (b *GoalBoard) GetText() string {
	turn := turnText(b.human())
	goal, ok := state.LoadGoal(b.Metadata)
	if !ok {
		return i18n.T("goal.none", "turn", turn)
	}
	var builder strings.Builder
	builder.WriteString(i18n.T("goal.read", "turn", turn) + "\n")
	builder.WriteString("goal_id: " + goal.ID + "\n")
	builder.WriteString("objective: " + goal.Objective + "\n")
	builder.WriteString("phase: " + string(goal.Phase) + "\n")
	builder.WriteString(fmt.Sprintf("revision: %d\n", goal.Revision))
	builder.WriteString(fmt.Sprintf("rounds: %d/%d（已用 %d，剩余 %d）\n",
		goal.Rounds, goal.MaxRounds, goal.Rounds, goal.MaxRounds-goal.Rounds))
	if goal.BlockedCode != "" {
		// The code first because it is the machine-routable half, then the sentence
		// because the code alone does not say what actually happened.
		builder.WriteString("blocked_reason: " + goal.BlockedCode + " — " + goal.BlockedText + "\n")
	}
	if goal.RoundLimitReached() {
		builder.WriteString(i18n.T("goal.limit_reached") + "\n")
	}
	return strings.TrimRight(builder.String(), "\n")
}

func turnText(human bool) string {
	if human {
		return i18n.T("goal.turn.human")
	}
	return i18n.T("goal.turn.autonomous")
}

// Create handles create_goal.
func (b *GoalBoard) Create(args map[string]any) tools.Result {
	if !state.AuthorizedBy(state.GoalOpCreate, b.human()) {
		return b.refusal(state.GoalErrNotHuman)
	}
	goal, err := state.CreateGoal(b.Metadata, state.GoalSpec{
		Objective: stringOf(args["objective"]),
		MaxRounds: intArg(args, "max_goal_rounds", 0),
	})
	if err != nil {
		return b.refusalFrom(err)
	}
	b.commitIfNeeded()
	return tools.Result{
		Text: i18n.T("goal.created", "objective", goal.Objective, "rounds", goal.RoundsText()) +
			"\n" + b.GetText(),
		Audit: b.auditFields(),
	}
}

// Update handles update_goal.
//
// The action names are checked against the schema's own enum, but the check is
// repeated here: a tool reached through MCP or through a hand-written call has not
// been through this package's validator, and an unchecked action string reaching
// the state layer would be a way to ask for something that is not a transition.
func (b *GoalBoard) Update(args map[string]any) tools.Result {
	action := stringOf(args["action"])
	switch action {
	case state.GoalOpEdit, state.GoalOpPause, state.GoalOpResume, state.GoalOpComplete, state.GoalOpBlock:
	default:
		return b.refusal(state.GoalErrInvalidOp)
	}
	if !state.AuthorizedBy(action, b.human()) {
		return b.refusal(state.GoalErrNotHuman)
	}

	goal, err := state.ApplyGoalChange(b.Metadata,
		stringOf(args["goal_id"]), intArg(args, "revision", 0),
		state.GoalChange{
			Op:          action,
			Objective:   stringOf(args["objective"]),
			MaxRounds:   intArg(args, "max_goal_rounds", 0),
			BlockedText: stringOf(args["blocked_reason"]),
		})
	if err != nil {
		return b.refusalFrom(err)
	}
	b.commitIfNeeded()

	head := i18n.T("goal.updated", "action", action)
	switch action {
	case state.GoalOpComplete:
		head = i18n.T("goal.completed")
	case state.GoalOpBlock:
		head = i18n.T("goal.blocked", "reason", goal.BlockedText)
	}
	return tools.Result{
		Text:  head + "\n" + b.GetText(),
		Audit: b.auditFields(),
	}
}

// --- refusals ---------------------------------------------------------------

// refusalFrom turns a state-layer refusal into text the model can act on.
//
// It never returns an error, and that is deliberate: a refused goal change is a
// normal answer, not a tool failure. Returning an error would make the caller see
// "the tool broke", and the model would retry the same call instead of reading the
// current goal and correcting the numbers.
func (b *GoalBoard) refusalFrom(err error) tools.Result {
	code, ok := state.GoalErrorOf(err)
	if !ok {
		return tools.Result{
			Text:  i18n.T("goal.refused", "code", err.Error()),
			Audit: b.auditFields(),
		}
	}
	return b.refusal(code)
}

// refusal answers with the sentence for a stable code, plus a fresh read of the
// goal so the model has the current revision in hand without a second round trip.
func (b *GoalBoard) refusal(code string) tools.Result {
	return tools.Result{
		Text:  goalRefusalText(code) + "\n" + b.GetText(),
		Audit: b.auditFields(),
	}
}

// auditFields are the goal facts a later reader asks about: which goal, at which
// revision, in which phase, how many rounds in.
//
// The round count is recorded even though nothing enforces it yet, because the
// question the audit answers is "how much did this goal get used", and a count that
// appears only in the final event is not an answer.
func (b *GoalBoard) auditFields() map[string]any {
	goal, ok := state.LoadGoal(b.Metadata)
	if !ok {
		return map[string]any{"goal_present": false}
	}
	fields := map[string]any{
		"goal_present":    true,
		"goal_id":         goal.ID,
		"goal_phase":      string(goal.Phase),
		"goal_revision":   goal.Revision,
		"goal_rounds":     goal.Rounds,
		"goal_max_rounds": goal.MaxRounds,
	}
	if goal.BlockedCode != "" {
		fields["goal_blocked_code"] = goal.BlockedCode
	}
	return fields
}

// goalRefusalText names each refusal, because the model has to know which number to
// re-read. A single "invalid goal update" would be retried unchanged.
//
// One literal key per code rather than a key built from the code: `T` answers with
// its own marker for a key it does not have, and a refusal the model reads as
// "⟪goal.refused.GOAL_STALE⟫" teaches it nothing about what to fix.
func goalRefusalText(code string) string {
	switch code {
	case state.GoalErrExists:
		return i18n.T("goal.refused.exists")
	case state.GoalErrNotFound:
		return i18n.T("goal.refused.not_found")
	case state.GoalErrStale:
		return i18n.T("goal.refused.stale")
	case state.GoalErrPhase:
		return i18n.T("goal.refused.phase")
	case state.GoalErrRound:
		return i18n.T("goal.refused.round")
	case state.GoalErrRoundLimit:
		return i18n.T("goal.refused.round_limit")
	case state.GoalErrInvalidOp:
		return i18n.T("goal.refused.invalid_op")
	case state.GoalErrInvalidEdit:
		return i18n.T("goal.refused.invalid_edit")
	case state.GoalErrInvalidBlock:
		return i18n.T("goal.refused.invalid_block")
	case state.GoalErrInvalidObjective:
		return i18n.T("goal.refused.invalid_objective")
	case state.GoalErrInvalidMaxRounds:
		return i18n.T("goal.refused.invalid_max_rounds")
	case state.GoalErrNotHuman:
		return i18n.T("goal.refused.not_human")
	default:
		return i18n.T("goal.refused", "code", code)
	}
}

// --- argument helpers -------------------------------------------------------

// The argument readers are the shared ones from websearch.go: one implementation
// per package, because a second one is a second answer to "what does this argument
// mean". `stringOf` reads a text argument, `intArg` an integer one with a fallback.
