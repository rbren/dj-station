// Non-modal list of recent failures (IPC rejections, render crashes). It sits
// under the header so the rack stays usable while errors are visible.

import { useEffect, useState } from 'react';
import { clearErrors, dismissError, subscribeErrors, type AppError } from '../errors';

export function ErrorBanner() {
  const [errors, setErrors] = useState<AppError[]>([]);
  useEffect(() => subscribeErrors(setErrors), []);

  if (errors.length === 0) return null;
  return (
    <div className="error-banner" data-testid="error-banner" role="alert">
      <ul className="error-banner-list">
        {errors.map((e) => (
          <li key={e.id} data-testid={`error-item-${e.id}`}>
            <span className="error-context">{e.context}</span>
            <span className="error-message">{e.message}</span>
            <button
              className="error-dismiss"
              data-testid={`error-dismiss-${e.id}`}
              title="Dismiss"
              onClick={() => dismissError(e.id)}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
      {errors.length > 1 && (
        <button className="error-clear" data-testid="error-clear" onClick={clearErrors}>
          Dismiss all
        </button>
      )}
    </div>
  );
}
