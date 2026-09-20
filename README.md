# tudouni-aigo

An agent runtime for the terminal. One static binary, no interpreter, no virtual
environment, no `_internal/` directory.

```
tudouni-aigo                  the full-screen interface (the default on a terminal)
tudouni-aigo --cli            the line-oriented REPL
tudouni-aigo --runtime-stdio  the JSONL protocol endpoint a front end starts as a child
tudouni-aigo --audit …        the read-only subcommands
```

The interface is chosen by the terminal rather than by a flag. A bare invocation gets
the full-screen interface when both stdin and stdout are a terminal, and the line REPL
when they are not: `tudouni-aigo > chat.txt`, `echo hi | tudouni-aigo` and a CI job all
take the second path, because a full-screen program on a pipe either fails to start or
writes escape sequences into the redirected file. `--cli` asks for the REPL anyway, and
`--tui` forces the interface back — which is what every note written before this
default changed already says.

The installer also leaves a second name, `tudouni`, pointing at the same binary: the
command was renamed, and a rename should not silently turn old notes and scripts into
"command not found".

`tudouni-aigo --version` answers which build this is; `--help` lists the rest, including
`--session`, `--list`, `--skills`, `--history`, `--autopilot`, `--theme`,
`--quiet`, `--stream`/`--no-stream`, `--debug` and `--max-steps`.

The program is meant to be started inside a project directory, and it refuses to
start in your home directory or at a filesystem root: the workspace is what the
model's file tools may touch, and `read_file` needs no approval, so a workspace
that is "everything below here" would hand over `.ssh` and other projects' `.env`
files without anybody being asked twice.

The interface text is English; the system prompt is Chinese and stays Chinese, no
matter what the interface speaks — changing what the interface says must not change
what the model is told.

## Getting a model

Configuration lives in one file: `~/.tudouni/config.json`. There is exactly one
source — no environment variables, no `.env` — because a value that can be set in
two places and only takes effect from one of them is the hardest kind of problem
to find.

```jsonc
{
  "providers": {
    "deepseek": {
      "base_url": "https://api.deepseek.com",
      "api_key": "sk-…",
      "models": [
        {"id": "deepseek-flash", "context_window": 1000000},
        {"id": "deepseek-v4-pro", "context_window": 1000000}
      ]
    }
  },
  "web": {
    "tavily_api_key": ""
  }
}
```

The key is the route name and the order is the `/model` list order, so **which
route is the default is something you arranged**: the first route with a key wins.
Omit `context_window` and the interface reports usage without a percentage — a
wrong percentage is worse than none, because it gets believed. Fill in the `web`
key and `web_search` is registered; leave it out and the tool is simply absent from
the schema rather than present and forever failing.

### Endpoints that are not plain OpenAI

Most gateways speak the chat completions shape and need nothing extra. Two other
protocols are supported, and a route is put on one by its `base_url` — ending it in
`/messages`, `/v1/messages` or `/anthropic` selects the Messages shape, `/responses`
selects the Responses shape, and anything else is chat completions:

```jsonc
{
  "providers": {
    "qwen": {
      "base_url": "https://{workspace}.ap-southeast-1.maas.aliyuncs.com/apps/anthropic",
      "api_key": "sk-…",
      "models": [{"id": "qwen3-max", "context_window": 200000}]
    },
    "vendor-required-headers": {
      "base_url": "https://gateway.example",
      "api_key": "sk-…",
      "headers": {
        "User-Agent": "my-agent/1.0",
        "x-vendor-session": "${session}"
      },
      "models": [{"id": "some-model", "context_window": 200000}]
    }
  }
}
```

`api_style` (`openai` / `anthropic` / `responses`) overrides that inference; write it
only when a base URL is genuinely ambiguous — the case it exists for is one gateway
serving several protocols under one host, where every route's `base_url` looks the
same. Nothing else is adjusted for you: if the endpoint is reached at
`/v1/messages`, `base_url` must not already end in `/v1`, or the path comes out
`/v1/v1/messages`.

