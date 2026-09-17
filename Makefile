# Build and release for tudouni.
#
# One binary, zero runtime dependencies: everything the program needs at run time
# is either compiled in or vendored next to it, so a release is `go build` plus a
# copy. There is no interpreter to install and no virtual environment to get wrong.
#
# The version stamp is written next to the resources rather than compiled in, for
# the same reason the Python build wrote one: the answer to "did I actually install
# the new build?" has to be available to the person who ran the installer, and a
# stamp they can read is better than a number only the maintainer knows.

GO ?= go
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
DIST := dist
STAMP := _version.txt

# Everything that gets cross-compiled. Each entry is GOOS/GOARCH.
TARGETS := \
	windows/amd64 \
	windows/arm64 \
	linux/amd64 \
	linux/arm64 \
	darwin/amd64 \
	darwin/arm64

.PHONY: all build test vet fmt clean release release-assets

all: test build

## build: compile for this machine, writing the version stamp first.
build:
	@printf '%s\n' "$(VERSION)" > $(STAMP)
	$(GO) build -trimpath -o $(DIST)/tudouni$(shell $(GO) env GOEXE) ./cmd/tudouni
	@echo "built $(DIST)/tudouni$(shell $(GO) env GOEXE) $(VERSION)"

## test: run the whole test suite.
test:
	$(GO) test ./...

vet:
	$(GO) vet ./...

fmt:
	gofmt -w cmd internal prompts

## release-assets: cross-compile every target.
#
# CGO is off deliberately: a static binary has no libc to match, which is what
# makes "download it and run it" true on a machine that has nothing installed.
release-assets:
	@printf '%s\n' "$(VERSION)" > $(STAMP)
	@mkdir -p $(DIST)
	@for target in $(TARGETS); do \
		os=$${target%/*}; arch=$${target#*/}; \
		name=tudouni-$$os-$$arch; \
		if [ "$$os" = "windows" ]; then name=$$name.exe; fi; \
		echo "  $$os/$$arch -> $(DIST)/$$name"; \
		GOOS=$$os GOARCH=$$arch CGO_ENABLED=0 $(GO) build -trimpath \
			-o $(DIST)/$$name ./cmd/tudouni || exit 1; \
	done
	@echo "done $(VERSION)"

## release: build every target and zip each one with the files it needs beside it.
#
# The archive carries the four categories that travel with the code. Any of them
# missing produces a program that starts and is quietly missing a feature, which is
# why they are copied explicitly rather than assumed.
release: release-assets
	@for target in $(TARGETS); do \
		os=$${target%/*}; arch=$${target#*/}; \
		name=tudouni-$$os-$$arch; \
		exe=$$name; if [ "$$os" = "windows" ]; then exe=$$name.exe; fi; \
		stage=$(DIST)/$$name; \
		rm -rf $$stage; mkdir -p $$stage; \
		cp $(DIST)/$$exe $$stage/; \
		cp $(STAMP) $$stage/; \
		cp -r prompts protocol config.example.json $$stage/; \
		mkdir -p $$stage/tools/vendor; cp -r tools/vendor/rg $$stage/tools/vendor/; \
		cp README.md $$stage/ 2>/dev/null || true; \
		(cd $(DIST) && zip -qr $$name.zip $$name); \
		rm -rf $$stage; \
		echo "  $(DIST)/$$name.zip"; \
	done

clean:
	rm -rf $(DIST) $(STAMP)
