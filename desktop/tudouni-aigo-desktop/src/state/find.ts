/** The find bar's idle value: one shared object, for identity comparison. */
/**
 * The find bar with nothing in it and nothing to point at.
 *
 * Used by the initial state and by the **two** paths that replace the transcript
 * on screen (`focusSession`, and opening a remote workspace's session). A needle
 * belongs to the conversation it was typed into: carried across a switch it would
 * report hits in a transcript the reader never searched, which is worse than
 * having to type it again. Spreading one constant is what keeps those two sites
 * from drifting apart — the same lesson `closePanel` records for the session
 * filter's six call sites.
 */
export const FIND_IDLE = { findOpen: false, findQuery: '', findIndex: 0 } as const;
