package ssh

import (
	"context"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeChannel is one remote shell with no network under it.
//
// It exists because the behaviour worth asserting here is not about SSH at all: a
// rune split across two reads, a buffer that overflows, an exit code that arrives
// after the last output. A test that needed a running `sshd` for any of those
// would be a test that does not run on most machines.
//
// Its two sides are separate, and that separation is what makes the assertions
// possible:
//
//   - `incoming` is what the "remote shell" wrote, which the read loop consumes;
//   - `sent` is what the session wrote, which the test inspects.
//
// A pipe would have conflated them, and the test would then be racing its own
// reader for the bytes it wants to assert on.
type fakeChannel struct {
	mu   sync.Mutex
	sent []byte
	// resizes records the sizes asked for, in order.
	resizes [][2]int

	incoming chan []byte
	// holdover is bytes from one write that did not fit in the caller's buffer.
	//
	// Without it the fake would silently **drop** the middle of a large write —
	// `copy` truncates — and the overflow test would be asserting against a
	// channel that lost the bytes itself rather than against the buffer bound it
	// means to test.
	holdover []byte
	// ended is closed when the remote shell is gone, which is what unblocks Read
	// and Wait — the same thing a real channel's EOF does.
	ended    chan struct{}
	endOnce  sync.Once
	exitCode int
	haveCode bool
	waitErr  error
}

func newFakeChannel() *fakeChannel {
	return &fakeChannel{
		incoming: make(chan []byte, 64),
		ended:    make(chan struct{}),
	}
}

// write delivers bytes as though the remote shell printed them.
func (c *fakeChannel) write(data string) {
	c.incoming <- []byte(data)
}

// sentBytes is everything the session wrote to the shell.
func (c *fakeChannel) sentBytes() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return string(c.sent)
}

// Read blocks until the remote shell writes something or the channel ends.
//
// It behaves like a real `io.Reader` in the one way that matters here: a write
// larger than `p` is delivered **in pieces**, not truncated. A fake that returned
// only what fit would leave the session's buffer looking healthy while its source
// had quietly discarded the middle, and the overflow test would pass or fail for a
// reason of the fake's own.
func (c *fakeChannel) Read(p []byte) (int, error) {
	if len(c.holdover) > 0 {
		count := copy(p, c.holdover)
		c.holdover = c.holdover[count:]
		return count, nil
	}

	var data []byte
	select {
	case data = <-c.incoming:
	case <-c.ended:
		select {
		case data = <-c.incoming:
		default:
			return 0, io.EOF
		}
	}
	count := copy(p, data)
	if count < len(data) {
		c.holdover = append(c.holdover[:0], data[count:]...)
	}
	return count, nil
}

func (c *fakeChannel) Write(p []byte) (int, error) {
	select {
	case <-c.ended:
		return 0, errors.New("channel closed")
	default:
	}
	c.mu.Lock()
	c.sent = append(c.sent, p...)
	c.mu.Unlock()
	return len(p), nil
}

func (c *fakeChannel) Resize(cols, rows int) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.resizes = append(c.resizes, [2]int{cols, rows})
	return nil
}

func (c *fakeChannel) Close() error {
	c.endOnce.Do(func() { close(c.ended) })
	return nil
}

func (c *fakeChannel) Wait() (int, bool, error) {
	<-c.ended
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.exitCode, c.haveCode, c.waitErr
}

// exit says the remote shell has ended, with a code.
func (c *fakeChannel) exit(code int) {
	c.mu.Lock()
	c.exitCode, c.haveCode = code, true
	c.mu.Unlock()
	c.endOnce.Do(func() { close(c.ended) })
}

// exitWithoutCode says it ended and there is no code to report — a signal, or a
// connection that dropped before the far end said how it ended.
func (c *fakeChannel) exitWithoutCode() {
	c.mu.Lock()
	c.haveCode = false
	c.mu.Unlock()
	c.endOnce.Do(func() { close(c.ended) })
}

