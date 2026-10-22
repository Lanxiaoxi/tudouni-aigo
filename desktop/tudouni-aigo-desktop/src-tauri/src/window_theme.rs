//! The colour the window has before anything is drawn in it.
//!
//! The values are a copy of `--bg` from `src/styles/tokens.css` because they
//! have to be applied before any CSS is parsed; `window_colour_tests` is what
//! keeps the copy honest.




/// The two colours a window can be before anything is drawn in it.
///
/// **These are `--bg` from `src/styles/tokens.css`, and they are duplicated here
/// on purpose.** The pair has to be applied by Rust before the webview has
/// parsed any CSS — that is the entire point, since the moment being covered is
/// the one where no document exists yet — so neither file can be the source for
/// the other. The duplication is the same kind `tauri.conf.json` already accepts
/// for `productName`, and it is pinned by
/// `the_window_colours_match_the_stylesheet` below, which reads the stylesheet
/// out of the source tree and fails if either drifts.
pub(crate) const WINDOW_BG_DARK: (u8, u8, u8) = (0x12, 0x15, 0x1A); // --bg, dark:  #12151A

pub(crate) const WINDOW_BG_LIGHT: (u8, u8, u8) = (0xF1, 0xF5, 0xEF); // --bg, light: #F1F5EF

/// Is the person running Windows in its light app mode?
///
/// **Read from the registry, not from the window, and that is not laziness.**
/// `Window::theme()` is a *getter*: it posts a message to the event loop and
/// blocks until the loop answers. This runs inside `setup`, and tauri creates the
/// configured windows and then calls `setup` **before** the event loop starts —
/// so asking the window here would block forever on a loop that has not begun,
/// turning a 1.6-second launch into a launch that never finishes.
///
/// The key is the one `tao` reads for itself (`dark_mode.rs`,
/// `read_apps_use_light_theme`), so this answer and the window's own cannot
/// disagree: `AppsUseLightTheme` is a DWORD, 1 means light.
fn system_prefers_light() -> bool {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Registry::{
            RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD,
        };

        // UTF-16, NUL-terminated, as the W-suffixed API requires. `\0` is a real
        // NUL here — a doubled backslash would pass the path
        // "…\Personalize\0" and the lookup would fail silently, which is exactly
        // the kind of mistake this comment exists to stop being repeated.
        let subkey: Vec<u16> = "Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize\0"
            .encode_utf16()
            .collect();
        let value: Vec<u16> = "AppsUseLightTheme\0".encode_utf16().collect();

        let mut data: u32 = 0;
        let mut size = std::mem::size_of::<u32>() as u32;
        // SAFETY: both strings are NUL-terminated UTF-16 buffers that outlive the
        // call, and `data`/`size` are a correctly-sized out-parameter pair.
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                subkey.as_ptr(),
                value.as_ptr(),
                RRF_RT_REG_DWORD,
                std::ptr::null_mut(),
                std::ptr::addr_of_mut!(data).cast(),
                &raw mut size,
            )
        };

        // 0 is ERROR_SUCCESS. A missing value is not an error worth reporting:
        // Windows older than the theme setting simply get the dark window, which
        // is this application's default anyway (`data-theme="dark"` in
        // index.html).
        status == 0 && data != 0
    }
    #[cfg(not(windows))]
    {
        // Every other platform hands this to WebKitGTK/AppKit's own default,
        // which is already the window's own colour. The config value below is
        // what applies there.
        false
    }
}

/// Paint the window the right colour, then show it.
///
/// **Why the window starts hidden (`"visible": false` in tauri.conf.json).** The
/// window is shown as soon as it is created — around 560 ms into a launch — but
/// the page inside it does not begin to load until ~1.1 s, and does not paint
/// anything of its own until ~1.9 s. For that whole 1.3 s the person is looking
/// at WebView2's default, which is white: a flash out of a dark application and
/// back, every single launch.
///
/// `backgroundColor` in the config fixes the colour, but it cannot be right for
/// both themes, and getting it wrong is worse than white in the one theme it does
/// not match. So the config carries the dark value — which is what
/// `index.html`'s own `data-theme` default is — and this corrects it to the light
/// value when the OS asks for light, **before** the window is ever shown. The
/// person sees one colour, the correct one, from the first frame.
///
/// Doing it here rather than in the front end is the whole point: the interval
/// being covered is the one before any document exists, so no script of ours can
/// be running yet.
pub(crate) fn show_window_in_its_own_colour(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    // `set_background_color` sets both the window layer and the webview layer
    // (see `WebviewWindow::set_background_color`), which is why one call is
    // enough — a window-background-only fix would leave the webview's own white
    // showing through once it composites.
    if system_prefers_light() {
        let (r, g, b) = WINDOW_BG_LIGHT;
        window.set_background_color(Some(tauri::window::Color(r, g, b, 255)))?;
    }
    // Dark is already what the config says, so there is nothing to correct.
    window.show()
}