`headers` are the escape hatch for a vendor that demands its own client
identification. They are sent on every request to that route and cannot displace the
headers the program sets itself. The value `${session}` is replaced by the current
session id, which is what a gateway asking for a per-conversation identifier wants;
a header whose value comes out empty is not sent at all.

**Where the credential goes is the protocol's decision, not yours.** Chat completions
and the Responses shape take `Authorization: Bearer <key>`; the Messages shape takes
`x-api-key: <key>`. Writing the bearer token by hand for a Messages endpoint is the
one thing here that fails in a way that names the wrong cause — the endpoint answers
"Missing API key" while the key is sitting in the request.

Three tools check a configuration without starting a session. They answer three
different questions, which is why there are three:

```sh
go run ./tools/checkconfig ~/.tudouni/config.json
go run ./tools/probeconfig ~/.tudouni/config.json my-session-id [route]
go run ./tools/probereachable ~/.tudouni/config.json my-session-id [model...]
```

`checkconfig` reads the file through the same catalogue reader the program uses and
prints what each route resolved to, including the endpoint it will actually POST to.
It sends nothing, so it costs nothing, and it is the one to run after editing by
hand.

`probeconfig` sends one small request per route — non-streamed and streamed — through
the same code path a session uses. It is the only way to tell a wrong request shape
from a wrong key before a real session does it for you. An empty `api_style`, an
inferred protocol and a header the configuration declared but nothing substituted are
all visible here and nowhere else.

`probereachable` asks **every** model in the file whether it answers, with no model
names, or only the ones named. A catalogue entry is a claim, not a fact: a model can
be listed by the vendor and still be refused for this account, for this region, or
for a plan that does not include it. It separates the three outcomes that matter —
answered, refused by the endpoint, and never reached — because they call for
completely different actions. Pass model names to re-check only what changed; a
region-restricted model will refuse every time, and there is no reason to pay for
that answer twice.

`probeconfig` and `probereachable` spend quota.

The program creates this file for you the first time it finds no usable route, and
tells you where it put it. `config.example.json` in this repository is only the
template it copies.

## Building

```
make build            # for this machine, with the version compiled in
make test             # the whole suite
make release          # build, verify and archive every shipped platform
```

`CGO_ENABLED=0` throughout: a static binary has no libc to match, which is what
makes "unpack it and run it" true.

The version is **compiled into the binary** with `-ldflags`. It is not a file next
to it, because a file can be newer than the binary it describes — replacing the
executable has silently failed before, the old binary went on reporting the new
version, and the one question `--version` exists to answer was answered wrongly.
The string comes from `VERSION`, or `$TUDOUNI_VERSION`, or `git describe`.

On some sandboxed machines `go test ./...` exits without printing anything even
though the tests pass. `bash test.sh` compiles each package's test binary and runs
it directly; the conclusion is the same.

### Releasing

`make release` runs `tools/release`, which for each platform builds the binary,
stages what has to sit beside it, **verifies the result**, and writes
`dist/tudouni-aigo-<version>-<triple>.zip`. The archive is the whole download: unpack
it, run `install.ps1` / `install.sh`, done.

Two platforms ship, both x86_64: the ones with a vendored ripgrep is exactly the
ones that can ship, because a package without it produces a program whose `grep`
tool is silently missing. Adding a platform means vendoring its ripgrep first.

The verification is the point, not a formality. A release package's characteristic
failure is not "it will not start" — it is "it starts and one feature is quietly
absent", and that is invisible in the source tree where the tests run. So the
release step re-opens the archive it just wrote, checks what landed in it, runs
the binary (`--help`, `--version`, `--runtime-stdio`), and reads the runtime's
startup notices to confirm the vendored ripgrep was found. It also checks the
installers' storage form: `install.ps1` must carry a UTF-8 BOM (without one,
PowerShell 5.1 mis-decodes it and fails to parse) and `install.sh` must be LF and
BOM-free (otherwise the kernel cannot find its interpreter).

