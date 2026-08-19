import React, { Profiler, type ProfilerOnRenderCallback } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { installGlobalErrorHandlers } from './errors';
import './styles.css';

installGlobalErrorHandlers();

/** Dev-only rendering stress harness (src/stress/): ?stress=N swaps the
 *  engine bridge for a mock rack and wraps the app in a <Profiler> feeding
 *  the perf HUD. Dynamic import behind DEV so none of it ships. */
async function stressOnCommit(): Promise<ProfilerOnRenderCallback | null> {
  if (!import.meta.env.DEV) return null;
  const { stressParams, installStressHarness } = await import('./stress');
  const params = stressParams(window.location.search);
  if (!params) return null;
  return installStressHarness(params).onCommit;
}

void stressOnCommit().then((onCommit) => {
  const app = (
    <ErrorBoundary context="app">
      <App />
    </ErrorBoundary>
  );
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      {onCommit ? (
        <Profiler id="app" onRender={onCommit}>
          {app}
        </Profiler>
      ) : (
        app
      )}
    </React.StrictMode>,
  );
});
