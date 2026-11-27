/**
 * The first-run guide's rules, none of which is visible in a window when wrong:
 *
 *   - when a launch opens the guide, and on which step;
 *   - how the new route enters `providers` (first, so it is the default, and
 *     alongside every route already there — a route left out of a patch is a
 *     route deleted from the file);
 *   - when "say hi" counts as answered;
 *   - where the guide sits in the column's priority order.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  firstRunStep,
  formFor,
  formProblems,
  hasUsableRoute,
  routeFromForm,
  withRouteFirst,
} from '@/onboarding/presets';
import { helloAnswered } from '@/onboarding/hello';
import { conversationView, showsComposer } from '@/conversationView';
import { emptyModel, emptyRoute, type ConfigDocument, type RouteView } from '@/runtime/userConfig';
import type { Entry } from '@/state/entries';

function route(name: string, apiKey: string, models: string[] = ['m']): RouteView {
  return { ...emptyRoute(), name, baseUrl: 'https://x', apiKey, models: models.map((id) => ({ ...emptyModel(), id })) };
}

function doc(providers: RouteView[], problem: string | null = null): ConfigDocument {
  return {
    path: '/home/u/.tudouni/config.json',
    exists: true,
    problem,
    providers,
    web: { tavilyApiKey: '', tavilyBaseUrl: '' } as ConfigDocument['web'],
    mcp: { path: '', exists: false, problem: null, servers: [] },
    subagents: { default: '', presets: [] },
  };
}

test('a route needs a key and a model to count as usable', () => {
  assert.equal(hasUsableRoute([route('a', '')]), false);
  assert.equal(hasUsableRoute([route('a', 'k', [])]), false, 'no model means nothing to select');
  assert.equal(hasUsableRoute([route('a', ''), route('b', 'k')]), true);
});

test('the launch opens the provider step whenever no route is usable', () => {
  assert.equal(firstRunStep(doc([]), null, null), 'provider');
  // The template's empty-key routes are not configuration.
  assert.equal(firstRunStep(doc([route('deepseek', '')]), '/w', Date.now()), 'provider');
});

test('a configured route skips to the workspace step only on a true first run', () => {
  assert.equal(firstRunStep(doc([route('a', 'k')]), null, null), 'workspace');
  assert.equal(firstRunStep(doc([route('a', 'k')]), '/w', null), null, 'a remembered workspace opens as before');
  assert.equal(firstRunStep(doc([route('a', 'k')]), null, 1), null, 'a finished guide does not return');
});

test('an unreadable or broken file never starts the guide', () => {
  assert.equal(firstRunStep(null, null, null), null);
  assert.equal(firstRunStep(doc([], 'not JSON'), null, null), null);
});

test('the form refuses an empty key except for a local endpoint', () => {
  assert.deepEqual(formProblems(formFor('openai')), ['key']);
  assert.deepEqual(formProblems(formFor('ollama')), []);
  assert.deepEqual(formProblems(formFor('custom')).sort(), ['baseUrl', 'key', 'model']);
  // The runtime calls an empty key unusable, so a keyless endpoint gets a placeholder.
  assert.equal(routeFromForm(formFor('ollama')).apiKey, 'ollama');
});

test('the new route goes first and every existing route is kept', () => {
  const draft = {
    providers: [route('work', 'k1'), route('other', 'k2')],
    web: { tavilyApiKey: '', tavilyBaseUrl: '' },
    mcp: [],
  } as unknown as Parameters<typeof withRouteFirst>[0];
  const next = withRouteFirst(draft, routeFromForm({ ...formFor('openai'), apiKey: 'sk' }));
  assert.deepEqual(
    next.providers.map((r) => r.name),
    ['openai', 'work', 'other'],
  );
});

test('a keyless placeholder of the same name is replaced; a working one is not', () => {
  const base = { web: {}, mcp: [] } as unknown as Omit<Parameters<typeof withRouteFirst>[0], 'providers'>;
  const form = { ...formFor('deepseek'), apiKey: 'sk' };

  const replaced = withRouteFirst({ ...base, providers: [route('deepseek', ''), route('x', '')] }, routeFromForm(form));
  assert.deepEqual(replaced.providers.map((r) => r.name), ['deepseek', 'x']);
  assert.equal(replaced.providers[0].apiKey, 'sk');

  const kept = withRouteFirst({ ...base, providers: [route('deepseek', 'old')] }, routeFromForm(form));
  assert.deepEqual(kept.providers.map((r) => r.name), ['deepseek-2', 'deepseek']);
  assert.equal(kept.providers[1].apiKey, 'old', 'somebody\'s working key is never overwritten');
});

test('hi is answered only by a reply to a prompt typed in this window', () => {
  const typed: Entry = { kind: 'user', id: 'u', text: 'hi', atMs: 5 };
  const restored: Entry = { kind: 'user', id: 'r', text: 'old', atMs: 0 };
  const answer: Entry = { kind: 'answer', id: 'a', runId: 'r1', text: 'Hello!', userBefore: 1 };
  assert.equal(helloAnswered([]), false);
  assert.equal(helloAnswered([typed]), false, 'still waiting');
  assert.equal(helloAnswered([typed, answer]), true);
  assert.equal(helloAnswered([restored, answer]), false, 'a reopened conversation does not finish it');
  assert.equal(helloAnswered([typed, answer, { ...typed, id: 'u2' }]), false, 'the newest prompt is the one that counts');
});

test('the guide outranks everything but a start-up failure, and has no composer', () => {
  const input = {
    startupProblem: false,
    sessionProblem: true,
    board: 'sessions' as const,
    hasSession: false,
    ready: false,
    hasConversation: false,
    onboarding: true,
  };
  assert.equal(conversationView(input), 'onboarding');
  assert.equal(conversationView({ ...input, startupProblem: true }), 'startup-problem');
  assert.equal(conversationView({ ...input, onboarding: false }), 'session-problem');
  assert.equal(showsComposer('onboarding'), false);
});
