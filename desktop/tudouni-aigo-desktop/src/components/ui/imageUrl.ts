import { defaultUrlTransform } from 'react-markdown';

/**
 * The URL rule for a rendered answer.
 *
 * ## Why the default is not enough
 *
 * `react-markdown`'s `defaultUrlTransform` allows only `http(s)`, `ircs`, `mailto`
 * and `xmpp` before the first `:`, and blanks everything else. That is the right
 * default for a link, and it silently destroys the three destinations this
 * renderer needs for a picture:
 *
 * - `data:image/png;base64,…` — how a resolved picture arrives from the bridge;
 * - `blob:…` — how a preview made in this window arrives;
 * - `C:/tmp/out.png` — **a Windows path is read as a scheme**. `C` looks like a
 *   protocol name, so a model writing a perfectly ordinary absolute path gets an
 *   empty string, and the picture would go unreadable for a reason that has
 *   nothing to do with the file. This one is not a nicety: it is the shape the
 *   runtime reports paths in.
 *
 * ## Why it is narrowed to `img`, and only to `img`
 *
 * The transform is called for every URL attribute with the node it belongs to
 * (`urlTransform(value, key, node)`), so this widens the rule **only** where the
 * destination is an image source and leaves every anchor on the default rule.
 * A model-authored `<a href="data:text/html,…">` — the shape that would matter if
 * anything here navigated — still comes out empty, exactly as before.
 *
 * ## What it still refuses
 *
 * `file:` and every other scheme, for images too. A `file:` URL names an
 * absolute path on this machine, which is precisely what the workspace boundary
 * in `inline_image` (Rust) exists to keep out of the render path; allowing it
 * here would render the boundary pointless. The refusal is not silent either:
 * `MarkdownImage` shows the path as text, so the person sees what was named.
 *
 * `data:` is allowed for images only, and checked as an image media type there —
 * this function returns the string and `MarkdownImage` does the media-type check,
 * because the two answers have to agree and one place is where they can.
 */
export function imageUrlTransform(value: string, key: string, node?: { tagName?: string }): string {
  if (key === 'src' && node?.tagName === 'img') {
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase();
    // No scheme: a relative or absolute path, which `MarkdownImage` resolves
    // against the workspace. Passed through untouched — including a Windows
    // drive path, which the default rule would have taken for a protocol.
    if (scheme === undefined) return value;
    if (scheme === 'data' || scheme === 'blob') return value;
    if (scheme === 'http' || scheme === 'https') return value;
    // A refused scheme keeps its text rather than becoming an empty string.
    // Blanking it here is what the default rule does, and it loses the one fact
    // worth showing: *which* path the model named. `MarkdownImage` recognises
    // the `file:` form and refuses it with the path still on screen. Returning
    // the value unchanged cannot make it a loadable source — the component is
    // what turns it into an element, and it never emits a `file:` `src`.
    if (scheme === 'file') return value;
    return '';
  }
  return defaultUrlTransform(value);
}
