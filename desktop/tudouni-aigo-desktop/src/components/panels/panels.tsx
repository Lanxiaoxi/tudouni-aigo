import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Archive,
  ArchiveRestore,
  Bot,
  Check,
  ChevronRight,
  Download,
  Eye,
  Radio,
  Search,
  Upload,
  X,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { notesByServer, type VmModel } from '@/runtime/adapt';
import {
  NO_ALIASES,
  NO_JOBS,
  NO_MCP_ROWS,
  NO_MODEL_ROWS,
  NO_SKILLS,
  NO_STRINGS,
  NO_SUBAGENTS,
  NO_SUBAGENTS_DONE,
  remoteWorkspaceIdOf,
  selectAskOn,
  selectEffortLevels,
  selectLiveSessionIdsKey,
  selectSavedSessionsOf,
  useApp,
  useSessionField,
} from '@/state/store';
import { useT } from '@/i18n/useT';
import type { TKey } from '@/i18n';
import { useListKeys } from '@/hooks/useListKeys';
import { buildPatch, draftFrom, type RouteView } from '@/runtime/userConfig';
import {
  nothingToSaveReason,
  probeApplies,
  probeResultExpired,
  probeSaveable,
  probeTally,
  saveLevels,
  stillProbing,
} from './effortProbe';
import {
  readRemoteUserConfig,
  readUserConfig,
  writeRemoteUserConfig,
  writeUserConfig,
} from '@/runtime/tauri';
import { Badge, EmptyState, Info, RiskTag, Tip } from '@/components/ui/kit';
import { ContextBlock } from '@/components/stream/InBlock';
import { PanelBody, PanelRow, PanelShell } from './PanelShell';
import { COMMANDS } from '@/commands';
import { formatDuration, formatPath, formatRelative, formatTokens, oneLine } from '@/utils/format';

// Through the store's action rather than `setState({ panel: null })`: the
// library borrows the connection's session filter while it is open, and this is
// what gives it back. Every panel close in this file goes through here, so none
// of them has to remember. See `AppStore.closePanel`. The four panels that also
// draw in the status bar's anchored popover (`SubagentsPanel`, `ContextPanel`,
// `TimingPanel`, `AuditPanel`) have no pick-that-closes path, and Esc there is
// the popover's own — so closing the store's panel from them is a no-op.
const closePanel = () => useApp.getState().closePanel();

/* ============================================================
   Model selection.
   Two routes can carry the same model name, so `provider/model` is
   what actually gets sent — the palette must be able to tell them apart.
   ============================================================ */
/**
 * The catalogue, the way the config declares it: one collapsible group per
 * route, the route's models under it, a shared column pair (context window,
 * effort) across every group.
 *
 * **The number on a row is the pick.** The sequence runs continuously across
 * the visible groups and is what `1`–`9` choose, so a filter change or a fold
 * renumbers — a number that outlived its row would pick a different model than
 * the one printed under the key.
 *
 * **A search unfolds.** The at-rest list honors the folds; a search that left
 * a match hidden behind one would be a search that did not search. The counter
 * in the search box is the honest version of the same rule: what matched
 * against what exists.
 *
 * **The `!` is the note.** The runtime's catalogue carries an optional free-text
 * `note` per model; a row with one wears the mark and the note is the mark's
 * tooltip — data shown, not a threshold invented here.
 */
export function ModelPanel() {
  const t = useT();
  // The catalogue belongs to the session's child — it is read from that child's
  // configuration at open — so it comes from the session being shown.
  const models = useSessionField((rt) => rt.models, NO_MODEL_ROWS);
  const aliases = useSessionField((rt) => rt.modelAliases, NO_ALIASES);
  const chooseModel = useApp((s) => s.chooseModel);
  const [q, setQ] = useState('');
  /** Route names folded shut. Reset on every fold, like every filter change:
   *  the cursor must not land on a row the fold hid. */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());

  /** Substring match over the three strings a person could type: the model
   *  name, its display label, and the route it sits under. */
  const matches = useCallback((row: VmModel) => {
    const needle = q.trim().toLowerCase();
    if (needle === '') return true;
    return (
      row.id.toLowerCase().includes(needle) ||
      row.label.toLowerCase().includes(needle) ||
      row.provider.toLowerCase().includes(needle)
    );
  }, [q]);

  /** The catalogue grouped by route, in the catalogue's own order. The route
   *  order is declared in the config, not derived (see the runtime's
   *  `providerNames`) — grouping must not re-derive what the order already
   *  states. */
  const groups = useMemo(() => {
    const out: Array<{ provider: string; models: VmModel[] }> = [];
    const at = new Map<string, number>();
    for (const row of models) {
      if (!matches(row)) continue;
      const spot = at.get(row.provider);
      if (spot === undefined) {
        at.set(row.provider, out.length);
        out.push({ provider: row.provider, models: [row] });
      } else {
        out[spot].models.push(row);
      }
    }
    return out;
  }, [models, matches]);

  const searching = q.trim() !== '';
  /** The rows still on screen — what the numbers count and what the keyboard
   *  walks. The group **heads** render from `groups`, never from this: a fold
   *  hides a group's rows, not the head that re-opens it. */
  const openGroups = useMemo(
    () => (searching ? groups : groups.filter((group) => !collapsed.has(group.provider))),
    [groups, collapsed, searching],
  );

  /** The rows a person can see, in render order, numbered from 1. */
  const visible = useMemo(
    () => openGroups.flatMap((group) => group.models).map((model, i) => ({ model, seq: i + 1 })),
    [openGroups],
  );
  const seqOf = useMemo(() => {
    const map = new Map<string, number>();
    for (const { model, seq } of visible) map.set(`${model.provider}/${model.id}`, seq);
    return map;
  }, [visible]);

  const { active, setActive } = useListKeys({
    count: visible.length,
    onClose: closePanel,
    onPick: (i) => {
      const row = visible[i]?.model;
      // `set_model` requires an exact name and does no fuzzy matching, so the
      // qualified form is what is sent when a name exists on several routes.
      if (row) chooseModel(row.provider ? `${row.provider}/${row.id}` : row.id);
    },
  });

  function toggleRoute(provider: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(provider)) next.delete(provider);
      else next.add(provider);
      return next;
    });
    setActive(0);
  }

  const total = models.length;

  return (
    <PanelShell title={t('panel.model.title')} count={total} note={t('cmd.model.desc')}>
      <div className="mp-search">
        <Search size={14} className="muted" />
        <input
          autoFocus
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            // The cursor must not stay on a row the new query hid — it would
            // pick the wrong model on Enter.
            setActive(0);
          }}
          placeholder={t('panel.model.search')}
          aria-label={t('panel.model.search')}
          spellCheck={false}
        />
        <span className="mp-search-count">
          {visible.length} / {total}
        </span>
      </div>

      <PanelBody>
        {total === 0 ? (
          <EmptyState title={t('common.loading')} />
        ) : visible.length === 0 ? (
          <EmptyState title={t('panel.model.noMatch')} />
        ) : (
          <>
            <div className="mp-cols" aria-hidden>
              <span />
              <span>{t('panel.model.colModel')}</span>
              <span className="mp-col-window">{t('panel.model.colWindow')}</span>
              <span className="mp-col-effort">{t('panel.model.colEffort')}</span>
            </div>

            {groups.map((group) => {
              const open = searching || !collapsed.has(group.provider);
              return (
                <section key={group.provider} className="mp-group">
                  <button
                    type="button"
                    className="mp-group-head"
                    aria-expanded={open}
                    onClick={() => toggleRoute(group.provider)}
                  >
                    <ChevronRight size={13} className={`caret${open ? ' caret-open' : ''}`} />
                    <span className="mp-group-name">{group.provider}</span>
                    <span className="mp-group-count">
                      {t('panel.model.count', { n: group.models.length })}
                    </span>
                  </button>

                  {open
                    ? group.models.map((model) => {
                        const seq = seqOf.get(`${model.provider}/${model.id}`) ?? 0;
                        return (
                          <ModelRow
                            key={`${model.provider}/${model.id}`}
                            model={model}
                            seq={seq}
                            active={active === seq - 1}
                            onHover={() => setActive(seq - 1)}
                            onPick={() =>
                              chooseModel(model.provider ? `${model.provider}/${model.id}` : model.id)
                            }
                          />
                        );
                      })
                    : null}
                </section>
              );
            })}

            {/* Aliases are names the runtime accepts that are not in the list. They
                are data, not an answer: shown and labelled rather than hidden. */}
            {aliases.length > 0 ? (
              <div className="mp-aliases">
                <div className="cmdk-group">{t('panel.model.aliases')}</div>
                {aliases.map((alias) => (
                  <div key={alias.id} className="mp-row mp-alias">
                    <span className="mp-seq" />
                    <span className="mp-name">
                      <span className="mono muted">{alias.id}</span>
                      <span className="caption muted">→ {alias.of}</span>
                    </span>
                    <span />
                    <span />
                  </div>
                ))}
              </div>
            ) : null}
          </>
        )}
      </PanelBody>
    </PanelShell>
  );
}

