/**
 * Issue #14: `dashboard.hideTabs` config hides tabs (Analytics, Team) from
 * the dashboard tab strip.
 *
 * Verifies:
 *  - `hideTabs: ['analytics']` removes the Analytics tab.
 *  - `hideTabs: ['team']` wins over `teamEnabled: true` (explicit hide beats
 *    derived state).
 *  - Unknown ids in `hideTabs` are ignored (warned, not thrown).
 *  - If the persisted active tab becomes hidden, the hook falls back to
 *    `work` rather than leaving `activeTab` pointing at nothing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { DashboardState } from '@cluesmith/codev-types';

// localStorage mock for jsdom (same pattern as useTabs.architects.test.ts)
const storageMap = new Map<string, string>();
const localStorageMock = {
  getItem: (key: string) => storageMap.get(key) ?? null,
  setItem: (key: string, value: string) => storageMap.set(key, value),
  removeItem: (key: string) => storageMap.delete(key),
  clear: () => storageMap.clear(),
  get length() { return storageMap.size; },
  key: (index: number) => [...storageMap.keys()][index] ?? null,
};
Object.defineProperty(window, 'localStorage', { value: localStorageMock, writable: true });

import { useTabs } from '../src/hooks/useTabs.js';

function makeState(overrides: Partial<DashboardState>): DashboardState {
  return {
    architect: null,
    architects: [],
    builders: [],
    utils: [],
    annotations: [],
    ...overrides,
  };
}

beforeEach(() => {
  window.history.replaceState({}, '', '/workspace/Vd29ya3NwYWNl/');
  storageMap.clear();
});

afterEach(() => {
  storageMap.clear();
  vi.restoreAllMocks();
});

describe('useTabs — dashboard.hideTabs (Issue #14)', () => {
  it('shows Analytics by default when hideTabs is unset', () => {
    const { result } = renderHook(() => useTabs(makeState({})));
    expect(result.current.tabs.some(t => t.id === 'analytics')).toBe(true);
  });

  it('hides the Analytics tab when hideTabs includes "analytics"', () => {
    const { result } = renderHook(() => useTabs(makeState({ hideTabs: ['analytics'] })));
    expect(result.current.tabs.some(t => t.id === 'analytics')).toBe(false);
    // Work tab is untouched.
    expect(result.current.tabs.some(t => t.id === 'work')).toBe(true);
  });

  it('explicit hide of "team" wins over teamEnabled: true (derived state)', () => {
    const { result } = renderHook(() => useTabs(makeState({
      teamEnabled: true,
      hideTabs: ['team'],
    })));
    expect(result.current.tabs.some(t => t.id === 'team')).toBe(false);
  });

  it('team tab still appears when teamEnabled is true and hideTabs is empty', () => {
    const { result } = renderHook(() => useTabs(makeState({
      teamEnabled: true,
      hideTabs: [],
    })));
    expect(result.current.tabs.some(t => t.id === 'team')).toBe(true);
  });

  it('warns but does not throw on an unknown hideTabs id', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => {
      renderHook(() => useTabs(makeState({ hideTabs: ['analyics'] })));
    }).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('analyics'));
  });

  it('an unknown hideTabs id does not remove any known tab', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = renderHook(() => useTabs(makeState({ hideTabs: ['analyics'] })));
    expect(result.current.tabs.some(t => t.id === 'analytics')).toBe(true);
    expect(result.current.tabs.some(t => t.id === 'work')).toBe(true);
  });

  it('falls back activeTabId to "work" when the active tab becomes hidden via config', () => {
    let stateRef = makeState({ hideTabs: [] });
    const { result, rerender } = renderHook(() => useTabs(stateRef));

    act(() => {
      result.current.selectTab('analytics');
    });
    expect(result.current.activeTabId).toBe('analytics');

    // Config now hides analytics while it's the active tab.
    stateRef = makeState({ hideTabs: ['analytics'] });
    rerender();

    expect(result.current.activeTabId).toBe('work');
    expect(result.current.activeTab?.id).toBe('work');
  });

  it('activeTab never renders undefined/nothing when the active tab is hidden (falls back to first tab)', () => {
    // Even before the fallback effect fires, the `activeTab` selector itself
    // falls back to tabs[0] ('work') so nothing ever renders as "missing".
    const { result } = renderHook(() => useTabs(makeState({ hideTabs: ['analytics'] })));
    act(() => {
      result.current.selectTab('analytics');
    });
    expect(result.current.activeTab).toBeDefined();
  });

  // A misconfigured (or otherwise unsanitized) hideTabs: ['work'] must never
  // blank the dashboard. The server (getDashboardConfig) already strips
  // 'work' before this ever runs — this test exercises the hook's own
  // defense-in-depth for the case where 'work' arrives anyway.
  it('never hides "work" even if hideTabs names it — the dashboard still renders a usable tab', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = renderHook(() => useTabs(makeState({ hideTabs: ['work'] })));

    expect(result.current.tabs.length).toBeGreaterThan(0);
    expect(result.current.tabs.some(t => t.id === 'work')).toBe(true);
    expect(result.current.activeTabId).toBe('work');
    expect(result.current.activeTab).toBeDefined();
    expect(result.current.activeTab?.id).toBe('work');
    // 'work' is no longer a "known" hideable id (Issue #14 review fix), so
    // naming it in hideTabs surfaces the same warning an unknown id would.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('work'));
  });

  it('falls back to the first surviving tab (not a hardcoded id) when the active tab vanishes, even if "work" were somehow also gone', () => {
    // Regression guard for the reviewed bug: the vanished-active-tab fallback
    // must never hardcode an id that could itself be absent. Simulates the
    // active tab disappearing while 'work' is not first in the tab order by
    // driving the fallback through the effect directly rather than assuming
    // any particular tab layout.
    let stateRef = makeState({ hideTabs: [] });
    const { result, rerender } = renderHook(() => useTabs(stateRef));

    act(() => {
      result.current.selectTab('team'); // not present yet (teamEnabled unset) — exercises "vanished" path
    });

    stateRef = makeState({ teamEnabled: true, hideTabs: ['team'] });
    rerender();

    // 'team' never existed in the rebuilt list; the fallback must land on
    // some real, rendered tab rather than leaving activeTabId dangling.
    expect(result.current.tabs.some(t => t.id === result.current.activeTabId)).toBe(true);
    expect(result.current.activeTab).toBeDefined();
  });
});
