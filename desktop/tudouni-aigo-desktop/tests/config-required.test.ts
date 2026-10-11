/**
 * The marker on a config field matches the rule that refuses the save.
 *
 * The asterisks on the config panel's labels are **derived**: a field carries
 * one exactly when leaving it empty comes back from `validateDraft` as a
 * `blocking` problem — i.e. when it is one of the fields that grey out Save. Two
 * lists saying the same thing is fine; two lists *drifting* is the failure this
 * file exists for, and it is one nobody reports: the field still works, the save
 * is still refused, only the label promises something else than the button does.
 *
 * So the invariant is asserted from both ends:
 *
 *   - which labels carry the marker, read out of `ConfigPanel.tsx` as text;
 *   - what `validateDraft` actually does to a draft with that field blanked.
 *
 * The TSX half is read as text for the same reason `stream-layout.test.ts` reads
 * a stylesheet as text: there is no build step between the two halves and no
 * runtime behaviour to observe in Node, and what is being protected is the
 * presence of a prop rather than its effect. An assertion over a rendered tree
 * would need a browser and would not fail any less clearly.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { blockingProblems, draftFrom, validateDraft, type ConfigDocument, type Draft } from '../src/runtime/userConfig.ts';

// Resolved from the project root and not from `import.meta.url`: the suites are
// bundled into `.test-build/` before they run, so a path relative to this module
// would point inside the build directory. The runner sets `cwd` to the root.
const tsx = readFileSync(
  resolve(process.cwd(), 'src', 'components', 'panels', 'ConfigPanel.tsx'),
  'utf8',
);

/**
 * The i18n keys of the fields that carry the marker, as written.
 *
 * Naive on purpose: it finds each `<Field …>` tag and asks whether `required`
 * appears among its props. `required` is only ever used as a bare boolean prop,
 * so a match on the word is a match on the prop — and the `Field` definition's
 * own `required?: boolean` is not a JSX tag, so it is not in scope here.
 */
