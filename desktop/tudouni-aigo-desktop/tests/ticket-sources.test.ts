/**
 * Ticket Sources, the pure half (docs/design/ticket-sources.md §3, §4).
 *
 * Three ways the form could be wrong without anybody noticing:
 *
 *   - **A save that eats a field.** `sources.json` is edited by hand as well as
 *     by the panel, and the design says unknown fields are ignored, not
 *     rejected. A read-edit-write that rebuilt each source from the fields this
 *     version knows would delete the rest, silently.
 *   - **A file that cannot be read treated as an empty one.** Saving over it
 *     would destroy what somebody was half-way through fixing.
 *   - **A kind with no way to be filled in.** The form is one table; a kind
 *     missing a required parameter, or a default template that is not a valid
 *     source, only shows when somebody picks that kind.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { en } from '@/i18n';
import {
  PROBE_KINDS,
  PROBE_SPECS,
  emptySource,
  filterToRows,
  parseJsonParam,
  parseNumberInput,
  parseSourcesFile,
  rowsToFilter,
  serializeSourcesFile,
  setEmitField,
  setProbeParam,
  setSourceField,
  summarizeScan,
  validateSource,
  describeScan,
  type ScanReport,
  type SourceConfig,
} from '@/ticket/sources';
import { makeT } from '@/i18n';

function valid(overrides: Partial<SourceConfig> = {}): SourceConfig {
  return {
    ...emptySource('github.branch', []),
    probe: { kind: 'github.branch', repo: 'org/repo', branch: 'main' },
    ...overrides,
  };
}

/* ============================================================
   parse / serialize
   ============================================================ */

test('a missing or blank file is no sources, not a problem', () => {
  for (const text of [null, '', '  \n']) {
    const { file, problem } = parseSourcesFile(text);
    assert.equal(problem, null);
    assert.deepEqual(file, { schema: 1, sources: [] });
  }
});

test('serialize uses two spaces and ends with a newline', () => {
  const text = serializeSourcesFile({ schema: 1, sources: [] });
  assert.equal(text, '{\n  "schema": 1,\n  "sources": []\n}\n');
});

test('read, edit, write keeps every field the panel does not know', () => {
  const original = {
    schema: 1,
    note: 'top-level extra',
    sources: [
      {
        id: 'a',
        probe: { kind: 'github.branch', repo: 'o/r', branch: 'main', futureParam: [1, 2] },
        emit: { brief: 'b', futureEmit: true, workspace: { kind: 'active' } },
        owner: 'me',
      },
    ],
  };
  const { file, problem } = parseSourcesFile(JSON.stringify(original));
  assert.equal(problem, null);

  let src = file.sources[0]!;
  src = setSourceField(src, 'name', 'Renamed');
  src = setProbeParam(src, 'branch', 'dev');
  src = setEmitField(src, 'title', 'T');
  const written = JSON.parse(serializeSourcesFile({ ...file, sources: [src] }));

  assert.equal(written.note, 'top-level extra');
  assert.equal(written.sources[0].owner, 'me');
  assert.deepEqual(written.sources[0].probe.futureParam, [1, 2]);
  assert.equal(written.sources[0].emit.futureEmit, true);
  assert.equal(written.sources[0].name, 'Renamed');
  assert.equal(written.sources[0].probe.branch, 'dev');
  assert.equal(written.sources[0].emit.title, 'T');
});

test('an unchanged file round-trips to the same document', () => {
  const doc = { schema: 1, sources: [valid()] };
  const text = serializeSourcesFile(doc);
  const { file } = parseSourcesFile(text);
  assert.equal(serializeSourcesFile(file), text);
});

test('a file that cannot be read comes back as a problem, never as an empty list', () => {
  assert.equal(parseSourcesFile('{ nope').problem?.code, 'json');
  assert.equal(parseSourcesFile('[]').problem?.code, 'shape');
  assert.equal(parseSourcesFile('{"schema":2,"sources":[]}').problem?.code, 'schema');
  assert.equal(parseSourcesFile('{"schema":1,"sources":{}}').problem?.code, 'shape');
  // A non-object entry would otherwise be dropped on the next save.
  assert.equal(parseSourcesFile('{"schema":1,"sources":[1]}').problem?.code, 'entry');
});

