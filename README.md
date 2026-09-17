# tudouni

An agent runtime for the terminal. One static binary, no interpreter, no virtual
environment, no `_internal/` directory.

```
tudouni                 the line-oriented REPL
tudouni --tui           the full-screen interface
tudouni --runtime-stdio the JSONL protocol endpoint a front end starts as a child
tudouni --audit …       the read-only subcommands
```

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
  }
}
```

The key is the route name and the order is the `/model` list order, so **which
route is the default is something you arranged**: the first route with a key wins.
Omit `context_window` and the interface reports usage without a percentage — a
wrong percentage is worse than none, because it gets believed.

The program creates this file for you the first time it finds no usable route, and
tells you where it put it.

## Building

```
make build            # for this machine
make test             # the whole suite
make release-assets   # cross-compile every supported target
make release          # …and zip each one with the files it needs beside it
```

`CGO_ENABLED=0` throughout: a static binary has no libc to match, which is what
makes "unpack it and run it" true.

## What travels with the code

Four categories of file ship beside the binary, and a missing one does not produce
an error — it produces a program that starts and is quietly missing a feature:

| | what breaks without it |
|---|---|
| `prompts/` | there is no system prompt to send |
| `config.example.json` | a new user has no template to fill in |
| `protocol/schema/` | other front ends have no shape to code against |
| `tools/vendor/rg/` | `grep` is not registered (text search falls back to `shell`, which asks for approval every time) |

`prompts/`, `protocol/schema/` and `config.example.json` are compiled in, so a
`go build` output already carries them. The ripgrep builds stay on disk because
they are executables that get run, and a test covering all four lives in
`internal/paths/paths_test.go`.

## Layout

```
cmd/tudouni/          the entry point and its four jobs
internal/protocol/    the JSONL contract: codec, server, client, transport
internal/runtime/     assembly: config, permissions, the runtime itself
internal/agent/       the loop: model call, tools, model call, until answered
internal/model/       the one place that knows what a completion looks like
internal/tools/       the tool framework, the workspace boundary, the builtins
internal/security/    policy, gate, command rules, the approval memory
internal/state/       session store, model catalogue, counters, AGENT.md
internal/audit/       the append-only trail, and its viewer
internal/frontends/   tui, cli
```

Three layers, and the arrows only point one way: a front end talks to the protocol
and never to the runtime's internals; the runtime talks to the protocol through an
interface and does not know who is on the other end.

## Two things worth knowing before reading the code

**The session file is append-only.** A turn appends the messages it produced and
nothing is ever rewritten, so the cost of saving a turn is the size of that turn
rather than the size of the conversation. The audit log is a second append-only
file, one line per event, and the protocol forwards those same lines unchanged —
which is what makes "the audit log is the protocol" true at the byte level.

**One invariant is not negotiable.** An assistant message carrying `tool_calls`
must be followed by a tool result for every one of those ids. Break it and the
session can never be sent again: the endpoint answers 400 for every later turn, and
the error reads like "the context is too long". So the session is only written down
between whole steps, which is also why `interrupt` stops *between* steps and why
`shutdown` waits for the current turn instead of cutting it off.

## Protocol

`doc/protocol.md` in the project this was rewritten from is the semantic reference;
`protocol/schema/*.schema.json` is the shape. The short version: stdin/stdout,
one JSON object per line, UTF-8, flushed per line. The envelope version (`v`) is
the one place either end fails hard; an unknown message kind is ignored and the
loop keeps going, because the two ends upgrade on their own schedules.
