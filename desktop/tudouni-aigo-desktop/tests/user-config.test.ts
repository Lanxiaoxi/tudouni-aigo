/**
 * The config panel's rules.
 *
 * Two of them are worth a test rather than a look at the screen, because both
 * failures are **invisible in a rendered string**:
 *
 *   - the order of `providers` decides the default route, so a save that
 *     re-orders them silently moves every request to another account;
 *   - a section that did not change must not be sent, or opening this panel to
 *     fix a key would create `mcp.json` — a list of programs the runtime runs at
 *     startup.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  API_STYLES,
  blockingProblems,
  buildPatch,
  draftFrom,
  emptyRoute,
  emptyServer,
  isDirty,
  linesOf,
  moved,
  validateDraft,
  type ConfigDocument,
} from '../src/runtime/userConfig.ts';

/** A document shaped like the Rust side's reply. */
function document(overrides: Partial<ConfigDocument> = {}): ConfigDocument {
  return {
    path: '/home/somebody/.tudouni/config.json',
    exists: true,
    problem: null,
    providers: [
      {
        name: 'zeta',
        displayName: '',
        baseUrl: 'https://z.example',
        apiKey: 'kz',
        apiStyle: '',
        verify: true,
        headers: [],
        effortLevels: [],
        models: [{ id: 'z-1', label: '', contextWindow: 1000, summary: '', note: '', vision: false, reasoningEffort: '', effortLevels: [] }],
      },
      {
        name: 'alpha',
        displayName: '',
        baseUrl: 'https://a.example',
        apiKey: '',
        apiStyle: 'anthropic',
        verify: true,
        headers: [{ key: 'User-Agent', value: 'tudouni/0.2' }],
        effortLevels: ['low', 'high'],
        models: [],
      },
    ],
    web: { tavilyApiKey: '', tavilyBaseUrl: '' },
    mcp: { path: '/home/somebody/.tudouni/mcp.json', exists: false, problem: null, servers: [] },
    ...overrides,
  };
}

test('a fresh draft sends nothing — a panel opened and closed writes no file', () => {
  const doc = document();
  const draft = draftFrom(doc);
  assert.equal(isDirty(doc, draft), false);
  assert.deepEqual(buildPatch(doc, draft), {});
});

test('the route order is the document order, not the sorted order', () => {
  const doc = document();
  const draft = draftFrom(doc);
  // This is the whole point: `zeta` is first because the file lists it first,
  // and the runtime takes the first usable route as the default.
  assert.deepEqual(
    draft.providers.map((route) => route.name),
    ['zeta', 'alpha'],
  );

  // Re-ordering is a change worth writing, and it arrives in the new order.
  const swapped = { ...draft, providers: moved(draft.providers, 1, 0) };
  const patch = buildPatch(doc, swapped);
  assert.deepEqual(
    patch.providers?.map((route) => route.name),
    ['alpha', 'zeta'],
  );
});

test('an edit to the routes does not carry the mcp section', () => {
  const doc = document();
  const draft = draftFrom(doc);
  draft.providers[0]!.apiKey = 'new-key';
  const patch = buildPatch(doc, draft);
  assert.ok(patch.providers, 'the edited routes are sent');
  assert.equal(patch.mcp, undefined, 'mcp.json is not written as a side effect');
  assert.equal(patch.web, undefined, 'an untouched web section is not sent');
});

test('editing a server sends only the mcp section', () => {
  const doc = document({
    mcp: {
      path: '/home/somebody/.tudouni/mcp.json',
      exists: true,
      problem: null,
      servers: [{ name: 'fs', command: 'npx', url: '', args: ['-y', 'server-fs'], env: [], headers: [], timeoutSeconds: null }],
    },
  });
  const draft = draftFrom(doc);
  draft.mcp[0]!.args = ['-y', 'server-fs', '--root', '.'];
  const patch = buildPatch(doc, draft);
  assert.deepEqual(patch.providers, undefined);
  assert.equal(patch.mcp?.length, 1);
});

test('a file that could not be read is never written', () => {
  // The merge needs an object to preserve; with none, a write would be a
  // wholesale replacement of the file that holds somebody's keys.
  const doc = document({ problem: 'config.json is not valid JSON', providers: [] });
  const draft = draftFrom(doc);
  draft.web.tavilyApiKey = 'tvly-1';
  assert.deepEqual(buildPatch(doc, draft), {});
  assert.equal(isDirty(doc, draft), false);
});

test('a broken mcp.json does not lock the routes editor', () => {
  // Two files, two failures: the routes are still editable while mcp.json is
  // not, which is the case that matters when the key is the thing being fixed.
  const doc = document({
    mcp: { path: '/x/mcp.json', exists: true, problem: 'mcp.json has a key the runtime does not accept', servers: [] },
  });
  const draft = draftFrom(doc);
  draft.providers[0]!.baseUrl = 'https://z2.example';
  const patch = buildPatch(doc, draft);
  assert.ok(patch.providers, 'the routes are still writable');
  assert.equal(patch.mcp, undefined, 'the broken file is left alone');
});

/** The texts of the problems, for readable assertions. */
function texts(problems: { text: string }[]): string {
  return problems.map((problem) => problem.text).join(' | ');
}