## What travels with the code

Four categories of file ship beside the binary, and a missing one does not produce
an error — it produces a program that starts and is quietly missing a feature:

| | what breaks without it |
|---|---|
| `prompts/` | there is no system prompt to send |
| `config.example.json` | a new user has no template to fill in |
| `protocol/schema/` | other front ends have no shape to code against |
| `tools/vendor/rg/` | `grep` is not registered (text search falls back to `shell`, which asks for approval every time) |

`prompts/` and `config.example.json` are compiled in with `go:embed`, so a `go
build` output already carries them. The ripgrep builds stay on disk because they
are executables that get run. `config.example.json` also **ships as a file** next
to the binary: its bytes being compiled in is what keeps the first-run message
from naming a file that is not there, and the copy on disk is what a person
actually opens. The protocol schema is compiled in by nothing — it has no reader
inside this program; `internal/protocol`'s conformance test checks the messages it
sends against the file field by field, because this program is both sender and
receiver and a key it forgot to send would otherwise be noticed by whoever writes
the next front end. `tools/release` checks for the other three in the staged tree,
and `internal/paths/paths_test.go` covers all four.

`prompts/` is on that list for a second reason worth knowing: its **presence** is
how the program recognises its own directory (`paths.PackageDir`), and the vendored
ripgrep is then looked up relative to that directory. So a package that carries the
binary and `tools/` but not `prompts/` resolves its root to the working directory
instead, does not find ripgrep, and drops `grep` — with one line on stderr to say
so. `tools/release` checks for the directory rather than assuming it.

## The tools, and the four rules they are built on

`read_file`, `write_file`, `edit_file`, `list_files`, `shell`, `grep`,
`get_current_time`, `ask_user`, `todo_write`; `shell_background`, `job_output`,
`job_list`, `job_kill` for work that outlives one step; `web_search` and
`fetch_web`; `load_skill`; and `subagent`, which hands a self-contained task to a
fresh agent. The registry sorts by name, so the schema the model sees is stable
between runs and a diff of two sessions means something.

A tool is **absent from the schema, never present and broken**. `grep` without a
vendored ripgrep for the platform, `web_search` without a key, `load_skill` in a
workspace with no skills — each one is left out and the startup notice says why.
A tool the model can see but that can only answer "not configured" costs a round
trip every time it is tried, and teaches it that tools lie.

**A tool declares its own risk** (low/medium/high) and the registry refuses to
build without one, because a missing level would silently land on low. Only low
risk may be marked parallel-safe: a parallel batch does not prompt. A tool that
asks a person can never run in one at all — hence the two separate flags.

**Approval is fail-closed.** Every medium and high call stops and asks. What you
answer with "always" is remembered in the workspace's `.tudouni/permissions.json`
— a reviewable file you can commit for a team — and that file can only ever
remember an *allowance*: refusals are the policy's job, and two places answering
"is this refused" would eventually disagree. `--autopilot` asks nobody and records
`outcome=autopilot` for every call it released, so "was anybody watching during
this run" has one answer in the audit rather than being inferred.

**A delegated subagent cannot ask for approval.** It runs on the parent's registry
with the delegation tools removed, and anything it is not allowed to do on its own
is refused rather than forwarded — otherwise "delegate" would be a way around the
approval prompt. Its whole transcript is saved as its own session beside the
parent's, and the session list hides those, because they are not sessions a person
resumes.

## Skills and MCP

A skill is a directory with a `SKILL.md` in it, and the frontmatter's description
is the only thing the model sees until it loads the skill — so that one line
decides whether the skill is ever used. Directories are scanned lowest priority
first:

```
~/.skills                       ~/<workspace>/.skills
~/.agents/skills                <workspace>/.agents/skills
~/.tudouni/skills               <workspace>/.tudouni/skills
```

