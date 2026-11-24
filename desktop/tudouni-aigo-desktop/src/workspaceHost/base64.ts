/**
 * Base64 → bytes, for the host's binary payloads (`term_output`, `term_attach`,
 * `fs_read_bytes`). Terminal output is split at byte offsets that do not respect
 * UTF-8, so it cannot travel as text; the decoder here is deliberately strict
 * about nothing but the alphabet, because a stray newline in a long payload is a
 * transport artefact and not a reason to drop terminal output.
 */
export function decodeBase64(text: string): Uint8Array {
  if (text === '') return new Uint8Array(0);
  const binary = atob(text.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Bytes → base64. Only tests and a future upload path need this direction. */
export function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
