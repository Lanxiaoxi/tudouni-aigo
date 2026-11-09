/**
 * Ticket attachments: the pure half.
 *
 * The bytes live in `~/.tudouni/tickets/attachments/<ticketId>/` (the authority,
 * copied when attached) and are staged into
 * `<workspace>/.tudouni/ticket-attachments/<ticketId>/` at every Start — see
 * `src-tauri/src/ticket_attachments.rs`. This module only formats what the
 * person and the agent are told.
 */
import type { StagedTicketAttachment } from '@/runtime/tauri';

/** Where staged copies land, mirrored from `STAGE_DIR` in the Rust module. */
export const TICKET_STAGE_DIR = '.tudouni/ticket-attachments';

/** `1.2 MB`, `830 KB`, `12 B`: the size a chip shows. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The paragraph appended to the first message when the runtime is older than
 * protocol 19 and cannot carry the attachments on `ticket_bind`. From 19 on the
 * runtime's own payload tail lists them every turn, so this is not sent.
 *
 * English, like every other sentence written for the model; the paths are
 * workspace-relative so `read_file` resolves them inside `SafePath`.
 */
export function attachmentLines(staged: readonly StagedTicketAttachment[]): string {
  const lines = staged.map((item) => `- ${item.name}: ${item.path} (${item.bytes} bytes)`);
  return [
    'Attached files (already copied into this workspace; read them with read_file, and read large logs in ranges or grep them):',
    ...lines,
  ].join('\n');
}
