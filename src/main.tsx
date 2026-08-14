import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

const BUILD_VERSION_CHECK_INTERVAL_MS = 60_000;
const UPDATE_IDLE_WINDOW_MS = 5_000;

function setupAutomaticBuildRefresh(registration: ServiceWorkerRegistration | null) {
  const currentBuildId = import.meta.env.VITE_APP_BUILD_ID;
  let checking = false;
  let refreshScheduled = false;
  let lastInteractionAt = Date.now();

  const noteInteraction = () => {
    lastInteractionAt = Date.now();
  };
  window.addEventListener('pointerdown', noteInteraction, { capture: true, passive: true });
  window.addEventListener('keydown', noteInteraction, { capture: true });
  window.addEventListener('input', noteInteraction, { capture: true });

  const refreshWhenIdle = () => {
    if (refreshScheduled) return;
    refreshScheduled = true;
    const tryRefresh = () => {
      const remainingIdleMs = UPDATE_IDLE_WINDOW_MS - (Date.now() - lastInteractionAt);
      if (remainingIdleMs > 0) {
        window.setTimeout(tryRefresh, remainingIdleMs);
        return;
      }
      window.location.reload();
    };
    window.setTimeout(tryRefresh, 250);
  };

  if ('serviceWorker' in navigator) {
    let hadController = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) {
        hadController = true;
        return;
      }
      refreshWhenIdle();
    });
  }

  const checkForNewBuild = async () => {
    if (checking || refreshScheduled || document.hidden || !navigator.onLine) return;
    checking = true;
    try {
      const response = await fetch('/version.json', { cache: 'no-store' });
      if (!response.ok) return;
      const latest = await response.json() as { buildId?: string };
      if (!latest.buildId || latest.buildId === currentBuildId) return;
      await registration?.update().catch(() => undefined);
      refreshWhenIdle();
    } catch {
      // Staying on the current build is safer when the version check is offline or incomplete.
    } finally {
      checking = false;
    }
  };

  window.setInterval(() => void checkForNewBuild(), BUILD_VERSION_CHECK_INTERVAL_MS);
  window.addEventListener('focus', () => void checkForNewBuild());
  window.addEventListener('online', () => void checkForNewBuild());
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void checkForNewBuild();
  });
  void checkForNewBuild();
}

if (import.meta.env.PROD) {
  window.addEventListener('load', () => {
    if (!('serviceWorker' in navigator)) {
      setupAutomaticBuildRefresh(null);
      return;
    }
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
      .then((registration) => {
        setupAutomaticBuildRefresh(registration);
        void registration.update().catch(() => undefined);
      })
      .catch(() => setupAutomaticBuildRefresh(null));
  });
}