// newTestManager builds a manager whose connector hands out channels a test made.
func newTestManager(t *testing.T, configPath, home string, channels ...*fakeChannel) *Manager {
	t.Helper()
	var mu sync.Mutex
	queue := append([]*fakeChannel(nil), channels...)
	connector := func(host Host, cols, rows int, timeout time.Duration) (Channel, error) {
		mu.Lock()
		defer mu.Unlock()
		if len(queue) == 0 {
			return nil, errors.New("no channel left for this connect")
		}
		next := queue[0]
		queue = queue[1:]
		return next, nil
	}
	return NewManagerWithConnector(connector, configPath, home)
}

// prodConfig is the configuration every session test uses: one host that resolves
// without any of the refusal paths, so a test only fails for the reason it asserts.
func prodConfig(t *testing.T) (configPath, home string) {
	t.Helper()
	configPath, home = writeConfig(t, `
Host prod
    HostName 10.0.1.5
    User deploy
    IdentityFile ~/.ssh/k
`)
	writeKey(t, home, "k")
	return configPath, home
}

func connectAndGet(t *testing.T, manager *Manager, alias string) Info {
	t.Helper()
	info, err := manager.Connect(alias, 0, 0, time.Second)
	if err != nil {
		t.Fatalf("Connect(%s): %v", alias, err)
	}
	return info
}

// passwordConfig is `prodConfig` minus the key: a host that can only be reached
// with a password, which is the shape every password-override test needs.
func passwordConfig(t *testing.T) (configPath, home string) {
	t.Helper()
	configPath, home = writeConfig(t, `
Host prod
    HostName 10.0.1.5
    User deploy
`)
	return configPath, home
}

// TestOverridePasswordMakesKeylessHostReachable: the whole reason the password
// override exists — a host with no key anywhere, reached by passing a password at
// connect time. It also pins the order: the override is applied during resolution,
// not after it, or the "no private key" refusal would fire first.
func TestOverridePasswordMakesKeylessHostReachable(t *testing.T) {
	configPath, home := passwordConfig(t)
	fake := newFakeChannel()
	manager := newTestManager(t, configPath, home, fake)
	defer manager.CloseAll()

	info, err := manager.ConnectWithPassword("prod", "chu123", 0, 0, time.Second)
	if err != nil {
		t.Fatalf("ConnectWithPassword refused a keyless host despite a password: %v", err)
	}
	waitForStatus(t, manager, info.ID, StatusRunning)
}

// TestOverridePasswordWithoutKeyAndNoPasswordStillRefused: missing both
// credentials is still refused, so the escape hatch cannot become a laxer default.
func TestOverridePasswordWithoutKeyAndNoPasswordStillRefused(t *testing.T) {
	configPath, home := passwordConfig(t)
	manager := newTestManager(t, configPath, home, newFakeChannel())
	defer manager.CloseAll()

	if _, err := manager.Connect("prod", 0, 0, time.Second); err == nil {
		t.Fatal("Connect succeeded with no key and no password")
	}
}

// TestResolveWithPasswordAcceptsKeylessHost pins the resolve step directly: this
// was the exact failure seen live — a password in hand, the host still refused,
// because the override was applied after the refusal.
func TestResolveWithPasswordAcceptsKeylessHost(t *testing.T) {
	configPath, home := passwordConfig(t)
	config, err := LoadConfig(configPath, home)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	host, err := config.LookupWithPassword("prod", "chu123")
	if err != nil {
		t.Fatalf("LookupWithPassword refused a keyless host despite a password: %v", err)
	}
	if host.Password != "chu123" {
		t.Errorf("Password = %q, want the override to have been applied", host.Password)
	}
	if len(host.IdentityFiles) != 0 {
		t.Errorf("IdentityFiles = %v, want none", host.IdentityFiles)
	}
}

// waitForStatus polls until a session reaches a status, or fails.
func waitForStatus(t *testing.T, manager *Manager, id string, want Status) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if statusOf(manager, id) == want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("session %s is %s, want %s", id, statusOf(manager, id), want)
}

func statusOf(manager *Manager, id string) Status {
	for _, info := range manager.List() {
		if info.ID == id {
			return info.Status
		}
	}
	return ""
}