/**
 * One model, in the catalogue's table shape: sequence, name, and the two
 * numbers the list is scanned by.
 *
 * The whole row picks (like every list row in this dialog family); the summary
 * rides on the row's tooltip so the catalogue's own sentence about a model is
 * one hover away without giving every row a second line.
 */
function ModelRow({
  model,
  seq,
  active,
  onHover,
  onPick,
}: {
  model: VmModel;
  seq: number;
  active: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  const t = useT();
  // The `!` and the tinted window are the same fact: the catalogue's note about
  // this model, and the note is the tooltip that says what it is.
  const flagged = model.note !== '';
  return (
    /* `stopPropagation` on the row's own keys, as in `PanelRow`: the panel's
        keys go through `useListKeys`, whose listener is on `window` — a
        focused row meant one `Enter` reached both handlers. */
    <div
      className={`mp-row${model.current ? ' is-current' : ''}${active ? ' is-active' : ''}`}
      role="button"
      tabIndex={0}
      title={model.summary || undefined}
      onClick={onPick}
      onMouseEnter={onHover}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          onPick();
        }
      }}
    >
      <span className="mp-seq">{seq}</span>
      <span className="mp-name">
        <span className="mono">{model.label || model.id}</span>
        {model.vision ? (
          <Tip label={t('panel.model.vision')}>
            <Eye size={13} className="mp-vision" />
          </Tip>
        ) : null}
        {flagged ? (
          <Tip label={model.note}>
            <AlertCircle size={13} className="mp-flag" />
          </Tip>
        ) : null}
        {model.current ? <span className="mp-current">{t('panel.model.current')}</span> : null}
      </span>
      <span className={`mp-window mono${flagged ? ' is-flagged' : ''}`}>
        {/* Null means the catalogue does not name a window. */}
        {model.window === null ? '—' : formatTokens(model.window)}
      </span>
      <span className="mp-effort">{model.effort || '—'}</span>
    </div>
  );
}

/* ============================================================
   Reasoning effort.
   The list is `string[]` from the runtime and changes with the model;
   the labels are this layer's job, the levels are not.
   ============================================================ */

/** The result a probe row can carry, and the badge it wears. */
const PROBE_TONE: Record<string, 'success' | 'destructive' | 'warning'> = {
  ok: 'success',
  rejected: 'destructive',
  uncertain: 'warning',
};

