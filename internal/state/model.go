package state

import (
	"strings"
	"sync"
	"time"
)

// Session-level model selection.
//
// Three things live together here because they are one story:
//
//  1. what was **chosen** (route, model, thinking switch, effort) — it is stored
//     in `session.metadata`, so restoring a session restores the choice;
//  2. what was **actually used** — the answer to "who generated those earlier
//     turns", and to "does a note need to go into the history";
//  3. the sentence written into the conversation when the model changed — it is
//     about the difference between two routes, and only this type knows both.
//
// The choice stores names, not configuration objects. That is deliberate: a
// route's address is a fact about this machine, and if it changes it should be
// used as it now is. Changing an address is an operations action, not a model
// change.
const (
	// SelectionKey is where the choice lives in the session metadata.
	SelectionKey = "model_selection"
	// LastUsedKey is which route/model the previous turn actually used. It is
	// kept apart from the choice because the choice is intent and this is fact:
	// merged together, "switched away and back" would be indistinguishable from
	// "never switched".
	LastUsedKey = "model_last_used"
	// SelectionVersion is the block format version.
	SelectionVersion = 2
)

// Selection is what this session intends to use.
type Selection struct {
	// Provider is empty when the choice should follow the catalogue's default
	// route. Older session files have no such field.
	Provider string
	Model    string
	Thinking bool
	Effort   string
	// Since is when this choice was made, in epoch seconds. After a model change
	// inside one session, "which stretch was this answer part of" cannot be read
	// out of the history alone.
	Since float64
}

// LoadSelection reads the choice out of a metadata block.
//
// Anything unreadable yields ok=false rather than an error: an older session file
// may predate this feature, and a broken key must not make the whole session
// unopenable. Missing fields fall back to the defaults — reading a missing
// `thinking` as false would make every old session quietly stop thinking, and
// that shows up only as worse, cheaper answers.
func LoadSelection(metadata map[string]any) (Selection, bool) {
	if metadata == nil {
		return Selection{}, false
	}
	return selectionFromBlock(metadata[SelectionKey])
}

func selectionFromBlock(block any) (Selection, bool) {
	object, ok := block.(map[string]any)
	if !ok {
		return Selection{}, false
	}
	model := strings.TrimSpace(stringFieldOf(object, "model"))
	if model == "" {
		return Selection{}, false
	}
	since := 0.0
	if value, ok := object["since"].(float64); ok {
		since = value
	}
	thinking := DefaultThinking
	if value, ok := object["thinking"].(bool); ok {
		thinking = value
	}
	effort := DefaultEffort
	if resolved, ok := ResolveEffort(stringFieldOf(object, "effort"), BroadEffortLevels); ok {
		effort = resolved
	}
	return Selection{
		Provider: strings.TrimSpace(stringFieldOf(object, "provider")),
		Model:    model,
		Thinking: thinking,
		Effort:   effort,
		Since:    since,
	}, true
}

// StoreSelection writes the choice into the metadata (it does not save the
// session; checkpointing is the agent's job).
func StoreSelection(metadata map[string]any, selection Selection, now float64) Selection {
	if now == 0 {
		now = float64(time.Now().Unix())
	}
	stamped := selection
	stamped.Since = now
	metadata[SelectionKey] = selectionToBlock(stamped)
	return stamped
}

func selectionToBlock(selection Selection) map[string]any {
	return map[string]any{
		"version":  SelectionVersion,
		"provider": selection.Provider,
		"model":    selection.Model,
		"thinking": selection.Thinking,
		"effort":   selection.Effort,
		"since":    selection.Since,
	}
}

// The note inserted into the history when the model changes.
//
// It has to be there: after a change, the model reads the earlier turns as its
// own and continues in that style and at that quality. A plain record turns "this
// stretch was written by the three-dollars-a-call model" into something the
// session itself says, rather than something only the audit log knows.
//
// It is a **user** message because changing the model is the operator's
// decision, not the model's output. An assistant message would be forging a
// claim by the model, and "what the model said" is the last thing here that may
// be forged.
const (
	noticeChanged = "[model changed: 上面那些轮次由 %s 生成；从这个点开始，这个会话用 %s。]"
	noticeFirst   = "[model changed: 这个会话从这里开始用 %s（此前还没有模型回答过）。]"
	noticeSame    = "[model changed: 这个会话继续用 %s。]"
)

// RouteName renders a selection as "which model on which route".
func RouteName(selection *Selection, fallback string) string {
	if selection == nil {
		return fallback
	}
	if selection.Provider != "" {
		return selection.Provider + "/" + selection.Model
	}
	return selection.Model
}