// TestReadReturnsWhatTheRemoteWrote is the baseline: bytes reach the caller.
func TestReadReturnsWhatTheRemoteWrote(t *testing.T) {
	configPath, home := prodConfig(t)
	fake := newFakeChannel()
	manager := newTestManager(t, configPath, home, fake)
	defer manager.CloseAll()
	info := connectAndGet(t, manager, "prod")

	fake.write("hello from the far end\n")

	result, err := manager.Read(context.Background(), info.ID, 0, 2*time.Second)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if result.Output != "hello from the far end\n" {
		t.Errorf("Output = %q", result.Output)
	}
	if result.Exited || result.EOF {
		t.Error("a running session reported an exit")
	}
	if result.TimedOut {
		t.Error("a read with output available reported a timeout")
	}
}

// TestExitDoesNotOvertakeTheOutputBeforeIt: the last line of a failed command is
// usually the reason it failed, so the exit must be reported only after everything
// the shell wrote has been handed over.
func TestExitDoesNotOvertakeTheOutputBeforeIt(t *testing.T) {
	configPath, home := prodConfig(t)
	fake := newFakeChannel()
	manager := newTestManager(t, configPath, home, fake)
	defer manager.CloseAll()
	info := connectAndGet(t, manager, "prod")

	fake.write("first half ")
	fake.write("second half\n")
	fake.exit(0)

	var seen strings.Builder
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		result, err := manager.Read(context.Background(), info.ID, 0, time.Second)
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		seen.WriteString(result.Output)
		if result.EOF {
			if got := seen.String(); got != "first half second half\n" {
				t.Errorf("output before EOF = %q", got)
			}
			if result.ExitCode == nil || *result.ExitCode != 0 {
				t.Errorf("ExitCode = %v, want 0", result.ExitCode)
			}
			if result.Reason != string(StatusExited) {
				t.Errorf("Reason = %q, want %q", result.Reason, StatusExited)
			}
			return
		}
	}
	t.Fatalf("never reached EOF; saw %q", seen.String())
}

// TestExitWithoutACodeIsNotZero pins the distinction the exit-code design exists
// for: "it was killed or the link dropped" and "it exited cleanly" must not read
// alike.
func TestExitWithoutACodeIsNotZero(t *testing.T) {
	configPath, home := prodConfig(t)
	fake := newFakeChannel()
	manager := newTestManager(t, configPath, home, fake)
	defer manager.CloseAll()
	info := connectAndGet(t, manager, "prod")

	fake.exitWithoutCode()
	waitForStatus(t, manager, info.ID, StatusExited)

	result, err := manager.Read(context.Background(), info.ID, 0, time.Second)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if !result.EOF {
		t.Fatalf("a read after the end did not report EOF: %+v", result)
	}
	if result.ExitCode != nil {
		t.Errorf("ExitCode = %d, want nil — there was no code to report", *result.ExitCode)
	}
}

// TestReadTimesOutWithoutEndingTheSession: a quiet command is an ordinary answer,
// not a failure — and it must not be mistaken for the session being over.
func TestReadTimesOutWithoutEndingTheSession(t *testing.T) {
	configPath, home := prodConfig(t)
	fake := newFakeChannel()
	manager := newTestManager(t, configPath, home, fake)
	defer manager.CloseAll()
	info := connectAndGet(t, manager, "prod")

	result, err := manager.Read(context.Background(), info.ID, 0, 120*time.Millisecond)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if !result.TimedOut {
		t.Error("a read with nothing to return was not reported as timed out")
	}
	if result.Exited || result.EOF {
		t.Error("a timeout was reported as an exit")
	}
	if status := statusOf(manager, info.ID); status != StatusRunning {
		t.Errorf("the session is %s after a quiet read", status)
	}
}