export function EffortPanel() {
  const t = useT();
  // The shared empty constant keeps the snapshot's identity while the data is
  // missing; a fresh `[]` here would re-render forever.
  const levels = useApp(
    useShallow((s) =>
      selectEffortLevels(s, s.activeKey),
    ),
  );
  const current = useSessionField((rt) => rt.session?.effort ?? '', '');
  const thinking = useSessionField((rt) => rt.session?.thinking ?? false, false);
  const model = useSessionField((rt) => rt.session?.model ?? '', '');
  const provider = useSessionField((rt) => rt.session?.provider ?? '', '');
  const protocol = useSessionField((rt) => rt.session?.protocol ?? 0, 0);
  const probe = useSessionField((rt) => rt.probeEffort, null);
  const probeAt = useSessionField((rt) => rt.probeEffortAt, null);
  const probeStartedAt = useSessionField((rt) => rt.probeEffortStartedAt, null);
  // A clock, not a flag: "probing" is derived from the store so a panel that is
  // closed and reopened still shows a running pass, but that same derivation
  // means a runtime that dies mid-pass leaves it running for ever. The deadline
  // above is read against a clock that ticks only while an ask is outstanding —
  // plus, once, when a result is due to expire — so a panel sitting on a
  // finished probe costs no timers.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (probeStartedAt === null && probeAt === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, [probeStartedAt, probeAt]);
  const probing = stillProbing(probeStartedAt, probe !== null, now);
  // Asked, never answered, and past the deadline: the runtime owed a reply and
  // did not send one (it died, the connection dropped, or the child was
  // replaced). Saying so is the only way the button comes back.
  const probeOverdue = probeStartedAt !== null && probe === null && !probing;
  const probeProblem = useSessionField((rt) => rt.probeEffortProblem, null);
  // A result older than the TTL is still drawn — it is history, and hiding it
  // would look like the probe never ran — but it no longer offers a save. See
  // `probeResultExpired`.
  const probeExpired = probeResultExpired(probeAt, now);
  const chooseEffort = useApp((s) => s.chooseEffort);
  const requestProbeEffort = useApp((s) => s.requestProbeEffort);
  // The write-back edits the configuration **file**, and on a remote screen
  // that file lives on the far host — the same door the config panel uses.
  const configTarget = useApp((s) => s.configTarget);
  const noteRemoteConfigWritten = useApp((s) => s.noteRemoteConfigWritten);

  const [confirming, setConfirming] = useState(false);
  const [writing, setWriting] = useState(false);
  // What the last save wrote, and for which endpoint — a **copy of that
  // moment's list**, not a flag, and not read back off the current probe. The
  // sentence under the result names levels, and a later probe must not inherit
  // the old "saved" and claim it had written levels it never did.
  const [written, setWritten] = useState<{ endpoint: string; levels: string } | null>(null);
  const [writeProblem, setWriteProblem] = useState<string | null>(null);
  // The unclear levels the person decided to leave out of a save. An empty set
  // is the default — "unclear is not a refusal" — so the checkbox on each
  // unclear row starts checked, and unchecking is the only way a save drops
  // one. It is intent, like the arms above: it dies with the panel.
  const [excludedUncertain, setExcludedUncertain] = useState<ReadonlySet<string>>(() => new Set());
  const toggleUncertain = (level: string) => {
    setExcludedUncertain((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  };
  // A new answer is a new situation: the ticks belong to the rows on screen,
  // so a fresh result starts from the default (keep every unclear level).
  useEffect(() => {
    setExcludedUncertain(new Set());
  }, [probeAt]);

  const { active, setActive } = useListKeys({
    count: levels.length,
    onClose: closePanel,
    onPick: (i) => levels[i] && chooseEffort(levels[i]),
  });

  // The result applies to the endpoint it probed — the **pair**, not the model
  // id. `probeApplies` owns the rule and its reason: one model id can be listed
  // on two routes, and a save writes into `probe.provider`'s entry.
  const probeMatches = probeApplies(probe, { model, provider });
  // The three columns, counted once: the head line, the rows and the "nothing
  // here can be saved" sentence all read the same tally, so one of them cannot
  // disagree with the badges beside it.
  const tally = probeTally(probe);
  const noSaveReason = nothingToSaveReason(probe);
  // What a press of Save would write **right now**: every confirmed level plus
  // the unclear ones still checked. `probeSaveable` keeps the *offer* honest
  // (an all-uncertain pass learned nothing and must not be saved at all), and
  // this list is what the person's ticks actually change.
  const saveable = probeSaveable(probe);
  const chosen = saveLevels(probe, excludedUncertain);
  // Saveable needs a **confirmed** level as well as a writable one: a pass that
  // came back entirely `uncertain` learned nothing, and writing it would both
  // claim a result and put a list into the file that no probe vouched for. See
  // `probeSaveable`. Unchecking every unclear level is different: the ok ones
  // remain, and that is a legitimate save of exactly what was confirmed.
  const canOfferWrite =
    saveable && chosen.length > 0 && probeMatches && !probing && !probeExpired;
  // Whether the rows below are six findings or one finding repeated. On the
  // Messages wire the level is translated into a thinking budget and a probe
  // uses the protocol floor, so the endpoint never sees the word — the runtime
  // says so rather than letting the panel sell six measurements.
  const rowsAreOneAnswer = probe?.levels_are_one_answer === true;
  // The endpoint as the panel names it. The save confirmation is only true of
  // the pair it was written for; switching route or model hides it rather than
  // letting a sentence about one entry sit under another.
  const endpointKey = `${provider}/${model}`;

  /**
   * Write the levels the endpoint did not refuse into the configuration file,
   * on whichever machine that file lives.
   *
   * The read-modify-write is **here and now**, not against the panel's state:
   * the file may have been edited since the panel opened, and the Rust merge
   * runs against the bytes it just read — the config panel's own save rule.
   * Only the one model the probe covered is touched; every other route and
   * model round-trips unchanged.
   */
  async function writeAccepted() {
    if (probe === null || !probeMatches) return;
    setWriting(true);
    setWriteProblem(null);
    setWritten(null);
    try {
      const where = configTarget();
      const doc = where === null ? await readUserConfig() : await readRemoteUserConfig(where.target);
      if (doc === null) {
        setWriteProblem(t('panel.effort.probeReadFailed'));
        return;
      }
      if (doc.problem !== null) {
        // The file did not parse. Its `providers` list is empty for that reason
        // and not because the model was removed — reporting "no longer lists
        // this model" would point at the wrong thing entirely, and the config
        // panel already refuses to write an unparseable file.
        setWriteProblem(doc.problem);
        return;
      }
      let found = false;
      const providers: RouteView[] = doc.providers.map((route) => {
        if (route.name !== probe.provider) return route;
        return {
          ...route,
          models: route.models.map((entry) => {
            if (entry.id !== probe.model) return entry;
            found = true;
            return { ...entry, effortLevels: chosen };
          }),
        };
      });
      if (!found) {
        // The file no longer lists the model the probe covered: writing the
        // levels into a rebuilt entry would invent configuration, and doing
        // nothing while saying "saved" would be a lie.
        setWriteProblem(t('panel.effort.probeNotFound'));
        return;
      }
      const patch = buildPatch(doc, { ...draftFrom(doc), providers });
      if (where === null) {
        await writeUserConfig(patch);
      } else {
        // The same §9.5 baseline move the config panel makes: without it the
        // next open would report this save as somebody else's change.
        const writtenDoc = await writeRemoteUserConfig(where.target, patch);
        if (writtenDoc.configFingerprint !== null) {
          noteRemoteConfigWritten(where.hostId, writtenDoc.configFingerprint);
        }
      }
      // The list is captured here, at the moment it was written, and carries
      // the endpoint it was written for. The sentence below the result is about
      // **that** save; reading the levels off whichever probe is on screen
      // later would let the old confirmation claim a write that never happened.
      setWritten({ endpoint: `${probe.provider}/${probe.model}`, levels: chosen.join(' / ') });
    } catch (err) {
      setWriteProblem(
        t('panel.effort.probeWriteFailed', { problem: err instanceof Error ? err.message : String(err) }),
      );
    } finally {
      setWriting(false);
    }
  }

  return (
    <PanelShell
      title={t('panel.effort.title')}
      count={levels.length}
      note={t('panel.effort.note')}
    >
      <PanelBody>
        {levels.length === 0 ? (
          <EmptyState title={t('common.loading')} />
        ) : (
          levels.map((level, i) => (
            <PanelRow
              key={level}
              index={i + 1}
              active={active === i}
              selected={level === current}
              onHover={() => setActive(i)}
              onPick={() => chooseEffort(level)}
              aside={
                level === current ? (
                  <Badge tone="success" dot={false}>
                    {t('panel.model.current')}
                  </Badge>
                ) : null
              }
            >
              <span className="mono strong">{level}</span>
            </PanelRow>
          ))
        )}

        {/* Thinking can be off while an effort is still recorded — that is the
            user's intent, so it is stated rather than corrected. */}
        {!thinking ? (
          <div className="caption muted" style={{ padding: 'var(--space-2) var(--space-3)' }}>
            {t('session.thinking')}: {t('session.thinkingOff')} —{' '}
            {t('cmd.thinking.desc')}
          </div>
        ) : null}

        {/* ---------------- the probe ----------------
         *
         * A button that asks real questions of the endpoint. The confirmation
         * is here rather than in the store, because the cost is what the
         * person is confirming: the list length and the model are this panel's
         * facts, and a store that had to hold them would know more than its
         * job. Gated on protocol 13 for the reason the fork control is: a
         * runtime below it would drop the message, and a button that answers
         * with nothing is a promise the runtime cannot keep. */}
        {protocol >= 13 ? (
          <div className="probe-zone">
            {probeProblem !== null ? (
              <div className="caption probe-problem">{probeProblem}</div>
            ) : null}

            {probing ? (
              <div className="caption probe-probing">
                <Radio size={12} aria-hidden />
                {t('panel.effort.probing')}
              </div>
            ) : null}

            {/* The ask went out and no answer ever came back: nothing will
                clear `startedAt` now, so the panel says so and offers the
                button again rather than spinning for ever. */}
            {probeOverdue ? (
              <div className="caption probe-problem">{t('panel.effort.probeOverdue')}</div>
            ) : null}

            {probe && !probing ? (
              <div className="probe-result">
                <div className="caption probe-result-head">
                  {probeMatches
                    ? t('panel.effort.probeResult', {
                        model: probe.model,
                        ok: tally.ok,
                        rejected: tally.rejected,
                        uncertain: tally.uncertain,
                      })
                    : t('panel.effort.probeStale', {
                        // The whole pair, not just the model: two routes can
                        // carry one model id, and "this result is for X" has to
                        // be able to say which route X is.
                        probed: `${probe.provider}/${probe.model}`,
                        model: endpointKey,
                      })}
                </div>
                {probe.levels.map((row) => (
                  <div key={row.level} className="probe-row">
                    <span className="mono strong">{row.level}</span>
                    <Badge tone={PROBE_TONE[row.result] ?? 'warning'} dot={false}>
                      {row.result}
                    </Badge>
                    {row.result === 'uncertain' ? (
                      // Only the unclear rows carry a box: "accepted" is the
                      // endpoint's own answer and "refused" is final, but the
                      // unclear ones are the person's to decide — a rate-limited
                      // key is not a refusal, and the person may know their
                      // endpoint better than the probe does.
                      <label className="cfg-check probe-keep" title={t('panel.effort.probeKeepHint')}>
                        <input
                          type="checkbox"
                          checked={!excludedUncertain.has(row.level)}
                          onChange={() => toggleUncertain(row.level)}
                        />
                        <span>{t('panel.effort.probeKeep')}</span>
                      </label>
                    ) : null}
                    {row.result === 'uncertain' && row.note ? (
                      <span className="caption muted probe-note" title={row.note}>
                        {row.note}
                      </span>
                    ) : null}
                  </div>
                ))}
                {/* One finding, drawn as one: listing six identical rows under
                    a heading that says "probe of <model>" would claim the
                    endpoint answered about each level. */}
                {rowsAreOneAnswer ? (
                  <div className="caption muted">{t('panel.effort.probeOneAnswer')}</div>
                ) : null}
                {/* Why nothing can be saved, in the one sentence that is true:
                    "refused every level" only when the endpoint refused every
                    level, and "no answer" when it never answered readably. See
                    `nothingToSaveReason`. */}
                {noSaveReason === 'all-refused' ? (
                  <div className="caption muted">{t('panel.effort.probeAllRefused')}</div>
                ) : noSaveReason === 'no-answer' ? (
                  <div className="caption muted">{t('panel.effort.probeNoAnswer')}</div>
                ) : null}
                {/* A result past its TTL keeps its rows and loses its save: the
                    list describes the endpoint as it was, and a stale list
                    written into the file would delete levels the endpoint has
                    since started taking. */}
                {probeExpired && probeMatches ? (
                  <div className="caption muted">{t('panel.effort.probeExpired')}</div>
                ) : null}
                <div className="probe-actions">
                  {canOfferWrite ? (
                    <Tip label={t('panel.effort.probeWriteHint')}>
                      <button
                        type="button"
                        className="btn btn-outline btn-compact"
                        // Disabled rather than unmounted while the write runs:
                        // unmounting it is what left a save in flight with no
                        // progress mark anywhere on screen.
                        disabled={writing}
                        onClick={() => void writeAccepted()}
                      >
                        {writing ? <Radio size={12} aria-hidden /> : <Check size={12} aria-hidden />}
                        {writing ? t('panel.effort.probeWriting') : t('panel.effort.probeWrite')}
                      </button>
                    </Tip>
                  ) : null}
                  {written !== null && written.endpoint === endpointKey ? (
                    <span className="caption probe-written">
                      {t('panel.effort.probeWritten', { levels: written.levels })}
                    </span>
                  ) : null}
                </div>
                {writeProblem !== null ? (
                  <div className="caption probe-problem">{writeProblem}</div>
                ) : null}
                <div className="caption muted probe-fineprint">{t('panel.effort.probeNote')}</div>
              </div>
            ) : null}

            {!probing ? (
              confirming ? (
                <div className="probe-confirm">
                  <div className="strong">{t('panel.effort.probeConfirmTitle')}</div>
                  <div className="caption">
                    {t('panel.effort.probeConfirmBody', { n: levels.length, model })}
                  </div>
                  <div className="probe-confirm-actions">
                    <button
                      type="button"
                      className="btn btn-primary btn-compact"
                      onClick={() => {
                        setConfirming(false);
                        // A new ask supersedes the last save: its sentence and
                        // its refusal both describe a probe that is now being
                        // replaced, and leaving them up would print "saved"
                        // beside a result the save never covered.
                        setWritten(null);
                        setWriteProblem(null);
                        requestProbeEffort();
                      }}
                    >
                      {t('panel.effort.probe')}
                    </button>
                    <button type="button" className="btn btn-outline btn-compact" onClick={() => setConfirming(false)}>
                      {t('common.cancel')}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="probe-actions">
                  <Tip label={t('panel.effort.probeHint')}>
                    <button type="button" className="btn btn-outline btn-compact" onClick={() => setConfirming(true)}>
                      <Radio size={12} aria-hidden />
                      {t('panel.effort.probe')}
                    </button>
                  </Tip>
                </div>
              )
            ) : null}
          </div>
        ) : null}
      </PanelBody>
    </PanelShell>
  );
}

/* ============================================================
   Session picker.
   Preview and progress are computed by the runtime; this view never
   reads a session file.
   ============================================================ */
/**
 * The library: every session this workspace has, active or archived.
 *
 * **Two tabs, not two panels.** "Active" is the list the rail shows; "Archived"
 * is what the rail deliberately does not. They are two views of one fact — the
 * workspace's saved sessions — so a tab strip is the honest shape, and the
 * archive action lives on the rows rather than in a separate "manage" screen.
 *
 * **The connection's filter follows the tab.** The runtime's list is one per
 * connection and its cap is fifty rows, so the desktop asks for `active` in its
 * steady state and switches to `all` while this panel is open (see
 * `AppStore.sessionFilter`). That is why the search below filters the rows it was
 * given rather than asking the runtime: the rows are already the union of both
 * tabs.
 *
 * **Archiving is reversible; deleting is not.** Archive moves a row to the other
 * tab and back; delete (the rail's action, `Ctrl+Del`) is not offered here, so
 * the destructive one keeps its single, deliberate home.
 */
export function ResumePanel() {
  const t = useT();
  const [tab, setTab] = useState<'active' | 'archived'>('active');
  const [q, setQ] = useState('');
  // The picker shows the **workspace's** saved sessions, so it reads the same
  // window-level list the left rail does — one source, so the two can never
  // disagree about what exists (see `SavedSessions`). `Of` because the machine is
  // part of which list this is.
  const saved = useApp((s) => selectSavedSessionsOf(s, s.activeKey));
  const listed = saved.listed;
  const openSession = useApp((s) => s.openSession);
  const archiveSession = useApp((s) => s.archiveSession);
  // The compact key, not the Set: `selectLiveSessionIds` builds a fresh Set on
  // every call, and a zustand selection that is a new reference on every read
  // loops the panel into "Maximum update depth exceeded". The key is a stable
  // primitive; the Set is derived from it and rebuilt only when the ids do.
  const liveIdsKey = useApp(selectLiveSessionIdsKey);
  const liveIds = useMemo(() => new Set(liveIdsKey === '' ? [] : liveIdsKey.split('\u0001')), [liveIdsKey]);
  const currentId = useSessionField((rt) => rt.session?.id ?? null, null);

  /** Field-level match: the topic and the session id, in that order.
   *  Not fuzzy and not the metadata — `preview` is the topic the runtime
   *  computed, and `id` is the name `/resume` itself uses, so these are the two
   *  strings a person could actually have typed. */
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const byTab = saved.items.filter((row) => (tab === 'archived' ? row.archived : !row.archived));
    if (needle === '') return byTab;
    return byTab.filter(
      (row) => row.preview.toLowerCase().includes(needle) || row.id.toLowerCase().includes(needle),
    );
  }, [saved.items, tab, q]);

  const { active, setActive } = useListKeys({
    count: list.length,
    onClose: closePanel,
    onPick: (i) => list[i] && void openSession(list[i].id),
  });

  const archivedCount = useMemo(() => saved.items.filter((r) => r.archived).length, [saved.items]);
  const activeCount = saved.items.length - archivedCount;

  return (
    <PanelShell title={t('panel.resume.title')} count={list.length} note={t('cmd.resume.desc')}>
      <div className="cmdk-head">
        <Search size={14} className="muted" />
        <input
          autoFocus
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            // The cursor must not stay on a row the new query hid — it would
            // select the wrong conversation on Enter.
            setActive(0);
          }}
          placeholder={t('panel.resume.search')}
          title={t('panel.resume.searchHint')}
          aria-label={t('panel.resume.search')}
          spellCheck={false}
        />
      </div>
      <div className="panel-tabs" role="tablist">
        {(['active', 'archived'] as const).map((which) => (
          <button
            key={which}
            type="button"
            role="tab"
            aria-selected={tab === which}
            className={`panel-tab${tab === which ? ' is-on' : ''}`}
            onClick={() => {
              setTab(which);
              setActive(0);
            }}
          >
            {t(which === 'active' ? 'panel.resume.tab.active' : 'panel.resume.tab.archived')}
            <span className="count">{which === 'active' ? activeCount : archivedCount}</span>
          </button>
        ))}
      </div>
      <PanelBody>
        {!listed ? (
          <EmptyState title={t('common.loading')} />
        ) : list.length === 0 ? (
          <EmptyState
            title={
              q.trim() !== ''
                ? t('panel.resume.noMatch')
                : tab === 'archived'
                  ? t('panel.resume.archivedEmpty')
                  : t('panel.resume.empty')
            }
          />
        ) : (
          list.map((item, i) => {
            // A live child holds this id, so archiving would edit a session file
            // something else is still writing. The button is disabled rather than
            // hidden: "why can't I archive this one" has an answer, and the
            // tooltip is it. `archiveSession` refuses the same case again — this
            // is the visible half of one rule, not the only half.
            const live = liveIds.has(item.id);
            const target = item.archived ? false : true;
            return (
              <PanelRow
                key={item.id}
                index={i + 1}
                active={active === i}
                selected={item.id === currentId}
                onHover={() => setActive(i)}
                onPick={() => void openSession(item.id)}
                aside={
                  item.modifiedAt === null
                    ? t('common.unknown')
                    : formatRelative(item.modifiedAt * 1000)
                }
              >
                <div className="row" style={{ gap: 'var(--space-2)', alignItems: 'center' }}>
                  <span className="truncate grow">{item.preview}</span>
                  {item.archived ? (
                    <Badge tone="neutral">{t('panel.resume.archivedTag')}</Badge>
                  ) : null}
                  <Tip label={live && !item.archived ? t('panel.resume.archiveLive') : ''}>
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon"
                      aria-label={
                        target ? t('panel.resume.archive') : t('panel.resume.unarchive')
                      }
                      disabled={live && !item.archived}
                      // The row is itself a button; without this the click would
                      // also pick the row and open the session.
                      onClick={(e) => {
                        e.stopPropagation();
                        archiveSession(item.id, target);
                      }}
                    >
                      {target ? <Archive size={13} /> : <ArchiveRestore size={13} />}
                    </button>
                  </Tip>
                </div>
                <div className="row" style={{ gap: 'var(--space-2)' }}>
                  {/* The id is a footnote now, not the title: it is a timestamp
                      (`YYYYMMDD-HHMMSS`) and the topic above is what identifies the
                      conversation. It stays because it is the name `/resume` and the
                      rail's own row use. */}
                  <span className="mono muted">{item.id}</span>
                  <span className="caption muted">{t('panel.resume.messages', { n: item.messages })}</span>
                  <span className="caption muted">{t('panel.resume.steps', { n: item.steps })}</span>
                  {/* `todos` is ready-made progress text; an empty string means
                      there is no task list, which is not the same as zero. */}
                  {item.todos ? <span className="caption muted">{item.todos}</span> : null}
                </div>
              </PanelRow>
            );
          })
        )}
      </PanelBody>
    </PanelShell>
  );
}

