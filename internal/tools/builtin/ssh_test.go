package builtin

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	sshlib "github.com/Lanxiaoxi/tudouni-aigo/internal/ssh"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// fakeRemote is one remote shell with no network under it.
//
// The tool layer needs the same seam the kernel has, and for the same reason: what
// these tests assert is not about SSH — that `ssh_connect` is high risk, that a
// write's bytes reach the audit, that a read's flags reach the text the model
// reads — and none of that should need a server to check.
type fakeRemote struct {
	mu       sync.Mutex
	sent     []byte
	incoming chan []byte
	ended    chan struct{}
	endOnce  sync.Once
	holdover []byte
}

func newFakeRemote() *fakeRemote {
	return &fakeRemote{incoming: make(chan []byte, 64), ended: make(chan struct{})}
}

func (f *fakeRemote) write(data string) { f.incoming <- []byte(data) }

func (f *fakeRemote) sentBytes() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return string(f.sent)
}

func (f *fakeRemote) Read(p []byte) (int, error) {
	if len(f.holdover) > 0 {
		count := copy(p, f.holdover)
		f.holdover = f.holdover[count:]
		return count, nil
	}
	var data []byte
	select {
	case data = <-f.incoming:
	case <-f.ended:
		select {
		case data = <-f.incoming:
		default:
			return 0, io.EOF
		}
	}
	count := copy(p, data)
	if count < len(data) {
		f.holdover = append(f.holdover[:0], data[count:]...)
	}
	return count, nil
}

func (f *fakeRemote) Write(p []byte) (int, error) {
	select {
	case <-f.ended:
		return 0, errors.New("channel closed")
	default:
	}
	f.mu.Lock()
	f.sent = append(f.sent, p...)
	f.mu.Unlock()
	return len(p), nil
}

func (f *fakeRemote) Resize(cols, rows int) error { return nil }

func (f *fakeRemote) Close() error {
	f.endOnce.Do(func() { close(f.ended) })
	return nil
}

func (f *fakeRemote) Wait() (int, bool, error) {
	<-f.ended
	return 0, true, nil
}

// end says the remote shell exited cleanly.
func (f *fakeRemote) end() { f.endOnce.Do(func() { close(f.ended) }) }

// sshManagerForTests builds a manager that opens fakeRemote connections.
//
// It lays out a real `~/.ssh/config` in a temporary directory rather than
// stubbing resolution out, so these tests exercise the same path a person's
// machine does: an alias becomes a host name, a user and a key file, and the
// connector is handed the result.
func sshManagerForTests(t *testing.T, remotes ...*fakeRemote) *sshlib.Manager {
	t.Helper()
	home := t.TempDir()
	sshDir := filepath.Join(home, ".ssh")
	if err := os.MkdirAll(sshDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(sshDir, "key"), []byte("key"), 0o600); err != nil {
		t.Fatalf("write key: %v", err)
	}
	config := "Host prod\n    HostName 10.0.1.5\n    User deploy\n    IdentityFile ~/.ssh/key\n"
	if err := os.WriteFile(filepath.Join(sshDir, "config"), []byte(config), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}

	var mu sync.Mutex
	queue := append([]*fakeRemote(nil), remotes...)
	connector := func(host sshlib.Host, cols, rows int, timeout time.Duration) (sshlib.Channel, error) {
		mu.Lock()
		defer mu.Unlock()
		if len(queue) == 0 {
			return nil, errors.New("no fake remote left")
		}
		next := queue[0]
		queue = queue[1:]
		return next, nil
	}
	manager := sshlib.NewManagerWithConnector(connector, "", home)
	t.Cleanup(func() { _ = manager.CloseAll() })
	return manager
}

// toolNamed finds one of the five by name.
func toolNamed(t *testing.T, manager *sshlib.Manager, name string) tools.Tool {
	t.Helper()
	for _, candidate := range NewSSHTools(manager) {
		if candidate.Name == name {
			return candidate
		}
	}
	t.Fatalf("no tool named %s in the SSH set", name)
	return tools.Tool{}
}