test('editing returns copies and undefined removes a field', () => {
  const src = valid({ name: 'x' });
  const next = setSourceField(src, 'name', undefined);
  assert.equal('name' in next, false);
  assert.equal(src.name, 'x');
  const probe = setProbeParam(src, 'branch', undefined);
  assert.equal('branch' in probe.probe, false);
  assert.equal(src.probe.branch, 'main');
});

/* ============================================================
   emptySource
   ============================================================ */

test('emptySource picks an id nobody has', () => {
  assert.equal(emptySource('github.pulls', []).id, 'github-pulls');
  assert.equal(emptySource('github.pulls', ['github-pulls']).id, 'github-pulls-2');
  assert.equal(emptySource('github.pulls', ['github-pulls', 'github-pulls-2']).id, 'github-pulls-3');
});

test('every kind makes a source whose id is legal', () => {
  for (const kind of PROBE_KINDS) {
    assert.deepEqual(
      Object.keys(validateSource(emptySource(kind, []), [])).filter((k) => k === 'id' || k === 'kind'),
      [],
      kind,
    );
  }
});

test('emptySource fills only the required params that have a default', () => {
  assert.equal(emptySource('github.branch', []).probe.branch, 'main');
  assert.equal(emptySource('schedule', []).probe.every, 'daily');
  // `repo` is required and has no default: it stays empty so the form says so.
  assert.equal('repo' in emptySource('github.branch', []).probe, false);
});

/* ============================================================
   validateSource
   ============================================================ */

test('a complete source has no errors', () => {
  assert.deepEqual(validateSource(valid(), []), {});
});

test('id: required, shaped, unique', () => {
  assert.equal(validateSource(valid({ id: '' }), []).id, 'required');
  for (const bad of ['Upper', '-lead', '_lead', 'has space', 'dot.ted', 'a'.repeat(65)]) {
    assert.equal(validateSource(valid({ id: bad }), []).id, 'format', bad);
  }
  for (const good of ['a', '0', 'a-b_c', 'a'.repeat(64)]) {
    assert.equal(validateSource(valid({ id: good }), []).id, undefined, good);
  }
  assert.equal(validateSource(valid({ id: 'x' }), [valid({ id: 'x' })]).id, 'duplicate');
  assert.equal(validateSource(valid({ id: 'x' }), [valid({ id: 'y' })]).id, undefined);
});

test('an unknown kind is reported, and no parameters are checked against it', () => {
  const errors = validateSource(valid({ probe: { kind: 'carrier.pigeon' } }), []);
  assert.equal(errors.kind, 'unknownKind');
  assert.deepEqual(Object.keys(errors).filter((k) => k.startsWith('probe.')), []);
});

test('required parameters are reported by name', () => {
  const errors = validateSource(valid({ probe: { kind: 'github.branch' } }), []);
  assert.equal(errors['probe.repo'], 'required');
  // `branch` is required but defaults to main, so leaving it empty is fine.
  assert.equal(errors['probe.branch'], undefined);
  assert.equal(validateSource(valid({ probe: { kind: 'github.branch', repo: '  ' } }), [])['probe.repo'], 'required');
});

test('parameter types, ranges and options are checked', () => {
  const base = { kind: 'github.pulls', repo: 'o/r' };
  const check = (extra: Record<string, unknown>, key: string) =>
    validateSource(valid({ probe: { ...base, ...extra } }), [])[`probe.${key}`];

  assert.equal(check({ repo: 'noslash' }, 'repo'), 'format');
  assert.equal(check({ state: 'merged' }, 'state'), 'option');
  assert.equal(check({ perPage: 0 }, 'perPage'), 'range');
  assert.equal(check({ perPage: 101 }, 'perPage'), 'range');
  assert.equal(check({ perPage: 100 }, 'perPage'), undefined);
  assert.equal(check({ perPage: 'abc' }, 'perPage'), 'type');
  assert.equal(check({ timeoutSec: 601 }, 'timeoutSec'), 'range');
});

test('json parameters: argv must be a list of strings, headers an object', () => {
  const run = (value: unknown) =>
    validateSource(valid({ probe: { kind: 'command', run: value } }), [])['probe.run'];
  assert.equal(run(['python', 'x.py']), undefined);
  assert.equal(run(undefined), 'required');
  assert.equal(run([]), 'required');
  assert.equal(run('python x.py'), 'json');
  assert.equal(run([1, 2]), 'json');
  assert.equal(run({ a: 1 }), 'json');

  const headers = (value: unknown) =>
    validateSource(valid({ probe: { kind: 'http.json', url: 'u', key: 'id', headers: value } }), [])[
      'probe.headers'
    ];
  assert.equal(headers({ A: 'b' }), undefined);
  assert.equal(headers(undefined), undefined);
  assert.equal(headers([1]), 'json');
  assert.equal(headers('{oops'), 'json');
});