/* ============================================================
   MCP. The three states are three different questions.
   ============================================================ */
export function McpPanel() {
  const t = useT();
  // Mounting is per session: each child connects its own servers, so the list
  // below is that session's and a load in one conversation does not show in
  // another's panel.
  const servers = useSessionField((rt) => rt.mcp, NO_MCP_ROWS);
  const notes = useSessionField((rt) => rt.mcpNotes, NO_STRINGS);
  const requestMcp = useApp((s) => s.requestMcp);

  // A server that would not connect has no state of its own on the wire — the
  // runtime says it in a sentence, under `mcp_notes`. Attaching that sentence to
  // the row it names is what stops "configured, never loaded" and "we tried and
  // it failed" from looking identical here.
  const perServer = useMemo(() => notesByServer(servers, notes), [servers, notes]);
  const unattached = notes.filter((note) => ![...perServer.values()].some((list) => list.includes(note)));

  function toggle(index: number) {
    const server = servers[index];
    if (!server) return;
    if (server.state === 'loaded') requestMcp('unload', [server.name]);
    else if (server.state === 'unload') requestMcp('load', [server.name]);
    // A failed server is not silently retried: asking again is a decision, and
    // the reason is already on the row.
  }

  const { active, setActive } = useListKeys({
    count: servers.length,
    onClose: closePanel,
    onPick: toggle,
  });

  return (
    <PanelShell title={t('panel.mcp.title')} count={servers.length} note={t('cmd.mcp.desc')}>
      <PanelBody>
        {servers.length === 0 ? (
          <EmptyState title={t('panel.mcp.empty')} hint={t('empty.mcp.hint')} />
        ) : (
          servers.map((server, i) => {
            const tone =
              server.state === 'loaded'
                ? 'success'
                : server.state === 'failed'
                  ? 'destructive'
                  : 'neutral';
            const label =
              server.state === 'loaded'
                ? t('mcp.loaded')
                : server.state === 'unload'
                  ? t('mcp.unload')
                  : t('mcp.failed');

            return (
              <PanelRow
                key={server.name}
                index={i + 1}
                active={active === i}
                onHover={() => setActive(i)}
                onPick={() => toggle(i)}
                aside={
                  server.state === 'failed' ? null : (
                    <span className="row" style={{ gap: 'var(--space-1)' }}>
                      {server.state === 'loaded' ? <Upload size={11} /> : <Download size={11} />}
                      {server.state === 'loaded' ? t('mcp.unloadAction') : t('mcp.load')}
                    </span>
                  )
                }
              >
                <div className="row" style={{ gap: 'var(--space-2)' }}>
                  <span className="mono strong">{server.name}</span>
                  <Badge tone={tone} dot={false}>
                    {label}
                  </Badge>
                  {server.state === 'failed' ? null : (
                    <span className="caption muted">{t('mcp.tools', { n: server.tools })}</span>
                  )}
                </div>
                {/* `where` reaches `scheme://host` for remote servers only: a URL
                    can carry a token, and this row is drawn and logged. */}
                <div className="caption muted truncate mono" title={server.where}>
                  {server.where}
                </div>
                {server.error ? (
                  <div className="caption" style={{ color: 'var(--destructive-text)' }}>
                    {server.error}
                  </div>
                ) : null}
                {/* The runtime's own sentence about *this* server, shown on the
                    row it belongs to. It is what distinguishes "configured, never
                    loaded" from "we tried and it failed" — the two carry the same
                    `state` on the wire. */}
                {(perServer.get(server.name) ?? []).map((note, n) => (
                  <div key={`n-${n}`} className="caption" style={{ color: 'var(--warning-text)' }}>
                    {note}
                  </div>
                ))}
              </PanelRow>
            );
          })
        )}

        {/* Notes that name no configured server (a bad `mcp.json`, a server that
            is not in the list) stay in their own group rather than being
            attached to the nearest row. The runtime wrote them whole; they are
            shown as-is. */}
        {unattached.length > 0 ? (
          <>
            <div className="cmdk-group">{t('panel.mcp.notes')}</div>
            {unattached.map((note, i) => (
              <PanelRow key={`note-${i}`}>
                <span className="caption muted">{note}</span>
              </PanelRow>
            ))}
          </>
        ) : null}
      </PanelBody>
    </PanelShell>
  );
}