// callTool runs one handler and returns what the model and the audit see.
//
// It fails the test on a returned error, because this set's contract is that every
// ordinary failure — an unreachable host, an unknown id, an interrupted read — is
// a **result** the model reads, not a thrown error.
func callTool(t *testing.T, tool tools.Tool, ctx context.Context, args map[string]any) (string, map[string]any) {
	t.Helper()
	if ctx == nil {
		ctx = context.Background()
	}
	result, err := tool.Handler(ctx, args)
	if err != nil {
		t.Fatalf("%s returned an error rather than a result: %v", tool.Name, err)
	}
	return result.Text, result.Audit
}

// TestNoManagerMeansNoTools: a tool the model can see but that can never work
// costs a round trip every time it is tried, and teaches it that tools lie.
func TestNoManagerMeansNoTools(t *testing.T) {
	if got := NewSSHTools(nil); got != nil {
		t.Errorf("NewSSHTools(nil) returned %d tools, want none", len(got))
	}
}

// TestTheFiveToolsExistAndAreNamedConsistently pins the set. A missing
// `ssh_sessions` would leave a model that lost a session id with no way back, and
// the session limit means it could not simply open another.
func TestTheFiveToolsExistAndAreNamedConsistently(t *testing.T) {
	manager := sshManagerForTests(t)
	want := map[string]bool{
		"ssh_connect":  true,
		"ssh_write":    true,
		"ssh_read":     true,
		"ssh_close":    true,
		"ssh_sessions": true,
	}
	got := NewSSHTools(manager)
	if len(got) != len(want) {
		t.Fatalf("got %d tools, want %d", len(got), len(want))
	}
	for _, tool := range got {
		if !want[tool.Name] {
			t.Errorf("unexpected tool %s", tool.Name)
		}
		delete(want, tool.Name)
	}
	for name := range want {
		t.Errorf("missing tool %s", name)
	}
}

// TestTheSSHToolsReachTheAssembledRegistry is the wiring assertion, and it is the
// one the unit tests above cannot make.
//
// They build the tools directly, so none of them would notice if `Assembly.Extra`
// never carried them — and a tool that is never registered is invisible to the
// model, which is the failure the whole feature exists to avoid. The registry is
// also where the risk declaration has to survive: `Register` refuses a tool with
// no risk, so a successful registration is proof that each one declared it.
func TestTheSSHToolsReachTheAssembledRegistry(t *testing.T) {
	manager := sshManagerForTests(t)
	workspace, err := tools.NewWorkspace(t.TempDir())
	if err != nil {
		t.Fatalf("workspace: %v", err)
	}
	result, err := CreateRegistry(Assembly{
		Workspace: workspace,
		Extra:     NewSSHTools(manager),
	})
	if err != nil {
		t.Fatalf("CreateRegistry: %v", err)
	}

	for _, name := range []string{"ssh_connect", "ssh_write", "ssh_read", "ssh_close", "ssh_sessions"} {
		tool, ok := result.Tools.Get(name)
		if !ok {
			t.Errorf("%s is not in the assembled tool set: %v", name, result.Tools.Names())
			continue
		}
		if tool.Risk == "" {
			t.Errorf("%s reached the registry with no risk declared", name)
		}
	}

	// And the model-facing schema survives the round trip, or the tool cannot be
	// called at all.
	connect, _ := result.Tools.Get("ssh_connect")
	schema := connect.OpenAISchema()
	function, _ := schema["function"].(map[string]any)
	parameters, _ := function["parameters"].(map[string]any)
	properties, _ := parameters["properties"].(map[string]any)
	if _, ok := properties["host"]; !ok {
		t.Errorf("ssh_connect's schema has no `host` argument: %#v", parameters)
	}
}

// TestConnectIsHighRiskAndNotParallelSafe is the tool the whole permission story
// rests on: the approval given here covers every command that follows, so it must
// not run beside anything else in one batch — a sibling could otherwise write to a
// session created in the same breath, before anybody saw the host.
func TestConnectIsHighRiskAndNotParallelSafe(t *testing.T) {
	manager := sshManagerForTests(t, newFakeRemote())
	tool := toolNamed(t, manager, "ssh_connect")
	if tool.Risk != security.RiskHigh {
		t.Errorf("Risk = %s, want high — the approval covers the whole session", tool.Risk)
	}
	if tool.ParallelSafe {
		t.Error("ssh_connect is parallel-safe; it must not be able to race the batch it arrived in")
	}
}

