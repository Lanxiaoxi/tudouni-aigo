/**
 * The shared dropdown (`components/ui/Select.tsx`, react-select underneath).
 *
 * What is asserted here is what a static render can honestly show: which label
 * the closed control displays, that a picker with no value shows its prompt,
 * the width/face classes, and that the wiring a window would be needed to see
 * is present — the stylesheet is imported, and the panel host lets Esc close
 * an open menu before it closes the panel.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server.browser';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Select, selectMenuIsOpen } from '@/components/ui/Select';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

const OPTIONS = [
  { value: '', label: 'Auto' },
  { value: 'openai', label: 'OpenAI style' },
  { value: 'anthropic', label: 'Anthropic style' },
];

function render(props: Partial<Parameters<typeof Select>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(Select, { value: 'openai', options: OPTIONS, onChange: () => {}, ...props }),
  );
}

test('the closed control shows the label of the chosen option, not its value', () => {
  const html = render({ value: 'anthropic' });
  assert.match(html, /Anthropic style/);
  assert.doesNotMatch(html, /OpenAI style/);
});

test('an empty-string value is a real choice and shows its own label', () => {
  assert.match(render({ value: '' }), /Auto/);
});

test('a picker with no value shows its prompt and no option label', () => {
  const html = render({ value: null, placeholder: 'Pick a script' });
  assert.match(html, /Pick a script/);
  assert.doesNotMatch(html, /OpenAI style/);
});

test('size and face are classes on the container, like .cfg-input.is-short', () => {
  const html = render({ size: 'short', mono: true });
  assert.match(html, /class="[^"]*rs-select is-short is-mono/);
  assert.match(render({ size: 'tiny' }), /rs-select is-tiny/);
});

test('the field id lands on the focusable input so a label can reach it', () => {
  assert.match(render({ id: 'hk-event' }), /id="hk-event"/);
});

test('no menu is open in a static render, and the check is safe without a DOM', () => {
  assert.equal(selectMenuIsOpen(), false);
});

test('the stylesheet is imported and styles the parts react-select names', () => {
  assert.match(read('src/styles/index.css'), /@import '\.\/components\/select\.css';/);
  const css = read('src/styles/components/select.css');
  for (const part of ['control', 'menu', 'option--is-focused', 'option--is-selected', 'dropdown-indicator']) {
    assert.ok(css.includes(`.rs__${part}`), `select.css has no rule for .rs__${part}`);
  }
});

test('the packaged window allows the runtime styles react-select draws itself', () => {
  // react-select builds its flex control, absolute menu and clipped live region
  // as emotion <style> tags at runtime. When Tauri bundles the assets it appends
  // a nonce to style-src, and a nonce source makes 'unsafe-inline' inert — the
  // nonce-less emotion tag is dropped and every dropdown stacks its parts. The
  // config therefore opts out of the style-src modification it already allows.
  const conf = JSON.parse(read('src-tauri/tauri.conf.json')) as {
    app: { security: { csp: string; dangerousDisableAssetCspModification?: unknown } };
  };
  assert.deepEqual(conf.app.security.dangerousDisableAssetCspModification, ['style-src']);
  assert.match(conf.app.security.csp, /style-src 'self' 'unsafe-inline'/);
});

test('the panel host lets Esc close an open menu before it closes the panel', () => {
  const host = read('src/components/panels/PanelHost.tsx');
  assert.match(host, /selectMenuIsOpen/);
  assert.match(host, /onEscapeKeyDown/);
});
