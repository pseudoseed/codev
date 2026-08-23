const work = document.getElementById('work');
const side = document.getElementById('side');
const stack = document.getElementById('stack');
const measureBtn = document.getElementById('measure');
const restore = document.getElementById('restore');
const restoreWrap = document.getElementById('restore-wrap');
const log = document.getElementById('log');

const detached = [];

function setSplit(mode) {
  work.classList.toggle('side', mode === 'side');
  work.classList.toggle('stack', mode === 'stack');
  side.setAttribute('aria-pressed', String(mode === 'side'));
  stack.setAttribute('aria-pressed', String(mode === 'stack'));
}

side.addEventListener('click', () => setSplit('side'));
stack.addEventListener('click', () => setSplit('stack'));

document.querySelectorAll('.close').forEach((btn) => {
  btn.addEventListener('click', () => {
    const id = btn.getAttribute('data-pane');
    const pane = document.getElementById(`pane-${id}`);
    if (!pane) return;
    pane.hidden = true;
    detached.push(id);
    restoreWrap.hidden = false;
  });
});

restore.addEventListener('click', () => {
  const id = detached.pop();
  if (!id) {
    restoreWrap.hidden = true;
    return;
  }
  const pane = document.getElementById(`pane-${id}`);
  if (pane) pane.hidden = false;
  if (!detached.length) restoreWrap.hidden = true;
});

function boxOf(el) {
  const r = el.getBoundingClientRect();
  return { w: round(r.width), h: round(r.height), x: round(r.x), y: round(r.y) };
}

function round(n) {
  return Math.round(n * 10) / 10;
}

function gapBetween(a, b) {
  const ra = a.getBoundingClientRect();
  const rb = b.getBoundingClientRect();
  return {
    horizontal: round(rb.left - ra.right),
    vertical: round(rb.top - ra.bottom),
  };
}

function measureTargets() {
  const tabs = Array.from(document.querySelectorAll('.tab'));
  const closes = Array.from(document.querySelectorAll('.close'));
  const toolbar = Array.from(document.querySelectorAll('.toolbar button, .link'));
  const pairs = tabs.map((tab, i) => {
    const close = closes[i];
    const parent = tab.parentElement;
    const nested = close ? parent.contains(close) && tab.contains(close) : null;
    return {
      tab: boxOf(tab),
      close: close ? boxOf(close) : null,
      closeInsideTab: nested,
      gapTabToClose: close ? gapBetween(tab, close) : null,
    };
  });
  const floor = 44;
  const sep = 8;
  const sizePass = [...tabs, ...closes, ...toolbar].every((el) => {
    const b = boxOf(el);
    return b.w >= floor && b.h >= floor;
  });
  const sepPass = pairs.every((p) => {
    if (!p.gapTabToClose) return false;
    if (p.closeInsideTab) return false;
    return p.gapTabToClose.horizontal >= sep || p.gapTabToClose.vertical >= sep;
  });
  return {
    at: new Date().toISOString(),
    arm: 'B',
    viewport: { width: window.innerWidth, height: window.innerHeight, dppx: window.devicePixelRatio },
    userAgent: navigator.userAgent,
    fontSize: getComputedStyle(document.documentElement).fontSize,
    safeArea: {
      top: getComputedStyle(document.body).paddingTop,
      right: getComputedStyle(document.body).paddingRight,
      bottom: getComputedStyle(document.body).paddingBottom,
      left: getComputedStyle(document.body).paddingLeft,
    },
    pairs,
    toolbar: toolbar.map(boxOf),
    fr22: { floorPt: floor, sepPt: sep, sizePass, sepPass, pass: sizePass && sepPass },
  };
}

measureBtn.addEventListener('click', () => {
  log.value = JSON.stringify(measureTargets(), null, 2);
});

window.__exp62MeasureB = measureTargets;
