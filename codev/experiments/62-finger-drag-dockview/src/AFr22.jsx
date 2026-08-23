import { DockviewReact } from 'dockview-react';
import { Fr22Tab } from './Fr22Tab.jsx';
import { Fr22Close } from './Fr22Close.jsx';

function Pane({ params }) {
  return (
    <div className="pane">
      <h2>{params.title}</h2>
      <p>{params.body}</p>
    </div>
  );
}

const components = { default: Pane };

function onReady(event) {
  const { api } = event;
  api.addPanel({
    id: 'architect',
    component: 'default',
    title: 'Architect',
    params: { title: 'Architect', body: 'FR-22 override. Close lives in the header actions.' },
  });
  api.addPanel({
    id: 'files',
    component: 'default',
    title: 'Files',
    params: { title: 'Files', body: 'Second tab.' },
    position: { referencePanel: 'architect', direction: 'within' },
  });
  api.addPanel({
    id: 'builder-a',
    component: 'default',
    title: 'Builder A',
    params: { title: 'Builder A', body: 'Right column.' },
    position: { referencePanel: 'architect', direction: 'right' },
  });
  api.addPanel({
    id: 'builder-b',
    component: 'default',
    title: 'Builder B',
    params: { title: 'Builder B', body: 'Bottom right.' },
    position: { referencePanel: 'builder-a', direction: 'below' },
  });
}

export function AFr22() {
  return (
    <div className="app exp-fr22" style={{ height: '100%' }}>
      <DockviewReact
        className="dockview-theme-abyss"
        components={components}
        defaultTabComponent={Fr22Tab}
        rightHeaderActionsComponent={Fr22Close}
        onReady={onReady}
      />
    </div>
  );
}
