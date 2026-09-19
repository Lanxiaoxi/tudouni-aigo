package builtin

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/paths"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/process"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// Caps on background work. Neither is about clumsiness — both are the gate on
// orphan processes. Every live job is a process tree the operating system will
// keep running until somebody collects it, and every output file is a file nothing
// is watching the size of.
const (
	MaxLiveJobs = 6
	MaxJobs     = 12
	// MaxJobOutputBytes is the read-time cap. Past it the job is terminated rather
	// than read: "how big is this file" has nobody watching it.
	MaxJobOutputBytes = 2 * 1024 * 1024
	MaxOutputChars    = 8000
	// DocumentedWaitSeconds is what the tool description promises, so it is also
	// what the default must be.
	DocumentedWaitSeconds = 30
	MaxWaitSeconds        = 300
)

// Job states, as the panel reports them.
//
// Four states because they answer four different questions, and the difference
// between `uncollected` and `done` is the one that matters: a job that finished
// but whose result was never fetched is the only one where somebody still has to
// act, and it is exactly the case a panel that only knew "running or not" would
// hide.
const (
	JobRunning     = "running"
	JobUncollected = "uncollected"
	JobDone        = "done"
	JobKilled      = "killed"
)

// Job is one background task.
//
// It is not a value type: it holds a process handle, so only "alive or not" is a
// meaningful comparison. Its timing comes from the injected clock, like everything
// else that reports a duration.
type Job struct {
	ID         string
	Command    string
	OutputPath string
	ShownPath  string
	Started    float64
	Clock      func() float64

	mu        sync.Mutex
	cmd       *exec.Cmd
	ended     *float64
	exitCode  *int
	reason    string
	killed    bool
	collected bool
	waitErr   error
}

// Running reports whether the process is still alive.
func (j *Job) Running() bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.ended == nil
}

// Duration is how long it has been going, in seconds.
func (j *Job) Duration() float64 {
	now := j.Clock()
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.ended != nil {
		return *j.ended - j.Started
	}
	return now - j.Started
}

// Collected reports whether the result has been fetched.
func (j *Job) Collected() bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.collected
}

// State is one of the four job states.
func (j *Job) State() string {
	j.mu.Lock()
	defer j.mu.Unlock()
	switch {
	case j.ended == nil:
		return JobRunning
	case j.killed:
		return JobKilled
	case j.collected:
		return JobDone
	default:
		return JobUncollected
	}
}

// Outstanding reports whether the result still needs collecting.
func (j *Job) Outstanding() bool {
	state := j.State()
	return state == JobRunning || state == JobUncollected
}

// JobBoard holds this session's background tasks.
//
// There are no background threads. A goroutine per job waits on the process and
// records the outcome, and every reader takes a copy under the lock — which is the
// same thing Python's `poll()` polling achieves, without a timer anywhere. "Zero
// background threads" is not a slogan: a monitor thread would have to be stopped,
// and stopping it is one more thing that can go wrong on the shutdown path.
type JobBoard struct {
	mu      sync.Mutex
	dir     string
	jobs    []*Job
	counter int
	clock   func() float64
	closed  bool
	// Leftovers is how many output files a previous run left behind. The session
	// that made them did not exit cleanly, so the commands may still be running.
	Leftovers int
}

// jobsDirName is the directory under `<workspace>/.tudouni` that holds job output.
const jobsDirName = "jobs"

// NewJobBoard opens the board and prunes what the last run of **this session** left
// behind.
//
// The directory is per session, and that is load-bearing rather than tidy. Job ids
// restart at 1 for every board, so two sessions in one workspace would both write
// `<workspace>/.tudouni/jobs/1.out` — the second session would overwrite the
// first's output, `job_output` would read back another session's text, and the
// prune below (which clears the directory it owns) would delete a live job's output
// out from under it. The shown path carries the session segment for the same
// reason: it is what a person types to look at the file themselves.
func NewJobBoard(clock func() float64) *JobBoard {
	return NewJobBoardForSession("", clock)
}

