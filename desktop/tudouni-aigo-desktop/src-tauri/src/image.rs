//! Turning a workspace file into a `data:` URL, and the two primitives that
//! make it safe: a signature sniff (the bytes decide, never the extension) and
//! base64.
//!
//! `inline_image` reads a local file; `inline_image_remote` reads one over
//! SFTP. Both refuse anything that is not a PNG, JPEG or GIF, because those
//! are the three formats the runtime can measure.

use std::fs;
use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::bridge::Bridge;
use crate::bridge::ChildKey;
use crate::image_stash::sniff_image;
use crate::remote_files;

/// The per-picture ceiling, mirroring `content.MaxImageBytes`
/// (`internal/content/content.go`). The front end checks the same number before
/// it ever sends bytes; this is the second door, and it exists because the first
/// one is in a different process.
pub(crate) const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;

/// The three formats the runtime can measure: the bytes that identify each, the
/// extension to store it under, and the media type to report.
///
/// The signature is what decides, **not** the extension or the type the front end
/// sent. A clipboard entry carries a name and a declared type, and both are
/// claims: a `.png` that is really a JPEG is common (a screenshot tool renaming
/// its output, a file downloaded twice), and a file whose extension disagrees
/// with its bytes is refused downstream with a message about the media type
/// rather than the file. The runtime sniffs with `http.DetectContentType`; this
/// is the same decision from the same evidence.
///
/// The three travel together in one row rather than in three tables, because they
/// are one decision — three parallel lists is how one of them ends up disagreeing
/// with the others.
///
/// WebP is deliberately absent, for the same reason `content.ImageMIMEs` leaves
/// it out: no decoder means no dimensions and no thumbnail, so accepting it here
/// would produce a file that is stashed and then refused.
pub(crate) struct ImageSignature {
    pub(crate) signature: &'static [u8],
    pub(crate) extension: &'static str,
    pub(crate) mime: &'static str,
}

pub(crate) const IMAGE_SIGNATURES: [ImageSignature; 3] = [
    ImageSignature {
        signature: &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
        extension: "png",
        mime: "image/png",
    },
    ImageSignature {
        signature: &[0xff, 0xd8, 0xff],
        extension: "jpg",
        mime: "image/jpeg",
    },
    // `GIF8` covers both GIF87a and GIF89a: they differ in the two bytes after
    // this signature, and both are accepted.
    ImageSignature {
        signature: &[0x47, 0x49, 0x46, 0x38],
        extension: "gif",
        mime: "image/gif",
    },
];

/// One workspace picture, ready to be handed to the WebView as a `data:` URL.
#[derive(Clone, Serialize)]
pub(crate) struct InlineImage {
    /// The picture's bytes, base64-encoded, already carrying its `data:` prefix.
    ///
    /// Returned as a complete URL rather than as raw bytes so the front end can
    /// put the value straight into an `<img src>`. Raw bytes would arrive as a
    /// JSON number array — over 20MB for a five megabyte picture — and the front
    /// end would then have to base64 them itself, which is the same work done
    /// twice in a slower place.
    url: String,
}

/// Ceiling on one inline picture.
///
/// The same number `image_stash` accepts, and for the same reason: it is the
/// runtime's own picture ceiling (`content.InspectImage`), so a picture the
/// runtime would accept is one this can draw. A `data:` URL is a third larger
/// than its bytes once base64 encoding is counted, and it lives in the DOM
/// rather than in a file, so this is also the point past which drawing one is
/// worse for the window than showing its path.
const MAX_INLINE_IMAGE_BYTES: usize = MAX_IMAGE_BYTES;

/// The extensions a workspace path may carry to be drawn inline.
///
/// A **name** check, deliberately, alongside the byte sniff below: the name
/// decides whether to read the file at all, and the bytes decide whether what was
/// read is really a picture. Neither alone is enough — the name is a claim, and
/// sniffing means reading a file whose first bytes would otherwise be discarded.
///
/// **It must agree with `IMAGE_SIGNATURES`, and a test pins that.**
///
/// The list used to carry two extra entries — `webp` and `bmp` — that no signature
/// knows. A `.webp` then passed this check, was read in full, and was refused by
/// the sniff below with "its contents do not match its name": a sentence that is
/// false, about a file whose contents matched its name perfectly. The two lists are
/// kept as a literal plus a test rather than derived in a `const`, because the
/// derivation is less readable than the rule it enforces.
///
/// Visible to `remote_files` rather than re-listed there: the remote door reads
/// through the same two facts, and a second copy is a second place to drift.
pub(crate) const INLINE_IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif"];

