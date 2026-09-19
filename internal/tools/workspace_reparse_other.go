//go:build !windows

package tools

import "io/fs"

// isReparsePoint is the Windows question asked on a platform that has no reparse
// points. Every link there is a symbolic link, and `filepath.EvalSymlinks` either
// resolves it or fails — and the caller refuses what it cannot resolve.
func isReparsePoint(fs.FileInfo) bool { return false }