// NewJobBoardForSession opens the board for one session.
//
// An empty session id keeps the old shared location. It exists only so a test can
// build a board without inventing an id; every real caller passes one.
func NewJobBoardForSession(sessionID string, clock func() float64) *JobBoard {
	if clock == nil {
		clock = security.PerfClock
	}
	dir := filepath.Join(paths.WorkspaceRuntimeDir(), jobsDirName)
	if sessionID != "" {
		dir = filepath.Join(dir, sessionID)
	}
	board := &JobBoard{dir: dir, clock: clock}
	board.Leftovers = board.prune()
	return board
}

// prune removes leftover output files and reports how many there were.
//
// A file that cannot be deleted does not stop startup: the alternative is refusing
// to run because of a file nobody needs, and the count is reported anyway.
func (b *JobBoard) prune() int {
	entries, err := os.ReadDir(b.dir)
	if err != nil {
		return 0
	}
	count := 0
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".out") {
			continue
		}
		if err := os.Remove(filepath.Join(b.dir, entry.Name())); err == nil {
			count++
		} else {
			count++
		}
	}
	return count
}

// liveJobs lists the ids of jobs that are actually running.
//
// The live cap and the record cap are two different questions and must not share a
// list. "Six things are running" is a statement about this machine; "six results
// were never fetched" is a statement about the model's bookkeeping. Merging them
// produces a refusal that says "6 个后台任务在跑" about six processes that ended
// hours ago, and the model cannot tell the two situations apart.
func (b *JobBoard) liveJobs() []string {
	var live []string
	for _, job := range b.jobs {
		if job.Running() {
			live = append(live, job.ID)
		}
	}
	return live
}

// outstandingJobs counts the jobs whose result nobody has seen yet: still running,
// or finished and never collected.
func (b *JobBoard) outstandingJobs() int {
	count := 0
	for _, job := range b.jobs {
		if job.Outstanding() {
			count++
		}
	}
	return count
}

// uncollectedJobs lists the ids of finished jobs whose result was never fetched.
func (b *JobBoard) uncollectedJobs() []string {
	var out []string
	for _, job := range b.jobs {
		if !job.Running() && !job.Collected() {
			out = append(out, job.ID)
		}
	}
	return out
}

// makeRoom frees the records whose information already reached the session
// history.
//
// Collected records are the only ones that may go: their result is in the
// conversation, so dropping the record loses nothing the model can still ask for.
// A running job and a finished-but-uncollected job are both still "somebody has to
// act", and dropping either would hide work — which is the failure this whole
// module exists to prevent.
func (b *JobBoard) makeRoom() {
	kept := make([]*Job, 0, len(b.jobs))
	for _, job := range b.jobs {
		if !job.Collected() {
			kept = append(kept, job)
		}
	}
	b.jobs = kept
}