// ChangeNotice builds the message inserted into the history.
func ChangeNotice(previous, selected string) map[string]any {
	var text string
	switch {
	case previous != "" && previous != selected:
		text = sprintf(noticeChanged, previous, selected)
	case previous != "":
		// The names are equal yet we got here. Do not claim a change — that
		// would be false — but leave a line, or "no change" and "nothing
		// happened" cannot be told apart.
		text = sprintf(noticeSame, selected)
	default:
		text = sprintf(noticeFirst, selected)
	}
	return map[string]any{
		"role":         "user",
		"content":      text,
		RuntimeNoteKey: true,
	}
}

// SessionModel is one session's model choice and thinking settings: intent,
// fact, and the decision about when to leave that sentence behind.
//
// The two names have separate jobs, and that is the whole reason this type
// exists:
//
//   - Selected / SelectedProvider — what the user **wants** (`/model` writes it);
//   - LastUsed — what the previous turn **actually** used (recorded per turn).
//
// The test for "leave the change note" is that the two differ, not that `/model`
// was called. That distinction is right on both paths: pressing `/model` while a
// turn is running leaves the note for the next turn (this turn already went out
// on the old model), and switching away and back leaves no note at all, because
// nothing was generated in between.
//
// The thinking switch and effort are not part of "the model changed": they change
// how a request on the same route thinks, so NoticeNeeded ignores them.
type SessionModel struct {
	meta             *Meta
	fallback         string
	fallbackProvider string
	// mu guards selection and effortChosen: `/model` writes them from the
	// protocol's read loop while the turn reads them to build its request.
	mu           sync.RWMutex
	selection    *Selection
	effortChosen bool
}

// NewSessionModel reads the session's choice, with the catalogue defaults as a
// fallback. The metadata is guarded by a lock of its own; callers that have a
// session should use NewSessionModelFor so it shares the session's lock.
func NewSessionModel(metadata map[string]any, fallback, fallbackProvider string) *SessionModel {
	return NewSessionModelFor(NewMeta(metadata), fallback, fallbackProvider)
}

// NewSessionModelFor reads the session's choice through the session's own guard.
func NewSessionModelFor(meta *Meta, fallback, fallbackProvider string) *SessionModel {
	model := &SessionModel{meta: meta, fallback: fallback, fallbackProvider: fallbackProvider}
	var selection Selection
	var ok bool
	meta.Read(func(metadata map[string]any) { selection, ok = LoadSelection(metadata) })
	if ok {
		model.selection = &selection
		// A stored selection was made by someone, in this session or an earlier
		// one; only the level it holds is remembered, so it counts as chosen.
		model.effortChosen = strings.TrimSpace(selection.Effort) != ""
	}
	return model
}

// Selected is the model this session should use.
//
// Aliases are not folded here: Selected reports a name, and a folded name would
// have /status report something that is not in the configuration file — at which
// point "what did I actually configure" has no answer. Window lookups go through
// the catalogue, which does fold.
func (s *SessionModel) Selected() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.selectedLocked()
}

func (s *SessionModel) selectedLocked() string {
	if s.selection != nil && s.selection.Model != "" {
		return s.selection.Model
	}
	return s.fallback
}

// SelectedProvider is which route, empty meaning "not decided yet".
func (s *SessionModel) SelectedProvider() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.selectedProviderLocked()
}

func (s *SessionModel) selectedProviderLocked() string {
	if s.selection != nil && s.selection.Provider != "" {
		return s.selection.Provider
	}
	return s.fallbackProvider
}

// Thinking reports the thinking switch.
func (s *SessionModel) Thinking() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.thinkingLocked()
}

func (s *SessionModel) thinkingLocked() bool {
	if s.selection != nil {
		return s.selection.Thinking
	}
	return DefaultThinking
}

// Effort reports the thinking effort. It has a value even when thinking is off:
// that is the user's intent for next time, not an error state.
func (s *SessionModel) Effort() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.effortLocked()
}

func (s *SessionModel) effortLocked() string {
	if s.selection != nil && s.selection.Effort != "" {
		return s.selection.Effort
	}
	return DefaultEffort
}

// SelectedSince is when the current choice was made.
func (s *SessionModel) SelectedSince() float64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.selection != nil {
		return s.selection.Since
	}
	return 0
}

// LastUsed is the route name of the previous turn.
func (s *SessionModel) LastUsed() string {
	var value string
	s.meta.Read(func(metadata map[string]any) {
		value, _ = metadata[LastUsedKey].(string)
	})
	return value
}

