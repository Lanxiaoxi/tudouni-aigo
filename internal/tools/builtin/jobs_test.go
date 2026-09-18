package builtin

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// These tests mirror the ones the original carried for its job board
// (`tests/test_jobs.py`). The behaviour they pin is the reason the module exists:
// "it finished and nobody ever saw the exit code" is its one silent failure mode,
// and three separate mechanisms exist to make sure the model is told.

// fakeClock is a deterministic clock, so durations are assertable.
func fakeClock() func() float64 {
	now := 100.0
	return func() float64 {
		now += 0.5
		return now
	}
}

func newBoard(t *testing.T) *JobBoard {
	t.Helper()
	board := NewJobBoardForSession("test-session", fakeClock())
	t.Cleanup(func() { _ = board.Close() })
	return board
}

// finish marks a job as ended without ever starting a process.
func finish(job *Job, exitCode int) {
	job.mu.Lock()
	defer job.mu.Unlock()
	ended := job.Started + 1
	job.ended = &ended
	code := exitCode
	job.exitCode = &code
}

// TestAPartialReadIsNotACollectedResult mirrors the original:
// "`wait=false` 收过不算收过 —— 载荷尾部那行提醒必须继续挂着".
func TestAPartialReadIsNotACollectedResult(t *testing.T) {
	board := newBoard(t)
	job := &Job{ID: "1", Command: "pytest", Started: 1, Clock: board.clock}
	board.jobs = append(board.jobs, job)

	result := board.Output("1", false, 0)
	if status := result.Audit["job_status"]; status != "running" {
		t.Errorf("audit job_status = %v, want running", status)
	}
	if job.Collected() {
		t.Error("a partial read marked the job collected; the payload reminder would go quiet")
	}
	if !job.Outstanding() {
		t.Error("a job that was only partially read is no longer outstanding")
	}

	// The same read after the job really ended does collect it.
	finish(job, 0)
	board.Output("1", false, 0)
	if !job.Collected() {
		t.Error("a final read did not mark the job collected")
	}
	if job.Outstanding() {
		t.Error("a collected, finished job is still outstanding")
	}
}

// TestCollectedRecordsMakeRoom mirrors the original:
// "收了结果的记录会让位（它的信息已经在会话历史里了）".
func TestCollectedRecordsMakeRoom(t *testing.T) {
	board := newBoard(t)
	for index := 0; index < MaxJobs; index++ {
		job := &Job{
			ID:      string(rune('a' + index)),
			Command: "true",
			Started: 1,
			Clock:   board.clock,
		}
		finish(job, 0)
		job.mu.Lock()
		job.collected = true
		job.mu.Unlock()
		board.jobs = append(board.jobs, job)
	}

	board.makeRoom()

	if len(board.jobs) != 0 {
		t.Fatalf("collected records did not make room: %d left", len(board.jobs))
	}
}

// TestUncollectedRecordsAreNeverDropped is the other half of the rule above: the
// cap may only free records whose information already reached the session
// history.
func TestUncollectedRecordsAreNeverDropped(t *testing.T) {
	board := newBoard(t)
	for index := 0; index < 3; index++ {
		job := &Job{
			ID:      string(rune('a' + index)),
			Command: "true",
			Started: 1,
			Clock:   board.clock,
		}
		if index == 0 {
			finish(job, 0)
			job.mu.Lock()
			job.collected = true
			job.mu.Unlock()
		}
		board.jobs = append(board.jobs, job)
	}

	board.makeRoom()

	if len(board.jobs) != 2 {
		t.Fatalf("after makeRoom: %d jobs, want 2 (only the collected one may go)", len(board.jobs))
	}
	for _, job := range board.jobs {
		if job.ID == "a" {
			t.Error("the collected record was kept")
		}
	}
}

// TestTheLiveCapCountsOnlyRunningJobs mirrors the original's `_live`: six
// *finished* jobs whose results were never fetched must not be described as "在跑",
// and must not block new work on the live cap.
func TestTheLiveCapCountsOnlyRunningJobs(t *testing.T) {
	board := newBoard(t)
	for index := 0; index < MaxLiveJobs; index++ {
		job := &Job{
			ID:      string(rune('a' + index)),
			Command: "true",
			Started: 1,
			Clock:   board.clock,
		}
		finish(job, 0)
		board.jobs = append(board.jobs, job)
	}

	live := board.liveJobs()
	if len(live) != 0 {
		t.Errorf("live count = %d, want 0: finished jobs are not running", len(live))
	}
	if outstanding := board.outstandingJobs(); outstanding != MaxLiveJobs {
		t.Errorf("outstanding = %d, want %d", outstanding, MaxLiveJobs)
	}
}

// TestTheSessionOwnsItsJobDirectory pins the per-session directory. Job ids
// restart at 1 per board, so a shared directory means the second session
// overwrites the first's output and the startup prune deletes it.
func TestTheSessionOwnsItsJobDirectory(t *testing.T) {
	first := NewJobBoardForSession("alpha", fakeClock())
	second := NewJobBoardForSession("beta", fakeClock())
	t.Cleanup(func() { _ = first.Close() })
	t.Cleanup(func() { _ = second.Close() })

	if first.dir == second.dir {
		t.Fatalf("two sessions share a job directory: %s", first.dir)
	}
	for _, board := range []*JobBoard{first, second} {
		if !strings.HasSuffix(filepath.ToSlash(board.dir), "/jobs/"+filepath.Base(board.dir)) {
			t.Errorf("job directory is not session-scoped: %s", board.dir)
		}
	}
}

// TestPruneCountsOnlyWhatItRemoved pins the leftover count: it feeds a startup
// notice, and a count of "files seen" would overstate what was cleaned.
func TestPruneCountsOnlyWhatItRemoved(t *testing.T) {
	board := NewJobBoardForSession("prune-session", fakeClock())
	t.Cleanup(func() { _ = board.Close() })

	if err := os.MkdirAll(board.dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	for _, name := range []string{"1.out", "2.out"} {
		if err := os.WriteFile(filepath.Join(board.dir, name), []byte("x"), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	// A file the prune must not touch, so the count is not simply "entries seen".
	if err := os.WriteFile(filepath.Join(board.dir, "keep.txt"), []byte("x"), 0o644); err != nil {
		t.Fatalf("write keep.txt: %v", err)
	}

	if got := board.prune(); got != 2 {
		t.Errorf("prune removed %d, want 2", got)
	}
	if _, err := os.Stat(filepath.Join(board.dir, "keep.txt")); err != nil {
		t.Errorf("prune removed a file that is not a job output: %v", err)
	}
}