// Start launches a command in the background.
func (b *JobBoard) Start(command string) (tools.Result, error) {
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return tools.TextResult("这次会话已经在收尾了，起不了新的后台任务。"), nil
	}
	live := b.liveJobs()
	if len(live) >= MaxLiveJobs {
		b.mu.Unlock()
		return tools.TextResult(fmt.Sprintf(
			"起不了：同时最多 %d 个后台任务在跑，现在跑着的是 %s。\n"+
				"先 job_output 收掉一个、或者 job_kill 收掉不再需要的，再起新的。",
			MaxLiveJobs, strings.Join(live, "、"))), nil
	}
	// The record cap counts *records*, and a record is only held onto while it
	// still owes something. Collected ones make room first, so the advice below is
	// true: after collecting, the next start succeeds.
	b.makeRoom()
	if len(b.jobs) >= MaxJobs {
		uncollected := b.uncollectedJobs()
		detail := "现在没有在跑的，也没有等收结果的"
		if len(uncollected) > 0 {
			detail = "结果是还没收的是 " + strings.Join(uncollected, "、")
		}
		b.mu.Unlock()
		return tools.TextResult(fmt.Sprintf(
			"开不了新任务：同时留着的任务最多 %d 个 —— %s。\n"+
				"先用 job_output 把它们的结果收掉（收完的记录会让位），不再需要的用 job_kill 收掉。",
			MaxJobs, detail)), nil
	}
	b.counter++
	id := strconv.Itoa(b.counter)
	b.mu.Unlock()

	outputPath := filepath.Join(b.dir, id+".out")
	argv := shellArgv(command)
	cmd, err := process.Start(argv, paths.WorkspaceDir(), outputPath)
	if err != nil {
		return tools.Result{
			Text:  "无法启动 shell：" + err.Error(),
			Audit: map[string]any{"job_status": "error"},
		}, nil
	}

	job := &Job{
		ID: id, Command: command, OutputPath: outputPath,
		ShownPath: jobShownPath(outputPath), Started: b.clock(), Clock: b.clock, cmd: cmd,
	}
	b.mu.Lock()
	b.jobs = append(b.jobs, job)
	b.mu.Unlock()

	go func() {
		err := cmd.Wait()
		ended := b.clock()
		job.mu.Lock()
		job.ended = &ended
		job.waitErr = err
		if cmd.ProcessState != nil {
			code := cmd.ProcessState.ExitCode()
			job.exitCode = &code
		}
		job.mu.Unlock()
	}()

	text := fmt.Sprintf(
		"后台任务 %s 已启动 —— **结果未知**。\n"+
			"命令：%s\n"+
			"它正在独立地跑，你**现在不知道它成没成**。输出写到 %s。\n"+
			"- 收结果：job_output(job_id=%q)（默认最多等 %d 秒；它慢就自己给 wait_seconds，上限 %d）\n"+
			"- 先干别的：它是后台任务，本来就不用等它 —— 但**在收到结果之前不要说它成功了**，也别改它正在读的文件\n"+
			"- 收掉它：job_kill(job_id=%q)",
		id, command, job.ShownPath, id, DocumentedWaitSeconds, MaxWaitSeconds, id)

	return tools.Result{
		Text: text,
		Audit: map[string]any{
			"background": true,
			"job_status": "started",
			"job_id":     id,
		},
	}, nil
}

// Output fetches a job's output, optionally waiting for it to finish.
func (b *JobBoard) Output(jobID string, wait bool, waitSeconds int) tools.Result {
	job, ok := b.find(jobID)
	if !ok {
		return tools.TextResult(b.unknownJob(jobID))
	}
	if wait && job.Running() {
		seconds := waitSeconds
		if seconds <= 0 {
			seconds = DocumentedWaitSeconds
		}
		if seconds > MaxWaitSeconds {
			seconds = MaxWaitSeconds
		}
		deadline := time.Now().Add(time.Duration(seconds) * time.Second)
		for time.Now().Before(deadline) && job.Running() {
			time.Sleep(50 * time.Millisecond)
		}
	}

	job.mu.Lock()
	stillRunning := job.ended == nil
	killed := job.killed
	reason := job.reason
	exitCode := job.exitCode
	// **Only a real ending counts as "collected".** A partial read is not a result:
	// the job is still running, so nobody has seen whether it worked. Marking it
	// collected here would drop it out of both `job_list` and the payload-tail
	// reminder, and "it finished and nobody ever saw the exit code" is the one
	// silent failure this whole module is built to prevent.
	if !stillRunning {
		job.collected = true
	}
	job.mu.Unlock()

	head := "--- 输出 ---"
	switch {
	case stillRunning:
		head = "--- 部分输出（**任务还没结束，这不是结果**）---"
	case killed:
		head = "--- 被终止时的输出（不完整，不是结果）---"
	}

	body := b.readOutput(job)
	var status string
	switch {
	case stillRunning:
		status = fmt.Sprintf("**还在跑**（已跑 %s）", durationText(job.Duration()))
	case killed:
		detail := reason
		if detail == "" {
			detail = "被终止了"
		}
		status = fmt.Sprintf("**不是它自己结束的**：%s（已跑 %s，退出码 %s）。它被终止了，所以它的输出不能当结论用",
			detail, durationText(job.Duration()), exitCodeText(exitCode))
	default:
		status = fmt.Sprintf("已结束（退出码 %s，跑了 %s）", exitCodeText(exitCode), durationText(job.Duration()))
	}

	auditStatus := "running"
	if !stillRunning {
		auditStatus = "collected"
	}
	return tools.Result{
		Text:  status + "\n" + head + "\n" + body,
		Audit: map[string]any{"job_id": jobID, "job_status": auditStatus},
	}
}

