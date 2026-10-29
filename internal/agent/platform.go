package agent

import "runtime"

// platformFoldCase is whether this platform's paths compare case-insensitively.
//
// It is a package variable rather than a `runtime.GOOS` check at the call site so that
// the guard's comparison and the workspace boundary's comparison cannot drift: both
// answer "are these the same file", and a machine where one folds and the other does
// not has a hole in exactly one of them.
var platformFoldCase = runtime.GOOS == "windows"
