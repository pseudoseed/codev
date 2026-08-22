import assert from 'node:assert/strict';
import { V2ResizeBroker } from './v2-resize-broker.mjs';

const DESKTOP = { cols: 80, rows: 24 };
const IPAD = { cols: 40, rows: 12 };
const HUGE = { cols: 100, rows: 30 };

function broker(policy) {
  const applied = [];
  const b = new V2ResizeBroker(policy, (cols, rows) => {
    applied.push({ cols, rows });
    return true;
  });
  return { b, applied };
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('follow-focused: two visible clients, only focused size applies', () => {
  const { b, applied } = broker('follow-focused');
  b.attach('desktop', DESKTOP);
  b.attach('ipad', IPAD);
  const nudge = b.requestResize('ipad', IPAD);
  assert.equal(nudge.applied, false);
  assert.equal(nudge.reason, 'ignored-unfocused');
  assert.deepEqual(b.negotiated, DESKTOP);
  assert.deepEqual(applied, [DESKTOP]);
});

test('follow-focused: focused disconnect promotes remaining visible viewer', () => {
  const { b, applied } = broker('follow-focused');
  b.attach('desktop', DESKTOP);
  b.attach('ipad', IPAD);
  const result = b.detach('desktop');
  assert.equal(result.applied, true);
  assert.equal(result.reason, 'applied-focused');
  assert.deepEqual(b.negotiated, IPAD);
  assert.deepEqual(applied, [DESKTOP, IPAD]);
  assert.equal(b.viewers.get('ipad')?.focused, true);
});

test('follow-focused: both hidden, resize ignored, last size holds', () => {
  const { b, applied } = broker('follow-focused');
  b.attach('desktop', DESKTOP);
  b.attach('ipad', IPAD);
  const hideFocused = b.setVisible('desktop', false);
  assert.equal(hideFocused.applied, true);
  assert.deepEqual(b.negotiated, IPAD);
  b.setVisible('ipad', false);
  const result = b.requestResize('desktop', HUGE);
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'ignored-hidden');
  assert.deepEqual(b.negotiated, IPAD);
  assert.deepEqual(applied, [DESKTOP, IPAD]);
});

test('follow-focused: iOS reconnect nudge does not steal focused size', () => {
  const { b, applied } = broker('follow-focused');
  b.attach('desktop', DESKTOP);
  b.attach('ipad', IPAD);
  b.detach('ipad');
  b.attach('ipad', IPAD);
  const nudge = b.requestResize('ipad', IPAD);
  assert.equal(nudge.applied, false);
  assert.equal(nudge.reason, 'ignored-unfocused');
  assert.deepEqual(b.negotiated, DESKTOP);
  assert.deepEqual(applied, [DESKTOP]);
});

test('follow-focused: sole reconnector applies its size', () => {
  const { b, applied } = broker('follow-focused');
  b.attach('desktop', DESKTOP);
  b.attach('ipad', IPAD);
  b.detach('desktop');
  b.detach('ipad');
  const result = b.attach('ipad', HUGE);
  assert.equal(result.applied, true);
  assert.equal(result.reason, 'applied-sole');
  assert.deepEqual(b.negotiated, HUGE);
  assert.deepEqual(applied, [DESKTOP, IPAD, HUGE]);
});

test('ignore-hidden: two visible clients still last-writer-wins (fails FR-38)', () => {
  const { b, applied } = broker('ignore-hidden');
  b.attach('desktop', DESKTOP);
  const fight = b.attach('ipad', IPAD);
  assert.equal(fight.applied, true);
  assert.equal(fight.reason, 'applied-visible');
  assert.deepEqual(b.negotiated, IPAD);
  assert.deepEqual(applied, [DESKTOP, IPAD]);
});

test('ignore-hidden: hidden resize is ignored', () => {
  const { b } = broker('ignore-hidden');
  b.attach('desktop', DESKTOP);
  b.attach('ipad', IPAD);
  b.setVisible('ipad', false);
  const result = b.requestResize('ipad', HUGE);
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'ignored-hidden');
  assert.deepEqual(b.negotiated, IPAD);
});

test('ignore-hidden: both hidden, last size holds', () => {
  const { b, applied } = broker('ignore-hidden');
  b.attach('desktop', DESKTOP);
  b.setVisible('desktop', false);
  const result = b.requestResize('desktop', HUGE);
  assert.equal(result.applied, false);
  assert.deepEqual(b.negotiated, DESKTOP);
  assert.deepEqual(applied, [DESKTOP]);
});

test('ignore-hidden: iOS reconnect nudge wins if visible (fails FR-38)', () => {
  const { b, applied } = broker('ignore-hidden');
  b.attach('desktop', DESKTOP);
  b.attach('ipad', IPAD);
  b.detach('ipad');
  b.attach('ipad', { cols: 42, rows: 14 });
  assert.deepEqual(b.negotiated, { cols: 42, rows: 14 });
  assert.deepEqual(applied.at(-1), { cols: 42, rows: 14 });
});

test('per-viewer-reflow: two visible different sizes is unsupported', () => {
  const { b, applied } = broker('per-viewer-reflow');
  b.attach('desktop', DESKTOP);
  const result = b.attach('ipad', IPAD);
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'unsupported-divergent');
  assert.deepEqual(b.negotiated, DESKTOP);
  assert.deepEqual(applied, [DESKTOP]);
});

test('per-viewer-reflow: matching sizes are allowed', () => {
  const { b } = broker('per-viewer-reflow');
  b.attach('desktop', DESKTOP);
  const result = b.attach('ipad', DESKTOP);
  assert.equal(result.reason, 'held-unchanged');
  assert.deepEqual(b.negotiated, DESKTOP);
});

test('per-viewer-reflow: both hidden holds last size', () => {
  const { b } = broker('per-viewer-reflow');
  b.attach('desktop', DESKTOP);
  b.setVisible('desktop', false);
  const result = b.requestResize('desktop', HUGE);
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'held-all-hidden');
  assert.deepEqual(b.negotiated, DESKTOP);
});

test('per-viewer-reflow: iOS reconnect with other viewer stays unsupported', () => {
  const { b } = broker('per-viewer-reflow');
  b.attach('desktop', DESKTOP);
  b.attach('ipad', IPAD);
  b.detach('ipad');
  const result = b.attach('ipad', IPAD);
  assert.equal(result.reason, 'unsupported-divergent');
  assert.deepEqual(b.negotiated, DESKTOP);
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    process.stdout.write(`ok  ${name}\n`);
  } catch (error) {
    failed += 1;
    process.stdout.write(`FAIL  ${name}\n`);
    process.stdout.write(`  ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
process.stdout.write(`\n${tests.length - failed} passed, ${failed} failed, ${tests.length} total\n`);
if (failed > 0) process.exitCode = 1;
