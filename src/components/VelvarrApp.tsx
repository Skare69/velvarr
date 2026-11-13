"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import { useSearchParams } from "next/navigation";
import type {
  Account,
  Library,
  ProviderStatus,
  RequestListResponse,
} from "../lib/contracts.ts";
import { REQUESTS_CHANGED } from "../lib/approvals.ts";
import { signOutKeepsSession } from "../lib/signout.ts";
import {
  ApiError,
  api,
  clearApiCache,
  Credit,
  ErrorPanel,
  ForbiddenPanel,
  Icon,
  legacyBrowsePatch,
  messageOf,
  notifyAuthChanged,
  onAuthChanged,
  OPEN_PREFERENCES,
  SessionCtx,
  setParamsClearing,
  useApiGet,
  useParamsSetter,
  useSession,
  useTapReveal,
} from "./shared.tsx";
import dynamic from "next/dynamic";
import { DiscoverShelves, FacetsView, RailSkeleton } from "./discover.tsx";

function ChunkLoading() {
  return <div className="skel m-6 h-8 w-48" aria-hidden="true" />;
}

// Views outside the boot path load on first navigation: only the shell and
// the default discover view ride the initial bundle. FacetsView stays static:
// it lives in discover.tsx, which BootSkeleton already pulls in eagerly.
const TitlesView = dynamic(
  () => import("./catalog.tsx").then((m) => m.TitlesView),
  { loading: ChunkLoading },
);
// loading gives the lazy dialog its own Suspense boundary: without it the
// first Shell render suspends past the shell into page.tsx's fallback, and
// the whole app swaps to the loading skeleton while the chunk is in flight.
const PreferencesDialog = dynamic(
  () => import("./preferences.tsx").then((m) => m.PreferencesDialog),
  { loading: () => null },
);
const SearchView = dynamic(
  () => import("./search.tsx").then((m) => m.SearchView),
  {
    loading: ChunkLoading,
  },
);
const RequestsView = dynamic(
  () => import("./requests.tsx").then((m) => m.RequestsView),
  { loading: ChunkLoading },
);
const SettingsView = dynamic(
  () => import("./settings.tsx").then((m) => m.SettingsView),
  { loading: ChunkLoading },
);
const AdminView = dynamic(
  () => import("./admin.tsx").then((m) => m.AdminView),
  {
    loading: ChunkLoading,
  },
);
const FollowingView = dynamic(
  () => import("./following.tsx").then((m) => m.FollowingView),
  { loading: ChunkLoading },
);
const LibraryView = dynamic(
  () => import("./library.tsx").then((m) => m.LibraryView),
  { loading: ChunkLoading },
);

function BootSkeleton() {
  return (
    <div className="app-shell" aria-label="Loading Velvarr" aria-busy="true">
      <aside className="app-sidebar" aria-hidden="true">
        <div className="skel mb-10 h-10 w-36" />
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="skel mb-3 h-10" />
        ))}
      </aside>
      <div className="app-topbar" aria-hidden="true">
        <div className="skel h-10 w-full" />
      </div>
      <main className="app-main">
        <div className="skel mb-6 h-8 w-48" />
        <div className="flex flex-col gap-5">
          <RailSkeleton count={6} />
          <RailSkeleton count={6} />
          <RailSkeleton count={5} />
          <RailSkeleton count={5} />
        </div>
      </main>
    </div>
  );
}

/* ---------- Root ---------- */

type Phase = "boot" | "bootError" | "setupLocked" | "setup" | "login" | "app";