#[cfg(test)]
mod window_colour_tests {
    //! The two colours in `WINDOW_BG_DARK` / `WINDOW_BG_LIGHT` are a **copy** of
    //! `--bg` in `src/styles/tokens.css`, and a copy is only safe if something
    //! fails when the original moves.
    //!
    //! That is what this is for. The failure it prevents is invisible in the
    //! ordinary way: change `--bg` to a new shade and the application repaints
    //! correctly everywhere — because everything else reads the variable — while
    //! the 1.3 s before the first paint keeps showing the *old* colour. Nobody
    //! would report that, and no screenshot of a settled window would show it.
    //!
    //! It reads the stylesheet out of the source tree rather than importing it,
    //! because the value is needed by Rust before any CSS has been parsed; the
    //! file is the only place that can be checked from here.

    use super::{WINDOW_BG_DARK, WINDOW_BG_LIGHT};

    /// `--bg` from one theme block of `tokens.css`.
    ///
    /// Reads the block that starts at `selector` and stops at the next `}`, which
    /// is enough for a flat custom-property block and independent of how many
    /// other variables it holds.
    ///
    /// **Every occurrence of the selector is tried, not just the first.** The
    /// stylesheet opens with a bare `:root {` (fonts and scale, no colours), so a
    /// search for `:root` finds a block that legitimately has no `--bg` in it.
    /// Taking the first match and giving up is what made this test fail the first
    /// time it ran — which is the failure it is meant to have.
    fn bg_of(selector: &str) -> Option<(u8, u8, u8)> {
        let css = include_str!("../../src/styles/tokens.css");

        let mut from = 0;
        while let Some(found) = css[from..].find(selector) {
            let start = from + found;
            from = start + selector.len();

            let block = &css[start..];
            let end = block.find('}')?;
            let block = &block[..end];

            // The first `--bg:` inside the block. Anchored on the property name
            // so that `--bg-card`, `--bg-bar` and friends cannot match it.
            for line in block.lines() {
                let line = line.trim();
                let Some(rest) = line.strip_prefix("--bg:") else {
                    continue;
                };
                // Cut at the semicolon **before** looking at whitespace: these
                // declarations carry a trailing `/* … */` comment, and reading
                // the first whitespace-separated token would yield `#12151A;`
                // — eight characters, not a colour, and silently `None`.
                let value = rest.split(';').next()?.trim();
                let hex = value.strip_prefix('#')?;
                if hex.len() != 6 {
                    return None;
                }
                let channel = |index: usize| u8::from_str_radix(&hex[index..index + 2], 16).ok();
                return Some((channel(0)?, channel(2)?, channel(4)?));
            }
        }
        None
    }

    #[test]
    fn the_window_colours_match_the_stylesheet() {
        // The dark block is `:root, :root[data-theme="dark"]` — the default — so
        // its selector is the first `:root`.
        let dark = bg_of(":root, :root[data-theme=\"dark\"]")
            .expect("the dark block should declare --bg, and it should be a 6-digit hex");
        assert_eq!(
            dark, WINDOW_BG_DARK,
            "WINDOW_BG_DARK is out of step with --bg in the dark theme: the window's \
             first frame would paint the old colour"
        );

        let light = bg_of(":root[data-theme=\"light\"]")
            .expect("the light block should declare --bg, and it should be a 6-digit hex");
        assert_eq!(
            light, WINDOW_BG_LIGHT,
            "WINDOW_BG_LIGHT is out of step with --bg in the light theme: the window's \
             first frame would paint the old colour"
        );
    }

    #[test]
    fn the_two_themes_are_actually_different() {
        // If this ever fails, the correction in `show_window_in_its_own_colour`
        // has become a no-op and the whole `visible: false` dance is pointless —
        // a cheaper signal than noticing white-on-white.
        assert_ne!(WINDOW_BG_DARK, WINDOW_BG_LIGHT);
    }
}