test('on: not empty, only known events', () => {
  assert.equal(validateSource(valid({ on: [] }), []).on, 'empty');
  assert.equal(validateSource(valid({ on: ['changed'] }), []).on, undefined);
  // Left out entirely means the default, which is not an error.
  const { on: _on, ...rest } = valid();
  assert.equal(validateSource(rest as SourceConfig, []).on, undefined);
  assert.equal(validateSource(valid({ on: ['exploded'] as never }), []).on, 'type');
});

test('limit: a whole number from 1 to 200', () => {
  for (const bad of [0, 201, 1.5, -3]) {
    assert.equal(validateSource(valid({ limit: bad }), []).limit, 'range', String(bad));
  }
  for (const good of [1, 20, 200]) {
    assert.equal(validateSource(valid({ limit: good }), []).limit, undefined, String(good));
  }
  assert.equal(validateSource(valid({ limit: 'many' as never }), []).limit, 'type');
});

test('brief must not be blank', () => {
  assert.equal(validateSource(valid({ emit: { brief: '' } }), []).brief, 'required');
  assert.equal(validateSource(valid({ emit: { brief: '   \n' } }), []).brief, 'required');
  assert.equal(validateSource(valid({ emit: {} }), []).brief, 'required');
  assert.equal(validateSource(valid({ emit: { brief: 'do it' } }), []).brief, undefined);
});

test('filter values must be strings; initial must be a known mode', () => {
  assert.equal(validateSource(valid({ filter: { 'fields.title': '*fix*' } }), []).filter, undefined);
  assert.equal(validateSource(valid({ filter: { a: 1 } as never }), []).filter, 'type');
  assert.equal(validateSource(valid({ initial: 'nope' as never }), []).initial, 'option');
});

/* ============================================================
   input helpers
   ============================================================ */

test('a number box keeps what cannot be a number, so validation can say so', () => {
  assert.equal(parseNumberInput(''), undefined);
  assert.equal(parseNumberInput(' 12 '), 12);
  assert.equal(parseNumberInput('1.5'), '1.5');
  assert.equal(parseNumberInput('abc'), 'abc');
});

test('a json box keeps what does not parse, so Save stays blocked', () => {
  assert.equal(parseJsonParam(' '), undefined);
  assert.deepEqual(parseJsonParam('["a"]'), ['a']);
  assert.equal(parseJsonParam('["a"'), '["a"');
});

test('filter rows leave out blank paths and collapse to undefined when empty', () => {
  assert.deepEqual(filterToRows({ 'fields.a': 'x*' }), [{ path: 'fields.a', glob: 'x*' }]);
  assert.deepEqual(filterToRows(undefined), []);
  assert.equal(rowsToFilter([{ path: ' ', glob: 'x' }]), undefined);
  assert.deepEqual(rowsToFilter([{ path: 'key', glob: 'a*' }, { path: '', glob: '' }]), { key: 'a*' });
});

/* ============================================================
   PROBE_SPECS
   ============================================================ */

test('every kind has a spec, with fields and a default emit template', () => {
  assert.equal(PROBE_KINDS.length, 12);
  assert.deepEqual(Object.keys(PROBE_SPECS).sort(), [...PROBE_KINDS].sort());
  for (const kind of PROBE_KINDS) {
    const spec = PROBE_SPECS[kind];
    assert.ok(spec.fields.length > 0, kind);
    assert.ok(spec.fields.some((f) => f.required), `${kind} has no required parameter`);
    const d = spec.defaults;
    assert.ok(d.on.length > 0, `${kind}: on`);
    assert.notEqual(d.thread.trim(), '', `${kind}: thread`);
    assert.notEqual(d.brief.trim(), '', `${kind}: brief`);
    assert.notEqual(d.title.trim(), '', `${kind}: title`);
    assert.equal(typeof d.url, 'string', `${kind}: url`);
  }
});

