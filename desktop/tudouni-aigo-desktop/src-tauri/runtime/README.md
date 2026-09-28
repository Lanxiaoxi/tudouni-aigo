# The runtime, shipped next to the app

A packaged build puts the runtime here, and the Rust bridge looks for it at
`runtime/tudouni-aigo[.exe]` next to the executable (see `resolve_binary` in
`src/lib.rs`).

The layout has to match what `make release` stages in the repository root,
because the runtime decides "am I in a package root?" by looking for a `prompts`
directory, and a miss is silent — the program starts and `grep` simply
disappears:

```
runtime/
  tudouni-aigo[.exe]        the binary
  prompts/                  system.zh.md, compact.zh.md
  config.example.json
  tools/vendor/rg/<triple>/rg[.exe]
```

`<triple>` is `x86_64-pc-windows-msvc` or `x86_64-unknown-linux-musl` — those
are the only two platforms with a vendored ripgrep, and a platform without one
gets no `grep` tool at all.

To populate this directory:

```bash
# from the repository root
make release
cp -r dist/tudouni-aigo-<version>-<triple>/* desktop/tudouni-aigo-desktop/src-tauri/runtime/
```

For development you do not need to copy anything: set `TUDOUNI_RUNTIME` to an
absolute path and the bridge uses that instead.
