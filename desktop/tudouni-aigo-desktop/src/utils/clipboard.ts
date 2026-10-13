/**
 * Copy plain text to the clipboard, with a fallback for webviews.
 *
 * `navigator.clipboard.writeText` is the first choice, but Tauri webviews expose
 * it only when the page holds the `user-select: text` permission, which this
 * build does not — so the primary path can refuse from a user gesture. The
 * fallback writes through a throwaway selection: `execCommand('copy')` copies
 * the *selection*, so the text is staged into a hidden textarea and selected
 * first; a bare call would copy whatever the user happened to have selected —
 * or nothing at all.
 *
 * Shared by every copy affordance in the transcript (code blocks, the user
 * bubble) so the fallback stays in one place rather than a copy per button.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(area);
      return ok;
    } catch {
      return false;
    }
  }
}
