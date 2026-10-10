package runtime

import (
	"github.com/Lanxiaoxi/tudouni-aigo/internal/ssh"
)

// --- the SSH surface the state snapshot carries ------------------------------
//
// Like the terminals panel, this is display only. The session's truth lives in
// `ssh.Manager`; the snapshot restates the list on every `ui(state)` so a front
// end that started after a session was connected — or one that lost a message —
// learns about it from the next snapshot instead of never, exactly the same
// reason the terminal list rides on every snapshot.

// sshPanel is the `ssh` array on every `ui(state)` snapshot.
//
// Always `[]` and never nil, for the reason every other panel list follows that
// rule: a front end that has to tell "there are none" apart from "the runtime
// did not say" is a front end with a second definition of the panel's shape,
// and the first bug it produces is a crash on the empty case.
func (r *Runtime) sshPanel() []any {
	if r.SSH == nil {
		return []any{}
	}
	return sshRows(r.SSH.List())
}

// sshRows is the wire form of the SSH session list. One function so the shape
// is defined here, once — the protocol layer carries it and no front end has to
// be told a second time what an SSH session looks like.
//
// `alias` stays beside `destination` for the same reason `ssh.Info` keeps both:
// the alias is what the model asked for, the destination is what actually
// opened, and they can differ. `exit_code` is explicitly null while the session
// runs — a front end must be able to tell "no exit code yet" from "the runtime
// did not say".
func sshRows(infos []ssh.Info) []any {
	rows := make([]any, 0, len(infos))
	for _, info := range infos {
		row := map[string]any{
			"id":          info.ID,
			"alias":       info.Alias,
			"destination": info.Destination(),
			"status":      string(info.Status),
			"created_at":  info.CreatedAt,
		}
		if info.ExitCode == nil {
			row["exit_code"] = nil
		} else {
			row["exit_code"] = *info.ExitCode
		}
		rows = append(rows, row)
	}
	return rows
}