func (b *JobBoard) readOutput(job *Job) string {
	info, err := os.Stat(job.OutputPath)
	if err != nil {
		return "（读不到它的输出文件：" + err.Error() + "）"
	}
	if info.Size() > MaxJobOutputBytes {
		b.Kill(job.ID)
		return fmt.Sprintf("（它的输出超过了 %d MiB，已终止）", MaxJobOutputBytes/1024/1024)
	}
	raw, err := os.ReadFile(job.OutputPath)
	if err != nil {
		return "（读不到它的输出文件：" + err.Error() + "）"
	}
	text := string(raw)
	if strings.TrimSpace(text) == "" {
		return "(无输出)"
	}
	return tools.Truncate(text, MaxOutputChars)
}

// Kill terminates a job's whole process tree.
func (b *JobBoard) Kill(jobID string) tools.Result {
	job, ok := b.find(jobID)
	if !ok {
		return tools.TextResult(b.unknownJob(jobID))
	}
	if !job.Running() {
		return tools.Result{
			Text:  fmt.Sprintf("后台任务 %s 已经结束了，不用收。要结果就用 job_output(job_id=%q)。", jobID, jobID),
			Audit: map[string]any{"job_id": jobID, "job_status": job.State()},
		}
	}
	job.mu.Lock()
	job.killed = true
	job.reason = "被 job_kill 收掉了"
	cmd := job.cmd
	job.mu.Unlock()
	// The kill is reported for what it was. Saying "terminated" over a refused
	// taskkill is how this program's own notes describe the worst kind of leftover:
	// a process still holding a port that the panel says is gone.
	if err := process.TerminateTree(cmd); err != nil {
		return tools.Result{
			Text: fmt.Sprintf("后台任务 %s **没能停掉**（%v）—— 它可能还在跑，也还占着端口或文件。"+
				"不要重复 job_kill；先确认那个进程还在不在，必要时手动结束它。", jobID, err),
			Audit: map[string]any{"job_id": jobID, "job_status": JobKilled, "kill_failed": true},
		}
	}
	return tools.Result{
		Text: fmt.Sprintf("后台任务 %s 已终止（整棵进程树）。**不是它自己结束的**，所以它的输出不是结果；要结果就重新起一条。",
			jobID),
		Audit: map[string]any{"job_id": jobID, "job_status": JobKilled},
	}
}

// ProgressLine is the one-line, **human** view: `2 running, 1 result not collected`
// plus the ids. It returns "" when there is nothing to say.
//
// It is separate from `Note` for the same reason the task list keeps two renderings:
// the model wants "which ones, what commands, which do I need to collect", while a
// person wants "is anything still hanging on my machine" at a glance. Merging them
// makes each side pay tokens for the other.
//
// It is one notch more important than the task list's line: a stale task list is
// stale information, while an uncollected job is a process that is still running.
func (b *JobBoard) ProgressLine() string {
	if b == nil {
		return ""
	}
	b.mu.Lock()
	running := b.liveJobs()
	uncollected := b.uncollectedJobs()
	b.mu.Unlock()

	if len(running) == 0 && len(uncollected) == 0 {
		return ""
	}
	var parts []string
	if len(running) > 0 {
		parts = append(parts, i18n.Tn("jobs.progress.running", len(running)))
	}
	if len(uncollected) > 0 {
		parts = append(parts, i18n.Tn("jobs.progress.uncollected", len(uncollected)))
	}
	ids := append(append([]string{}, running...), uncollected...)
	return i18n.T("jobs.progress.line",
		"parts", strings.Join(parts, "、"),
		"ids", strings.Join(ids, "、"))
}