// TestWriteIsLowRiskAndParallelSafe: the useful moment to refuse is before the
// session exists, and the audit — not a per-call prompt — is what records what was
// typed.
func TestWriteIsLowRiskAndParallelSafe(t *testing.T) {
	manager := sshManagerForTests(t, newFakeRemote())
	tool := toolNamed(t, manager, "ssh_write")
	if tool.Risk != security.RiskLow {
		t.Errorf("Risk = %s, want low: the connect approval already covers this", tool.Risk)
	}
	if !tool.ParallelSafe {
		t.Error("ssh_write is not parallel-safe; writing to two sessions in one batch is legitimate")
	}
	if tool.CommandParam != "" {
		t.Errorf("CommandParam = %q, want empty: prefix rules match command lines, and this sends raw bytes to a shell that is already open",
			tool.CommandParam)
	}
}

// TestReadAndSessionsAndCloseAreLowRisk: none of the three opens anything, so none
// of them is the moment a person should be asked.
func TestReadAndSessionsAndCloseAreLowRisk(t *testing.T) {
	manager := sshManagerForTests(t, newFakeRemote())
	for _, name := range []string{"ssh_read", "ssh_sessions", "ssh_close"} {
		tool := toolNamed(t, manager, name)
		if tool.Risk != security.RiskLow {
			t.Errorf("%s Risk = %s, want low", name, tool.Risk)
		}
	}
}

// TestConnectReportsWhatItResolved is the tool result that carries the destination
// the approval panel does not: the panel shows the alias, and `user@host:port`
// arrives here and in the audit.
func TestConnectReportsWhatItResolved(t *testing.T) {
	manager := sshManagerForTests(t, newFakeRemote())
	connect := toolNamed(t, manager, "ssh_connect")

	text, audit := callTool(t, connect, nil, map[string]any{"host": "prod"})

	if !strings.Contains(text, "deploy@10.0.1.5:22") {
		t.Errorf("the result does not say where it connected:\n%s", text)
	}
	if audit["destination"] != "deploy@10.0.1.5:22" {
		t.Errorf("audit destination = %v", audit["destination"])
	}
	if audit["user"] != "deploy" || audit["host"] != "10.0.1.5" {
		t.Errorf("audit identity = %v@%v", audit["user"], audit["host"])
	}
	if audit["connected"] != true {
		t.Errorf("audit connected = %v", audit["connected"])
	}
}

// TestAFailedConnectIsAResultNotAnError: the model has to read the reason and try
// something else, and a thrown error would be a different channel of information
// that no tool result follows.
func TestAFailedConnectIsAResultNotAnError(t *testing.T) {
	manager := sshManagerForTests(t)
	connect := toolNamed(t, manager, "ssh_connect")

	text, audit := callTool(t, connect, nil, map[string]any{"host": "nope"})
	if !strings.Contains(text, "连接失败") {
		t.Errorf("the result does not say it failed:\n%s", text)
	}
	if audit["connected"] != false {
		t.Errorf("audit connected = %v, want false", audit["connected"])
	}
	if audit["alias"] != "nope" {
		t.Errorf("audit alias = %v, want the alias that was tried", audit["alias"])
	}
}

// TestWriteRecordsTheBytesInTheAudit is what replaces the per-call prompt: "what
// was actually typed on that host" has an answer afterwards even though nobody was
// asked at the time.
func TestWriteRecordsTheBytesInTheAudit(t *testing.T) {
	remote := newFakeRemote()
	manager := sshManagerForTests(t, remote)
	connect := toolNamed(t, manager, "ssh_connect")
	write := toolNamed(t, manager, "ssh_write")
	read := toolNamed(t, manager, "ssh_read")

	connectText, _ := callTool(t, connect, nil, map[string]any{"host": "prod"})
	id := sessionIdFromText(t, connectText)

	_, audit := callTool(t, write, nil, map[string]any{"session_id": id, "data": "systemctl restart nginx\n"})
	if audit["data"] != "systemctl restart nginx\n" {
		t.Errorf("audit data = %v, want the bytes themselves", audit["data"])
	}
	if audit["session_action"] != "write" {
		t.Errorf("audit session_action = %v", audit["session_action"])
	}

	// The bytes really reached the channel, so the audit is a record of something
	// that happened rather than of an intention.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && !strings.Contains(remote.sentBytes(), "systemctl restart nginx") {
		time.Sleep(5 * time.Millisecond)
	}
	if got := remote.sentBytes(); !strings.Contains(got, "systemctl restart nginx") {
		t.Errorf("the bytes never reached the remote shell: %q", got)
	}

	// Silence the read tool's own assertion: it is here so the id helper below is
	// used on a session that has actually been read from at least once.
	_ = read
}