// TestSplitRuneIsNotEmittedInHalves is the UTF-8 case, which is more likely over
// SSH than locally: the channel's window decides where a read lands, and a remote
// build printing Chinese filenames crosses that boundary constantly.
func TestSplitRuneIsNotEmittedInHalves(t *testing.T) {
	configPath, home := prodConfig(t)
	fake := newFakeChannel()
	manager := newTestManager(t, configPath, home, fake)
	defer manager.CloseAll()
	info := connectAndGet(t, manager, "prod")

	// 汉字 is six bytes. Pushing the first four ends in the middle of the second
	// character, which is exactly what a channel boundary does.
	fake.write("汉")
	fake.write(string([]byte("字")[:1]))

	result, err := manager.Read(context.Background(), info.ID, 0, 2*time.Second)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if result.Output != "汉" {
		t.Errorf("Output = %q, want just 汉 — the incomplete rune must wait for its continuation", result.Output)
	}

	fake.write(string([]byte("字")[1:]))
	second, err := manager.Read(context.Background(), info.ID, 0, 2*time.Second)
	if err != nil {
		t.Fatalf("second read: %v", err)
	}
	if second.Output != "字" {
		t.Errorf("second Output = %q, want 字", second.Output)
	}
	if got := result.Output + second.Output; got != "汉字" {
		t.Errorf("the word reassembled as %q (a replacement character here is the bug this test exists for)", got)
	}
}

// TestATinyLimitStillMakesProgress is the deadlock the rune logic could otherwise
// create.
//
// A limit smaller than the widest encoding cannot split a character, so a strict
// reading would return nothing and leave the buffer untouched — and the next read
// would do the same thing. The model would then loop on `ssh_read` for ever, with
// every result saying `truncated: true` and holding no output to explain why.
// Raising the floor to one whole encoding is what turns that into progress.
func TestATinyLimitStillMakesProgress(t *testing.T) {
	configPath, home := prodConfig(t)
	fake := newFakeChannel()
	manager := newTestManager(t, configPath, home, fake)
	defer manager.CloseAll()
	info := connectAndGet(t, manager, "prod")

	// A four-byte character, which is the worst case for a one-byte limit.
	fake.write("😀")
	time.Sleep(30 * time.Millisecond)

	result, err := manager.Read(context.Background(), info.ID, 1, time.Second)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if result.Output == "" {
		t.Fatalf("a read with a one-byte limit returned nothing at all: %+v", result)
	}
	if result.Output != "😀" {
		t.Errorf("Output = %q, want the whole character — half of it is not a character", result.Output)
	}
}

// TestOutputIsTruncatedAtTheLimitAndTheRestIsStillThere: a read that hits its
// ceiling must say so, and must not consume what it did not return.
func TestOutputIsTruncatedAtTheLimitAndTheRestIsStillThere(t *testing.T) {
	configPath, home := prodConfig(t)
	fake := newFakeChannel()
	manager := newTestManager(t, configPath, home, fake)
	defer manager.CloseAll()
	info := connectAndGet(t, manager, "prod")

	// Twice the read limit, in whole ASCII so no rune logic interferes.
	payload := strings.Repeat("a", 200)
	fake.write(payload)
	// Give the read loop a moment to land it in the buffer.
	time.Sleep(30 * time.Millisecond)

	first, err := manager.Read(context.Background(), info.ID, 100, time.Second)
	if err != nil {
		t.Fatalf("first read: %v", err)
	}
	if !first.Truncated {
		t.Error("a read that hit the limit did not report truncation")
	}
	if len(first.Output) != 100 {
		t.Errorf("first read returned %d bytes, want 100", len(first.Output))
	}

	var rest strings.Builder
	rest.WriteString(first.Output)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && rest.Len() < len(payload) {
		next, err := manager.Read(context.Background(), info.ID, 100, 200*time.Millisecond)
		if err != nil {
			t.Fatalf("follow-up read: %v", err)
		}
		rest.WriteString(next.Output)
	}
	if rest.String() != payload {
		t.Errorf("the output reassembled to %d bytes, want %d — nothing may be lost", rest.Len(), len(payload))
	}
}

