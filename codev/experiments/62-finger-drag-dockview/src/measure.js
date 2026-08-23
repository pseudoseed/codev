const SELECTORS = {
  sash: ['.dv-sash'],
  tabClose: ['.dv-default-tab-action'],
  tab: ['.dv-tab'],
};

function firstAll(selectors) {
  for (const sel of selectors) {
    const nodes = Array.from(document.querySelectorAll(sel));
    if (nodes.length) return { selector: sel, nodes };
  }
  return { selector: null, nodes: [] };
}

function boxOf(el) {
  const r = el.getBoundingClientRect();
  return {
    width: round(r.width),
    height: round(r.height),
    className: el.className?.toString?.() ?? '',
  };
}

function round(n) {
  return Math.round(n * 10) / 10;
}

function gapBetween(a, b) {
  const ra = a.getBoundingClientRect();
  const rb = b.getBoundingClientRect();
  const horizontal = rb.left - ra.right;
  const vertical = rb.top - ra.bottom;
  return {
    horizontal: round(horizontal),
    vertical: round(vertical),
  };
}

export function measureTargets() {
  const sash = firstAll(SELECTORS.sash);
  const close = firstAll(SELECTORS.tabClose);
  const tab = firstAll(SELECTORS.tab);
  const dppx = window.devicePixelRatio || 1;

  const closeBoxes = close.nodes.slice(0, 8).map(boxOf);
  const closeGaps = [];
  for (let i = 0; i < close.nodes.length - 1 && i < 4; i += 1) {
    closeGaps.push(gapBetween(close.nodes[i], close.nodes[i + 1]));
  }

  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const sashBoxes = sash.nodes.slice(0, 8).map((el) => {
    const box = boxOf(el);
    const style = getComputedStyle(el);
    const expand = coarse ? 20 : 0;
    const travel = box.width < box.height ? box.width : box.height;
    return {
      ...box,
      pointerEvents: style.pointerEvents,
      cursor: style.cursor,
      coarseExpandPx: expand,
      travelPx: travel,
      hitTravelPx: travel + expand,
    };
  });

  return {
    at: new Date().toISOString(),
    viewport: { width: window.innerWidth, height: window.innerHeight, dppx },
    pointerCoarse: coarse,
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints,
    sash: {
      selector: sash.selector,
      count: sash.nodes.length,
      boxes: sashBoxes,
    },
    tabClose: {
      selector: close.selector,
      count: close.nodes.length,
      boxes: closeBoxes,
      gaps: closeGaps,
    },
    tab: {
      selector: tab.selector,
      count: tab.nodes.length,
      boxes: tab.nodes.slice(0, 6).map(boxOf),
    },
    fr22: scoreFr22(sashBoxes, closeBoxes, closeGaps),
  };
}

function scoreFr22(sashes, closes, gaps) {
  const floor = 44;
  const sep = 8;
  const sashPass = sashes.some((b) => (b.hitTravelPx ?? Math.min(b.width, b.height)) >= floor);
  const closePass = closes.length > 0 && closes.every((b) => b.width >= floor && b.height >= floor);
  const gapPass =
    gaps.length === 0
      ? null
      : gaps.every((g) => g.horizontal >= sep || g.vertical >= sep);
  return {
    floorPt: floor,
    sepPt: sep,
    sashMeetsFloor: sashPass,
    closeMeetsFloor: closePass,
    closeSeparation: gapPass,
    pass: sashPass && closePass && gapPass !== false,
  };
}
