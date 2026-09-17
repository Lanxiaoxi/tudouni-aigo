package security

import "runtime"

// platformIsWindows is the assumption the command parser makes. It matches the
// shell the tool layer will actually use.
var platformIsWindows = runtime.GOOS == "windows"
