/**
 * The splitter's arithmetic: the sign of a drag and of an arrow key.
 *
 * Same worry as `rail-drag.test.ts`: `start + dx` reads sensibly and produces a
 * column that narrows as you pull it wider. The dock's outer handle is on its
 * *left* edge (grows toward the start), the navigator's is on *its* right edge
 * (grows toward the end), and the terminal's is on its top edge (grows upward),
 * so all four directions are asserted.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  SPLITTER_STEP,
  SPLITTER_STEP_LARGE,
  draggedValue,
  keyboardValue,
  type SplitterKeyInput,
} from '@/state/workspaceDock/splitter';

test('drag: a handle on the start edge grows when pulled toward the start', () => {
  // The dock: pulling its left edge leftwards (negative travel) widens it.
  assert.equal(draggedValue(500, -40, 'start', 320, 1000), 540);
  assert.equal(draggedValue(500, 40, 'start', 320, 1000), 460);
});

test('drag: a handle on the end edge grows when pulled toward the end', () => {
  assert.equal(draggedValue(240, 40, 'end', 160, 480), 280);
  assert.equal(draggedValue(240, -40, 'end', 160, 480), 200);
});

test('drag: the result is clamped and whole', () => {
  assert.equal(draggedValue(500, -9999, 'start', 320, 1000), 1000);
  assert.equal(draggedValue(500, 9999, 'start', 320, 1000), 320);
  assert.equal(draggedValue(240, 0.4, 'end', 160, 480), 240);
});

const k = (over: Partial<SplitterKeyInput>): SplitterKeyInput => ({
  key: 'ArrowRight',
  shiftKey: false,
  orientation: 'vertical',
  grow: 'end',
  value: 240,
  min: 160,
  max: 480,
  ...over,
});

test('keys move the bar the way they point, so the value follows `grow`', () => {
  // Navigator: its bar is on its right edge, so Right grows it.
  assert.equal(keyboardValue(k({ key: 'ArrowRight' })), 240 + SPLITTER_STEP);
  assert.equal(keyboardValue(k({ key: 'ArrowLeft' })), 240 - SPLITTER_STEP);
  // Dock: its bar is on its left edge, so Left (moving the bar left) grows it.
  assert.equal(keyboardValue(k({ grow: 'start', key: 'ArrowLeft' })), 240 + SPLITTER_STEP);
  assert.equal(keyboardValue(k({ grow: 'start', key: 'ArrowRight' })), 240 - SPLITTER_STEP);
  // Terminal: its bar is on its top edge, so Up grows it.
  const term = { orientation: 'horizontal', grow: 'start' } as const;
  assert.equal(keyboardValue(k({ ...term, key: 'ArrowUp' })), 240 + SPLITTER_STEP);
  assert.equal(keyboardValue(k({ ...term, key: 'ArrowDown' })), 240 - SPLITTER_STEP);
});

test('keys: only the arrows along the axis belong to the splitter', () => {
  assert.equal(keyboardValue(k({ key: 'ArrowUp' })), null, 'a vertical bar ignores Up');
  assert.equal(keyboardValue(k({ key: 'ArrowDown' })), null);
  assert.equal(keyboardValue(k({ orientation: 'horizontal', key: 'ArrowLeft' })), null);
  assert.equal(keyboardValue(k({ key: 'a' })), null);
  assert.equal(keyboardValue(k({ key: 'Tab' })), null, 'Tab must keep moving focus');
});

test('keys: Shift takes the large step, Home/End jump, and everything is clamped', () => {
  assert.equal(keyboardValue(k({ shiftKey: true })), 240 + SPLITTER_STEP_LARGE);
  assert.equal(keyboardValue(k({ key: 'Home' })), 160);
  assert.equal(keyboardValue(k({ key: 'End' })), 480);
  assert.equal(keyboardValue(k({ value: 475 })), 480);
  assert.equal(keyboardValue(k({ value: 165, key: 'ArrowLeft' })), 160);
});
