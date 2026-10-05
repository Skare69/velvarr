"use client";

/* Admin: accounts — user table, Jellyfin import, and the per-account edit
 * dialog, extracted from the shell's admin view. */

import { useEffect, useRef, useState } from "react";
import type { Account, AdminAccount, Library, Role } from "../lib/contracts.ts";
import {
  ApiError,
  api,
  ErrorPanel,
  ForbiddenPanel,
  messageOf,
  useApiGet,
} from "./shared.tsx";

/* ---------- Admin: accounts ---------- */
// Locale-aware joined dates for the admin user table.
const JOINED_FMT = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

export function AdminView() {
  const [editing, setEditing] = useState<AdminAccount | null>(null);
  const [importForbidden, setImportForbidden] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const {
    data,
    error,
    err: readErr,
    reload,
  } = useApiGet<{ accounts: AdminAccount[]; libraries: Library[] }>(
    "/api/admin/users",
    [],
    { fresh: true },
  );
  const accounts = data?.accounts ?? null;
  const libs = data?.libraries ?? [];
  // The read's 403 is the hook's ApiError; the import POST reports its own.
  const forbidden = readErr?.status === 403 || importForbidden;

  const importUsers = async () => {
    setImporting(true);
    setImportMsg(null);
    setImportError(null);
    try {
      const r = await api<{ accounts: Account[] }>("/api/admin/users/import", {
        method: "POST",
        body: "{}",
      });
      setImportMsg(
        r.accounts.length > 0
          ? `Imported ${r.accounts.length} account${r.accounts.length === 1 ? "" : "s"} — disabled until you grant access.`
          : "No new Jellyfin users to import.",
      );
      reload();
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setImportForbidden(true);
      else setImportError(messageOf(e));
    } finally {
      setImporting(false);
    }
  };

  if (forbidden) return <ForbiddenPanel />;

  return (
    <div className="settings-page space-y-6">
      <div className="page-heading">
        <div>
          <h1 className="page-title">Users</h1>
          <p className="page-description">
            Manage library access, requests, and account permissions.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn"
            onClick={reload}
            disabled={importing}
          >
            Refresh
          </button>
          <button
            type="button"
            className="btn btn-accent"
            onClick={() => void importUsers()}
            disabled={importing}
          >
            {importing ? "Importing…" : "Import from Jellyfin"}
          </button>
        </div>
      </div>

      {importMsg && (
        <div className="panel p-3 text-sm" role="status">
          {importMsg}
        </div>
      )}
      {importError && (
        <ErrorPanel title="Import failed" message={importError} />
      )}

      {error ? (
        <ErrorPanel
          title="Accounts unavailable"
          message={error}
          onRetry={reload}
        />
      ) : accounts == null ? (
        <div className="panel p-4" aria-label="Loading accounts">
          <div className="skel mb-3 h-12 w-full" />
          <div className="skel mb-3 h-12 w-full" />
          <div className="skel h-12 w-full" />
        </div>
      ) : accounts.length === 0 ? (
        <div className="panel p-8 text-center text-sm text-muted">
          No Velvarr accounts yet. Import Jellyfin users to get started.
        </div>
      ) : (
        <table className="user-table">
          <thead>
            <tr>
              <th>User</th>
              <th>Requests</th>
              <th>Role</th>
              <th>Joined</th>
              <th>Status</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id}>
                <td>
                  <div className="user-name-cell">
                    <UserAvatar account={a} />
                    <span className="font-medium">{a.name}</span>
                    {a.isOwner && (
                      <span className="chip chip-accent">Owner</span>
                    )}
                  </div>
                </td>
                <td>{a.requestCount}</td>
                <td>
                  {a.isOwner
                    ? "Owner"
                    : a.role.slice(0, 1).toUpperCase() + a.role.slice(1)}
                </td>
                <td>{JOINED_FMT.format(a.joinedAt)}</td>
                <td>
                  <span
                    className={`chip ${a.enabled || a.isOwner ? "chip-accent" : ""}`}
                  >
                    {a.enabled || a.isOwner ? "Active" : "Disabled"}
                  </span>
                </td>
                <td className="user-actions">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setEditing(a)}
                  >
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editing && (
        <AccountDialog
          key={editing.id}
          account={editing}
          libraries={libs}
          onClose={() => setEditing(null)}
          onSaved={() => {
            reload();
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

/** Jellyfin avatar, initials when there is none — or when the stored tag went
 *  stale between this list load and the image fetch. Never a broken image. */
function UserAvatar({ account }: { account: AdminAccount }) {
  const [failed, setFailed] = useState(false);
  const tag = account.avatarTag;
  return (
    <div className="user-avatar">
      {tag && !failed ? (
        <img
          src={`/api/admin/users/${account.id}/avatar?tag=${encodeURIComponent(tag)}`}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : (
        <span aria-hidden="true">
          {account.name.slice(0, 1).toUpperCase() || "·"}
        </span>
      )}
    </div>
  );
}

function AccountDialog({
  account: initial,
  libraries,
  onClose,
  onSaved,
}: {
  account: AdminAccount;
  libraries: Library[];
  onClose: () => void;
  onSaved: (a: AdminAccount) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [role, setRole] = useState<Role>(initial.role);
  const [autoApprove, setAutoApprove] = useState(initial.autoApprove);
  const [libIds, setLibIds] = useState<string[]>(initial.libraryIds);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const owner = initial.isOwner;
  const dirty =
    (!owner && enabled !== initial.enabled) ||
    (!owner && role !== initial.role) ||
    (!owner && autoApprove !== initial.autoApprove) ||
    libIds.length !== initial.libraryIds.length ||
    !libIds.every((x) => initial.libraryIds.includes(x));

  // Native <dialog>: open on mount; Escape fires close, which unmounts via onClose.
  useEffect(() => {
    const d = dialogRef.current;
    if (d && !d.open) d.showModal();
  }, []);

  const toggleLib = (id: string) =>
    setLibIds((cur) =>
      cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id],
    );

  const save = async () => {
    setPending(true);
    setError(null);
    try {
      const r = await api<{ account: Account }>(
        `/api/admin/users/${initial.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            enabled: owner ? initial.enabled : enabled,
            role: owner ? initial.role : role,
            autoApprove: owner ? initial.autoApprove : autoApprove,
            libraryIds: libIds,
          }),
        },
      );
      onSaved({ ...initial, ...r.account });
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="user-dialog"
      aria-labelledby="user-dialog-title"
      onClose={onClose}
    >
      <div className="user-dialog-body">
        <h3 id="user-dialog-title" className="font-semibold">
          Edit {initial.name}
        </h3>

        <div>
          <label className="label" htmlFor={`role-${initial.id}`}>
            Role
          </label>
          <select
            id={`role-${initial.id}`}
            className="input"
            value={owner ? initial.role : role}
            disabled={owner || pending}
            onChange={(e) => setRole(e.target.value as Role)}
          >
            <option value="requester">Requester</option>
            <option value="moderator">Moderator</option>
            <option value="admin">Admin</option>
          </select>
        </div>

        <div>
          <span className="label">Enabled</span>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="check"
              checked={owner ? initial.enabled : enabled}
              disabled={owner || pending}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            {owner ? "Always enabled" : "Account can sign in"}
          </label>
        </div>

        <div>
          <span className="label">Auto-approve</span>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="check"
              checked={
                initial.role === "admin"
                  ? true
                  : owner
                    ? initial.autoApprove
                    : autoApprove
              }
              disabled={owner || initial.role === "admin" || pending}
              onChange={(e) => setAutoApprove(e.target.checked)}
            />
            {initial.role === "admin"
              ? "Always (admin)"
              : owner
                ? "Always (owner)"
                : "Approves own requests"}
          </label>
          <p className="mt-1 text-xs text-muted">
            {initial.role === "admin"
              ? "Admin requests are approved the moment they are made."
              : "Lets this user approve their own requests without a moderator."}
          </p>
        </div>

        <fieldset>
          <legend className="label">Libraries</legend>
          {libraries.length === 0 ? (
            <div className="text-sm text-muted">No libraries configured.</div>
          ) : (
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {libraries.map((l) => (
                <label key={l.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="check"
                    checked={libIds.includes(l.id)}
                    disabled={pending}
                    onChange={() => toggleLib(l.id)}
                  />
                  {l.name}
                </label>
              ))}
            </div>
          )}
        </fieldset>

        {error && (
          <div role="alert">
            <ErrorPanel message={error} />
          </div>
        )}

        <div className="flex gap-2">
          <button
            type="button"
            className="btn btn-accent"
            disabled={!dirty || pending}
            onClick={() => void save()}
          >
            {pending ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => dialogRef.current?.close()}
          >
            Cancel
          </button>
        </div>
      </div>
    </dialog>
  );
}
