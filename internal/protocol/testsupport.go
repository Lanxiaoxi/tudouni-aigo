package protocol

// TestClientWithExit builds a client that looks like one whose runtime has already
// ended, for front end tests.
//
// It lives in a normal file rather than a `_test.go` one on purpose: the front end
// packages are separate Go packages, so their tests cannot reach unexported fields,
// and a full-screen interface's behaviour after the runtime dies is exactly the kind
// of thing that needs testing without launching a process.
//
// The name says test because that is the only caller it may have: nothing in the
// program constructs a client in an end state, and a production caller would be
// fabricating a death. `stopped` is the front end's own request to finish, which is
// what separates "the session is over" from "the runtime died" — and it cannot be
// inferred from the code, because a runtime ended by a closed stdin also leaves with
// zero.
func TestClientWithExit(code int, stopped bool) *Client {
	// The global pre-runtime reporter is cleared so a front end test observes the
	// death on its own terms instead of inheriting the wiring of whichever test in
	// this package ran last.
	openFailureNotice = nil
	client := NewClient(nil)
	client.code = code
	client.codeSet = true
	client.stopped = stopped
	return client
}