/// Read one picture **inside the workspace** and return it as a `data:` URL.
///
/// ## Why this exists
///
/// The runtime has no channel for a picture other than a path in a sentence (see
/// `image_stash`), so a model that generates an image hands back a path. Before
/// this command the chat could only print that path: a WebView cannot load
/// `C:\…\out.png` as an `<img>`, and the CSP deliberately allows no remote image
/// origins. The person was told *where* the picture was instead of being shown
/// it, which is the one thing a chat window is for.
///
/// ## Why through a command and not the `asset:` protocol
///
/// The `asset:` protocol is the obvious answer and it is the wrong one here: its
/// scope is configuration, so the whole permitted surface is a static list of
/// directories decided at build time, and it would have to name the workspace
/// directory of whoever is running — which is not known until they pick one. It
/// also turns **any** model-authored `![](asset://…)` into a read of any path the
/// scope covers, decided by the renderer rather than by this boundary. A command
/// takes the workspace from the bridge and re-checks every path against it, which
/// is the same rule `deliverable_open` applies and for the same reason.
///
/// ## The boundary
///
/// Canonicalize the root and the target, then require the target to stay under
/// the root. `..`, an absolute path, and a symlink pointing out all fail here,
/// because the check is made against the file that is really there rather than
/// against the string. `workspace` arrives from the front end but is only ever
/// the runtime's own `init.workspace` — the relative path's meaning depends on
/// it, so the two have to be the same fact.
///
/// ## What it refuses
///
/// Non-pictures by extension and by bytes, directories, files over the ceiling,
/// and anything outside the workspace. Each refusal is a sentence for a person,
/// because it is drawn next to the picture that did not load.
#[tauri::command]
pub(crate) fn inline_image(workspace: String, path: String) -> Result<InlineImage, String> {
    let relative = path.trim();
    if relative.is_empty() {
        return Err("no picture was named".to_string());
    }
    let root = fs::canonicalize(workspace.trim())
        .map_err(|e| format!("cannot read the workspace directory: {e}"))?;

    // Resolved against the root, and an absolute path is refused rather than
    // joined: `Path::join` with an absolute argument *replaces* the base, which
    // would skip the boundary below by construction.
    let named = Path::new(relative);
    if named.is_absolute() {
        return Err("the picture names a path outside the workspace".to_string());
    }
    let candidate = root.join(named);
    let target = fs::canonicalize(&candidate).map_err(|_| {
        format!("{relative} is not there — the picture may not have been written yet")
    })?;
    if target.strip_prefix(&root).is_err() {
        return Err(format!("{relative} is outside the workspace"));
    }
    if !target.is_file() {
        return Err(format!("{relative} is not a regular file"));
    }

    // The extension decides whether to read at all; see `INLINE_IMAGE_EXTENSIONS`.
    let extension = target
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if !INLINE_IMAGE_EXTENSIONS.contains(&extension.as_str()) {
        return Err(format!(
            "{relative} is not a picture this window can draw (it accepts png, jpg and gif)"
        ));
    }

    let metadata = fs::metadata(&target).map_err(|e| format!("cannot read {relative}: {e}"))?;
    if metadata.len() > MAX_INLINE_IMAGE_BYTES as u64 {
        return Err(format!(
            "{relative} is {} bytes, over the {} byte ceiling for one picture",
            metadata.len(),
            MAX_INLINE_IMAGE_BYTES
        ));
    }

    let bytes = fs::read(&target).map_err(|e| format!("cannot read {relative}: {e}"))?;
    // The bytes are the authority on what this is, never the name. `sniff_image`
    // is the same check `image_stash` applies, so the two cannot accept
    // different formats.
    let known = sniff_image(&bytes).ok_or_else(|| {
        format!("{relative} is not a PNG, JPEG or GIF — its contents do not match its name")
    })?;

    Ok(InlineImage {
        url: format!("data:{};base64,{}", known.mime, base64_encode(&bytes)),
    })
}

/// Base64 encode, for a `data:` URL.
///
/// Hand-written rather than a dependency: this is the whole of what the crate
/// would be used for, and the alphabet has no options to get wrong. The standard
/// `+/` alphabet with `=` padding is what a `data:` URL expects.
///
/// Also the remote picture door's encoder: the two must produce the same
/// `data:` URL for the same bytes, so there is one implementation rather than
/// one per door.
pub(crate) fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[(triple >> 18) as usize & 0x3f] as char);
        out.push(ALPHABET[(triple >> 12) as usize & 0x3f] as char);
        // The final group is padded rather than filled with zero bits, so a
        // decoder can tell a short tail from a real character.
        if chunk.len() > 1 {
            out.push(ALPHABET[(triple >> 6) as usize & 0x3f] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[triple as usize & 0x3f] as char);
        } else {
            out.push('=');
        }
    }
    out
}