// List renders the state of every job.
func (b *JobBoard) List() tools.Result {
	rows := b.Panel()
	if len(rows) == 0 {
		return tools.TextResult("这次会话还没有起过后台任务。")
	}
	var lines []string
	for _, row := range rows {
		state, _ := row["state"].(string)
		command, _ := row["command"].(string)
		seconds, _ := row["seconds"].(int)
		switch state {
		case JobRunning:
			lines = append(lines, fmt.Sprintf("- %v（在跑，%s）：%s", row["id"], durationText(float64(seconds)), command))
		case JobUncollected:
			lines = append(lines, fmt.Sprintf("- %v（**结果还没收**，退出码 %v）：%s", row["id"], row["exit_code"], command))
		default:
			lines = append(lines, fmt.Sprintf("- %v（收过了）：%s", row["id"], command))
		}
	}
	header := fmt.Sprintf("后台任务 %d 个（同时最多 %d 个在跑、最多留着 %d 个）。标着「结果还没收」的那些，你现在**还不知道**它们成没成。",
		len(rows), MaxLiveJobs, MaxJobs)
	return tools.TextResult(header + "\n" + strings.Join(lines, "\n"))
}

// Panel is the snapshot the interface draws.
//
// Order is computed, not incidental: unfinished jobs first, and inside each group
// in the order they were started. The state is computed here too — "what
// combination counts as a result nobody has collected" is a judgement, and a
// front end deriving it again would be a second definition that drifts, and it
// drifts by *missing a warning on the one thing that fails silently*.
func (b *JobBoard) Panel() []map[string]any {
	b.mu.Lock()
	jobs := append([]*Job(nil), b.jobs...)
	b.mu.Unlock()

	sort.SliceStable(jobs, func(i, j int) bool {
		left, right := jobs[i].Outstanding(), jobs[j].Outstanding()
		if left != right {
			return left
		}
		return jobs[i].Started < jobs[j].Started
	})

	rows := make([]map[string]any, 0, len(jobs))
	for _, job := range jobs {
		job.mu.Lock()
		var exit any
		if job.exitCode != nil {
			exit = *job.exitCode
		}
		job.mu.Unlock()
		rows = append(rows, map[string]any{
			"id":        job.ID,
			"command":   job.Command,
			"state":     job.State(),
			"seconds":   int(job.Duration()),
			"exit_code": exit,
		})
	}
	return rows
}

// Note is the block appended to the request payload while anything is outstanding.
//
// It never enters the session's messages: it is this run's working memory, and
// writing it into the history would grow the conversation by a paragraph every
// step. It keeps shouting until the result is collected, because until then the
// model genuinely does not know whether the command worked — and the note is the
// only thing standing between it and writing "tests passed" about a command that
// is still running.
func (b *JobBoard) Note() string {
	rows := b.Panel()
	var running, uncollected []string
	for _, row := range rows {
		state, _ := row["state"].(string)
		id, _ := row["id"].(string)
		switch state {
		case JobRunning:
			running = append(running, id)
		case JobUncollected:
			uncollected = append(uncollected, id)
		}
	}
	if len(running) == 0 && len(uncollected) == 0 {
		return ""
	}
	var parts []string
	if len(running) > 0 {
		parts = append(parts, fmt.Sprintf("%d 个在跑", len(running)))
	}
	if len(uncollected) > 0 {
		parts = append(parts, fmt.Sprintf("%d 个结果还没收", len(uncollected)))
	}
	ids := append(append([]string(nil), running...), uncollected...)
	return "## 后台任务\n" +
		strings.Join(parts, "、") + "（" + strings.Join(ids, "、") + "）— 详情用 job_list。\n" +
		"**在收到结果之前不要下结论**：没收到就是还不知道，不要写成成功、也不要当成验证通过。"
}

// Close terminates every running job and removes the output files.
//
// It is idempotent, and it leaves other files in the directory alone: a cleanup
// that deletes more than it made is a cleanup nobody dares run.
func (b *JobBoard) Close() error {
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return nil
	}
	b.closed = true
	jobs := append([]*Job(nil), b.jobs...)
	b.mu.Unlock()

	for _, job := range jobs {
		if job.Running() {
			job.mu.Lock()
			cmd := job.cmd
			job.mu.Unlock()
			// Best effort, and deliberately not reported per job: closing the board is
			// the shutdown path, where the job object's kill-on-close is the next line
			// of defence and a warning per stuck process would bury the exit.
			_ = process.TerminateTree(cmd)
		}
		_ = os.Remove(job.OutputPath)
	}
	return nil
}