test('validation catches the mistakes that would write a file the runtime refuses', () => {
  const base = draftFrom(document());

  const noName = { ...base, providers: [{ ...emptyRoute(), baseUrl: 'https://x.example', models: [] }] };
  assert.match(texts(validateDraft(noName)), /has no name/);

  const duplicate = {
    ...base,
    providers: [
      { ...emptyRoute(), name: 'same', baseUrl: 'https://a.example', models: [{ ...emptyRoute().models[0], id: 'm' }] },
      { ...emptyRoute(), name: 'same', baseUrl: 'https://b.example' },
    ],
  };
  assert.match(texts(validateDraft(duplicate)), /both named/);

  const noBaseUrl = { ...base, providers: [{ ...emptyRoute(), name: 'r' }] };
  assert.match(texts(validateDraft(noBaseUrl)), /needs a base URL/);

  const badWindow = {
    ...base,
    providers: [
      {
        ...emptyRoute(),
        name: 'r',
        baseUrl: 'https://a.example',
        models: [{ ...emptyRoute().models[0], id: 'm', contextWindow: 0 }],
      },
    ],
  };
  assert.match(texts(validateDraft(badWindow)), /whole number above zero/);
});

test('a route with no models warns but does not block the save', () => {
  // The runtime only *warns* about this (`catalog.problem.no_models`) and the
  // session still starts, and an empty list is the normal state of a route
  // somebody has just added — so blocking here would make "add a route, then
  // fill in its models" impossible to do in two steps.
  const draft = draftFrom(document());
  draft.providers[1]!.models = [];
  const problems = validateDraft(draft);
  const aboutModels = problems.filter((problem) => problem.text.includes('no models'));
  assert.equal(aboutModels.length, 1);
  assert.equal(aboutModels[0]!.blocking, false);
  assert.deepEqual(blockingProblems(problems), []);
});

test('removing every route is blocking, because it deletes every key', () => {
  const draft = draftFrom(document());
  draft.providers = [];
  const blocking = blockingProblems(validateDraft(draft));
  assert.equal(blocking.length, 1);
  assert.match(blocking[0]!.text, /remove every key/);
});

test('an MCP server needs exactly one of a command or a URL', () => {
  const base = draftFrom(document());
  const both = {
    ...base,
    mcp: [{ name: 'x', command: 'npx', url: 'https://x.example', args: [], env: [], headers: [], timeoutSeconds: null, autoLoad: false }],
  };
  assert.match(texts(blockingProblems(validateDraft(both))), /exactly one/);

  const neither = { ...base, mcp: [{ name: 'x', command: '', url: '', args: [], env: [], headers: [], timeoutSeconds: null, autoLoad: false }] };
  assert.match(texts(blockingProblems(validateDraft(neither))), /exactly one/);

  const stdio = { ...base, mcp: [{ name: 'x', command: 'npx', url: '', args: [], env: [], headers: [], timeoutSeconds: null, autoLoad: false }] };
  assert.equal(
    validateDraft(stdio).filter((problem) => problem.text.includes('MCP server')).length,
    0,
  );
});

test('auto_load is off for a new server, and an untouched switch is not a change', () => {
  // The runtime reads an absent key as false, so there is one unticked box rather
  // than a third "unset" state to draw.
  assert.equal(emptyServer().autoLoad, false);

  const doc = document({
    mcp: {
      path: '/home/somebody/.tudouni/mcp.json',
      exists: true,
      problem: null,
      servers: [
        {
          name: 'codegraph',
          command: 'codegraph',
          url: '',
          args: [],
          env: [],
          headers: [],
          timeoutSeconds: 120,
          autoLoad: true,
        },
      ],
    },
  });

  const draft = draftFrom(doc);
  assert.equal(draft.mcp[0]!.autoLoad, true);
  // Opening the panel and closing it must not write the file: a save that dropped
  // this key would quietly turn a server that starts with the session back into one
  // that waits for /mcp.
  assert.equal(isDirty(doc, draft), false);

  // Flipping it off is a real change, and it is the whole field that travels.
  const off = { ...draft, mcp: [{ ...draft.mcp[0]!, autoLoad: false }] };
  assert.deepEqual(buildPatch(doc, off).mcp?.[0]?.autoLoad, false);
});

test('the protocol list is the catalogue\'s three styles, plus "infer it"', () => {
  // `styleField` refuses anything else outright, so a text field here would
  // invite a value the runtime rejects. The empty string is the first entry: it
  // means "work it out from base_url", which is right for almost every route.
  assert.deepEqual([...API_STYLES], ['', 'openai', 'anthropic', 'responses']);
});

test('line lists drop blanks, which is what an empty textarea means', () => {
  assert.deepEqual(linesOf('a\n\n  b  \n'), ['a', 'b']);
  assert.deepEqual(linesOf(''), []);
});

test('moved() stops at the edges rather than wrapping', () => {
  const list = ['a', 'b', 'c'];
  assert.deepEqual(moved(list, 0, -1), list);
  assert.deepEqual(moved(list, 2, 3), list);
  assert.deepEqual(moved(list, 0, 2), ['b', 'c', 'a']);
  // A new array every time, so React sees a change rather than the same one.
  assert.notEqual(moved(list, 0, 2), list);
});
