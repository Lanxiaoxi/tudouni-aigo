# Build and release for tudouni.
#
# One binary, zero runtime dependencies: everything the program needs at run time
# is either compiled in or vendored next to it, so a release is a build plus a
# copy. There is no interpreter to install and no virtual environment to get wrong.
#
# **Every recipe goes through the Go tool, not through shell utilities.** That is
# not indirection for its own sake: `mkdir -p`, `rm -rf` and `$(shell cat ...)` are
# POSIX, this repository is developed on Windows, and a Makefile that works in Git
# Bash but dies in cmd is a Makefile whose commands nobody can remember the
# PowerShell equivalent of. `go run ./tools/release` runs in any shell, and it is
# also the one place that knows how a binary gets built with its version in it.
#
# The version is **compiled into the binary** with -ldflags. It is not a file next
# to it, because a file can be newer than the binary it describes: replacing the
# executable has silently failed before, the old binary went on reporting the new
# version, and the one question `--version` exists to answer was answered wrongly.

GO ?= go

.PHONY: all build test vet fmt release clean

all: test build

## build: compile for this machine, with the version compiled in.
build:
	$(GO) run ./tools/release --local

## test: run the whole test suite.
test:
	$(GO) test ./...

vet:
	$(GO) vet ./...

fmt:
	$(GO) fmt ./...

## release: build, verify and archive every shipped platform.
#
# It is a Go program rather than a shell loop because the packaging step has to do
# things a shell does badly: open the archive it just wrote and check what is in
# it, run the binary, and read the runtime's startup notices to confirm the
# vendored ripgrep was found. See tools/release.
release:
	$(GO) run ./tools/release

clean:
	$(GO) run ./tools/release --clean