// TestOversizedOutputKeepsTheTail: when the buffer overflows, the oldest bytes go
// and the count is reported. Keeping the tail is deliberate — the end of a
// command's output is where the prompt and the result are.
func TestOversizedOutputKeepsTheTail(t *testing.T) {
	configPath, home := prodConfig(t)
	fake := newFakeChannel()
	manager := newTestManager(t, configPath, home, fake)
	defer manager.CloseAll()
	info := connectAndGet(t, manager, "prod")

	// One write larger than the bound, so the trim happens inside `append`.
	fake.write(strings.Repeat("x", MaxOutputPending) + "TAIL")

	// The read loop has to consume the payload before the overflow exists, and it
	// does so on its own goroutine. Polling rather than sleeping a fixed amount is
	// what keeps this test from depending on how fast the machine is.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		run, err := manager.lookup(info.ID)
		if err != nil {
			t.Fatalf("lookup: %v", err)
		}
		run.mu.Lock()
		dropped := run.dropped
		run.mu.Unlock()
		if dropped > 0 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}

	// The buffer holds megabytes and one read returns at most `MaxReadLimit`, so
	// reaching the tail means draining it — which is exactly the condition the
	// assertion is about: the end of the output has to **still be there** after the
	// overflow, however many reads it takes to get to it.
	var all strings.Builder
	dropped := 0
	for attempt := 0; attempt < 200; attempt++ {
		result, err := manager.Read(context.Background(), info.ID, MaxReadLimit, 300*time.Millisecond)
		if err != nil {
			t.Fatalf("Read: %v", err)
		}
		all.WriteString(result.Output)
		if result.Dropped > dropped {
			dropped = result.Dropped
		}
		if result.TimedOut || result.Exited || result.EOF {
			break
		}
	}
	if dropped == 0 {
		t.Fatal("the overflow was not recorded")
	}
	got := all.String()
	if !strings.Contains(got, "TAIL") {
		t.Errorf("the tail of the output was dropped; the buffer must keep the end (drained %d bytes)", len(got))
	}
	if !strings.HasPrefix(got, DroppedNotice) {
		t.Error("the gap is not marked, so the model would read the output as continuous")
	}
}

// TestReadIsInterruptibleByCancellation: pressing stop must not have to wait out a
// read on a remote machine, and an abandoned read must not lose bytes.
func TestReadIsInterruptibleByCancellation(t *testing.T) {
	configPath, home := prodConfig(t)
	fake := newFakeChannel()
	manager := newTestManager(t, configPath, home, fake)
	defer manager.CloseAll()
	info := connectAndGet(t, manager, "prod")

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(50 * time.Millisecond)
		cancel()
	}()

	done := make(chan error, 1)
	go func() {
		_, err := manager.Read(ctx, info.ID, 0, 30*time.Second)
		done <- err
	}()

	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("err = %v, want context.Canceled", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a cancelled read kept waiting; stop must reach it")
	}
}

// TestSessionLimitRefusesTheNextConnect: the refusal has to happen **before** a
// connection is made, or the far end accumulates logins the model cannot see.
func TestSessionLimitRefusesTheNextConnect(t *testing.T) {
	configPath, home := prodConfig(t)
	fakes := make([]*fakeChannel, 0, MaxSessions)
	for index := 0; index < MaxSessions; index++ {
		fakes = append(fakes, newFakeChannel())
	}
	manager := newTestManager(t, configPath, home, fakes...)
	defer manager.CloseAll()

	for index := 0; index < MaxSessions; index++ {
		connectAndGet(t, manager, "prod")
	}
	_, err := manager.Connect("prod", 0, 0, time.Second)
	if err == nil {
		t.Fatalf("a %dth connect succeeded; the limit is %d", MaxSessions+1, MaxSessions)
	}
	if !strings.Contains(err.Error(), "ssh_close") {
		t.Errorf("the refusal does not say how to make room: %v", err)
	}
}

