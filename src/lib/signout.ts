// Which failed sign-out attempts may clear this tab's session view.
//
// POST /api/logout is auth: "open", so admission never answers 401 for it:
// only the handler's 200 revokes the server session and sends the clearing
// Set-Cookie. A 401 would be the server's explicit "no session" answer (the
// api helper also fires velvarr:unauthorized for it, landing the tab on the
// login screen). Any other failure — a network error, a CSRF 403, a 5xx —
// leaves the session cookie valid, so the tab must stay signed in and offer
// a retry instead of showing a login screen that hides a live session.
//
// Duck-typed on ApiError's `.status` so this stays React-free and testable
// without a component harness.
export function signOutKeepsSession(err: unknown): boolean {
  return (err as { status?: number } | null)?.status !== 401;
}
