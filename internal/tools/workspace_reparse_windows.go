//go:build windows

package tools

import (
	"io/fs"
	"syscall"
)

// isReparsePoint reports whether an entry is a filesystem link: a symbolic link,
// a junction, or any other reparse point.
//
// Asking `os.Lstat` is not enough on Windows. Which reparse points it calls
// `ModeSymlink` has changed between Go releases, and a junction — the kind an
// ordinary user can create with no privilege at all — is currently reported as an
// irregular file whose mode carries no link in it. The attribute is what Windows
// itself sets for every kind of link, so it is the one answer that does not
// depend on how a Go release chose to map it.
func isReparsePoint(info fs.FileInfo) bool {
	if data, ok := info.Sys().(*syscall.Win32FileAttributeData); ok {
		return data.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0
	}
	// Nothing to read the attribute from. Answering from the mode is weaker, but
	// it is not nothing: on the releases that report a junction as an irregular
	// file this is set, and a false negative here hands out the boundary.
	return info.Mode()&fs.ModeIrregular != 0
}
