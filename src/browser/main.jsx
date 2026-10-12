import React from 'react';
import { prepareIsolation } from './isolation';
import { createRoot } from 'react-dom/client';
import BrowserApp from './BrowserApp';
import '@fontsource/atkinson-hyperlegible/400.css';
import '@fontsource/atkinson-hyperlegible/700.css';
import '../styles.css';
const root = document.getElementById('root');
root.textContent = 'Preparing private browser captions…';
prepareIsolation().then(result => {
  if (result !== 'reloading') createRoot(root).render(<BrowserApp />);
});