// RouteName is the current choice as "model on route".
func (s *SessionModel) RouteName() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.routeNameLocked()
}

func (s *SessionModel) routeNameLocked() string {
	fallback := s.fallback
	if s.fallbackProvider != "" && s.fallback != "" {
		fallback = s.fallbackProvider + "/" + s.fallback
	}
	if s.selection == nil {
		return fallback
	}
	return RouteName(s.selection, fallback)
}

func (s *SessionModel) currentLocked() Selection {
	selection := Selection{
		Provider: s.selectedProviderLocked(),
		Model:    s.selectedLocked(),
		Thinking: s.thinkingLocked(),
		Effort:   s.effortLocked(),
	}
	if s.selection != nil {
		selection.Since = s.selection.Since
	}
	return selection
}

// SelectRoute records the intent to use a model on a route. It does not touch
// LastUsed — that is the turn's business.
func (s *SessionModel) SelectRoute(provider, model string, now float64) Selection {
	s.mu.Lock()
	defer s.mu.Unlock()
	var selection Selection
	s.meta.Write(func(metadata map[string]any) {
		selection = StoreSelection(metadata, Selection{
			Provider: provider, Model: model,
			Thinking: s.thinkingLocked(), Effort: s.effortLocked(),
		}, now)
	})
	s.selection = &selection
	return selection
}

// SelectThinking changes only the switch; model and effort are preserved.
func (s *SessionModel) SelectThinking(on bool, now float64) Selection {
	s.mu.Lock()
	defer s.mu.Unlock()
	current := s.currentLocked()
	if now == 0 {
		now = current.Since
	}
	var selection Selection
	s.meta.Write(func(metadata map[string]any) {
		selection = StoreSelection(metadata, Selection{
			Provider: current.Provider, Model: current.Model,
			Thinking: on, Effort: current.Effort,
		}, now)
	})
	s.selection = &selection
	return selection
}

// EffortChosen reports whether the effort came from an explicit choice rather
// than from a default.
func (s *SessionModel) EffortChosen() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.effortChosen
}

// SelectEffort changes only the effort. It is recorded even while thinking is
// off: the user's intent is "still this one when I turn it back on".
func (s *SessionModel) SelectEffort(effort string, now float64) Selection {
	s.mu.Lock()
	defer s.mu.Unlock()
	current := s.currentLocked()
	if now == 0 {
		now = current.Since
	}
	var selection Selection
	s.meta.Write(func(metadata map[string]any) {
		selection = StoreSelection(metadata, Selection{
			Provider: current.Provider, Model: current.Model,
			Thinking: current.Thinking, Effort: effort,
		}, now)
	})
	s.selection = &selection
	s.effortChosen = true
	return selection
}

// NoticeNeeded reports whether this turn should open with a change note.
//
// Both conditions matter. The second one — LastUsed is non-empty — is not
// redundant: a new session, or one that has never run a turn, has nothing there.
// With only the first condition, every new session would open with "the model
// changed" while there was no previous model at all, which is simply false.
func (s *SessionModel) NoticeNeeded() bool {
	return s.LastUsed() != "" && s.RouteName() != s.LastUsed()
}

// RecordUse notes that this turn really is using the current choice.
//
// It runs **before** the request goes out, not after the answer arrives: the
// sentence in the history says "from here on, who generates", and that stays true
// even when the model fails. Recording it after the answer would make a failed
// turn repeat the sentence on the next one.
func (s *SessionModel) RecordUse() {
	s.mu.RLock()
	route := s.routeNameLocked()
	s.mu.RUnlock()
	s.meta.Write(func(metadata map[string]any) { metadata[LastUsedKey] = route })
}

// Notice builds the message for the start of this turn.
func (s *SessionModel) Notice(previous string) map[string]any {
	old := previous
	if old == "" {
		old = s.LastUsed()
	}
	return ChangeNotice(old, s.RouteName())
}

// AsState renders the fields of the `ui(state)` snapshot.
func (s *SessionModel) AsState() map[string]any {
	return map[string]any{
		"model":           s.Selected(),
		"model_provider":  s.SelectedProvider(),
		"model_since":     s.SelectedSince(),
		"model_last_used": s.LastUsed(),
		"thinking":        s.Thinking(),
		"effort":          s.Effort(),
	}
}

func stringFieldOf(raw map[string]any, key string) string {
	value, _ := raw[key].(string)
	return value
}
