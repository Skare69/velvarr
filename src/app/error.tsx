"use client";

/*
 * Root-segment error boundary. A rejected lazy-chunk load (a stale deploy
 * hash, a dropped connection) throws during a render and lands here instead
 * of the framework's default error page. retry() cannot recover a rejected
 * dynamic import — React caches the failure — so the recovery action is a
 * real reload.
 */
export default function ErrorView({
  error,
}: {
  error: Error & { digest?: string };
}) {
  return (
    <div
      role="alert"
      className="panel panel-error mx-auto my-24 max-w-xl p-6"
      aria-label="Application error"
    >
      <h2 className="text-lg font-semibold">Velvarr could not load</h2>
      <p className="mt-2 text-sm text-muted">
        A part of the app failed to load. Reload the page; if this keeps
        happening, the server may be restarting — try again shortly.
      </p>
      {error.digest !== undefined && (
        <p className="mt-2 text-sm text-muted">Error id: {error.digest}</p>
      )}
      <button
        type="button"
        className="btn mt-4"
        onClick={() => window.location.reload()}
      >
        Reload
      </button>
    </div>
  );
}
