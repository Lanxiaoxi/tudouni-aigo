/**
 * The one global key whose failure is quiet and permanent: a reload.
 *
 * Every other shortcut this window swallows opens or closes something, and a
 * missed one is noticed immediately. A refresh is the opposite — the screen
 * comes back looking normal, and what was lost (the transcript on screen, the
 * draft, the input history) is gone without a word. The child that was running
 * is not killed either; it keeps working unseen.
 *
 * So the modifier combinations are asserted rather than trusted: the handler
 * used to skip the whole rule when Shift was held, which left WebView2's
 * **hard** reload (`Ctrl+Shift+R`) as an undocumented escape hatch.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isReloadKey } from '@/hooks/useGlobalKeys';

function key(name: string, mods: { ctrl?: boolean; meta?: boolean; shift?: boolean } = {}) {
  return {
    key: name,
    ctrlKey: mods.ctrl === true,
    metaKey: mods.meta === true,
    shiftKey: mods.shift === true,
  };
}

test('F5 is swallowed with and without modifiers', () => {
  assert.equal(isReloadKey(key('F5')), true);
  assert.equal(isReloadKey(key('F5', { shift: true })), true);
  assert.equal(isReloadKey(key('F5', { ctrl: true, shift: true })), true);
});

test('Ctrl/Cmd+R and Ctrl/Cmd+P are swallowed, and Shift is not an exception', () => {
  for (const name of ['r', 'R', 'p', 'P']) {
    assert.equal(isReloadKey(key(name, { ctrl: true })), true, `Ctrl+${name}`);
    assert.equal(isReloadKey(key(name, { meta: true })), true, `Cmd+${name}`);
    // The regression this suite exists for: WebView2's refresh-without-cache.
    assert.equal(
      isReloadKey(key(name, { ctrl: true, shift: true })),
      true,
      `Ctrl+Shift+${name}`,
    );
    assert.equal(
      isReloadKey(key(name, { meta: true, shift: true })),
      true,
      `Cmd+Shift+${name}`,
    );
  }
});

test('the same letters without a modifier stay ordinary typing', () => {
  for (const name of ['r', 'R', 'p', 'P', 'f', 'F']) {
    assert.equal(isReloadKey(key(name)), false, name);
    assert.equal(isReloadKey(key(name, { shift: true })), false, `Shift+${name}`);
    const letter = name.toLowerCase();
    assert.equal(
      isReloadKey(key(name, { ctrl: true })),
      letter === 'r' || letter === 'p',
      `Ctrl+${name}`,
    );
  }
});

test('Ctrl+F is not a reload key any more: it is the transcript find', () => {
  assert.equal(isReloadKey(key('f', { ctrl: true })), false);
  assert.equal(isReloadKey(key('F', { ctrl: true, shift: true })), false);
});