func (b *JobBoard) find(jobID string) (*Job, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, job := range b.jobs {
		if job.ID == jobID {
			return job, true
		}
	}
	return nil, false
}

func (b *JobBoard) unknownJob(jobID string) string {
	b.mu.Lock()
	ids := make([]string, 0, len(b.jobs))
	for _, job := range b.jobs {
		ids = append(ids, job.ID)
	}
	b.mu.Unlock()
	if len(ids) == 0 {
		return fmt.Sprintf("没有 id 为 %q 的后台任务 —— 现在一个后台任务都没有。", jobID)
	}
	return fmt.Sprintf("没有 id 为 %q 的后台任务。现有的：%s。", jobID, strings.Join(ids, "、"))
}

// durationText renders 45s / 2m10s / 1h02m. One line for a person, not to the
// millisecond.
func durationText(seconds float64) string {
	total := int(seconds)
	hours := total / 3600
	minutes := (total % 3600) / 60
	secs := total % 60
	switch {
	case hours > 0:
		return fmt.Sprintf("%dh%02dm", hours, minutes)
	case minutes > 0:
		return fmt.Sprintf("%dm%02ds", minutes, secs)
	default:
		return fmt.Sprintf("%ds", secs)
	}
}

func exitCodeText(code *int) string {
	if code == nil {
		return "?"
	}
	return strconv.Itoa(*code)
}

func jobShownPath(full string) string {
	relative, err := filepath.Rel(paths.WorkspaceDir(), full)
	if err != nil || strings.HasPrefix(relative, "..") {
		return full
	}
	return filepath.ToSlash(relative)
}

