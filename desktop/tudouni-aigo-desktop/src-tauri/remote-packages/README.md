# The remote install archives, shipped next to the app

A packaged build carries the **packed** release archive for every platform this
project ships, and the Remote Bootstrapper uploads the matching one over SFTP
when somebody opens a workspace on a host that has no Runtime yet (see
`remote_install.rs`, and §8 of the remote-runtime design).

This directory is **build output and is not version-controlled**. `runtime/`
next door holds the *unpacked* build for the machine the app is running on;
this one holds the *packed* archives for machines it might connect **to**, which
is why the two cannot be the same directory:

```
remote-packages/
  tudouni-aigo-<version>-x86_64-unknown-linux-musl.zip
  tudouni-aigo-<version>-x86_64-unknown-linux-musl.zip.sha256
  tudouni-aigo-<version>-x86_64-pc-windows-msvc.zip
  tudouni-aigo-<version>-x86_64-pc-windows-msvc.zip.sha256
```

To populate this directory:

```bash
# from the repository root
make release
# then, from desktop/tudouni-aigo-desktop/
npm run runtime:stage-remote
```

The staging script copies whichever archive matches the repository's `VERSION`
and writes a `.sha256` beside each one. It creates this directory if it is
missing, so a fresh clone needs no setup step.

## Why the archives are committed-adjacent but not committed

Each one is ~9 MB, and they are regenerated whole by every release, so keeping
them in git would add ~19 MB per version to the history and let a checked-in
copy drift from the `VERSION` it claims to be. `tauri.conf.json` lists
`remote-packages/*.zip` as a bundle resource, so a packaged installer **does**
contain them; the repository simply does not.

## Why a host with no Runtime is a normal state

The picker reports whether the Runtime is installed as a **fact** rather than
refusing the host, and the wizard's button reads "Install Runtime and open"
rather than "Open". A fresh account is the ordinary first case, not an error:
the install is what makes the workspace usable, and it happens on the way in.