// TestEndingAndForgettingAreDifferentOperations walks both and checks they do
// different things: one ends a connection, the other deletes a record.
func TestEndingAndForgettingAreDifferentOperations(t *testing.T) {
	configPath, home := prodConfig(t)
	fake := newFakeChannel()
	manager := newTestManager(t, configPath, home, fake)
	defer manager.CloseAll()
	info := connectAndGet(t, manager, "prod")

	if err := manager.Forget(info.ID); err == nil {
		t.Error("Forget accepted a running session; that would leave a login nobody can see or end")
	}
	if err := manager.Close(info.ID); err != nil {
		t.Fatalf("Close: %v", err)
	}
	waitForStatus(t, manager, info.ID, StatusKilled)

	if err := manager.Forget(info.ID); err != nil {
		t.Fatalf("Forget on an ended session: %v", err)
	}
	if rows := manager.List(); len(rows) != 0 {
		t.Errorf("the session is still listed after Forget: %v", rows)
	}
}

// TestEndedSessionsStayOnTheList: they answer "what was I running", and a session
// that vanished on exit would take its exit code with it.
func TestEndedSessionsStayOnTheList(t *testing.T) {
	configPath, home := prodConfig(t)
	fake := newFakeChannel()
	manager := newTestManager(t, configPath, home, fake)
	defer manager.CloseAll()
	info := connectAndGet(t, manager, "prod")

	fake.exit(7)
	waitForStatus(t, manager, info.ID, StatusExited)

	rows := manager.List()
	if len(rows) != 1 {
		t.Fatalf("List() has %d rows, want the ended session to remain", len(rows))
	}
	if rows[0].ExitCode == nil || *rows[0].ExitCode != 7 {
		t.Errorf("the exit code was lost from the row: %v", rows[0].ExitCode)
	}
}

