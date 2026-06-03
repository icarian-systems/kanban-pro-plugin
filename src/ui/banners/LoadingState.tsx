/**
 * LoadingState — shown while the parser is still chewing on the file or the
 * store is being hydrated. Intentionally text-only; CSS owns the spinner.
 */
import * as React from 'react';

export const LoadingState: React.FC<{ label?: string }> = ({ label = 'Loading board…' }) => {
  return (
    <div className="loading-state" role="status" aria-busy="true">
      <div className="loading-state__spinner" aria-hidden="true" />
      <div className="loading-state__label">{label}</div>
    </div>
  );
};