/* ============================================================
   Skills. Four facts, two lists.
   `ui(skills).skills` is what this session **can load**; `active` is what is
   **loaded**. The digest and the description come from `ui(state)`, which is
   the only message carrying them. The store merges them (`mergeSkills`), so
   this view reads two ready lists rather than re-deriving the split.
   ============================================================ */
export function SkillsPanel() {
  const t = useT();
  const loaded = useSessionField((rt) => rt.skills, NO_SKILLS);
  const available = useSessionField((rt) => rt.skillAvailable, NO_SKILLS);
  const problems = useSessionField((rt) => rt.skillProblems, NO_STRINGS);
  const shadowed = useSessionField((rt) => rt.skillShadowed, NO_STRINGS);
  const requestSkills = useApp((s) => s.requestSkills);

  const total = loaded.length + available.length;

  return (
    <PanelShell
      title={t('panel.skills.title')}
      count={`${loaded.length} / ${total}`}
      note={t('cmd.skills.desc')}
    >
      <PanelBody>
        {/* Group head = the group's label plus a `?` carrying the sentence the
            row itself cannot carry. The row is name-first now (strong, no badge
            in the middle): the badge moved to `aside`, where it cannot break
            the name out of the first visual slot. */}
        <div className="panel-group-head">
          <span>{t('panel.skills.loaded')}</span>
          <Info label={t('panel.skills.hint')} />
        </div>
        {loaded.length === 0 ? (
          <EmptyState title={t('panel.skills.empty')} hint={t('empty.skills.hint')} />
        ) : (
          loaded.map((skill) => (
            <PanelRow key={skill.name} aside={<Badge tone="success" dot={false}>{t('panel.skills.loaded')}</Badge>}>
              <div className="skill-row-main">
                <span className="mono strong">{skill.name}</span>
                {/* Empty means the runtime did not send a digest for this one —
                    unknown, not "no digest". */}
                {skill.digest !== '' ? <span className="caption muted mono">{skill.digest}</span> : null}
              </div>
              <div className="caption muted clamp-2">
                {skill.description ?? t('common.unknown')}
              </div>
            </PanelRow>
          ))
        )}

        {/* What is left is what a person could still load — the difference
            between the catalogue and the loaded set. The plain `.cmdk-group`
            rule (no weight, fainter colour) is the second tier: the loaded
            group's head is bold and one shade up. */}
        {available.length > 0 ? (
          <>
            <div className="cmdk-group">{t('panel.skills.available')}</div>
            {available.map((row) => (
              <PanelRow key={row.name}>
                <div className="skill-row-main">
                  <span className="mono">{row.name}</span>
                </div>
                {row.description ? <div className="caption muted clamp-2">{row.description}</div> : null}
              </PanelRow>
            ))}
          </>
        ) : null}

        {problems.length > 0 ? (
          <>
            <div className="cmdk-group">{t('panel.skills.problems')}</div>
            {problems.map((problem, i) => (
              <PanelRow key={`p-${i}`}>
                <span className="caption" style={{ color: 'var(--warning-text)' }}>
                  {problem}
                </span>
              </PanelRow>
            ))}
          </>
        ) : null}

        {shadowed.length > 0 ? (
          <>
            <div className="cmdk-group">{t('panel.skills.shadowed')}</div>
            {shadowed.map((line, i) => (
              <PanelRow key={`s-${i}`}>
                <span className="caption muted">{line}</span>
              </PanelRow>
            ))}
          </>
        ) : null}

        <button
          type="button"
          className="btn btn-ghost btn-compact"
          style={{ margin: 'var(--space-3)' }}
          onClick={requestSkills}
        >
          {t('panel.skills.refresh')}
        </button>
      </PanelBody>
    </PanelShell>
  );
}

