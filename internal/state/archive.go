package state

// Session archiving.
//
// A session is archived when somebody has decided they are done looking at it,
// without wanting it gone. It is a **fact about the session**, stored in
// `session.metadata` beside the goal, the model selection and the todos — not a
// window preference. Three things follow from that, and each one is the reason
// the other choice was wrong:
//
//  1. **It travels with the session.** A different front end, a different
//     machine, a restored file: the archived sessions are the same ones. A
//     `localStorage` flag would answer a different question — "which sessions
//     has this window hidden" — and would disagree with itself the moment a
//     second front end looked at the same workspace.
//  2. **The runtime can filter before it truncates.** `SessionSummaries` reads
//     every session file, sorts by creation time and only then caps the list
//     (`SessionListLimit`). A front end that filtered the answer would be
//     filtering the newest fifty, so an older un-archived session would vanish
//     for good. Only the side that owns the cap can make archiving actually
//     free up a slot, and that is the runtime.
//  3. **It is a durable edit.** `SessionStore.Save` appends a fresh `meta`
//     record whenever the metadata changes, and readers take the newest. Adding
//     a key needs no new machinery anywhere.
//
// **It does not make listing cheaper.** The runtime still reads every file; the
// filtered answer is simply shorter. Skipping the scan would need a side index
// or a separate directory, which is a different change with its own risks (a
// file moved out from under a writer; `--session <id>` having to find it again).
const (
	// ArchivedKey is where the flag lives in the session metadata.
	ArchivedKey = "archived"
	// ArchivedAtKey is when it was archived, in epoch seconds. Kept because
	// "recently archived" is a different sort from "recently used", and because
	// a timestamp is the one thing a bare boolean can never recover.
	ArchivedAtKey = "archived_at"
)

// IsArchived reads the flag out of a metadata block.
//
// Anything other than a true boolean reads as false: an older session file has
// no such key, and a malformed value must not make a session unopenable. The
// fail-closed direction here is "not archived", which is the safer one — an
// un-archived session stays visible, and the cost of that is one row somebody
// did not want, not a conversation that disappeared.
func IsArchived(metadata map[string]any) bool {
	if metadata == nil {
		return false
	}
	value, _ := metadata[ArchivedKey].(bool)
	return value
}

// SetArchived writes the flag into a metadata block, or removes it.
//
// Removing is not the same as writing false, and the difference is what keeps
// session files from accumulating keys nobody set: "not archived" is the
// default, so un-archiving deletes the key and the `archived_at` that went with
// it. A stored `false` would be indistinguishable in effect but would grow every
// file that was ever archived and then restored.
//
// It does not touch the disk — callers save the session, exactly like the goal
// and model-selection helpers.
func SetArchived(metadata map[string]any, archived bool, now float64) {
	if metadata == nil {
		return
	}
	if !archived {
		delete(metadata, ArchivedKey)
		delete(metadata, ArchivedAtKey)
		return
	}
	metadata[ArchivedKey] = true
	metadata[ArchivedAtKey] = now
}