// TestWriteReachesTheChannel: the write path has a queue in front of it, and this
// is the assertion that the queue actually drains.
func TestWriteReachesTheChannel(t *testing.T) {
	configPath, home := prodConfig(t)
	fake := newFakeChannel()
	manager := newTestManager(t, configPath, home, fake)
	defer manager.CloseAll()
	info := connectAndGet(t, manager, "prod")

	if err := manager.Write(info.ID, "echo hi\n"); err != nil {
		t.Fatalf("Write: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && !strings.Contains(fake.sentBytes(), "echo hi") {
		time.Sleep(5 * time.Millisecond)
	}
	if got := fake.sentBytes(); !strings.Contains(got, "echo hi") {
		t.Errorf("the bytes never reached the channel: %q", got)
	}
}

// TestWriteIsRefusedOnceTheChannelIsGone: the model has to be told the write went
// nowhere, because "sent" for a closed session is a command that never ran.
func TestWriteIsRefusedOnceTheChannelIsGone(t *testing.T) {
	configPath, home := prodConfig(t)
	fake := newFakeChannel()
	manager := newTestManager(t, configPath, home, fake)
	defer manager.CloseAll()
	info := connectAndGet(t, manager, "prod")

	fake.exit(0)
	waitForStatus(t, manager, info.ID, StatusExited)

	if err := manager.Write(info.ID, "echo hi\n"); err == nil {
		t.Fatal("Write accepted bytes for a session that has ended")
	}
}

// TestConnectResolvesBeforeOpeningAnything: a typo in the configuration must not
// reach the network, and it must not consume a session slot either.
func TestConnectResolvesBeforeOpeningAnything(t *testing.T) {
	configPath, home := writeConfig(t, `
Host prod
    HostName 10.0.1.5
    ProxyJump bastion
`)
	manager := newTestManager(t, configPath, home, newFakeChannel())
	defer manager.CloseAll()

	if _, err := manager.Connect("prod", 0, 0, time.Second); err == nil {
		t.Fatal("Connect opened a session for a host whose configuration is refused")
	}
	if rows := manager.List(); len(rows) != 0 {
		t.Errorf("a failed connect left %d sessions behind", len(rows))
	}
}

// TestConnectUnknownSessionIDExplainsItself: a model that mistyped an id has no
// other way to find out what does exist, so the message has to point at the list.
func TestConnectUnknownSessionIDExplainsItself(t *testing.T) {
	configPath, home := prodConfig(t)
	fake := newFakeChannel()
	manager := newTestManager(t, configPath, home, fake)
	defer manager.CloseAll()

	_, err := manager.Read(context.Background(), "ssh-99", 0, time.Second)
	if err == nil {
		t.Fatal("reading an unknown session succeeded")
	}
	if !strings.Contains(err.Error(), "ssh_sessions") {
		t.Errorf("the error does not point at the tool that lists them: %v", err)
	}
}

// TestNonsenseWindowSizesAreIgnored: a size nobody asked for would make a
// full-screen program redraw at the wrong width, which is indistinguishable from a
// rendering bug in this program.
//
// The guard is tested directly rather than through `sshChannel`, because reaching
// `sshChannel.Resize` needs a live SSH session — and the rule being pinned here is
// this program's, not the library's.
func TestNonsenseWindowSizesAreIgnored(t *testing.T) {
	for _, size := range [][2]int{{0, 0}, {0, 40}, {120, 0}, {-1, 40}} {
		if sensibleSize(size[0], size[1]) {
			t.Errorf("sensibleSize(%d, %d) = true; a size with a zero or negative half must be ignored",
				size[0], size[1])
		}
	}
	for _, size := range [][2]int{{1, 1}, {80, 24}, {120, 40}} {
		if !sensibleSize(size[0], size[1]) {
			t.Errorf("sensibleSize(%d, %d) = false; an ordinary size must go through", size[0], size[1])
		}
	}
}

// TestConnectWithPasswordOverridesConfig: a password passed at connect time is a
// temporary credential, and it must reach the connector as the host's password —
// replacing whatever the Host block said, not merging with it.
func TestConnectWithPasswordOverridesConfig(t *testing.T) {
	configPath, home := writeConfig(t, `
Host prod
    HostName 10.0.1.5
    User deploy
    Password config-password
`)
	var got []Host
	var mu sync.Mutex
	connector := func(host Host, cols, rows int, timeout time.Duration) (Channel, error) {
		mu.Lock()
		got = append(got, host)
		mu.Unlock()
		return newFakeChannel(), nil
	}
	manager := NewManagerWithConnector(connector, configPath, home)
	defer manager.CloseAll()

	if _, err := manager.ConnectWithPassword("prod", "override-password", 0, 0, time.Second); err != nil {
		t.Fatalf("ConnectWithPassword: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(got) != 1 {
		t.Fatalf("the connector saw %d hosts, want 1", len(got))
	}
	if got[0].Password != "override-password" {
		t.Errorf("Password = %q, want the call-time override", got[0].Password)
	}
}

// TestConnectWithPasswordEmptyKeepsConfig: an empty call-time password means
// "use the configuration", not "wipe the configured password".
func TestConnectWithPasswordEmptyKeepsConfig(t *testing.T) {
	configPath, home := writeConfig(t, `
Host prod
    HostName 10.0.1.5
    User deploy
    Password config-password
`)
	var got []Host
	var mu sync.Mutex
	connector := func(host Host, cols, rows int, timeout time.Duration) (Channel, error) {
		mu.Lock()
		got = append(got, host)
		mu.Unlock()
		return newFakeChannel(), nil
	}
	manager := NewManagerWithConnector(connector, configPath, home)
	defer manager.CloseAll()

	if _, err := manager.ConnectWithPassword("prod", "", 0, 0, time.Second); err != nil {
		t.Fatalf("ConnectWithPassword: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(got) != 1 {
		t.Fatalf("the connector saw %d hosts, want 1", len(got))
	}
	if got[0].Password != "config-password" {
		t.Errorf("Password = %q, want the configured one", got[0].Password)
	}
}

// TestPasswordOnlyHostConnectsWithoutKeys: a host whose configuration carries a
// password and no key at all must open a session — the resolve step already
// accepts it, and this pins that the manager passes it through end to end.
func TestPasswordOnlyHostConnectsWithoutKeys(t *testing.T) {
	configPath, home := writeConfig(t, `
Host prod
    HostName 10.0.1.5
    User deploy
    Password s3cret!
`)
	fake := newFakeChannel()
	manager := newTestManager(t, configPath, home, fake)
	defer manager.CloseAll()

	info, err := manager.Connect("prod", 0, 0, time.Second)
	if err != nil {
		t.Fatalf("Connect on a password-only host: %v", err)
	}
	waitForStatus(t, manager, info.ID, StatusRunning)
}