test('a parameter is declared once per kind, and select fields list their options', () => {
  for (const kind of PROBE_KINDS) {
    const keys = PROBE_SPECS[kind].fields.map((f) => f.key);
    assert.equal(new Set(keys).size, keys.length, `${kind} repeats a parameter`);
    for (const f of PROBE_SPECS[kind].fields) {
      if (f.type === 'select') assert.ok((f.options ?? []).length > 0, `${kind}.${f.key}`);
      if (f.type === 'number') {
        assert.ok(f.min === undefined || f.max === undefined || f.min <= f.max, `${kind}.${f.key}`);
      }
    }
  }
});

test('the default templates the design names', () => {
  assert.equal(PROBE_SPECS['github.pulls'].defaults.thread, 'pr#{key}');
  assert.equal(PROBE_SPECS['github.pulls'].defaults.title, 'PR #{key}: {fields.title}');
  assert.equal(PROBE_SPECS['github.pulls'].defaults.url, '{fields.url}');
  assert.deepEqual(PROBE_SPECS['github.branch'].defaults.on, ['changed']);
  assert.equal(PROBE_SPECS['github.branch'].defaults.thread, 'push#{version}');
});

test('a fresh source of every kind is valid once its required blanks are filled', () => {
  const blanks: Record<string, unknown> = {
    repo: 'o/r',
    ref: 'main',
    url: 'https://example.com',
    path: 'D:/x',
    glob: 'D:/x/*',
    key: 'id',
    run: ['x'],
  };
  for (const kind of PROBE_KINDS) {
    let src = emptySource(kind, []);
    for (const f of PROBE_SPECS[kind].fields) {
      if (f.required && src.probe[f.key] === undefined) src = setProbeParam(src, f.key, blanks[f.key]);
    }
    assert.deepEqual(validateSource(src, []), {}, kind);
  }
});

test('every label and hint key the table names exists in the catalogue', () => {
  const missing: string[] = [];
  for (const kind of PROBE_KINDS) {
    for (const key of [`ticket.sources.kind.${kind}`, `ticket.sources.kind.${kind}.hint`]) {
      if (!(key in en)) missing.push(key);
    }
    for (const f of PROBE_SPECS[kind].fields) {
      for (const key of [f.labelKey, f.hintKey]) if (!(key in en)) missing.push(key);
      for (const option of f.options ?? []) {
        const key = `ticket.sources.opt.${option}`;
        if (!(key in en)) missing.push(key);
      }
    }
  }
  assert.deepEqual([...new Set(missing)], []);
});

/* ============================================================
   what a scan says
   ============================================================ */

const report = (over: Partial<ScanReport>): ScanReport => ({ configError: null, sources: [], ...over });
const row = (over: Record<string, unknown>) => ({
  id: 's',
  ok: true,
  error: null,
  skipped: null,
  baseline: false,
  total: 0,
  emitted: 0,
  deferred: 0,
  ...over,
});

test('the scan summary counts drops, baselines and failures, and ignores disabled sources', () => {
  const summary = summarizeScan(
    report({
      sources: [
        row({ id: 'a', emitted: 2 }),
        row({ id: 'b', baseline: true, total: 5 }),
        row({ id: 'c', ok: false, error: 'boom' }),
        row({ id: 'd', skipped: 'disabled' }),
        row({ id: 'e', ok: false, skipped: 'invalid', error: 'bad id' }),
      ],
    }),
  );
  assert.equal(summary.emitted, 2);
  assert.equal(summary.baselines, 1);
  assert.equal(summary.scanned, 4);
  assert.deepEqual(summary.failures.map((f) => f.id), ['c', 'e']);
});

test('the scan sentence points at Check inbox only when something was dropped', () => {
  const t = makeT();
  const dropped = describeScan(report({ sources: [row({ emitted: 2 })] }), t);
  assert.match(dropped, /2 dropped into the inbox/);
  assert.match(dropped, /Check inbox/);

  const quiet = describeScan(report({ sources: [row({ baseline: true })] }), t);
  assert.match(quiet, /1 set a baseline/);
  assert.doesNotMatch(quiet, /Check inbox/);

  const failed = describeScan(report({ sources: [row({ id: 'gh', ok: false, error: 'HTTP 403' })] }), t);
  assert.match(failed, /gh: HTTP 403/);

  assert.match(describeScan(report({ configError: 'not JSON' }), t), /not JSON/);
  assert.match(describeScan(report({}), t), /No enabled sources/);
  assert.match(describeScan(report({ sources: [row({})] }), t), /Nothing changed/);
});