function markedFields(): string[] {
  const keys: string[] = [];
  for (const tag of tsx.matchAll(/<Field\b[\s\S]*?>/g)) {
    const props = tag[0];
    const label = props.match(/label=\{t\('([^']+)'\)\}/);
    assert.ok(label !== null, `a <Field> has no t('…') label: ${props.slice(0, 120)}`);
    if (/(?:^|\s)required(?:\s|\/?>|$)/m.test(props)) keys.push(label[1]);
  }
  return keys;
}

/**
 * A document nothing is wrong with, so a mutation is the only reason for a
 * problem. Every value a `blocking` rule looks at is filled in.
 */
function sound(): ConfigDocument {
  return {
    path: '/home/somebody/.tudouni/config.json',
    exists: true,
    problem: null,
    providers: [
      {
        name: 'zhipu',
        displayName: '',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        apiKey: 'k-1',
        apiStyle: '',
        verify: true,
        headers: [],
        effortLevels: [],
        models: [
          {
            id: 'glm-5.2',
            label: '',
            contextWindow: 1048576,
            summary: '',
            note: '',
            vision: false,
            reasoningEffort: '',
            effortLevels: [],
          },
        ],
      },
    ],
    web: { tavilyApiKey: '', tavilyBaseUrl: '' },
    mcp: {
      path: '/home/somebody/.tudouni/mcp.json',
      exists: true,
      problem: null,
      servers: [
        { name: 'fs', command: 'npx', url: '', args: [], env: [], headers: [], timeoutSeconds: null },
      ],
    },
  };
}

/** The first route, first model and first MCP server, as an editable draft. */
function draft(): Draft {
  return draftFrom(sound());
}

test('a document with nothing wrong is not blocked at all', () => {
  // The control for every case below: without this, a `validateDraft` that
  // reported *everything* as blocking would satisfy them all.
  assert.deepEqual(blockingProblems(validateDraft(draft())), []);
});

test('the marked fields are the ones whose emptiness refuses the save', () => {
  const blanked: Record<string, (d: Draft) => void> = {
    'panel.config.name': (d) => {
      d.providers[0].name = '';
    },
    'panel.config.baseUrl': (d) => {
      d.providers[0].baseUrl = '';
    },
    'panel.config.modelId': (d) => {
      d.providers[0].models[0].id = '';
    },
    // Both transports, and that is not two answers to one question: the runtime
    // refuses a server that names *both* as readily as one that names neither,
    // so which of the two is required depends on which radio is selected, and
    // the panel marks both. The test blanks both at once, which is the
    // neither-named case.
    'panel.config.mcpCommand': (d) => {
      d.mcp[0].command = '';
    },
    'panel.config.mcpUrl': (d) => {
      d.mcp[0].command = '';
      d.mcp[0].url = '';
    },
  };

  for (const [key, blank] of Object.entries(blanked)) {
    const d = draft();
    blank(d);
    assert.ok(
      blockingProblems(validateDraft(d)).length > 0,
      `${key} is marked required in the panel, but blanking it does not block the save`,
    );
  }

  assert.deepEqual(
    [...new Set(markedFields())].sort(),
    Object.keys(blanked).sort(),
    'the panel marks a different set of fields than the ones that block the save',
  );
});

test('every field the panel leaves unmarked may be left empty', () => {
  // The other direction, and the one that catches an over-eager asterisk: a
  // marker on a field whose emptiness is *fine* refuses work the panel should
  // do. Each entry names a field the panel deliberately does not mark.
  const cleared: Record<string, (d: Draft) => void> = {
    'panel.config.apiKey': (d) => {
      d.providers[0].apiKey = '';
    },
    'panel.config.displayName': (d) => {
      d.providers[0].displayName = '';
    },
    'panel.config.apiStyle': (d) => {
      d.providers[0].apiStyle = '';
    },
    'panel.config.headers': (d) => {
      d.providers[0].headers = [];
    },
    'panel.config.effortLevels': (d) => {
      d.providers[0].effortLevels = [];
    },
    'panel.config.modelLabel': (d) => {
      d.providers[0].models[0].label = '';
    },
    // **The one that looks like it should be marked and must not be.** Null
    // means "the catalogue does not know this model", which is a real answer —
    // the interface then reports usage without a percentage, and a wrong
    // percentage is worse than none. What the panel *does* refuse is a value
    // that is not a positive integer, and that is a rule about what is typed
    // rather than about whether anything was.
    'panel.config.contextWindow': (d) => {
      d.providers[0].models[0].contextWindow = null;
    },
    'panel.config.reasoningEffort': (d) => {
      d.providers[0].models[0].reasoningEffort = '';
    },
    'panel.config.modelEffortLevels': (d) => {
      d.providers[0].models[0].effortLevels = [];
    },
    'panel.config.mcpArgs': (d) => {
      d.mcp[0].args = [];
    },
    'panel.config.mcpEnv': (d) => {
      d.mcp[0].env = [];
    },
    'panel.config.mcpTimeout': (d) => {
      d.mcp[0].timeoutSeconds = null;
    },
  };

  for (const [key, clear] of Object.entries(cleared)) {
    const d = draft();
    clear(d);
    assert.deepEqual(
      blockingProblems(validateDraft(d)),
      [],
      `${key} is not marked required, but emptying it blocks the save`,
    );
    assert.ok(
      !markedFields().includes(key),
      `${key} carries the required marker, but emptying it is allowed`,
    );
  }

  // And a value rule is still a rule: a context window of zero is refused, which
  // is exactly why the marker above had to be about emptiness rather than about
  // the field.
  const zeroed = draft();
  zeroed.providers[0].models[0].contextWindow = 0;
  assert.ok(
    blockingProblems(validateDraft(zeroed)).length > 0,
    'a context window of zero is no longer refused, so nothing keeps the empty field meaningful',
  );
});