/* ============================================================
   Help: the command table plus the key table.
   ============================================================ */
const KEY_ROWS: Array<{ keys: string[]; label: TKey }> = [
  { keys: ['Enter'], label: 'key.send' },
  { keys: ['Shift', 'Enter'], label: 'key.newline' },
  { keys: ['Esc'], label: 'key.esc' },
  { keys: ['↑', '↓', 'PgUp', 'PgDn'], label: 'key.move' },
  { keys: ['Ctrl', 'T'], label: 'key.thinking' },
  { keys: ['Ctrl', 'B'], label: 'key.sidebar' },
  { keys: ['Ctrl', 'L'], label: 'key.leftbar' },
  { keys: ['Ctrl', 'K'], label: 'key.palette' },
  { keys: ['Ctrl', 'S'], label: 'key.skills' },
  // Above `Ctrl+\\`, and next to the other `Ctrl` letters: the transcript's find
  // belongs with the window's other keys, and the help table is the only place a
  // reader can learn it exists.
  { keys: ['Ctrl', 'F'], label: 'key.find' },
  { keys: ['Ctrl', '\\'], label: 'key.quiet' },
  { keys: ['Ctrl', 'Shift', 'D'], label: 'key.dock' },
  { keys: ['Ctrl', 'Shift', 'E'], label: 'key.dockExplorer' },
  { keys: ['Ctrl', 'Shift', 'G'], label: 'key.dockGit' },
  { keys: ['Ctrl', '`'], label: 'key.dockTerminal' },
  { keys: ['Ctrl', 'A', 'E', 'W', 'U'], label: 'key.edit' },
  { keys: ['1', '9'], label: 'key.pick' },
];