The first two of each group are shared with other tools; the personal level beats
the project level, the same way git config does. `--skills` prints the ones that
were recognised **and the ones that were skipped, with their file and fault** —
a malformed frontmatter block produces no symptom anywhere else, because the skill
is simply absent from the list the model is given.

MCP servers are configured in `~/.tudouni/mcp.json` and nothing else. It is
user-level on purpose, and that is a security boundary rather than a convenience:
`command` in that file is code executed at start-up, and a workspace-level list
would mean cloning a repository is enough to run something. A workspace
`.tudouni/mcp.json` is ignored, and says so on stderr rather than silently.

## Sessions, context, and the audit

A session is a JSONL file under the workspace's `.tudouni/sessions/`, so each
directory has its own history: what you did in project A is not visible from
project B. `--list` and the TUI's `/resume` read the same store. The long-running
goal of a session lives in the same file, which is why "which session still has
work left in it" is a fact you get by reading one file.

Old context is not thrown away, it is **moved**: a large tool result becomes an
artifact under `.tudouni/artifacts/<session>/` and the message keeps a reference —
size, source, line count — that `--history` resolves by reading the index rather
than the body. An artifact index that cannot be read degrades to one sentence
instead of failing, because `--history` is a troubleshooting command.

Every turn re-states cumulative usage, this turn's duration and the context
figure; `--audit` adds the summary block (model calls, tokens, cache hit rate,
tool outcomes, the timing breakdown, stop reasons). The audit log is a second
append-only file, one line per event, and the protocol forwards those same lines
unchanged — which is what makes "the audit log is the protocol" true at the byte
level.

## Layout

```
cmd/tudouni/          the entry point and its four jobs
internal/protocol/    the JSONL contract: codec, server, client, transport
internal/runtime/     assembly: config, permissions, notices, the runtime itself
internal/agent/       the loop: model call, tools, model call, until answered
internal/model/       the one place that knows what a completion looks like
internal/tools/       the tool framework, the workspace boundary, the builtins
internal/security/    policy, gate, command rules, the approval memory
internal/state/       session store, model catalogue, counters, goals
internal/context/     budget, degradation, compaction, the artifact store
internal/skills/      finding and parsing the workspace's procedures
internal/mcp/         mounting external tool servers
internal/subagent/    delegation: the child registry, the board, the depth rule
internal/audit/       the append-only trail, and its viewer
internal/frontends/   tui, cli, ansi
```

Three layers, and the arrows only point one way: a front end talks to the protocol
and never to the runtime's internals; the runtime talks to the protocol through an
interface and does not know who is on the other end.

## Two things worth knowing before reading the code

**The session file is append-only.** A turn appends the messages it produced and
nothing is ever rewritten, so the cost of saving a turn is the size of that turn
rather than the size of the conversation.

**One invariant is not negotiable.** An assistant message carrying `tool_calls`
must be followed by a tool result for every one of those ids. Break it and the
session can never be sent again: the endpoint answers 400 for every later turn, and
the error reads like "the context is too long". So the session is only written down
between whole steps, which is also why `interrupt` stops *between* steps and why
`shutdown` waits for the current turn instead of cutting it off.

## Protocol

`protocol/schema/*.schema.json` is the shape. `docs/protocol.md` is the semantic
reference, inherited from the Python project this was rewritten from — it answers
what a schema cannot: when a message is sent, what to do on receipt, what a client
is not allowed to decide for itself. Note that it describes the *original* wire
semantics, so where it and the schema disagree, the schema and the conformance
test are what this program actually does.

The short version: stdin/stdout, one JSON object per line, UTF-8, flushed per
line. The envelope version (`v`) is the one place either end fails hard; an unknown
message kind is ignored and the loop keeps going, because the two ends upgrade on
their own schedules. A front end that is not the TUI is the reason `--runtime-stdio`
is a documented entry point rather than an implementation detail: it is the same
process a web front end or a test harness would start.