export default function VelvarrApp() {
  const [phase, setPhase] = useState<Phase>("boot");
  const [account, setAccount] = useState<Account | null>(null);
  const [providers, setProviders] = useState<ProviderStatus | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [signOutError, setSignOutError] = useState(false);
  useTapReveal();

  // Re-reads the session snapshot; also runs after an admin saves or clears
  // a provider key, so provider chips and not-configured claims update
  // without a full reload.
  const refreshSession = useCallback(async () => {
    const me = await api<{ account: Account; providers: ProviderStatus }>(
      "/api/me",
    );
    setAccount(me.account);
    setProviders(me.providers);
  }, []);

  const enterApp = useCallback(async () => {
    await refreshSession();
    setPhase("app");
  }, [refreshSession]);

  const enterAppSafe = useCallback(() => {
    // This tab just swapped the cookie (login or setup completion); other
    // tabs must drop the previous account's reads and re-boot.
    notifyAuthChanged();
    enterApp().catch((e) => {
      if (e instanceof ApiError && e.status === 401) {
        setPhase("login");
        return;
      }
      setBootError(messageOf(e));
      setPhase("bootError");
    });
  }, [enterApp]);
  const boot = useCallback(async () => {
    setPhase("boot");
    setBootError(null);
    try {
      const status = await api<{ initialized: boolean; setupReady: boolean }>(
        "/api/status",
      );
      if (!status.initialized) {
        setPhase(status.setupReady ? "setup" : "setupLocked");
        return;
      }
      await enterApp();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setPhase("login");
      } else {
        setBootError(messageOf(err));
        setPhase("bootError");
      }
    }
  }, [enterApp]);

  const clearSession = () => {
    // One account's cached reads must not reach the next sign-in: drop the
    // cache and any rendered account.
    clearApiCache();
    setAccount(null);
    setProviders(null);
  };

  useEffect(() => {
    const on401 = () => {
      clearSession();
      setPhase("login");
    };
    window.addEventListener("velvarr:unauthorized", on401);
    // Another tab signed in or out: the cookie changed under this tab, so
    // its cached reads and rendered account belong to the previous account.
    // Re-boot to pick up the session now in the cookie jar (a 401 lands the
    // tab back on the login screen).
    const offAuth = onAuthChanged(() => {
      clearSession();
      void boot();
    });
    return () => {
      window.removeEventListener("velvarr:unauthorized", on401);
      offAuth();
    };
  }, [boot]);

  useEffect(() => {
    void boot();
  }, [boot]);

  const signOut = useCallback(async () => {
    try {
      await api("/api/logout", { method: "POST", body: "{}" });
    } catch (err) {
      // Only an explicit "no session" answer may clear this tab's view. A
      // 401 already fired velvarr:unauthorized, which lands the tab on the
      // login screen. Any other failure — a network error, a CSRF 403, a
      // 5xx — leaves the session cookie valid: clearing the view would hide
      // a live session behind the login screen, and notifyAuthChanged would
      // re-boot other tabs for a cookie that never changed.
      if (!signOutKeepsSession(err)) return;
      setSignOutError(true);
      return;
    }
    clearSession();
    // Tell other tabs the cookie jar changed; they drop A's reads and re-boot.
    notifyAuthChanged();
    setSignOutError(false);
    setPhase("login");
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  if (phase === "boot") return <BootSkeleton />;
  if (phase === "bootError")
    return (
      <div className="mx-auto flex min-h-screen max-w-md items-center p-6">
        <div className="w-full">
          <ErrorPanel
            title="Velvarr could not start"
            message={bootError ?? "Unknown error"}
            onRetry={() => void boot()}
          />
        </div>
      </div>
    );
  if (phase === "setupLocked") return <SetupLocked />;
  if (phase === "setup") return <SetupWizard onDone={enterAppSafe} />;
  if (phase === "login") return <LoginView onSignedIn={enterAppSafe} />;

  if (phase !== "app" || !account) return <BootSkeleton />;
  return (
    <SessionCtx.Provider
      value={{ account, providers, signOut, refreshSession }}
    >
      <Shell />
      {/* A failed sign-out keeps the session: the banner must live outside
          the account menu so closing the menu cannot hide it. */}
      {signOutError && (
        <div className="signout-alert">
          <ErrorPanel
            title="Sign-out failed"
            message="You are still signed in."
            onRetry={() => void signOut()}
          />
        </div>
      )}
    </SessionCtx.Provider>
  );
}

/* ---------- Anonymous: setup not configured ---------- */

function SetupLocked() {
  return (
    <div className="mx-auto flex min-h-screen max-w-lg items-center p-6">
      <div className="panel w-full p-6">
        <div className="text-lg font-semibold">
          Velvarr setup is not configured yet
        </div>
        <p className="mt-3 text-sm text-muted">
          This instance has no operator secrets. To finish installation, the
          server operator needs to:
        </p>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm">
          <li>
            Set <code className="chip">VELVARR_SECRET_KEY</code> — exactly 64
            hex characters — and{" "}
            <code className="chip">VELVARR_SETUP_SECRET</code> — at least 32
            characters — in the server environment.
          </li>
          <li>
            Run <code className="chip">bun run setup</code> (or{" "}
            <code className="chip">npm run setup</code>) and restart Velvarr.
          </li>
        </ol>
        <p className="mt-3 text-sm text-muted">
          This page becomes the setup wizard once the secrets are present. No
          credentials are collected here.
        </p>
      </div>
    </div>
  );
}

/* ---------- Anonymous: setup wizard ---------- */

function SetupWizard({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({
    setupSecret: "",
    jellyfinUrl: "",
    jellyfinExternalUrl: "",
    jellyfinApiKey: "",
    username: "",
    password: "",
  });
  const [step, setStep] = useState<"inspect" | "confirm">("inspect");
  const [user, setUser] = useState<{ id: string; name: string } | null>(null);
  const [libs, setLibs] = useState<Library[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [ack, setAck] = useState(false);
  const [whisparrUrl, setWhisparrUrl] = useState("");
  const [whisparrApiKey, setWhisparrApiKey] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<keyof typeof f, string>>
  >({});

  const bind = (k: keyof typeof f) => (e: ChangeEvent<HTMLInputElement>) =>
    setF((cur) => ({ ...cur, [k]: e.target.value }));
  // Rule 35: a flagged field rechecks when the user leaves it, so a filled
  // field drops its error without waiting for the next submit.
  const recheck = (k: keyof typeof f) => () => {
    if (f[k].trim())
      setFieldErrors((cur) => {
        const next = { ...cur };
        delete next[k];
        return next;
      });
  };

  const inspect = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    // Rule 35: a missing field flags that field, at that field — the
    // form-level alert stays for server and network failures only.
    const errs: Partial<Record<keyof typeof f, string>> = {};
    for (const key of Object.keys(f) as (keyof typeof f)[])
      if (!f[key].trim()) errs[key] = "This field is required.";
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setPending(true);
    try {
      const r = await api<{
        user: { id: string; name: string };
        libraries: Library[];
      }>("/api/setup/inspect", { method: "POST", body: JSON.stringify(f) });
      setUser(r.user);
      setLibs(r.libraries);
      setStep("confirm");
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setPending(false);
    }
  };

  const commit = async () => {
    setError(null);
    if (selected.length === 0) {
      setError("Select at least one library for the owner account.");
      return;
    }
    if (!ack) {
      setError("Confirm the owner acknowledgement to continue.");
      return;
    }
    setPending(true);
    try {
      await api<{ account: Account }>("/api/setup", {
        method: "POST",
        body: JSON.stringify({
          ...f,
          libraryIds: selected,
          whisparrUrl: whisparrUrl || undefined,
          whisparrApiKey: whisparrApiKey || undefined,
        }),
      });
      onDone();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-screen max-w-lg items-center p-4 sm:p-6">
      <div className="panel w-full p-6">
        <div className="text-lg font-semibold">Set up Velvarr</div>
        <p className="mt-1 text-sm text-muted">
          One-time protected bootstrap. The selected Jellyfin account becomes
          the permanent owner.
        </p>

        {error && (
          <div className="mt-4" role="alert">
            <ErrorPanel message={error} />
          </div>
        )}

        {step === "inspect" && (
          <form
            className="mt-5 space-y-4"
            onSubmit={(e) => void inspect(e)}
            noValidate
          >
            <div>
              <label className="label" htmlFor="su-secret">
                Setup secret
              </label>
              <input
                id="su-secret"
                type="password"
                className="input"
                autoComplete="off"
                aria-invalid={fieldErrors.setupSecret ? true : undefined}
                aria-describedby={
                  fieldErrors.setupSecret ? "su-secret-error" : undefined
                }
                value={f.setupSecret}
                onChange={bind("setupSecret")}
                onBlur={recheck("setupSecret")}
              />
              {fieldErrors.setupSecret && (
                <p id="su-secret-error" className="mt-1 text-xs text-danger">
                  {fieldErrors.setupSecret}
                </p>
              )}
              <p className="mt-1 text-xs text-muted">
                The VELVARR_SETUP_SECRET value from your compose/.env file.
                Whoever knows it can claim ownership of this fresh instance.
              </p>
            </div>
            <div>
              <label className="label" htmlFor="su-url">
                Jellyfin server URL
              </label>
              <input
                id="su-url"
                type="url"
                className="input"
                placeholder="http://jellyfin:8096"
                autoComplete="url"
                maxLength={300}
                aria-invalid={fieldErrors.jellyfinUrl ? true : undefined}
                aria-describedby={
                  fieldErrors.jellyfinUrl ? "su-url-error" : undefined
                }
                value={f.jellyfinUrl}
                onChange={bind("jellyfinUrl")}
                onBlur={recheck("jellyfinUrl")}
              />
              {fieldErrors.jellyfinUrl && (
                <p id="su-url-error" className="mt-1 text-xs text-danger">
                  {fieldErrors.jellyfinUrl}
                </p>
              )}
              <p className="mt-1 text-xs text-muted">
                How Velvarr reaches Jellyfin — must resolve from inside the
                Velvarr container (http://jellyfin:8096 only works on a shared
                Docker network; otherwise use the host address).
              </p>
            </div>
            <div>
              <label className="label" htmlFor="su-ext">
                Jellyfin external URL (web address users open)
              </label>
              <input
                id="su-ext"
                type="url"
                className="input"
                placeholder="https://jellyfin.example.com"
                autoComplete="url"
                maxLength={300}
                aria-invalid={
                  fieldErrors.jellyfinExternalUrl ? true : undefined
                }
                aria-describedby={
                  fieldErrors.jellyfinExternalUrl ? "su-ext-error" : undefined
                }
                value={f.jellyfinExternalUrl}
                onChange={bind("jellyfinExternalUrl")}
                onBlur={recheck("jellyfinExternalUrl")}
              />
              {fieldErrors.jellyfinExternalUrl && (
                <p id="su-ext-error" className="mt-1 text-xs text-danger">
                  {fieldErrors.jellyfinExternalUrl}
                </p>
              )}
              <p className="mt-1 text-xs text-muted">
                The Jellyfin web address users open in a browser. Used to build
                playback links.
              </p>
            </div>
            <div>
              <label className="label" htmlFor="su-key">
                Jellyfin API key (administrator)
              </label>
              <input
                id="su-key"
                type="password"
                className="input"
                autoComplete="off"
                aria-invalid={fieldErrors.jellyfinApiKey ? true : undefined}
                aria-describedby={
                  fieldErrors.jellyfinApiKey ? "su-key-error" : undefined
                }
                value={f.jellyfinApiKey}
                onChange={bind("jellyfinApiKey")}
                onBlur={recheck("jellyfinApiKey")}
              />
              {fieldErrors.jellyfinApiKey && (
                <p id="su-key-error" className="mt-1 text-xs text-danger">
                  {fieldErrors.jellyfinApiKey}
                </p>
              )}
              <p className="mt-1 text-xs text-muted">
                Administrator key from Jellyfin Dashboard → API Keys. Used for
                read-only server status; user actions always run under the
                signed-in user's own token.
              </p>
            </div>
            <div>
              <label className="label" htmlFor="su-user">
                Owner Jellyfin username
              </label>
              <input
                id="su-user"
                type="text"
                className="input"
                autoComplete="username"
                aria-invalid={fieldErrors.username ? true : undefined}
                aria-describedby={
                  fieldErrors.username ? "su-user-error" : undefined
                }
                value={f.username}
                onChange={bind("username")}
                onBlur={recheck("username")}
              />
              {fieldErrors.username && (
                <p id="su-user-error" className="mt-1 text-xs text-danger">
                  {fieldErrors.username}
                </p>
              )}
              <p className="mt-1 text-xs text-muted">
                The Jellyfin account that becomes Velvarr's permanent owner.
              </p>
            </div>
            <div>
              <label className="label" htmlFor="su-pass">
                Owner Jellyfin password
              </label>
              <input
                id="su-pass"
                type="password"
                className="input"
                autoComplete="current-password"
                aria-invalid={fieldErrors.password ? true : undefined}
                aria-describedby={
                  fieldErrors.password ? "su-pass-error" : undefined
                }
                value={f.password}
                onChange={bind("password")}
                onBlur={recheck("password")}
              />
              {fieldErrors.password && (
                <p id="su-pass-error" className="mt-1 text-xs text-danger">
                  {fieldErrors.password}
                </p>
              )}
              <p className="mt-1 text-xs text-muted">
                That account's Jellyfin password. Velvarr verifies it once
                against Jellyfin and never stores it — every login happens
                against Jellyfin.
              </p>
            </div>
            <button
              type="submit"
              className="btn btn-accent w-full"
              disabled={pending}
            >
              {pending ? "Checking…" : "Inspect connection"}
            </button>
          </form>
        )}

        {step === "confirm" && user && (
          <div className="mt-5 space-y-4">
            <div className="text-sm">
              Verified Jellyfin account:{" "}
              <span className="font-medium">
                {user.name} <span className="chip">{user.id}</span>
              </span>
            </div>

            <fieldset>
              <legend className="label">Libraries the owner can browse</legend>
              {libs.length === 0 ? (
                <div className="panel p-3 text-sm text-muted">
                  No eligible movie/video libraries were returned. Setup cannot
                  be completed without at least one library.
                </div>
              ) : (
                <div className="space-y-2">
                  {libs.map((lib) => (
                    <label
                      key={lib.id}
                      className="flex items-center gap-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        className="check"
                        checked={selected.includes(lib.id)}
                        onChange={() =>
                          setSelected((cur) =>
                            cur.includes(lib.id)
                              ? cur.filter((x) => x !== lib.id)
                              : [...cur, lib.id],
                          )
                        }
                      />
                      {lib.name}
                    </label>
                  ))}
                </div>
              )}
            </fieldset>

            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="check mt-0.5"
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
              />
              <span>
                I understand this Jellyfin account becomes the permanent Velvarr
                owner and that bootstrap closes after this step.
              </span>
            </label>

            <details className="panel p-3">
              <summary className="cursor-pointer text-sm text-muted">
                Optional: Whisparr integration
              </summary>
              <div className="mt-3 space-y-3">
                <div>
                  <label className="label" htmlFor="su-whisparr-url">
                    Whisparr URL
                  </label>
                  <input
                    id="su-whisparr-url"
                    type="url"
                    className="input"
                    placeholder="http://whisparr:6969"
                    autoComplete="url"
                    maxLength={300}
                    value={whisparrUrl}
                    onChange={(e) => setWhisparrUrl(e.target.value)}
                  />
                </div>
                <div>
                  <label className="label" htmlFor="su-whisparr-key">
                    Whisparr API key
                  </label>
                  <input
                    id="su-whisparr-key"
                    type="password"
                    className="input"
                    autoComplete="off"
                    value={whisparrApiKey}
                    onChange={(e) => setWhisparrApiKey(e.target.value)}
                  />
                </div>
              </div>
            </details>

            <div className="flex gap-2">
              <button
                type="button"
                className="btn"
                disabled={pending}
                onClick={() => {
                  setStep("inspect");
                  setAck(false);
                }}
              >
                Back
              </button>
              <button
                type="button"
                className="btn btn-accent flex-1"
                disabled={pending || libs.length === 0}
                onClick={() => void commit()}
              >
                {pending ? "Creating…" : "Create owner account"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- Anonymous: login ---------- */

function LoginView({ onSignedIn }: { onSignedIn: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{
    username?: string;
    password?: string;
  }>({});

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    // Rule 35: each missing field flags itself at the field; the form-level
    // alert stays for server and network failures only.
    const errs: { username?: string; password?: string } = {};
    if (!username.trim()) errs.username = "Enter your username.";
    if (!password) errs.password = "Enter your password.";
    setFieldErrors(errs);
    if (errs.username || errs.password) return;
    setPending(true);
    try {
      await api<{ account: Account }>("/api/login", {
        method: "POST",
        body: JSON.stringify({ username: username.trim(), password }),
      });
      setPassword("");
      onSignedIn();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="panel auth-card">
        <div className="brand">
          <span className="brand-mark">
            <img src="/velvarr-logo.png" alt="" />
          </span>
          Velvarr
        </div>
        <h1>Welcome back</h1>
        <p className="mt-1 text-sm text-muted">
          Sign in with your Jellyfin account.
        </p>
        {error && (
          <div className="mt-4" role="alert">
            <ErrorPanel message={error} />
          </div>
        )}
        <form
          className="mt-5 space-y-4"
          onSubmit={(e) => void submit(e)}
          noValidate
        >
          <div>
            <label className="label" htmlFor="li-user">
              Username
            </label>
            <input
              id="li-user"
              type="text"
              className="input"
              autoComplete="username"
              aria-invalid={fieldErrors.username ? true : undefined}
              aria-describedby={
                fieldErrors.username ? "li-user-error" : undefined
              }
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onBlur={() => {
                // Rule 35: a filled field drops its error when left.
                if (username.trim())
                  setFieldErrors((c) => ({ ...c, username: undefined }));
              }}
            />
            {fieldErrors.username && (
              <p id="li-user-error" className="mt-1 text-xs text-danger">
                {fieldErrors.username}
              </p>
            )}
          </div>
          <div>
            <label className="label" htmlFor="li-pass">
              Password
            </label>
            <input
              id="li-pass"
              type="password"
              className="input"
              autoComplete="current-password"
              aria-invalid={fieldErrors.password ? true : undefined}
              aria-describedby={
                fieldErrors.password ? "li-pass-error" : undefined
              }
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onBlur={() => {
                if (password)
                  setFieldErrors((c) => ({ ...c, password: undefined }));
              }}
            />
            {fieldErrors.password && (
              <p id="li-pass-error" className="mt-1 text-xs text-danger">
                {fieldErrors.password}
              </p>
            )}
          </div>
          <button
            type="submit"
            className="btn btn-accent w-full"
            disabled={pending}
          >
            {pending ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <Credit />
      </div>
    </div>
  );
}

/* ---------- Shell ---------- */

/** localStorage key of the desktop sidebar's collapsed state. */
const SIDEBAR_KEY = "velvarr:sidebar-collapsed";

const VIEWS = [
  "discover",
  "facets",
  "titles",
  "following",
  "search",
  "requests",
  "library",
  "admin",
  "settings",
] as const;
type View = (typeof VIEWS)[number];

/* ---------- Persistent global search ---------- */

function GlobalSearchForm() {
  const params = useSearchParams();
  const setP = useParamsSetter();
  const urlQ = params.get("view") === "search" ? (params.get("q") ?? "") : "";
  const [input, setInput] = useState(urlQ);
  const inputRef = useRef<HTMLInputElement>(null);
  // The debounced write below echoes back through urlQ after the navigation
  // commits. Rewriting the box from that echo eats characters typed while it
  // was in flight (the trimmed trailing space in "jane "), so the echo is
  // recognized by the q this component just wrote and ignored. Any other q —
  // Back/Forward, a link from another surface — still resets the box.
  const ownQRef = useRef<string | null>(null);

  useEffect(() => {
    if (urlQ === ownQRef.current) return;
    ownQRef.current = null;
    setInput(urlQ);
  }, [urlQ]);
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      const target = event.target;
      const typing =
        target instanceof HTMLElement &&
        (target.matches("input, textarea, select") || target.isContentEditable);
      if (
        ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") ||
        (event.key === "/" &&
          !typing &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey)
      ) {
        if (document.querySelector("dialog[open]")) return;
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setParamsClearing(
      setP,
      { view: "search", q: input.trim() || null },
      { push: true },
    );
    window.scrollTo({ top: 0 });
  };

  // Live search: the omnibox starts searching on keystrokes. A debounced
  // timer writes the same { view: "search", q } URL the submit button writes,
  // so SearchView's URL-driven fetch fires without Enter. The first write
  // opens the surface (push, so Back returns to where you were); later
  // keystrokes replace the entry so typing never fills the history stack.
  // Guarded on input vs the URL's q: mounting on any view writes nothing.
  useEffect(() => {
    const t = setTimeout(() => {
      const q = input.trim();
      if (q === urlQ) return;
      ownQRef.current = q;
      setParamsClearing(
        setP,
        { view: "search", q: q || null },
        { push: params.get("view") !== "search" },
      );
    }, 300);
    return () => clearTimeout(t);
  }, [input, urlQ, params, setP]);
  return (
    <form role="search" onSubmit={submit} className="global-search">
      <Icon name="search" />
      <label htmlFor="global-search" className="sr-only">
        Search all sources
      </label>
      <input
        ref={inputRef}
        id="global-search"
        type="search"
        maxLength={200}
        autoComplete="off"
        spellCheck={false}
        placeholder="Search movies, scenes, performers…"
        value={input}
        onChange={(event) => setInput(event.target.value)}
      />
      <kbd className="search-shortcut" title="Press / or Control K to search">
        /
      </kbd>
      <button
        type="submit"
        className="icon-button"
        aria-label="Search everything"
      >
        <Icon name="arrow-right" />
      </button>
    </form>
  );
}

/** How many requests this account may actually decide right now: staff see
 * every pending row, an autoApprove holder only their own. The server counts
 * (`pendingApprovals` on GET /api/requests), so the badge reads one row, not
 * the whole table. A failed or forbidden read shows "?", never a zero.
 * Re-reads on navigation and whenever the Requests view has just read
 * authoritative rows, so approving a request drops the count immediately.
 * ponytail: no polling or SSE — another tab's decision lands on this one's
 * next navigation; add a live channel only if operators need cross-tab counts. */
function usePendingApprovals(
  account: Account,
  view: View,
): number | "unavailable" {
  const eligible =
    account.role === "admin" ||
    account.role === "moderator" ||
    account.autoApprove;
  const { data, error, reload } = useApiGet<RequestListResponse>(
    eligible ? "/api/requests?limit=1" : null,
    [eligible, account, view],
  );
  // The Requests view announces fresh authoritative rows, so approving a
  // request drops the count immediately. A failed read never reads as zero
  // — that would look like "nothing to approve"; the badge shows "?" and
  // names the count unavailable (§5: a failing source degrades with a
  // named error).
  useEffect(() => {
    if (!eligible) return;
    window.addEventListener(REQUESTS_CHANGED, reload);
    return () => window.removeEventListener(REQUESTS_CHANGED, reload);
  }, [eligible, reload]);
  // "?" only for an eligible read that failed: an account that cannot
  // decide, or a read still in flight, shows no badge at all.
  if (!eligible || (error === null && data === null)) return 0;
  return error === null && data !== null
    ? data.pendingApprovals
    : "unavailable";
}

function Shell() {
  const session = useSession();
  const params = useSearchParams();
  const setP = useParamsSetter();
  const raw = params.get("view");
  // Old movies/scenes bookmarks and facet links normalize once into the
  // canonical titles URL — replaced, not pushed, so Back still exits the app
  // instead of bouncing off a dead view. Detail provider/kind/id and every
  // preserved filter ride along via the patch.
  const legacy = useMemo(() => legacyBrowsePatch(params), [params]);
  useEffect(() => {
    if (legacy) setP(legacy);
  }, [legacy, setP]);
  const view: View = VIEWS.includes(raw as View)
    ? (raw as View)
    : legacy
      ? "titles"
      : !raw &&
          (params.has("item") ||
            params.has("libraryId") ||
            params.has("search"))
        ? "library"
        : "discover";
  const isAdmin = session.account.role === "admin";
  const navigation = useRef<HTMLDialogElement>(null);
  const accountMenu = useRef<HTMLDetailsElement>(null);
  // Desktop sidebar collapse, remembered on this device. Read after mount:
  // the server render has no localStorage, so the first paint is expanded.
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    setCollapsed(localStorage.getItem(SIDEBAR_KEY) === "1");
  }, []);
  const toggleSidebar = useCallback(() => {
    const next = !collapsed;
    localStorage.setItem(SIDEBAR_KEY, next ? "1" : "0");
    setCollapsed(next);
  }, [collapsed]);
  // The menu's Preferences button hides with the menu before showModal, so
  // that path restores focus by hand. Browse's openers are live when they
  // open, but a save remounts them (the reload clears acc, and "N hidden"
  // renders only while tags are hidden), so open records the focused node
  // and close restores it or its fresh replacement.
  const prefsFromMenu = useRef(false);
  const prefsOpener = useRef<Element | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);
  // Browse controls ("N hidden", drawer note) open the modal in place so the
  // URL keeps every filter — the removed ?view=preferences dropped them.
  useEffect(() => {
    const open = () => {
      prefsFromMenu.current = false;
      prefsOpener.current = document.activeElement;
      setPrefsOpen(true);
    };
    window.addEventListener(OPEN_PREFERENCES, open);
    return () => window.removeEventListener(OPEN_PREFERENCES, open);
  }, []);
  // A <details> menu stays open when you click anywhere else; close it on an
  // outside click and on Escape, like every other menu on the page.
  useEffect(() => {
    const close = (event: MouseEvent) => {
      const menu = accountMenu.current;
      if (menu?.open && !menu.contains(event.target as Node)) menu.open = false;
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && accountMenu.current?.open)
        accountMenu.current.open = false;
    };
    document.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", onKey);
    };
  }, []);
  const pendingApprovals = usePendingApprovals(session.account, view);
  const nav = [
    { id: "discover", label: "Discover", icon: "discover", group: "browse" },
    // One browse surface: movies and scenes are a filter inside it, not
    // separate destinations.
    { id: "titles", label: "Browse", icon: "movie", group: "browse" },
    // One performer surface: the ones you follow. Discovery of new
    // performers is the top search bar, which already searches them.
    {
      id: "following",
      label: "Performers",
      icon: "performer",
      group: "browse",
    },
    { id: "library", label: "Library", icon: "library", group: "manage" },
    { id: "requests", label: "Requests", icon: "requests", group: "manage" },
    { id: "admin", label: "Users", icon: "users", group: "admin" },
    { id: "settings", label: "Settings", icon: "settings", group: "admin" },
  ] as const;
  const visibleNav = nav.filter((item) => item.group !== "admin" || isAdmin);
  const go = (next: View) => {
    setParamsClearing(
      setP,
      { view: next === "discover" ? null : next },
      { push: true },
    );
    navigation.current?.close();
    window.scrollTo({ top: 0 });
  };
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 1024px)");
    const closeMenu = () => {
      if (desktop.matches) navigation.current?.close();
    };
    desktop.addEventListener("change", closeMenu);
    return () => desktop.removeEventListener("change", closeMenu);
  }, []);
  const navLinks = visibleNav.map((item, index) => (
    <div key={item.id}>
      {index > 0 && visibleNav[index - 1]?.group !== item.group && (
        <div className="nav-section" />
      )}
      <a
        href={item.id === "discover" ? "/" : `/?view=${item.id}`}
        className="nav-btn"
        aria-current={view === item.id ? "page" : undefined}
        title={collapsed ? item.label : undefined}
        onClick={(event) => {
          if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
            return;
          event.preventDefault();
          go(item.id);
        }}
      >
        <Icon name={item.icon} />
        <span className="nav-label">{item.label}</span>
        {item.id === "requests" &&
          (pendingApprovals === "unavailable" || pendingApprovals > 0) && (
            <span
              className="nav-badge"
              aria-label={
                pendingApprovals === "unavailable"
                  ? "Approval count unavailable"
                  : `${pendingApprovals} request${pendingApprovals === 1 ? "" : "s"} awaiting approval`
              }
            >
              {pendingApprovals === "unavailable" ? "?" : pendingApprovals}
            </span>
          )}
      </a>
    </div>
  ));
  const brand = (
    <a
      className="brand"
      href="/"
      onClick={(event) => {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
          return;
        event.preventDefault();
        go("discover");
      }}
    >
      <span className="brand-mark">
        <img src="/velvarr-logo.png" alt="" />
      </span>
      <span className="brand-name">Velvarr</span>
    </a>
  );

  return (
    <div className={`app-shell${collapsed ? " is-collapsed" : ""}`}>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      {/* A click on empty sidebar space toggles it too, a mouse shortcut;
          the Collapse button is the keyboard and screen-reader control. */}
      <aside
        className="app-sidebar"
        onClick={(event) => {
          if (!(event.target as Element).closest("a, button")) toggleSidebar();
        }}
      >
        {brand}
        <nav className="app-nav" aria-label="Main">
          {navLinks}
        </nav>
        <div className="sidebar-footer">
          <button
            type="button"
            className="nav-btn sidebar-toggle"
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : undefined}
            onClick={toggleSidebar}
          >
            <Icon name={collapsed ? "chevron-right" : "chevron-left"} />
            <span className="nav-label">Collapse</span>
          </button>
          <Credit />
        </div>
      </aside>
      <header className="app-topbar">
        <GlobalSearchForm />
        <details ref={accountMenu} className="account-menu">
          <summary aria-label="Account menu" title={session.account.name}>
            <AccountAvatar account={session.account} />
          </summary>
          <div className="panel account-popover">
            <div className="account-identity">
              <AccountAvatar account={session.account} />
              <div className="min-w-0">
                <div className="truncate font-semibold">
                  {session.account.name}
                </div>
                <div className="mt-1 text-sm text-muted capitalize">
                  {session.account.role}
                </div>
              </div>
            </div>
            {/* Personal preferences are every account's own surface — never
                the admin Settings view. Now the modal, not a page. */}
            <button
              type="button"
              className="btn"
              onClick={() => {
                if (accountMenu.current) accountMenu.current.open = false;
                prefsFromMenu.current = true;
                setPrefsOpen(true);
              }}
            >
              <Icon name="settings" />
              Preferences
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => void session.signOut()}
            >
              <Icon name="logout" />
              Sign out
            </button>
          </div>
        </details>
      </header>
      <main className="app-main" id="main-content" tabIndex={-1}>
        {view === "discover" && <DiscoverShelves />}
        {view === "facets" && <FacetsView />}
        {view === "titles" && <TitlesView />}
        {view === "following" && <FollowingView />}
        {view === "library" && <LibraryView />}
        {view === "requests" && <RequestsView />}
        {view === "search" && <SearchView />}
        {view === "admin" && (isAdmin ? <AdminView /> : <ForbiddenPanel />)}
        {view === "settings" &&
          (isAdmin ? <SettingsView /> : <ForbiddenPanel />)}
      </main>
      <nav className="mobile-bottom-nav" aria-label="Quick navigation">
        {visibleNav
          .filter((item) => item.group === "browse" || item.id === "requests")
          .map((item) => (
            <a
              key={item.id}
              href={item.id === "discover" ? "/" : `/?view=${item.id}`}
              aria-current={view === item.id ? "page" : undefined}
              onClick={(event) => {
                if (
                  event.ctrlKey ||
                  event.metaKey ||
                  event.shiftKey ||
                  event.altKey
                )
                  return;
                event.preventDefault();
                go(item.id);
              }}
            >
              <Icon name={item.icon} />
              {item.label}
            </a>
          ))}
        {/* Seerr's phone layout: the pages the bar has no room for live
            behind More, one entry point instead of a second (hamburger) one. */}
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={menuOpen}
          aria-controls="mobile-navigation"
          onClick={() => {
            navigation.current?.showModal();
            setMenuOpen(true);
          }}
        >
          <Icon name="menu" />
          More
        </button>
      </nav>
      <dialog
        ref={navigation}
        className="mobile-navigation"
        id="mobile-navigation"
        aria-label="Navigation"
        onClose={() => setMenuOpen(false)}
        onClick={(event) => {
          // A backdrop tap targets the dialog itself, above the sheet's box.
          if (
            event.target === event.currentTarget &&
            event.clientY < event.currentTarget.getBoundingClientRect().top
          )
            navigation.current?.close();
        }}
      >
        <div className="drawer-heading">
          {brand}
          <button
            type="button"
            className="icon-button"
            aria-label="Close navigation"
            onClick={() => navigation.current?.close()}
          >
            <Icon name="close" />
          </button>
        </div>
        <nav className="app-nav" aria-label="Mobile navigation">
          {navLinks}
        </nav>
        <div className="sidebar-footer">
          <Credit />
        </div>
      </dialog>
      <PreferencesDialog
        open={prefsOpen}
        onClose={() => {
          setPrefsOpen(false);
          const summary = accountMenu.current?.querySelector("summary");
          if (prefsFromMenu.current) {
            // The menu's Preferences button hid with the account menu before
            // showModal, so the browser has no live element to return focus
            // to; put it back on the menu's visible opener.
            summary?.focus();
            return;
          }
          // A save unmounts Browse's openers (the reload clears acc, and the
          // "N hidden" button only renders while tags are hidden), so the
          // node the native close steps would restore to can be detached.
          // Restore to the recorded opener when it survived, else the fresh
          // button of the same kind, else the account menu's visible opener.
          const opener = prefsOpener.current;
          const kind = opener?.getAttribute("data-prefs-opener");
          const target =
            opener instanceof HTMLElement && opener.isConnected
              ? opener
              : kind
                ? document.querySelector<HTMLElement>(
                    `[data-prefs-opener="${kind}"]`,
                  )
                : null;
          (target ?? summary)?.focus();
        }}
      />
    </div>
  );
}

/** The signed-in account's own Jellyfin avatar: its initial until the image
 *  loads, and for good when Jellyfin has none (the route 404s) — never a blank
 *  or broken image. The server ignores `?account`; it keys the browser cache
 *  per account, so a second sign-in here never shows the first one's face. */
function AccountAvatar({ account }: { account: Account }) {
  const [image, setImage] = useState<"loading" | "shown" | "none">("loading");
  return (
    <span className="account-avatar">
      {image !== "shown" && account.name.slice(0, 1).toUpperCase()}
      {image !== "none" && (
        <img
          src={`/api/me/avatar?account=${account.id}`}
          alt=""
          hidden={image === "loading"}
          onLoad={() => setImage("shown")}
          onError={() => setImage("none")}
        />
      )}
    </span>
  );
}