export function HelpPanel() {
  const t = useT();
  return (
    <PanelShell
      title={t('panel.help.title')}
      count={`${COMMANDS.length}`}
      note={`${t('panel.help.commands')} · ${t('panel.help.keys')}`}
    >
      <PanelBody>
        <div className="etb-label">{t('panel.help.commands')}</div>
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>{t('panel.help.commands')}</th>
              <th>{t('inblock.note')}</th>
            </tr>
          </thead>
          <tbody>
            {COMMANDS.map((command, i) => (
              <tr key={command.id}>
                <td className="num">{i + 1}</td>
                <td className="mono strong">{command.name}</td>
                <td className="muted">{t(command.descKey)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="etb-label" style={{ marginTop: 'var(--space-3)' }}>
          {t('panel.help.keys')}
        </div>
        <table className="table">
          <tbody>
            {KEY_ROWS.map((row) => (
              <tr key={row.label}>
                <td style={{ width: 220 }}>
                  <span className="row" style={{ gap: 3 }}>
                    {row.keys.map((key) => (
                      <kbd className="kbd" key={key}>
                        {key}
                      </kbd>
                    ))}
                  </span>
                </td>
                <td className="muted">{t(row.label)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </PanelBody>
    </PanelShell>
  );
}

/* ============================================================
   Subagents and background jobs.
   The status bar carries the badge; this is where the detail lives.
   ============================================================ */
export function SubagentsPanel({ section = 'all' }: { section?: 'all' | 'subagents' | 'jobs' } = {}) {
  const t = useT();
  // The status bar has one chip per half, and each chip opens only its own
  // half; the `/subagents` dialog keeps both. Section labels are drawn only
  // when both halves share the panel — alone, the title already says it.
  const showAgents = section !== 'jobs';
  const showJobs = section !== 'subagents';
  const both = showAgents && showJobs;
  // Delegations and background jobs belong to one session's turn.
  const agents = useSessionField((rt) => rt.uiState?.subagents ?? NO_SUBAGENTS, NO_SUBAGENTS);
  // Background delegations, newest first. Only the **uncollected** half is drawn
  // below: a background delegation that is still running is already a row in the
  // SUBAGENTS list above — the runtime reports it in both lists and it carries its
  // `bg` badge there — so drawing it a second time here would be one delegation
  // twice in one panel. The uncollected half is this section's reason to exist: an
  // answer is sitting in memory waiting to be read.
  const done = useSessionField((rt) => rt.uiState?.subagentsDone ?? NO_SUBAGENTS_DONE, NO_SUBAGENTS_DONE);
  const jobs = useSessionField((rt) => rt.uiState?.jobs ?? NO_JOBS, NO_JOBS);
  const stopSubagent = useApp((s) => s.stopSubagent);

  const uncollected = done.filter((row) => row.state === 'uncollected');

  // Job rows show a one-line command; a press unfolds the whole of it. Kept by
  // job id so a snapshot refresh (new array, same jobs) does not fold them.
  const [openJobs, setOpenJobs] = useState<ReadonlySet<string>>(() => new Set());
  const toggleJob = (id: string) =>
    setOpenJobs((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const { active, setActive } = useListKeys({
    count: agents.length,
    onClose: closePanel,
    onPick: () => undefined,
  });

  const stopButton = (id: string) => (
    <button
      type="button"
      className="caption muted"
      style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer' }}
      onClick={() => stopSubagent(id)}
    >
      <Tip label={t('panel.subagents.stop')}>
        <X size={12} />
      </Tip>
    </button>
  );

  return (
    <PanelShell
      title={
        both
          ? t('panel.subagents.title')
          : showAgents
            ? t('panel.subagents.titleAgents')
            : t('block.jobs')
      }
      count={both ? `${agents.length} / ${jobs.length}` : String(showAgents ? agents.length : jobs.length)}
    >
      <PanelBody>
        {showAgents ? (
          <>
        {both ? <div className="etb-label">{t('status.subagents')}</div> : null}
        {agents.length === 0 ? (
          <EmptyState title={t('panel.subagents.empty')} />
        ) : (
          agents.map((agent, i) => {
            // `provider` is shown next to the model because a name can exist
            // on more than one route. The meta line is one line that
            // ellipsis-truncates, so the label and activity get full width
            // instead of the four competing in one squeezed row.
            const meta = `${agent.provider}/${agent.model} · depth ${agent.depth} · ${agent.steps} steps · ${agent.toolCalls} calls`;
            return (
              <PanelRow
                key={agent.id}
                index={i + 1}
                active={active === i}
                onHover={() => setActive(i)}
                aside={
                  <>
                    {agent.background ? <Badge tone="info" dot={false}>{t('panel.subagents.background')}</Badge> : null}
                    {formatDuration(agent.seconds * 1000)}
                  </>
                }
              >
                <div className="panel-subagent">
                  <div className="sa-line">
                    <Bot size={12} className="muted" />
                    <span className="strong sa-ellipsis" title={agent.label}>
                      {agent.label}
                    </span>
                    {/* The stop is offered only where it can work: a background
                        delegation has a context of its own, so one child can end
                        without touching the turn. A foreground one is the turn's
                        business, and the turn's interrupt is its stop. */}
                    {agent.background ? stopButton(agent.id) : null}
                  </div>
                  <div className="sa-line sa-ellipsis" title={meta}>
                    <span className="mono caption muted">{meta}</span>
                  </div>
                  <div className="caption muted sa-ellipsis" title={agent.activity}>
                    {agent.activity}
                  </div>
                </div>
              </PanelRow>
            );
          })
        )}

        {uncollected.length > 0 ? (
          <>
            <div className="etb-label" style={{ marginTop: 'var(--space-3)' }}>
              {t('panel.subagents.done')}
            </div>
            {uncollected.map((row) => (
              <PanelRow
                key={row.id}
                aside={
                  <>
                    {row.stopReason !== '' && row.stopReason !== 'answered' ? (
                      <Badge tone={row.stopReason === 'cancelled' ? 'warning' : 'destructive'} dot={false}>
                        {row.stopReason}
                      </Badge>
                    ) : null}
                    {formatDuration(row.seconds * 1000)}
                  </>
                }
              >
                <div className="panel-subagent">
                  <div className="sa-line">
                    <Bot size={12} className="muted" />
                    <span className="strong sa-ellipsis" title={row.label}>
                      {row.label}
                    </span>
                  </div>
                  <div className="sa-line sa-ellipsis" title={`${row.provider}/${row.model} · ${row.steps} steps`}>
                    <span className="mono caption muted">
                      {row.provider}/{row.model} · {row.steps} steps
                    </span>
                  </div>
                  <div className="caption muted sa-ellipsis">{t('panel.subagents.uncollected')}</div>
                </div>
              </PanelRow>
            ))}
          </>
        ) : null}
          </>
        ) : null}

        {showJobs ? (
          <>
        {both ? (
          <div className="etb-label" style={{ marginTop: 'var(--space-3)' }}>
            {t('block.jobs')}
          </div>
        ) : null}
        {jobs.length === 0 ? (
          <EmptyState title={t('empty.jobs.title')} hint={t('empty.jobs.hint')} />
        ) : (
          jobs.map((job) => (
            <PanelRow
              key={job.id}
              onPick={() => toggleJob(job.id)}
              aside={
                <>
                  {job.uncollected ? (
                    <Badge tone="warning" dot={false}>
                      {t('jobs.uncollected')}
                    </Badge>
                  ) : null}{' '}
                  {formatDuration(job.seconds * 1000)}
                  {job.exitCode !== null ? ` · ${t('jobs.exit', { n: job.exitCode })}` : ''}
                </>
              }
            >
              <span className="mono" title={job.command}>
                {oneLine(job.command, 72)}
              </span>
              {openJobs.has(job.id) ? (
                // A click inside the text is a selection gesture, not a fold.
                <pre className="job-full mono" onClick={(e) => e.stopPropagation()}>
                  {job.command}
                </pre>
              ) : null}
            </PanelRow>
          ))
        )}
          </>
        ) : null}
      </PanelBody>
    </PanelShell>
  );
}

/* ============================================================
   Audit and wiring: the facts that explain "why did that not take effect".
   ============================================================ */
export function AuditPanel() {
  const t = useT();
  // Everything here except the two version numbers is a fact about **one**
  // session: its audit path, its permission scope, its counts, its own decoder
  // tally. The versions are window-level and read from the store.
  const key = useApp((s) => s.activeKey);
  const session = useSessionField((rt) => rt.session, null);
  const snap = useSessionField((rt) => rt.uiState, null);
  const desktopVersion = useApp((s) => s.desktopVersion);
  const runtimeVersion = useApp((s) => s.runtimeVersion);
  // **Which build answered this conversation.** The window-level `runtimeVersion`
  // is read from the binary next to this application, and on a remote screen that
  // is a different build from the one running the session — so the panel used to
  // show this machine's version beside a `protocol` that came from the host, two
  // lines contradicting each other in the one place somebody looks to resolve
  // exactly that kind of question.
  //
  // `runtimeBuild` is per session and filled on demand: `null` is "not asked
  // yet", `''` is "asked and the host did not answer", and a value is the host's
  // own `--version`. Asking on first draw is what makes the panel self-sufficient
  // — the alternative is documenting that a person must press something first.
  const runtimeBuild = useSessionField((rt) => rt.runtimeBuild, null);
  const resolveRuntimeBuild = useApp((s) => s.resolveRuntimeBuild);
  const sessionIsRemote = useApp((s) => remoteWorkspaceIdOf(s, s.activeKey) !== null);
  useEffect(() => {
    if (key !== null && sessionIsRemote && runtimeBuild === null) {
      void resolveRuntimeBuild(key);
    }
  }, [key, sessionIsRemote, runtimeBuild, resolveRuntimeBuild]);
  const dropped = useSessionField((rt) => rt.dropped, 0);
  const lateDropped = useSessionField((rt) => rt.lateDropped, 0);
  const status = useSessionField((rt) => rt.status, null);
  const askOn = useApp(useShallow((s) => selectAskOn(s, key)));
  // Two different facts, deliberately not merged:
  //   - `init.permissions` is the **config-level scope** — what `auto_approve`,
  //     `auto_approve_tools`, `shell_allow` say in the config file. It is fixed
  //     for the life of the process.
  //   - `ui(state).permission` is what the runtime has **decided live** —
  //     `granted_tools` / `granted_prefixes` grow as a person presses "always
  //     allow". It carries no config-level scope at all, which is why reading
  //     the config rows from it showed "none" over a configured file.
  const configured = session?.permissions;
  const live = snap?.permission;
  const configuredRows = configured
    ? [
        configured.auto_approve?.length
          ? `auto_approve: ${configured.auto_approve.join(',')}`
          : '',
        configured.auto_approve_tools?.length
          ? `auto_approve_tools: ${configured.auto_approve_tools.join(',')}`
          : '',
        configured.deny_tools?.length ? `deny_tools: ${configured.deny_tools.join(',')}` : '',
        configured.shell_allow?.length ? `shell_allow: ${configured.shell_allow.join(',')}` : '',
      ].filter((part) => part !== '')
    : [];

  return (
    <PanelShell title={t('panel.audit.title')} note={t('cmd.audit.desc')}>
      <PanelBody>
        <dl className="kv">
          <dt>{t('panel.audit.desktopVersion')}</dt>
          <dd className="mono">v{desktopVersion}</dd>

          {/* `dev` is shown as-is: a build without ldflags is a dev build, and
              prettifying it would hide which binary is actually running.
              On a remote screen the label says so: the number is the **host's**,
              and a reader comparing it against the desktop version above needs
              to know which machine each one came from. */}
          <dt>
            {sessionIsRemote
              ? t('panel.audit.runtimeVersionRemote')
              : t('panel.audit.runtimeVersion')}
          </dt>
          <dd className="mono">
            {sessionIsRemote
              ? runtimeBuild === null
                ? t('common.loading')
                : runtimeBuild === ''
                  ? t('panel.audit.runtimeVersionUnknown')
                  : runtimeBuild
              : runtimeVersion ?? '—'}
          </dd>

          <dt>{t('panel.audit.protocol')}</dt>
          <dd className="mono">v{session?.protocol ?? '—'}</dd>

          <dt>{t('panel.audit.workspace')}</dt>
          <dd className="mono" title={session?.workspace ?? ''}>
            {formatPath(session?.workspace ?? '—', 56)}
          </dd>

          <dt>{t('panel.audit.path')}</dt>
          <dd className="mono" title={session?.auditPath ?? ''}>
            {formatPath(session?.auditPath || '—', 56)}
          </dd>

          <dt>model</dt>
          <dd className="mono">
            {session?.model || '—'} @ {session?.provider || '—'}
          </dd>

          <dt>{t('panel.audit.contextWindow')}</dt>
          <dd className="mono">
            {session?.contextTokens === null || session?.contextTokens === undefined
              ? t('common.unknown')
              : formatTokens(session.contextTokens)}
          </dd>

          <dt>{t('session.permScope')}</dt>
          <dd className="mono">
            {askOn.length === 0 ? t('common.none') : askOn.join(', ')}
            {snap?.autopilot ? ` · ${t('session.permAuto')}` : ''}
          </dd>

          {/* Config-level scope. Read from `init`, which is the message that
              carries it (`ui(state)` never does) — the panel used to read the
              live snapshot here and reported "none" over a configured file. */}
          <dt>{t('panel.audit.permissions')}</dt>
          <dd className="mono">
            {configured ? configuredRows.join(' · ') || t('panel.audit.none') : t('common.unknown')}
          </dd>

          {/* Live authorization: what the runtime has released since start-up.
              Separate rows, because "written in the config file" and "allowed
              while this session ran" are different facts. */}
          <dt>{t('panel.audit.granted')}</dt>
          <dd className="mono">
            {live
              ? [
                  live.grantedTools.length > 0
                    ? `granted_tools: ${live.grantedTools.join(',')}`
                    : '',
                  live.grantedPrefixes.length > 0
                    ? `granted_prefixes: ${live.grantedPrefixes.join(',')}`
                    : '',
                  live.deniedTools.length > 0 ? `denied_tools: ${live.deniedTools.join(',')}` : '',
                ]
                  .filter((part) => part !== '')
                  .join(' · ') || t('panel.audit.none')
              : t('common.unknown')}
          </dd>

          {status?.meta?.catalog ? (
            <>
              <dt>catalogue</dt>
              <dd className="mono" title={status.meta.catalog}>
                {formatPath(status.meta.catalog, 56)}
              </dd>
            </>
          ) : null}

          {/* Two counters, because they are two facts. Summing them under one
              label made every delegation look like an ordering problem: those
              records carry the *child's* id, so they were "late" against the
              parent's turn and the count climbed with nothing actually late. */}
          <dt>{t('panel.audit.dropped')}</dt>
          <dd className="mono">
            {dropped}
            <span className="caption muted" style={{ marginLeft: 8 }}>
              {t('panel.audit.droppedNote')}
            </span>
          </dd>

          <dt>{t('panel.audit.late')}</dt>
          <dd className="mono">
            {lateDropped}
            <span className="caption muted" style={{ marginLeft: 8 }}>
              {t('panel.audit.lateNote')}
            </span>
          </dd>
        </dl>

        {snap && snap.agentsMd.length > 0 ? (
          <>
            <div className="etb-label">{t('panel.audit.agentsMd')}</div>
            <table className="table">
              <tbody>
                {snap.agentsMd.map((row) => (
                  <tr key={row.path}>
                    <td className="mono">{row.path}</td>
                    <td className="mono num">{row.lines}</td>
                    <td>
                      <Badge
                        tone={row.status === 'loaded' ? 'success' : row.status === 'ignored' ? 'warning' : 'destructive'}
                        dot={false}
                      >
                        {row.status}
                      </Badge>
                    </td>
                    <td className="caption muted">{row.problem ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : null}

        {snap && snap.riskScope.length > 0 ? (
          <>
            <div className="etb-label">{t('session.permScope')}</div>
            <table className="table">
              <tbody>
                {snap.riskScope.map((row) => (
                  <tr key={row.risk}>
                    <td style={{ width: 90 }}>
                      <RiskTag level={row.risk} />
                    </td>
                    <td>
                      <Badge tone={row.disposition === 'auto' ? 'success' : 'warning'} dot={false}>
                        {row.disposition === 'auto' ? t('inblock.auto') : t('inblock.ask')}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : null}
      </PanelBody>
    </PanelShell>
  );
}

/* ============================================================
   Context ledger.
   The status bar's usage chip opens this. It asks the runtime for
   `ui(context)` on mount and renders the same block the /context
   command draws in the transcript — one fact, one rendering.
   ============================================================ */
export function ContextPanel() {
  const t = useT();
  const contextMsg = useSessionField((rt) => rt.contextMsg, null);
  const refreshContext = useApp((s) => s.refreshContext);
  const enterContextView = useApp((s) => s.enterContextView);
  const leaveContextView = useApp((s) => s.leaveContextView);

  // Announce the panel for as long as it is mounted. The runtime's `ui(context)`
  // answer carries no request id, so this is how the store knows the reply has a
  // reader already looking at it — and therefore must not also append a block to
  // the transcript (see `contextPanels`). Both surfaces render this component,
  // so the popover and the dialog are covered by one rule.
  useEffect(() => {
    enterContextView();
    return leaveContextView;
  }, [enterContextView, leaveContextView]);

  useEffect(() => {
    refreshContext();
  }, [refreshContext]);

  return (
    <PanelShell title={t('inblock.context.title')} note={t('cmd.context.desc')}>
      <PanelBody>
        {contextMsg === null ? (
          <EmptyState title={t('common.loading')} />
        ) : (
          <ContextBlock p={contextMsg} />
        )}
      </PanelBody>
    </PanelShell>
  );
}

/* ============================================================
   Turn time.
   The status bar's turn chip opens this: the chip is a total, and
   this is the split beneath it — where that turn's wall time went.
   The numbers come from `ui(status).status.timing` (protocol 5),
   which the runtime sums from the audit log over that turn's own
   run_id — the same buckets the `--audit` line states.
   ============================================================ */
export function TimingPanel() {
  const t = useT();
  const timing = useSessionField((rt) => rt.status?.timing ?? null, null);
  // The split is one turn's, and the turn that just ended is the one a person
  // opens this about — so the panel asks for a fresh status rather than
  // trusting the cached copy, the way `ContextPanel` does for its ledger.
  const refreshStatus = useApp((s) => s.refreshStatus);
  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  const rows =
    timing === null
      ? []
      : [
          { key: 'model', label: t('panel.timing.model'), ms: timing.modelMs },
          { key: 'tool', label: t('panel.timing.tool'), ms: timing.toolMs },
          { key: 'waited', label: t('panel.timing.waited'), ms: timing.waitedMs },
          { key: 'human', label: t('panel.timing.human'), ms: timing.humanMs },
          { key: 'backoff', label: t('panel.timing.backoff'), ms: timing.backoffMs },
          { key: 'unattributed', label: t('panel.timing.unattributed'), ms: timing.unattributed },
        ];

  return (
    <PanelShell title={t('panel.timing.title')} note={t('panel.timing.desc')}>
      <PanelBody>
        {timing === null ? (
          // `null`, not a zero row: before a turn has run there is no total to
          // split, and "0ms model + 0ms tools" would claim one.
          <EmptyState title={t('panel.timing.empty')} />
        ) : (
          <div className="timing-panel">
            <div className="timing-total">
              <span>{t('panel.timing.run')}</span>
              <span className="mono">{formatDuration(timing.runMs)}</span>
            </div>

            {timing.runMs > 0 ? (
              // One bar per bucket, against the turn's own total. A bucket is a
              // slice of the total, so the bar is the split made visible — and a
              // bar that did not fit (unattributed floored at zero) is not
              // drawn as a negative width.
              rows
                .filter((row) => row.ms > 0)
                .map((row) => (
                  <div className="timing-row" key={row.key}>
                    <span className="timing-label">{row.label}</span>
                    <span className="timing-bar">
                      <span
                        className="timing-fill"
                        style={{ width: `${Math.min(100, (row.ms / timing.runMs) * 100)}%` }}
                      />
                    </span>
                    <span className="mono timing-value">
                      {formatDuration(row.ms)}
                      {timing.runMs > 0 ? ` · ${Math.round((row.ms / timing.runMs) * 100)}%` : ''}
                    </span>
                  </div>
                ))
            ) : (
              // The turn has no total of its own (it ended before finishing, so
              // no `run_finished` landed): the buckets are still real — the work
              // ran — but there is no denominator, so no percentages.
              rows
                .filter((row) => row.ms > 0)
                .map((row) => (
                  <div className="timing-row" key={row.key}>
                    <span className="timing-label">{row.label}</span>
                    <span className="mono timing-value">{formatDuration(row.ms)}</span>
                  </div>
                ))
            )}

            {timing.savedMs > 0 ? (
              // The saving is not a bucket of the total: it is time that was
              // saved and therefore never happened. Stated beside the bar, as
              // the `--audit` line states it, never subtracted from it.
              <div className="timing-note">
                {t('panel.timing.saved')} {formatDuration(timing.savedMs)}
              </div>
            ) : null}
          </div>
        )}
      </PanelBody>
    </PanelShell>
  );
}
