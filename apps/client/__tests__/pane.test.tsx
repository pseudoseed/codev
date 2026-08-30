/*
 * The pane's content, and the three absences that must not read alike.
 *
 * #112's lesson is the reason this file asserts what is VISIBLE rather than what
 * rendered: a client passed 127 component tests with every label prefix dropped,
 * because "the name renders" is true of a pane that has become unreadable.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BuilderPane } from '../src/pane/BuilderPane.js';
import { MessageLog } from '../src/pane/MessageLog.js';
import type { AgentMessage } from '../src/connection/types.js';
import type { ThreadRow } from '../src/tree/build.js';

afterEach(cleanup);

const NOW = Date.parse('2026-08-30T12:00:00Z');

const MESSAGES: AgentMessage[] = [
  { id: 'm3', from: 'main', at: '2026-08-30T11:59:30Z', body: 'newest' },
  { id: 'm2', from: 'air-219', at: '2026-08-30T11:50:00Z', body: 'middle', held: true },
  { id: 'm1', from: 'main', at: '2026-08-30T11:00:00Z', body: 'cut here', truncated: true },
  { id: 'm0', from: 'main', at: '2026-08-30T10:00:00Z', body: 'too old to show' },
];

function row(over: Partial<ThreadRow> = {}): ThreadRow {
  return {
    key: 'alpha:builder:builder-air-234',
    backing: 'thread',
    threadId: 'th-1',
    name: 'builder-air-234',
    role: 'builder',
    management: 'managed',
    machine: 'alpha',
    status: { kind: 'working' },
    porch: {
      projectId: '234',
      title: 'phase 12',
      protocol: 'air',
      phase: 'implement',
      currentPlanPhase: null,
      gates: {},
      artifactRoot: '/w',
      statusPath: '/w/codev/projects/234/status.yaml',
    },
    ...over,
  } as ThreadRow;
}

function renderPane(over: Partial<ThreadRow> = {}, log: 'available' | 'unreadable' | 'not-provided' = 'available') {
  return render(
    <BuilderPane
      row={row(over)}
      approval={null}
      messageLog={log}
      nowMs={NOW}
      showMachine
      stale={false}
    />,
  );
}

describe('criterion 4: what a pane shows', () => {
  it('shows the builder id with its kind prefix and no duplicated builder-', () => {
    renderPane({ messages: MESSAGES });
    expect(screen.getByText('builder/')).toBeTruthy();
    expect(screen.getByText('air-234')).toBeTruthy();
    expect(screen.queryByText('builder-air-234')).toBeNull();
  });

  it('shows the status as a word', () => {
    renderPane({ messages: MESSAGES });
    const stamp = document.querySelector('.status-stamp')!;
    expect(stamp.textContent!.trim().length).toBeGreaterThan(0);
    expect(stamp.getAttribute('data-status')).toBe('working');
  });

  it('shows the last three messages, newest first, and no more', () => {
    renderPane({ messages: MESSAGES });
    const bodies = [...document.querySelectorAll('.msg-body')].map((el) => el.textContent);
    expect(bodies).toEqual(['newest', 'middle', 'cut here']);
    expect(screen.queryByText('too old to show')).toBeNull();
  });
});

describe('a cut message says it was cut', () => {
  it('marks a truncated body and leaves whole ones unmarked', () => {
    renderPane({ messages: MESSAGES });
    const marks = document.querySelectorAll('.msg-truncated');
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toContain('longer than shown');
  });

  it('marks a held message so an undelivered one is not read as delivered', () => {
    renderPane({ messages: MESSAGES });
    expect(document.querySelectorAll('.msg.is-held')).toHaveLength(1);
  });
});

describe('three absences, three sentences', () => {
  const cases = [
    { log: 'available' as const, messages: undefined, className: '.msg-note.is-empty', says: 'No messages' },
    { log: 'unreadable' as const, messages: undefined, className: '.msg-note.is-unknown', says: 'would not open' },
    { log: 'not-provided' as const, messages: undefined, className: '.msg-note.is-unknown', says: 'does not report' },
  ];

  for (const testCase of cases) {
    it(`${testCase.log} renders its own sentence`, () => {
      render(<MessageLog messages={testCase.messages} log={testCase.log} nowMs={NOW} />);
      const note = document.querySelector(testCase.className);
      expect(note, `expected ${testCase.className} for log=${testCase.log}`).toBeTruthy();
      expect(note!.textContent).toContain(testCase.says);
    });
  }

  /*
   * THE ASSERTION THAT MATTERS. Each of the three renders SOMETHING; the defect
   * is three different facts rendering the SAME something. An operator reading
   * "no messages" for a machine whose log would not open concludes nobody has
   * written to a builder that may have a queue of unread instructions.
   */
  it('never spells two of them the same way', () => {
    const texts = new Set<string>();
    for (const log of ['available', 'unreadable', 'not-provided'] as const) {
      const view = render(<MessageLog messages={undefined} log={log} nowMs={NOW} />);
      texts.add(document.querySelector('.msg-note')!.textContent!.trim());
      view.unmount();
    }
    expect(texts.size).toBe(3);
  });
});
