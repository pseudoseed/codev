import { useCallback, useMemo, useRef, useState } from 'react';
import { DockviewReact } from 'dockview-react';
import { measureTargets } from './measure.js';

const GESTURES = [
  { id: 'split-h', label: 'Split a pane horizontally by dragging a tab to an edge' },
  { id: 'split-v', label: 'Split a pane vertically by dragging a tab to an edge' },
  { id: 'move-group', label: 'Drag a pane from one group into another' },
  { id: 'sash-h', label: 'Resize by dragging the horizontal sash' },
  { id: 'sash-v', label: 'Resize by dragging the vertical sash' },
];

const SCORES = [
  { id: 'first-try', label: 'First try' },
  { id: 'retries', label: 'Retries' },
  { id: 'impossible', label: 'Impossible' },
];

const MODES = [
  { id: 'finger', label: 'Finger only' },
  { id: 'keyboard', label: 'Keyboard attached' },
];

function emptyScores() {
  const out = {};
  for (const mode of MODES) {
    out[mode.id] = {};
    for (const g of GESTURES) {
      out[mode.id][g.id] = { score: null, retries: '', note: '' };
    }
  }
  return out;
}

function Pane({ params }) {
  return (
    <div className="pane">
      <h2>{params.title}</h2>
      <p>{params.body}</p>
      <p>Hold a tab ~250 ms, then drag. Docs call that the touch gesture.</p>
    </div>
  );
}

const components = {
  default: Pane,
};

function onReady(event) {
  const { api } = event;
  api.addPanel({
    id: 'architect',
    component: 'default',
    title: 'Architect',
    params: {
      title: 'Architect',
      body: 'Left column. Drag this tab onto Builder A to merge groups, or to an empty edge to split.',
    },
  });
  api.addPanel({
    id: 'files',
    component: 'default',
    title: 'Files',
    params: {
      title: 'Files',
      body: 'Second tab in the Architect group. Drag this tab to split without emptying the group.',
    },
    position: { referencePanel: 'architect', direction: 'within' },
  });
  api.addPanel({
    id: 'builder-a',
    component: 'default',
    title: 'Builder A',
    params: {
      title: 'Builder A',
      body: 'Right column. The vertical sash is between Architect and this pane.',
    },
    position: { referencePanel: 'architect', direction: 'right' },
  });
  api.addPanel({
    id: 'builder-b',
    component: 'default',
    title: 'Builder B',
    params: {
      title: 'Builder B',
      body: 'Bottom right. The horizontal sash is between Builder A and this pane.',
    },
    position: { referencePanel: 'builder-a', direction: 'below' },
  });
}

export function App() {
  const [mode, setMode] = useState('finger');
  const [scores, setScores] = useState(emptyScores);
  const [measure, setMeasure] = useState(null);
  const [copied, setCopied] = useState('');
  const logRef = useRef(null);

  const dump = useMemo(() => {
    return JSON.stringify(
      {
        experiment: 62,
        dockview: '8.2.0',
        dndStrategy: 'auto',
        scores,
        measure,
        at: new Date().toISOString(),
      },
      null,
      2,
    );
  }, [scores, measure]);

  const setScore = useCallback((gestureId, scoreId) => {
    setScores((prev) => ({
      ...prev,
      [mode]: {
        ...prev[mode],
        [gestureId]: { ...prev[mode][gestureId], score: scoreId },
      },
    }));
  }, [mode]);

  const setField = useCallback((gestureId, field, value) => {
    setScores((prev) => ({
      ...prev,
      [mode]: {
        ...prev[mode],
        [gestureId]: { ...prev[mode][gestureId], [field]: value },
      },
    }));
  }, [mode]);

  const runMeasure = useCallback(() => {
    const result = measureTargets();
    setMeasure(result);
  }, []);

  const copyLog = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(dump);
      setCopied('copied');
    } catch {
      logRef.current?.select();
      setCopied('select and copy');
    }
  }, [dump]);

  return (
    <div className="app">
      <header className="top">
        <h1>Exp 62: finger drag, dockview 8.2.0</h1>
        <div className="meta">dndStrategy auto. LAN page. Playwright does not count.</div>
        <p className="hint">
          Finger first. Hold a tab about a quarter second, then drag.
          Then attach the hardware keyboard and score the same list again.
        </p>
      </header>
      <div className="dock">
        <DockviewReact
          className="dockview-theme-abyss"
          components={components}
          onReady={onReady}
        />
      </div>
      <section className="sheet">
        <h2>Score on this device</h2>
        <div className="mode">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              data-on={String(mode === m.id)}
              onClick={() => setMode(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <div className="row">
          {GESTURES.map((g) => {
            const entry = scores[mode][g.id];
            return (
              <div className="gesture" key={g.id}>
                <strong>{g.label}</strong>
                <div className="scores">
                  {SCORES.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      data-on={entry.score === s.id ? s.id : ''}
                      onClick={() => setScore(g.id, s.id)}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
                {entry.score === 'retries' ? (
                  <input
                    className="note"
                    inputMode="numeric"
                    placeholder="How many tries"
                    value={entry.retries}
                    onChange={(e) => setField(g.id, 'retries', e.target.value)}
                  />
                ) : null}
                <input
                  className="note"
                  placeholder="What happened. One line."
                  value={entry.note}
                  onChange={(e) => setField(g.id, 'note', e.target.value)}
                />
              </div>
            );
          })}
        </div>
        <div className="actions">
          <button type="button" onClick={runMeasure}>Measure targets</button>
          <button type="button" className="copy" onClick={copyLog}>
            Copy log{copied ? ` (${copied})` : ''}
          </button>
        </div>
        <textarea className="log" ref={logRef} readOnly value={dump} />
      </section>
    </div>
  );
}