// NewJobs builds the board and its four tools for one session.
func NewJobs(workspace *tools.Workspace, sessionID string) (*JobBoard, []tools.Tool) {
	board := NewJobBoardForSession(sessionID, nil)

	background := tools.Tool{
		Name: "shell_background",
		Description: fmt.Sprintf(
			"在后台执行一条 shell 命令（%s 语法），**立刻返回**、不等它结束。\n"+
				"**它返回的是「已启动」，不是结果** —— 在你用 job_output 把结果收回来之前，"+
				"这条命令成没成你是不知道的，**绝不要说它成功了**。\n"+
				"什么时候该用：你手上有**不依赖这条命令**的活可以同时干（比如一条要跑几分钟"+
				"的测试，而你还要写别的东西），或者要起一个**不会自己结束**的东西"+
				"（后端服务、watch 任务）—— 后者用 shell 是做不到的，它到点会被掐掉。\n"+
				"只是想让一条命令跑完再继续，就用 shell：后台化会多一次模型往返，"+
				"而你什么也没省下。\n"+
				"它不受文件工具那条路径限制 —— 命令能碰到工作区之外的路径，"+
				"所以每次调用都要人工审批（和 shell 一样）。\n"+
				"- 收结果 job_output、看状态 job_list、收掉它 job_kill\n"+
				"- 同一条命令不要重复后台起（那会跑两遍，而且两边都改同一批文件）\n"+
				"- 它跑着的时候**不要改它当作输入读的文件**（测试、构建、lint 都是这一类）"+
				"—— 那样出来的结果哪个版本都不是。**服务类任务反过来**：改了代码它才会"+
				"重载，那正是你要的\n"+
				"- 要等一个服务「起来了」再往下做，就隔一会儿 job_output(wait=false) 看它的"+
				"日志（比如那行 listening on 3000）\n"+
				"- 前端 + 后端这类组合可以**同时起好几条**，各自收各自的；收尾时 job_list "+
				"核对一遍别落下", shellName()),
		Risk:         security.RiskHigh,
		CommandParam: "command",
		Schema: tools.ObjectSchema(map[string]any{
			"command": tools.StringSchema(fmt.Sprintf("要执行的命令，按 %s 的语法写。它会在后台一直跑，直到它自己结束或被 job_kill 收掉", shellName()), tools.MinLength(1)),
		}, "command"),
		Handler: func(arguments map[string]any) (tools.Result, error) {
			command, _ := arguments["command"].(string)
			return board.Start(command)
		},
	}

	output := tools.Tool{
		Name: "job_output",
		Description: fmt.Sprintf(
			"取一条后台任务的输出。**它结束了才叫结果** —— 还没结束的话，返回的是"+
				"「还在跑」加上一段**部分**输出，那不是结果。\n"+
				"默认会等最多 %d 秒；知道它要跑更久就自己给 wait_seconds（上限 %d）。\n"+
				"看一个不会结束的服务（dev server）跑到哪儿了：wait=false。\n"+
				"输出超过 %d 字符会掐掉中间，头和尾都留着。"+
				"任务被终止过的话，这里会说明它是被谁收掉的 —— 那种输出不能当结论用。",
			DocumentedWaitSeconds, MaxWaitSeconds, MaxOutputChars),
		Risk: security.RiskLow,
		Schema: tools.ObjectSchema(map[string]any{
			"job_id":       tools.StringSchema("shell_background 返回的那个 id", tools.MinLength(1)),
			"wait":         tools.BoolSchema("true（默认）表示它还没结束就等一会儿；false 表示立刻返回**到目前为止**的输出 —— 看一个不会结束的服务（dev server）跑到哪儿了就用 false", tools.Default(true)),
			"wait_seconds": tools.IntSchema(fmt.Sprintf("wait=true 时最多等多少秒（上限 %d）。到点它还没结束，返回的就是「还在跑」加上一段部分输出 —— 那不是结果", MaxWaitSeconds), tools.Default(DocumentedWaitSeconds), tools.Minimum(1), tools.Maximum(MaxWaitSeconds)),
		}, "job_id"),
		Handler: func(arguments map[string]any) (tools.Result, error) {
			id, _ := arguments["job_id"].(string)
			wait, _ := arguments["wait"].(bool)
			seconds, _ := arguments["wait_seconds"].(int)
			return board.Output(id, wait, seconds), nil
		},
	}

	list := tools.Tool{
		Name: "job_list",
		Description: fmt.Sprintf(
			"列出这次会话里起过的后台任务：在跑的有哪些、哪些**已经结束但结果还没收**、"+
				"哪些收过了。\n"+
				"同时留着的任务最多 %d 个、同时最多 %d 个在跑；"+
				"到上限时要先收掉旧的才能起新的。\n"+
				"收尾之前用它核对一遍：标着「结果还没收」的那些，你现在**还不知道**它们成没成。",
			MaxJobs, MaxLiveJobs),
		Risk:   security.RiskLow,
		Schema: tools.EmptySchema(),
		Handler: func(arguments map[string]any) (tools.Result, error) {
			return board.List(), nil
		},
	}

	kill := tools.Tool{
		Name: "job_kill",
		Description: "终止一条后台任务，**整棵进程树一起收**（包括它自己拉起来的子进程）。\n" +
			"只在确定不要那个结果了才用它 —— 它是终止，不是暂停，收掉之后这条命令" +
			"的结果就永远不会有了（要就重新起一条）。\n" +
			"服务、watch 这类不会自己结束的任务，用完就该收掉：它们会一直占着端口和内存，" +
			"而会话结束时也会被收掉。\n" +
			"已经结束的任务不用收，用 job_output 取它的结果。",
		Risk: security.RiskLow,
		Schema: tools.ObjectSchema(map[string]any{
			"job_id": tools.StringSchema("要终止的后台任务 id。整棵进程树都会被收掉（包括它拉起来的子进程）", tools.MinLength(1)),
		}, "job_id"),
		Handler: func(arguments map[string]any) (tools.Result, error) {
			id, _ := arguments["job_id"].(string)
			return board.Kill(id), nil
		},
	}

	return board, []tools.Tool{background, output, list, kill}
}
