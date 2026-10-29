import type { FrontMessage } from '@/state/entries';
import type { Translate } from '@/i18n';

/**
 * One sentence this front end is saying, as words.
 *
 * A function with an exhaustive `switch` and no `default`, like
 * `Composer.tsx`'s `noticeText`: a new code has to be given a sentence, and the
 * exhaustiveness check is what enforces that rather than a fallback that would
 * print an empty row.
 *
 * Pure (it takes the translator) and kept out of `EntryView` so the sentences
 * can be asserted without a renderer. The distinction it exists for is in
 * `FrontMessage`'s own doc: `text` is the runtime's verbatim sentence, this is
 * the window's.
 */
export function frontMessageText(t: Translate, message: FrontMessage): string {
  switch (message.code) {
    case 'terminalEnded':
      // The three endings stay three sentences. `killed` is not "exited with
      // code null": a killed shell did not choose an exit status, so printing a
      // number for it would invent one.
      if (message.reason === 'killed') return t('note.term.endedKilled', { id: message.id });
      if (message.exitCode === null) return t('note.term.ended', { id: message.id });
      return t('note.term.endedCode', { id: message.id, code: message.exitCode });
    case 'terminalDetached':
      return t('note.term.detached', { id: message.id });
    case 'refineApplied':
      // Zero is the honest outcome of an answer that named nothing
      // recognisable, and it gets its own sentence: "1 applied" with zero
      // chosen would be a report the transcript contradicts.
      if (message.applied === 0) return t('note.refine.appliedNone');
      return t('note.refine.applied', { n: message.applied });
    case 'contextDegraded': {
      const detail = [
        message.items === null ? '' : t('note.context.items', { n: message.items }),
        message.estimated === null || message.limit === null
          ? ''
          : t('note.context.tokens', { from: message.estimated, to: message.limit }),
        message.changes.join(', '),
      ]
        .filter((part) => part !== '')
        .join(' · ');
      return detail === ''
        ? t('note.context.degraded')
        : t('note.context.degradedDetail', { detail });
    }
    case 'contextCompacted': {
      const detail = [
        message.folded === null ? '' : t('note.context.folded', { n: message.folded }),
        message.before === null || message.after === null
          ? ''
          : t('note.context.tokens', { from: message.before, to: message.after }),
      ]
        .filter((part) => part !== '')
        .join(' · ');
      return detail === ''
        ? t('note.context.compacted')
        : t('note.context.compactedDetail', { detail });
    }
    case 'goalRound': {
      // The separators are the same ` · ` the other composed rows use; the
      // words around them are keys, and every absent figure drops out.
      return [
        message.decision === ''
          ? t('note.goal.round')
          : t('note.goal.roundDecision', { decision: message.decision }),
        message.round === null ? '' : t('note.goal.position', { n: message.round }),
        message.rounds === null || message.maxRounds === null
          ? ''
          : t('note.goal.progress', { n: message.rounds, max: message.maxRounds }),
        message.reason,
      ]
        .filter((part) => part !== '')
        .join(' · ');
    }
    case 'imageAttached':
      return t('note.image.attached', {
        name: message.name,
        size:
          message.width === null || message.height === null
            ? ''
            : t('note.image.size', { width: message.width, height: message.height }),
      });
    case 'imageSkipped':
      return message.reason === ''
        ? t('note.image.skippedNoReason', { path: message.path })
        : t('note.image.skipped', { path: message.path, reason: message.reason });
    case 'imageRefused': {
      const names = message.names.join(', ');
      return message.model === ''
        ? t('note.image.refusedNoModel', { n: message.names.length, names })
        : t('note.image.refused', {
            model: message.model,
            n: message.names.length,
            names,
          });
    }
    case 'imageOverLimit': {
      if (message.rest === null || message.limit === null) {
        return t('note.image.overLimitUnknown');
      }
      return t('note.image.overLimit', {
        n: message.rest,
        limit: message.limit,
        detail:
          message.paths.length === 0
            ? ''
            : t('note.image.paths', { paths: message.paths.join(', ') }),
      });
    }
    case 'handshakeTimeout':
      return message.task === null
        ? t('note.handshake.timeout', { seconds: message.seconds })
        : t('note.handshake.timeoutTask', {
            seconds: message.seconds,
            task: message.task,
          });
    case 'hookDenied':
      // The hook's own words come last and are kept verbatim: they are the reason
      // the person wrote the script, and rewording them would be this window
      // explaining somebody else's rule.
      return message.reason === ''
        ? t('note.hook.deniedNoReason', { hook: message.hook, tool: message.tool })
        : t('note.hook.denied', {
            hook: message.hook,
            tool: message.tool,
            reason: message.reason,
          });
    case 'hookFailed':
      return message.reason === ''
        ? t('note.hook.failedNoReason', {
            hook: message.hook,
            status: message.status,
            tool: message.tool,
          })
        : t('note.hook.failed', {
            hook: message.hook,
            status: message.status,
            tool: message.tool,
            reason: message.reason,
          });
  }
}
