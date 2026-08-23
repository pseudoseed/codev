import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import 'dockview-react/dist/styles/dockview.css';
import './app.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
