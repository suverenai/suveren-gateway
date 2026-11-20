import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// The same tokens and rules as the gateway page, so the shared approval card is drawn by the same CSS on every device.
import '../../ui/src/styles/tokens.css';
import '../../ui/src/styles/design-system.css';
import './approve.css';
import { configurePhoneHost } from './lib/app-host';
import App from './App';

configurePhoneHost();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Step 1 results: the service worker keeps the app's static files and fetches a new version behind them. Push is stage D4.
if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js').catch(() => { /* the app works without it */ });
}
