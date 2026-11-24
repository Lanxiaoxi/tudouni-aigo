/**
 * Re-stamp each catalogue row's `current` from the snapshot's live model.
 *
 * The catalogue's flag is written once, at `init`, and the snapshot is the only
 * later message that names the model actually in effect. Without this the flag
 * stays on the first row forever after a model is chosen — which is what left
 * the panel's "current" badge pinned while the top bar (reading `session.model`)
 * moved on. This is the same rule the TUI's picker applies rather than trusting
 * the stored flag: `current` is "this row is the one in effect", recomputed from
 * the live model, not a fact the catalogue asserts.
 *
 * The comparison is `id` **and** `provider`, exactly as the runtime stamps it
 * (`modelCatalog`): two routes can serve a same-named model, and only the pair
 * is the answer — a same-name row on another route must not light up too.
 *
 * Reconcile, and emit only when something actually moved. The snapshot rides on
 * every tool result and turn end, so a fresh array on each one would re-render
 * the model panel on every snapshot even when the model is unchanged. If every
 * row's flag already agrees with the snapshot's model, the same list reference
 * is returned — nothing to draw, no re-render. Only the one snapshot after a
 * real switch produces a corrected array, and that is the moment the badge must
 * move.
 *
 * An absent model (the projection's `''`) or provider names nothing to mark, so
 * the stored flags are left alone rather than wiped.
 */
import type { VmModel } from '@/runtime/adapt';

export function recomputeModelCurrent(
  models: VmModel[],
  snapModel: string,
  snapProvider: string,
): VmModel[] {
  if (models.length === 0 || snapModel === '' || snapProvider === '') return models;
  let changed = false;
  for (const row of models) {
    if (row.current !== (row.id === snapModel && row.provider === snapProvider)) {
      changed = true;
      break;
    }
  }
  if (!changed) return models;
  return models.map((row) => ({
    ...row,
    current: row.id === snapModel && row.provider === snapProvider,
  }));
}
