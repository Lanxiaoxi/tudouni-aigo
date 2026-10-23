package runtime

import (
	"sort"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/paths"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools/builtin"
)

// ResolveSession picks the session a run should start on.
//
// A missing id means "new", and so does an id whose file is not there — the same
// rule as `--session`: a name that does not exist yet is a new session with that
// name, which is how a person gives a session a memorable id.
func ResolveSession(store *state.SessionStore, sessionID string) (*state.Session, bool, error) {
	if sessionID == "" {
		id := store.NewSessionID()
		return state.NewSession(id, paths.WorkspaceDir()), false, nil
	}
	if !state.IsValidSessionID(sessionID) {
		return nil, false, errorf("%s", i18n.T("check.session_id.invalid",
			"name", sessionID, "dir", paths.RuntimeDirName))
	}
	if !store.Exists(sessionID) {
		return state.NewSession(sessionID, paths.WorkspaceDir()), false, nil
	}
	session, err := store.Load(sessionID)
	if err != nil {
		return nil, false, err
	}
	session.Resumed = true
	return session, true, nil
}

// PreviewChars bounds the one-line digest in the session list.
//
// The number lives in `state.PreviewBudget`, beside the rule that spends it,
// because a front end must never re-cut the preview: "how a preview is cut" has
// one owner, or two screens disagree about the same row. It used to be 40 here
// and the row was the first user message; a session that opened with "hi" was
// listed as "hi" for its whole life.
const PreviewChars = state.PreviewBudget

// SessionListLimit bounds how many sessions the picker shows.
const SessionListLimit = 50

// SessionSummaries lists saved sessions, newest first.
//
// The order is by **creation time**, not by id. `--session demo` is not a
// timestamp, and sorting by id would put it in the wrong place — while the
// question the list answers is "which one was I working on", and that is almost
// always the most recent.
//
// Each file is read **once**, through `LoadSummary`, which skips the `ctx`
// records that make up the bulk of a session file. The list used to load every
// session twice — once to sort, once to describe — and each load parsed the whole
// transcript; on a workspace with a few dozen sessions that was seconds of work
// for one line of preview per row.
//
// `includeArchived` decides whether archived sessions are in the answer. The
// filter runs **before the cap**, and that order is the whole point of putting
// this decision here rather than in a front end: the cap keeps the newest N, so a
// front end that filtered the answer would be filtering the newest N — and an
// older un-archived session would drop out of the list entirely. Only the side
// that owns the cap can make archiving free up a slot. It still reads every
// file: the answer is shorter, the work is not.
func SessionSummaries(store *state.SessionStore, limit int, includeArchived bool) []map[string]any {
	// Delegated agents share this store, and their sessions are not sessions
	// anybody resumes: one belongs to a task that is already over, and picking it
	// opens a transcript whose other half is the parent. They are told apart by
	// name, so drawing the picker never has to open one.
	ids := store.ListParentIDs()
	type entry struct {
		summary  *state.SessionSummary
		err      error
		created  float64
		id       string
		archived bool
	}
	entries := make([]entry, 0, len(ids))
	for _, id := range ids {
		summary, err := store.LoadSummary(id, PreviewChars)
		created := 0.0
		archived := false
		if err == nil {
			created = summary.CreatedAt
			archived = state.IsArchived(summary.Metadata)
		}
		// Archived sessions are dropped **here**, before the sort and the cap.
		// See the function comment: filtering after the cap would hide old
		// un-archived sessions instead.
		if archived && !includeArchived {
			continue
		}
		entries = append(entries, entry{summary: summary, err: err, created: created, id: id, archived: archived})
	}
	sort.SliceStable(entries, func(i, j int) bool { return entries[i].created > entries[j].created })

	if limit > 0 && len(entries) > limit {
		entries = entries[:limit]
	}

	out := make([]map[string]any, 0, len(entries))
	for _, item := range entries {
		row := map[string]any{
			"session_id":  item.id,
			"messages":    0,
			"steps":       0,
			"todos":       "",
			"preview":     "",
			"modified_at": nil,
			// Always stated, like every other field here: a front end drawing an
			// archive filter needs the flag on every row, and "absent" would be a
			// second way of saying false.
			"archived": item.archived,
		}
		if item.err != nil {
			// A file that cannot be read stays in the list with the reason in place
			// of the preview. Dropping it would hide a real problem, and the user
			// asking "why is one session gone" has no way to find out. The mtime is
			// still reported when the file exists: a newer-version file is readable
			// enough to be stated, and the old list showed its modified time.
			if _, modified := store.FileTimes(item.id); modified != nil {
				row["modified_at"] = *modified
			}
			row["preview"] = i18n.T("session.preview.unreadable", "kind", item.err.Error())
			out = append(out, row)
			continue
		}
		summary := item.summary
		row["modified_at"] = summary.ModifiedAt
		row["messages"] = summary.Messages
		row["steps"] = summary.Steps
		if line := todoProgressLine(summary.Metadata); line != "" {
			row["todos"] = line
		}
		row["preview"] = summary.Preview
		out = append(out, row)
	}
	return out
}

func todoProgressLine(metadata map[string]any) string {
	// The map comes from a saved session summary rather than a live session, so
	// it has no lock of its own; a standalone guard is enough.
	board := builtin.NewTodoBoard(state.NewMeta(metadata))
	return board.ProgressLine()
}

// SessionSummaries implements protocol.Runtime.
//
// It includes archived sessions, because this method is what the CLI's `/resume`
// prints — and the CLI has no way to un-archive, so hiding rows from it would be
// hiding conversations it cannot get back. The desktop front end asks for the
// filtered list over the protocol instead (`session_list` with `filter=active`),
// where the filter runs before the cap.
func (r *Runtime) SessionSummaries() []map[string]any {
	return SessionSummaries(r.Store, SessionListLimit, true)
}