/// Read one picture from the session's remote workspace as a `data:` URL —
/// the remote twin of `inline_image`, which for the same reason cannot reach
/// a file on the far host (its boundary is a local `canonicalize`).
///
/// Named by the child's key for the same reason `deliverable_download` is:
/// the workspace and the connection are facts the child carries, and
/// neither may arrive from the caller. The extension check, the ceiling and
/// the byte sniff are the local door's own, read from the same constants, so
/// a picture accepted by one door is accepted by the other.
#[tauri::command]
pub(crate) fn inline_image_remote(
    app: AppHandle,
    key: ChildKey,
    path: String,
) -> Result<InlineImage, String> {
    let relative = path.trim().to_string();
    if relative.is_empty() {
        return Err("no picture was named".to_string());
    }
    // The extension decides whether to read at all; see `INLINE_IMAGE_EXTENSIONS`.
    // `rsplit_once` plus a non-empty stem rather than a bare last-segment, so a
    // name that is *only* a dot and an extension (`.png`) names no file and is
    // refused rather than read — the same answer `Path::extension` gives.
    let name = remote_files::file_name_of(&relative);
    let extension = name
        .rsplit_once('.')
        .filter(|(stem, _)| !stem.is_empty())
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .unwrap_or_default();
    if !INLINE_IMAGE_EXTENSIONS.contains(&extension.as_str()) {
        return Err(format!(
            "{relative} is not a picture this window can draw (it accepts png, jpg and gif)"
        ));
    }

    let (workspace, target) = {
        let state: State<Bridge> = app.state();
        let guard = state.inner.lock().map_err(|_| "the bridge lock is poisoned")?;
        let current = guard
            .children
            .get(&key)
            .ok_or("that session's runtime is not running, so there is no picture to read")?;
        let (workspace, ssh) = match (current.remote_workspace.clone(), current.remote_ssh.clone()) {
            (Some(workspace), Some(ssh)) => (workspace, ssh),
            _ => return Err("that session's workspace is local; read it with the ordinary door".to_string()),
        };
        (workspace, ssh.to_target())
    };

    let bytes = remote_files::read_image(&target, &workspace, &relative, MAX_INLINE_IMAGE_BYTES)?;
    // The bytes are the authority on what this is, never the name: the same
    // check the local door applies, so the two cannot accept different
    // formats.
    let known = sniff_image(&bytes).ok_or_else(|| {
        format!("{relative} is not a PNG, JPEG or GIF — its contents do not match its name")
    })?;

    Ok(InlineImage {
        url: format!("data:{};base64,{}", known.mime, base64_encode(&bytes)),
    })
}

#[cfg(test)]
mod inline_image_tests {
    //! The half of `inline_image` that is testable without a Tauri app: the
    //! encoding, and the boundary arithmetic the command applies.
    //!
    //! The command itself needs an `AppHandle`, so it is not called here; what is
    //! pinned is that its two building blocks are right, because both are the kind
    //! of code that fails silently — a base64 off-by-one produces a picture that
    //! decodes to garbage, and a boundary check that lets a `..` through produces
    //! no symptom at all until it matters.

    use super::{base64_encode, INLINE_IMAGE_EXTENSIONS};

    #[test]
    fn base64_matches_the_standard_alphabet_and_padding() {
        // Reference values produced by an independent implementation, because the
        // failure mode here is a wrong character rather than a crash.
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"a"), "YQ==");
        assert_eq!(base64_encode(b"ab"), "YWI=");
        assert_eq!(base64_encode(b"hello"), "aGVsbG8=");
        assert_eq!(base64_encode(&[0, 1, 2, 253, 254, 255]), "AAEC/f7/");
    }

    #[test]
    fn base64_produces_exactly_four_characters_per_three_bytes() {
        // The property that matters for a `data:` URL: a decoder must see whole
        // quanta, so the length is always a multiple of four.
        for length in 0..64usize {
            let bytes: Vec<u8> = (0..length).map(|index| index as u8).collect();
            assert_eq!(
                base64_encode(&bytes).len() % 4,
                0,
                "length {length} did not encode to whole quanta"
            );
        }
    }

    #[test]
    fn the_accepted_extensions_are_exactly_the_ones_a_signature_knows() {
        // The invariant that was violated once: a name this accepts whose bytes the
        // sniff cannot vouch for is read in full and then refused with a message
        // that blames the file ("contents do not match its name") for a limit that
        // is really ours.
        //
        // JPEG is the one alias: a signature declares its canonical extension
        // (`jpg`), and `.jpeg` is the same format spelled the long way. The alias
        // table below is the whole of the extra spelling, so a second one cannot be
        // added here without naming it — which is the point.
        const ALIASES: &[(&str, &str)] = &[("jpeg", "jpg")];

        for signature in super::IMAGE_SIGNATURES.iter() {
            assert!(
                INLINE_IMAGE_EXTENSIONS.contains(&signature.extension),
                "{} is a known signature but is not an accepted extension",
                signature.extension
            );
        }
        for extension in INLINE_IMAGE_EXTENSIONS {
            let canonical = ALIASES
                .iter()
                .find(|(alias, _)| alias == extension)
                .map(|(_, canonical)| *canonical)
                .unwrap_or(extension);
            assert!(
                super::IMAGE_SIGNATURES
                    .iter()
                    .any(|signature| signature.extension == canonical),
                "{extension} is accepted by name but no signature knows it, so the \
                 sniff can only refuse it"
            );
        }
    }

    #[test]
    fn the_formats_the_runtime_cannot_measure_are_not_accepted() {
        // `content.ImageMIMEs` has no decoder for these, so the runtime would stash
        // one and then refuse it. Accepting the name here would only move the
        // refusal later and make it look like a rendering bug.
        for extension in ["webp", "bmp", "svg", "html", "txt", "exe"] {
            assert!(
                !INLINE_IMAGE_EXTENSIONS.contains(&extension),
                "{extension} must not be accepted"
            );
        }
    }
}
