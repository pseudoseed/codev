import React from 'react';
import { createRoot } from 'react-dom/client';
import { AFr22 } from './AFr22.jsx';
import 'dockview-react/dist/styles/dockview.css';
import './app.css';
import './a-fr22.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AFr22 />
  </React.StrictMode>,
);
