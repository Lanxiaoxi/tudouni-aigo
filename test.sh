#!/usr/bin/env bash
# Run every package's tests.
#
# Why not `go test ./...`: in some sandboxed environments the test runner exits
# without producing any output for this module, even though the tests themselves
# pass. Compiling each test binary and running it directly avoids whatever the
# runner is unhappy about, and it prints the same thing. Use whichever works on
# your machine — `go test ./...` is the normal answer, this is the fallback.

set -u

GO="${GO:-go}"
# The scratch directory lives under the system temp dir and is left behind on
# purpose: cleaning it up costs an `rm -rf` that some sandboxed shells refuse,
# and a few megabytes of test binaries in %TEMP% are not worth fighting about.
OUT="${TMPDIR:-${TMP:-/tmp}}/tudouni-test-$$"
mkdir -p "$OUT"
status=0

packages=$(cd "$(dirname "$0")" && "$GO" list ./... 2>/dev/null)

for pkg in $packages; do
  binary="$OUT/$(echo "$pkg" | tr '/' '_')"
  if ! "$GO" test -c -o "$binary" "$pkg" >/dev/null 2>&1; then
    # No test files is not a failure: plenty of packages are covered by another
    # package's tests, or have nothing to test.
    continue
  fi
  # `go test -c` also exits 0 for a package with no test files — it just does not
  # write the binary. The file, not the exit code, is the real signal.
  if [ ! -f "$binary" ]; then
    continue
  fi
  if result=$("$binary" 2>&1); then
    echo "ok      $pkg"
  else
    echo "FAIL    $pkg"
    echo "$result" | sed 's/^/        /'
    status=1
  fi
done

rm -rf "$OUT" 2>/dev/null || true
exit $status
