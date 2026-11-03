# tools/vendor/anymd

The document extractor behind the `read_document` tool (`internal/tools/builtin/document.go`).
Design and the reasons for every rewrite it does: `docs/design/read-document.md`.

```
tools/vendor/anymd/
  LICENSE-MIT                        upstream licence (MIT)
  x86_64-pc-windows-msvc/anymd.exe   the only build; there is deliberately no Linux entry
```

## Windows only, on purpose

`read_document` is not offered on Linux. A remote workspace runs the **Linux** runtime on the far
host, so the tool is absent there too, and the Linux release archive does not carry this binary.
`release.Target.HasAnymd` is the single place that says which targets ship it; the registry gate
(`builtin.AnymdBinary`) and the packaging check both follow it.

## Pin

| | |
| --- | --- |
| upstream | https://github.com/SylphxAI/anymd (MIT) |
| version | 8.5.7 (commit `7a848cca7608f52ae002a890762f385c3928f1ef`) |
| source | npm `@sylphx/anymd-win32-x64-msvc@8.5.7`, file `package/anymd.exe` |
| size | 28,422,144 bytes |
| SHA-256 | `23660c8e222be1707ce8bb62c063b56e116657ba026c5b10713f8073cd515036` (matches the package's `identity.json`) |

The version is also written in `internal/tools/builtin/document.go` (`anymdPinnedVersion`); the
two must move together. Upgrading means: replace the binary, re-run the acceptance samples listed
in the design doc, then the full `make test`.