// TestWriteSaysItIsNotAConfirmation: "sent" is not "succeeded", and a result that
// blurred the two is how a model concludes a deployment worked.
func TestWriteSaysItIsNotAConfirmation(t *testing.T) {
	manager := sshManagerForTests(t, newFakeRemote())
	connect := toolNamed(t, manager, "ssh_connect")
	write := toolNamed(t, manager, "ssh_write")

	text, _ := callTool(t, connect, nil, map[string]any{"host": "prod"})
	id := sessionIdFromText(t, text)

	writeText, _ := callTool(t, write, nil, map[string]any{"session_id": id, "data": "echo hi\n"})
	if !strings.Contains(writeText, "不代表命令执行成功") && !strings.Contains(writeText, "不是") {
		t.Errorf("the result does not deny that the command succeeded:\n%s", writeText)
	}
}

// TestReadReportsATimeoutAsAnOrdinaryAnswer: a quiet command is normal, and a
// result that read as a failure would send the model debugging a working shell.
func TestReadReportsATimeoutAsAnOrdinaryAnswer(t *testing.T) {
	manager := sshManagerForTests(t, newFakeRemote())
	connect := toolNamed(t, manager, "ssh_connect")
	read := toolNamed(t, manager, "ssh_read")

	text, _ := callTool(t, connect, nil, map[string]any{"host": "prod"})
	id := sessionIdFromText(t, text)

	readText, audit := callTool(t, read, nil, map[string]any{
		"session_id":      id,
		"timeout_seconds": 1,
	})
	if !strings.Contains(readText, "没有输出") {
		t.Errorf("the result does not say it simply waited and saw nothing:\n%s", readText)
	}
	if audit["timed_out"] != true {
		t.Errorf("audit timed_out = %v, want true", audit["timed_out"])
	}
	if audit["exited"] != false {
		t.Errorf("a still-running session was audited as exited: %v", audit["exited"])
	}
}

// TestReadSurfacesTruncationAndDroppedOutput: the two facts a model has to act on
// and cannot derive from the text alone.
func TestReadSurfacesTruncationAndDroppedOutput(t *testing.T) {
	remote := newFakeRemote()
	manager := sshManagerForTests(t, remote)
	connect := toolNamed(t, manager, "ssh_connect")
	read := toolNamed(t, manager, "ssh_read")

	text, _ := callTool(t, connect, nil, map[string]any{"host": "prod"})
	id := sessionIdFromText(t, text)

	// More than one read's worth, so the truncation path is exercised.
	remote.write(strings.Repeat("a", sshlib.DefaultReadLimit+512))
	time.Sleep(50 * time.Millisecond)

	readText, audit := callTool(t, read, nil, map[string]any{"session_id": id, "timeout_seconds": 2})
	if audit["truncated"] != true {
		t.Errorf("audit truncated = %v, want true when there is more to read", audit["truncated"])
	}
	if !strings.Contains(readText, "truncated") {
		t.Errorf("the text does not tell the model to read again:\n%s", readText)
	}
}

// TestReadSaysWhenThereIsNoExitCode: "no code" and "code 0" are different
// observations, and over SSH the first one is routine — connections drop.
func TestReadSaysWhenThereIsNoExitCode(t *testing.T) {
	remote := newFakeRemote()
	manager := sshManagerForTests(t, remote)
	connect := toolNamed(t, manager, "ssh_connect")
	read := toolNamed(t, manager, "ssh_read")

	text, _ := callTool(t, connect, nil, map[string]any{"host": "prod"})
	id := sessionIdFromText(t, text)

	remote.end()
	time.Sleep(30 * time.Millisecond)

	// The fake reports a code, so this asserts the positive case: the number
	// reaches the audit as a number.
	var audit map[string]any
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		_, audit = callTool(t, read, nil, map[string]any{"session_id": id, "timeout_seconds": 1})
		if audit["eof"] == true {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if audit["eof"] != true {
		t.Fatalf("the read never reported EOF: %v", audit)
	}
	if audit["exit_code"] != 0 {
		t.Errorf("audit exit_code = %v, want 0", audit["exit_code"])
	}
}

// TestCloseIsIdempotent is the contract the model relies on when it is not sure
// whether a session has already ended: "make it gone" must succeed either way.
func TestCloseIsIdempotent(t *testing.T) {
	manager := sshManagerForTests(t, newFakeRemote())
	connect := toolNamed(t, manager, "ssh_connect")
	closeTool := toolNamed(t, manager, "ssh_close")

	text, _ := callTool(t, connect, nil, map[string]any{"host": "prod"})
	id := sessionIdFromText(t, text)

	callTool(t, closeTool, nil, map[string]any{"session_id": id})
	second, audit := callTool(t, closeTool, nil, map[string]any{"session_id": id})
	if audit["status"] != "ok" {
		t.Errorf("a second close reported %v, want ok", audit["status"])
	}
	if !strings.Contains(second, "已结束") && !strings.Contains(second, "没有额外动作") {
		t.Errorf("a second close does not say the session was already gone:\n%s", second)
	}
}

// TestSessionsListsWhatExists: it is the tool a model needs after it has lost an
// id, and the one that answers "which of these is still alive".
func TestSessionsListsWhatExists(t *testing.T) {
	manager := sshManagerForTests(t, newFakeRemote(), newFakeRemote())
	connect := toolNamed(t, manager, "ssh_connect")
	sessions := toolNamed(t, manager, "ssh_sessions")

	first, _ := callTool(t, connect, nil, map[string]any{"host": "prod"})
	second, _ := callTool(t, connect, nil, map[string]any{"host": "prod"})

	text, audit := callTool(t, sessions, nil, nil)
	if audit["count"] != 2 {
		t.Errorf("audit count = %v, want 2", audit["count"])
	}
	for _, want := range []string{sessionIdFromText(t, first), sessionIdFromText(t, second), "running"} {
		if !strings.Contains(text, want) {
			t.Errorf("the list does not mention %q:\n%s", want, text)
		}
	}
}

// TestSessionsOnAnEmptyWorkspaceSaysHowToStart: an empty list with no next step is
// a dead end for a model that just discovered the tool.
func TestSessionsOnAnEmptyWorkspaceSaysHowToStart(t *testing.T) {
	manager := sshManagerForTests(t)
	sessions := toolNamed(t, manager, "ssh_sessions")
	text, _ := callTool(t, sessions, nil, nil)
	if !strings.Contains(text, "ssh_connect") {
		t.Errorf("an empty list does not say how to make one:\n%s", text)
	}
}

// TestCancellationReachesTheRead: pressing stop must not have to wait out a read
// on a remote machine, and the text has to say the output was not lost.
func TestCancellationReachesTheRead(t *testing.T) {
	manager := sshManagerForTests(t, newFakeRemote())
	connect := toolNamed(t, manager, "ssh_connect")
	read := toolNamed(t, manager, "ssh_read")

	text, _ := callTool(t, connect, nil, map[string]any{"host": "prod"})
	id := sessionIdFromText(t, text)

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(50 * time.Millisecond)
		cancel()
	}()

	readText, audit := callTool(t, read, ctx, map[string]any{"session_id": id, "timeout_seconds": 30})
	if audit["status"] != "interrupted" {
		t.Errorf("audit status = %v, want interrupted", audit["status"])
	}
	if !strings.Contains(readText, "没有丢") {
		t.Errorf("the interruption does not tell the model the output is still there:\n%s", readText)
	}
}

// sessionIdFromText pulls the id out of a connect result.
//
// It parses the text rather than reading the manager, and that is the point: the
// id has to be **in the text**, because the model only ever sees the text. A test
// that read the manager would pass while the model was handed an unusable result.
func sessionIdFromText(t *testing.T, text string) string {
	t.Helper()
	start := strings.Index(text, "ssh-")
	if start < 0 {
		t.Fatalf("no session id in the result:\n%s", text)
	}
	end := start
	for end < len(text) {
		char := text[end]
		if (char >= '0' && char <= '9') || char == '-' || (char >= 'a' && char <= 'z') {
			end++
			continue
		}
		break
	}
	return text[start:end]
}
