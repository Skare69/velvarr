"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import { useSearchParams } from "next/navigation";
import type {
  Account,
  AdminAccount,
  CatalogReference,
  Library,
  LibraryItem,
  LibraryPage,
  PerformerFollow,
  ProviderStatus,
  RequestRecord,
  Role,
  WhisparrDelivery,
  WhisparrPathMapping,
} from "../lib/contracts.ts";
import { countPendingApprovals, REQUESTS_CHANGED } from "../lib/approvals.ts";
import {
  ApiError,
  api,
  CardStatusBadge,
  CardTypeBadge,
  ErrorPanel,
  FileFacts,
  ForbiddenPanel,
  Icon,
  imgSrc,
  intOr,
  ItemImage,
  messageOf,
  SessionCtx,
  useApiGet,
  useParamsSetter,
  useSession,
  useTapReveal,
} from "./shared.tsx";
import { MoviesView, ScenesView } from "./catalog.tsx";
import { PerformerView } from "./performer.tsx";
import { DiscoverShelves } from "./discover.tsx";
import { SearchView } from "./search.tsx";
import { RequestsView } from "./requests.tsx";
import { RemovalsView } from "./removals.tsx";
import { LimitsPanel, ReleaseStatusPanel } from "./limits.tsx";

/* ---------- App-local API view records (not in contracts.ts) ---------- */

interface WhisparrStatus {
  configured: boolean;
  version?: string;
  appName?: string;
  rootFolders?: { id: number; path: string }[];
  profiles?: { id: number; name: string }[];
}

interface JellyfinStatus {
  configured: boolean;
  serverName?: string;
  version?: string;
}
interface IntegrationsInfo {
  jellyfin: {
    url: string;
    externalUrl: string;
    serverId: string;
    libraryIds: string[];
    apiKeyConfigured: boolean;
  };
  whisparr: {
    url: string;
    apiKeyConfigured: boolean;
    delivery: WhisparrDelivery | null;
    pathMappings: WhisparrPathMapping[];
  } | null;
}

/* ---------- View helpers ---------- */

const runtime = (ticks?: number) =>
  ticks && ticks > 0 ? `${Math.round(ticks / 600_000_000)} min` : null;

const PROVIDER_STATE: Record<ProviderStatus["tpdb"], string> = {
  not_configured: "Not configured",
  not_verified: "API key present — not verified",
};

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
        <div className="poster-grid">
          {Array.from({ length: 14 }, (_, i) => (
            <div key={i} className="skel aspect-[2/3]" />
          ))}
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
  useTapReveal();

  const enterApp = useCallback(async () => {
    const me = await api<{ account: Account; providers: ProviderStatus }>(
      "/api/me",
    );
    setAccount(me.account);
    setProviders(me.providers);
    setPhase("app");
  }, []);

  const enterAppSafe = useCallback(() => {
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

  useEffect(() => {
    const on401 = () => {
      setAccount(null);
      setProviders(null);
      setPhase("login");
    };
    window.addEventListener("velvarr:unauthorized", on401);
    return () => window.removeEventListener("velvarr:unauthorized", on401);
  }, []);

  useEffect(() => {
    void boot();
  }, [boot]);

  const signOut = useCallback(async () => {
    try {
      await api("/api/logout", { method: "POST", body: "{}" });
    } catch {
      /* cookie already gone */
    }
    setAccount(null);
    setProviders(null);
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
    <SessionCtx.Provider value={{ account, providers, signOut }}>
      <Shell />
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

  const bind = (k: keyof typeof f) => (e: ChangeEvent<HTMLInputElement>) =>
    setF((cur) => ({ ...cur, [k]: e.target.value }));

  const inspect = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (Object.values(f).some((v) => !v.trim())) {
      setError("All fields are required.");
      return;
    }
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
                value={f.setupSecret}
                onChange={bind("setupSecret")}
              />
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
                type="text"
                className="input"
                placeholder="http://jellyfin:8096"
                autoComplete="off"
                maxLength={300}
                value={f.jellyfinUrl}
                onChange={bind("jellyfinUrl")}
              />
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
                type="text"
                className="input"
                placeholder="https://jellyfin.example.com"
                autoComplete="off"
                maxLength={300}
                value={f.jellyfinExternalUrl}
                onChange={bind("jellyfinExternalUrl")}
              />
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
                value={f.jellyfinApiKey}
                onChange={bind("jellyfinApiKey")}
              />
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
                value={f.username}
                onChange={bind("username")}
              />
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
                value={f.password}
                onChange={bind("password")}
              />
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
                    type="text"
                    className="input"
                    placeholder="http://whisparr:6969"
                    autoComplete="off"
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

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!username.trim() || !password) {
      setError("Enter your username and password.");
      return;
    }
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
            <Icon name="play" />
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
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
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
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <button
            type="submit"
            className="btn btn-accent w-full"
            disabled={pending}
          >
            {pending ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}

/* ---------- Shell ---------- */

const VIEWS = [
  "discover",
  "movies",
  "scenes",
  "following",
  "search",
  "requests",
  "removals",
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

  useEffect(() => setInput(urlQ), [urlQ]);
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
    const updates: Record<string, string | null> = {};
    for (const key of new URLSearchParams(window.location.search).keys())
      updates[key] = null;
    setP(
      { ...updates, view: "search", q: input.trim() || null },
      { push: true },
    );
    window.scrollTo({ top: 0 });
  };
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
 * every pending row, an autoApprove holder only their own. A failed or
 * forbidden read counts zero — a wrong number is worse than no badge.
 * Re-reads on navigation and whenever the Requests view has just read
 * authoritative rows, so approving a request drops the count immediately.
 * ponytail: no polling or SSE — another tab's decision lands on this one's
 * next navigation; add a live channel only if operators need cross-tab counts. */
function usePendingApprovals(account: Account, view: View): number {
  const eligible =
    account.role === "admin" ||
    account.role === "moderator" ||
    account.autoApprove;
  const { data, error, reload } = useApiGet<{ requests: RequestRecord[] }>(
    eligible ? "/api/requests" : null,
    [eligible, account, view],
  );
  // The Requests view announces fresh authoritative rows, so approving a
  // request drops the count immediately. A failed read counts zero — a
  // wrong number is worse than no badge.
  useEffect(() => {
    if (!eligible) return;
    window.addEventListener(REQUESTS_CHANGED, reload);
    return () => window.removeEventListener(REQUESTS_CHANGED, reload);
  }, [eligible, reload]);
  return error === null && data !== null
    ? countPendingApprovals(data.requests, account)
    : 0;
}

function Shell() {
  const session = useSession();
  const params = useSearchParams();
  const setP = useParamsSetter();
  const raw = params.get("view");
  const view: View = VIEWS.includes(raw as View)
    ? (raw as View)
    : !raw &&
        (params.has("item") || params.has("libraryId") || params.has("search"))
      ? "library"
      : "discover";
  const isAdmin = session.account.role === "admin";
  const navigation = useRef<HTMLDialogElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const pendingApprovals = usePendingApprovals(session.account, view);
  const nav = [
    { id: "discover", label: "Discover", icon: "discover", group: "browse" },
    { id: "movies", label: "Movies", icon: "movie", group: "browse" },
    { id: "scenes", label: "Scenes", icon: "scene", group: "browse" },
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
    { id: "removals", label: "Removals", icon: "removals", group: "manage" },
    { id: "admin", label: "Users", icon: "users", group: "admin" },
    { id: "settings", label: "Settings", icon: "settings", group: "admin" },
  ] as const;
  const visibleNav = nav.filter((item) => item.group !== "admin" || isAdmin);
  const go = (next: View) => {
    const updates: Record<string, string | null> = {};
    for (const key of new URLSearchParams(window.location.search).keys())
      updates[key] = null;
    setP(
      { ...updates, view: next === "discover" ? null : next },
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
        onClick={(event) => {
          if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
            return;
          event.preventDefault();
          go(item.id);
        }}
      >
        <Icon name={item.icon} />
        {item.label}
        {item.id === "requests" && pendingApprovals > 0 && (
          <span
            className="nav-badge"
            aria-label={`${pendingApprovals} request${pendingApprovals === 1 ? "" : "s"} awaiting approval`}
          >
            {pendingApprovals}
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
        <Icon name="play" />
      </span>
      Velvarr
    </a>
  );

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className="app-sidebar">
        {brand}
        <nav className="app-nav" aria-label="Main">
          {navLinks}
        </nav>
        <div className="sidebar-footer">
          <strong>Your next watch, discovered.</strong>Powered by your own
          library.
        </div>
      </aside>
      <header className="app-topbar">
        <button
          type="button"
          className="icon-button mobile-menu-button"
          aria-label="Open navigation"
          aria-expanded={menuOpen}
          aria-controls="mobile-navigation"
          onClick={() => {
            navigation.current?.showModal();
            setMenuOpen(true);
          }}
        >
          <Icon name="menu" />
        </button>
        <GlobalSearchForm />
        <details className="account-menu">
          <summary aria-label="Account menu" title={session.account.name}>
            <span className="account-avatar">
              {session.account.name.slice(0, 1).toUpperCase()}
            </span>
          </summary>
          <div className="panel account-popover">
            <div className="truncate font-semibold">{session.account.name}</div>
            <div className="mt-1 text-sm text-muted capitalize">
              {session.account.role}
            </div>
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
        {view === "movies" && <MoviesView />}
        {view === "scenes" && <ScenesView />}
        {view === "following" && <FollowingView />}
        {view === "library" && <LibraryView />}
        {view === "requests" && <RequestsView />}
        {view === "search" && <SearchView />}
        {view === "removals" && <RemovalsView />}
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
      </nav>
      <dialog
        ref={navigation}
        className="mobile-navigation"
        id="mobile-navigation"
        aria-label="Navigation"
        onClose={() => setMenuOpen(false)}
        onClick={(event) => {
          if (
            event.target === event.currentTarget &&
            event.clientX > event.currentTarget.getBoundingClientRect().right
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
      </dialog>
    </div>
  );
}

/* ---------- Following ---------- */

function FollowingView() {
  const params = useSearchParams();
  const setP = useParamsSetter();
  const [follows, setFollows] = useState<PerformerFollow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    setError(null);
    api<{ follows: PerformerFollow[] }>("/api/follows")
      .then((d) => {
        if (live) setFollows(d.follows);
      })
      .catch((e) => {
        if (live) setError(messageOf(e));
      });
    return () => {
      live = false;
    };
  }, [reload]);

  // Opening a performer stays on this view — the same URL carries the
  // performer page below. Push, so Back returns to the list.
  const open = useCallback(
    (r: CatalogReference) =>
      setP({ provider: r.provider, kind: r.kind, id: r.id }, { push: true }),
    [setP],
  );

  // The row leaves the list only after the server confirmed the delete; a
  // failure keeps the row and says so.
  const unfollow = (f: PerformerFollow) => {
    setBusyId(f.id);
    setRowError(null);
    api<void>(
      `/api/follows/${f.reference.provider}/${encodeURIComponent(f.reference.id)}`,
      { method: "DELETE" },
    )
      .then(() => {
        setFollows((list) => (list ?? []).filter((x) => x.id !== f.id));
      })
      .catch((e) => {
        setRowError(`${f.name} is still followed — ${messageOf(e)}`);
      })
      .finally(() => setBusyId(null));
  };

  // Performer detail is this view's own detail page: provider + id in the
  // URL open it, and Back drops straight to the follow list. The kind is
  // checked, because a movie or scene id here is not a performer — this view
  // used to hand any id to the performer page, which then asked the provider
  // for a performer that never existed.
  const id = params.get("id");
  const provider = params.get("provider");
  const kind = params.get("kind");
  if (
    id &&
    (provider === "tpdb" || provider === "stashdb") &&
    (kind === null || kind === "performer")
  ) {
    return (
      <section aria-label="Performer">
        <PerformerView reference={{ provider, kind: "performer", id }} />
      </section>
    );
  }

  return (
    <section aria-label="Performers you follow">
      <div className="page-heading">
        <div>
          <h1 className="page-title">Performers</h1>
        </div>
      </div>
      {rowError && <ErrorPanel title="Could not unfollow" message={rowError} />}
      {error ? (
        <ErrorPanel
          title="Follow list unavailable"
          message={error}
          onRetry={() => setReload((n) => n + 1)}
        />
      ) : follows === null ? (
        <div
          className="performer-grid"
          aria-label="Loading follows"
          aria-busy="true"
        >
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="skel aspect-square" />
          ))}
        </div>
      ) : follows.length === 0 ? (
        <div className="panel p-8 text-center text-sm text-muted">
          You are not following anyone yet. Open a performer and press Follow —
          the star on their page — and they will appear here.
        </div>
      ) : (
        <div className="performer-grid">
          {follows.map((f) => (
            <div key={f.id} className="media-card performer-card follow-card">
              <button
                type="button"
                className="follow-open"
                onClick={() => open(f.reference)}
              >
                <div className="media-art aspect-square">
                  <ItemImage
                    name={f.name}
                    src={imgSrc(f.imageUrl ?? undefined)}
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                </div>
                {/* No provider chip: a follow covers both metadata sources,
                    so naming one here would be a half-truth. The performer's
                    own page still says which source it is reading. */}
                <div className="media-meta">
                  <div className="media-title">{f.name}</div>
                </div>
              </button>
              <button
                type="button"
                className="follow-star"
                aria-label={`Unfollow ${f.name}`}
                disabled={busyId === f.id}
                onClick={() => unfollow(f)}
              >
                <Icon name="star" filled />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/* ---------- Library ---------- */

function LibraryView() {
  const params = useSearchParams();
  const setP = useParamsSetter();
  const search = params.get("search") ?? "";
  const libraryId = params.get("libraryId") ?? "";
  const start = Math.max(0, intOr(params.get("start"), 0));
  const limitRaw = intOr(params.get("limit"), 24);
  const limit = limitRaw >= 1 && limitRaw <= 60 ? limitRaw : 24;
  const itemId = params.get("item");

  const [searchInput, setSearchInput] = useState(search);
  const [libs, setLibs] = useState<Library[] | null>(null);
  const [libsError, setLibsError] = useState<string | null>(null);
  const closeItem = useCallback(() => setP({ item: null }), [setP]);

  const loadLibs = useCallback(() => {
    setLibsError(null);
    api<{ libraries: Library[] }>("/api/libraries")
      .then((d) => setLibs(d.libraries))
      .catch((e) => setLibsError(messageOf(e)));
  }, []);

  useEffect(loadLibs, [loadLibs]);

  // ponytail: fixed 400ms debounce; typed-submit (Enter) flushes immediately
  useEffect(() => {
    if (searchInput === search) return;
    const t = setTimeout(
      () => setP({ search: searchInput || null, start: null }),
      400,
    );
    return () => clearTimeout(t);
  }, [searchInput, search, setP]);

  const gridQs = new URLSearchParams({
    start: String(start),
    limit: String(limit),
    search,
  });
  if (libraryId) gridQs.set("libraryId", libraryId);
  const {
    data: pageData,
    error: gridError,
    loading,
    reload,
  } = useApiGet<LibraryPage>(`/api/library?${gridQs}`, [
    start,
    limit,
    search,
    libraryId,
  ]);

  const items = pageData?.items ?? [];
  const end = pageData
    ? Math.min(pageData.start + pageData.items.length, pageData.total)
    : 0;
  const hasNext = pageData
    ? pageData.start + pageData.items.length < pageData.total
    : false;

  // Keyed per item: the hook keeps its last read, so an id change without a
  // remount would show the previous item's details until the fetch lands.
  if (itemId)
    return <ItemDetail key={itemId} id={itemId} onClose={closeItem} />;

  return (
    <section aria-label="Library">
      <div className="page-heading">
        <div>
          <h1 className="page-title">Your library</h1>
          <p className="page-description">
            Browse your collection. Play directly in Jellyfin.
          </p>
        </div>
        <span className="chip">Jellyfin</span>
      </div>
      <div className="page-toolbar">
        <div className="sm:max-w-xs sm:flex-1">
          <label className="label" htmlFor="lib-search">
            Search your library
          </label>
          <input
            id="lib-search"
            type="search"
            className="input"
            placeholder="Search titles…"
            maxLength={200}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter")
                setP({ search: searchInput || null, start: null });
            }}
          />
        </div>
        <div className="sm:w-64">
          <label className="label" htmlFor="lib-filter">
            Library
          </label>
          {libsError ? (
            <ErrorPanel message={libsError} onRetry={loadLibs} />
          ) : (
            <select
              id="lib-filter"
              className="input"
              value={libraryId}
              onChange={(e) =>
                setP({ libraryId: e.target.value || null, start: null })
              }
            >
              <option value="">All libraries</option>
              {(libs ?? []).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {gridError ? (
        <ErrorPanel
          title="Library unavailable"
          message={gridError}
          onRetry={reload}
        />
      ) : loading ? (
        <div className="poster-grid" aria-label="Loading library">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="skel aspect-[2/3]" />
          ))}
        </div>
      ) : libs && libs.length === 0 ? (
        <div className="panel p-8 text-center text-sm text-muted">
          Your account has no library access yet. Ask an administrator to grant
          you libraries.
        </div>
      ) : items.length === 0 ? (
        <div className="panel p-8 text-center text-sm text-muted">
          {search || libraryId
            ? "No items match your search or filter."
            : "This library has no items yet."}
        </div>
      ) : (
        <>
          {/* ponytail: grid is uniformly 2:3 by operator choice, so a 16:9
              Jellyfin still is centre-cropped to about the middle third of
              its width by object-fit: cover. Upgrade path: per-item aspect
              detection from the Jellyfin image tags. */}
          <div className="poster-grid">
            {items.map((it) => (
              <button
                key={it.id}
                type="button"
                className="media-card"
                onClick={() => setP({ item: it.id }, { push: true })}
              >
                <div className="media-art aspect-[2/3]">
                  <ItemImage
                    name={it.name}
                    src={it.image}
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                  <CardTypeBadge kind={it.kind} />
                  {it.canPlay && (
                    <CardStatusBadge status="available" title={it.name} />
                  )}
                  <div className="media-quick-overlay">
                    <div className="media-quick-summary" aria-hidden="true">
                      {it.year && <span>{it.year}</span>}
                      <strong>{it.name}</strong>
                    </div>
                  </div>
                </div>
                <div className="media-meta">
                  <div className="media-title">{it.name}</div>
                  <div className="media-subtitle">
                    {[it.year, it.kind].filter(Boolean).join(" · ")}
                  </div>
                </div>
              </button>
            ))}
          </div>
          <div className="mt-6 flex items-center justify-between gap-3">
            <div className="text-sm text-muted">
              {pageData && pageData.total > 0
                ? `Items ${pageData.start + 1}–${end} of ${pageData.total}`
                : "No items"}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn"
                disabled={start === 0}
                onClick={() => {
                  setP({ start: String(Math.max(0, start - limit)) });
                  window.scrollTo({ top: 0 });
                }}
              >
                Previous
              </button>
              <button
                type="button"
                className="btn"
                disabled={!hasNext}
                onClick={() => {
                  setP({ start: String(start + limit) });
                  window.scrollTo({ top: 0 });
                }}
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

/* ---------- Library detail page ---------- */
function ItemDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);

  const { data, error, reload } = useApiGet<{ item: LibraryItem }>(
    `/api/library/${encodeURIComponent(id)}`,
    [id],
  );
  const item = data?.item ?? null;

  useEffect(() => {
    const scrollY = window.scrollY;
    panelRef.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !(
          event.target instanceof HTMLElement &&
          event.target.matches("input, textarea, select")
        )
      )
        onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      requestAnimationFrame(() => {
        // Restore only on return to this library, not when global search or navigation leaves it.
        const params = new URLSearchParams(window.location.search);
        if (params.get("view") === "library" && !params.has("item"))
          window.scrollTo({ top: scrollY });
      });
    };
  }, [onClose]);

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      className="library-detail"
      aria-label="Item details"
    >
      <div className="page-heading">
        <button type="button" className="btn" onClick={onClose}>
          <Icon name="chevron-left" />
          Back to library
        </button>
        <span className="chip">In your library</span>
      </div>
      {error ? (
        <ErrorPanel title="Item unavailable" message={error} onRetry={reload} />
      ) : !item ? (
        <div
          className="skel h-96"
          aria-label="Loading details"
          aria-busy="true"
        />
      ) : (
        <>
          <div className="library-detail-hero">
            {item.image && (
              <img src={item.image} alt="" className="library-backdrop" />
            )}
            <div className="library-detail-poster">
              <ItemImage
                name={item.name}
                src={item.image}
                className="h-full w-full object-cover"
              />
            </div>
            <div className="library-detail-copy">
              <div className="flex flex-wrap gap-2">
                <span className="chip">{item.kind}</span>
                {item.year != null && <span className="chip">{item.year}</span>}
                {runtime(item.durationTicks) && (
                  <span className="chip">{runtime(item.durationTicks)}</span>
                )}
              </div>
              <h2>{item.name}</h2>
              {item.canPlay && item.watchUrl ? (
                <a
                  className="btn btn-accent"
                  href={item.watchUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Icon name="play" />
                  Watch in Jellyfin
                </a>
              ) : (
                <p className="text-sm text-muted">
                  Playback is not available for this item or your account.
                </p>
              )}
              <FileFacts item={item} />
            </div>
          </div>
          <section className="library-overview" aria-label="Overview">
            <h3 className="mb-3 text-xl font-semibold text-ink">Overview</h3>
            <p>{item.overview || "No synopsis available."}</p>
          </section>
        </>
      )}
    </div>
  );
}

/* ---------- Admin: accounts ---------- */
// Locale-aware joined dates for the admin user table.
const JOINED_FMT = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function AdminView() {
  const [accounts, setAccounts] = useState<AdminAccount[] | null>(null);
  const [editing, setEditing] = useState<AdminAccount | null>(null);
  const [libs, setLibs] = useState<Library[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    setForbidden(false);
    api<{ accounts: AdminAccount[]; libraries: Library[] }>("/api/admin/users")
      .then((d) => {
        setAccounts(d.accounts);
        setLibs(d.libraries);
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 403) setForbidden(true);
        else setError(messageOf(e));
      });
  }, []);

  useEffect(load, [load]);

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
      load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setForbidden(true);
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
            onClick={load}
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
          onRetry={load}
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
          onSaved={(acc) => {
            setAccounts(
              (cur) => cur?.map((x) => (x.id === acc.id ? acc : x)) ?? cur,
            );
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
  const [canRemove, setCanRemove] = useState(initial.canRemove);
  const [libIds, setLibIds] = useState<string[]>(initial.libraryIds);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const owner = initial.isOwner;
  const dirty =
    (!owner && enabled !== initial.enabled) ||
    (!owner && role !== initial.role) ||
    (!owner && autoApprove !== initial.autoApprove) ||
    canRemove !== initial.canRemove ||
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

  const reset = () => {
    setEnabled(initial.enabled);
    setRole(initial.role);
    setAutoApprove(initial.autoApprove);
    setCanRemove(initial.canRemove);
    setLibIds(initial.libraryIds);
    setError(null);
  };

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
            canRemove,
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
              checked={owner ? initial.autoApprove : autoApprove}
              disabled={owner || pending}
              onChange={(e) => setAutoApprove(e.target.checked)}
            />
            {owner ? "Always (owner)" : "Approves own requests"}
          </label>
          <p className="mt-1 text-xs text-muted">
            Lets this user approve their own requests without a moderator.
          </p>
        </div>

        <div>
          <span className="label">Removals</span>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="check"
              checked={canRemove}
              disabled={pending}
              onChange={(e) => setCanRemove(e.target.checked)}
            />
            Can request and approve removals
          </label>
          <p className="mt-1 text-xs text-muted">
            Removal requests also need the operator to enable removals.
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

/* ---------- Settings: integrations, Whisparr, providers ---------- */

function SettingsView() {
  const { providers } = useSession();
  const [forbidden, setForbidden] = useState(false);
  const [section, setSection] = useState("connections");
  if (forbidden) return <ForbiddenPanel />;

  return (
    <section className="settings-page" aria-label="Settings">
      <div className="page-heading">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-description">
            Connect your services and make Velvarr yours.
          </p>
        </div>
      </div>
      <nav className="settings-tabs" aria-label="Settings sections">
        {[
          ["connections", "Connections"],
          ["metadata", "Metadata providers"],
          ["system", "System"],
        ].map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={section === id}
            onClick={() => setSection(id!)}
          >
            {label}
          </button>
        ))}
      </nav>
      <div hidden={section !== "connections"}>
        <div className="settings-content">
          <div className="connection-status-grid">
            <JellyfinCard onForbidden={() => setForbidden(true)} />
            <WhisparrCard onForbidden={() => setForbidden(true)} />
          </div>
          <IntegrationsForm onForbidden={() => setForbidden(true)} />
        </div>
      </div>
      <div hidden={section !== "metadata"}>
        <ProvidersCard providers={providers} />
      </div>
      <div hidden={section !== "system"}>
        <div className="settings-content">
          <LimitsPanel />
          <ReleaseStatusPanel />
        </div>
      </div>
    </section>
  );
}

function IntegrationsForm({ onForbidden }: { onForbidden: () => void }) {
  const [info, setInfo] = useState<IntegrationsInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [jellyfinUrl, setJellyfinUrl] = useState("");
  const [externalUrl, setExternalUrl] = useState("");
  const [jellyfinApiKey, setJellyfinApiKey] = useState("");
  const [whisparrUrl, setWhisparrUrl] = useState("");
  const [whisparrApiKey, setWhisparrApiKey] = useState("");
  const [deliveryEnabled, setDeliveryEnabled] = useState(false);
  const [rootFolderPath, setRootFolderPath] = useState("");
  const [qualityProfileId, setQualityProfileId] = useState("");
  const [searchOnAdd, setSearchOnAdd] = useState(true);
  const [mappings, setMappings] = useState<WhisparrPathMapping[]>([]);
  const [whisparrStatus, setWhisparrStatus] = useState<WhisparrStatus | null>(
    null,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    api<IntegrationsInfo>("/api/admin/integrations")
      .then((d) => {
        setInfo(d);
        setJellyfinUrl(d.jellyfin.url);
        setExternalUrl(d.jellyfin.externalUrl);
        setWhisparrUrl(d.whisparr?.url ?? "");
        setDeliveryEnabled(d.whisparr?.delivery?.enabled ?? false);
        setRootFolderPath(d.whisparr?.delivery?.rootFolderPath ?? "");
        setQualityProfileId(
          d.whisparr?.delivery
            ? String(d.whisparr.delivery.qualityProfileId)
            : "",
        );
        setSearchOnAdd(d.whisparr?.delivery?.searchOnAdd ?? true);
        setMappings(d.whisparr?.pathMappings ?? []);
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 403) onForbidden();
        else setLoadError(messageOf(e));
      });
    // Read-only status supplies the real root folders / quality profiles; when
    // it is unavailable the form falls back to manual entry below.
    api<WhisparrStatus>("/api/admin/whisparr")
      .then(setWhisparrStatus)
      .catch(() => setWhisparrStatus(null));
  }, [onForbidden]);

  useEffect(load, [load]);

  // Select choices; the currently stored value is always offered so a stale
  // status can never silently change what will be saved.
  const hasUrl = whisparrUrl.trim() !== "";
  const rootChoices = (() => {
    const paths = whisparrStatus?.rootFolders?.map((rf) => rf.path) ?? [];
    if (rootFolderPath !== "" && !paths.includes(rootFolderPath))
      return [rootFolderPath, ...paths];
    return paths;
  })();
  const profileChoices = (() => {
    const known = whisparrStatus?.profiles ?? [];
    const id = Number(qualityProfileId);
    if (
      qualityProfileId !== "" &&
      Number.isInteger(id) &&
      !known.some((p) => p.id === id)
    )
      return [...known, { id, name: `Saved profile #${id}` }];
    return known;
  })();
  const effectiveRoot = rootFolderPath || rootChoices[0] || "";
  const effectiveProfile =
    qualityProfileId || (profileChoices[0] ? String(profileChoices[0].id) : "");
  const halfMappings = mappings.filter(
    (m) =>
      (m.whisparrPrefix.trim() === "") !== (m.jellyfinPrefix.trim() === ""),
  );

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaved(null);
    if (!jellyfinUrl.trim() || !externalUrl.trim()) {
      setError("Jellyfin URL and external URL are required.");
      return;
    }
    if (!hasUrl && whisparrApiKey.trim() !== "") {
      setError(
        "A Whisparr API key needs the Whisparr URL — the URL is the connection, the key authenticates it.",
      );
      return;
    }
    const profile = Number(effectiveProfile);
    if (
      hasUrl &&
      (deliveryEnabled || info?.whisparr?.delivery) &&
      (!Number.isInteger(profile) || profile < 1)
    ) {
      setError("Choose a quality profile (a positive whole number).");
      return;
    }
    if (hasUrl && deliveryEnabled && !effectiveRoot.trim()) {
      setError("A root folder is required while delivery is enabled.");
      return;
    }
    if (hasUrl && halfMappings.length > 0) {
      setError(
        "Each path mapping needs both a Whisparr prefix and a Jellyfin prefix.",
      );
      return;
    }
    setPending(true);
    try {
      await api<unknown>("/api/admin/integrations", {
        method: "PATCH",
        body: JSON.stringify({
          jellyfinUrl: jellyfinUrl.trim(),
          jellyfinExternalUrl: externalUrl.trim(),
          ...(jellyfinApiKey ? { jellyfinApiKey } : {}),
          whisparrUrl: whisparrUrl.trim(),
          ...(whisparrApiKey ? { whisparrApiKey } : {}),
          // Delivery travels only when it exists on either side: enabled now,
          // or previously configured (an omitted key would drop it wholesale).
          // A first-time save with delivery off stores none — profiles and
          // roots can be chosen after the connection probe succeeds.
          ...(hasUrl && (deliveryEnabled || info?.whisparr?.delivery)
            ? {
                delivery: {
                  enabled: deliveryEnabled,
                  rootFolderPath: effectiveRoot.trim(),
                  qualityProfileId: profile,
                  searchOnAdd,
                },
                pathMappings: mappings
                  .filter(
                    (m) =>
                      m.whisparrPrefix.trim() !== "" &&
                      m.jellyfinPrefix.trim() !== "",
                  )
                  .map((m) => ({
                    whisparrPrefix: m.whisparrPrefix.trim(),
                    jellyfinPrefix: m.jellyfinPrefix.trim(),
                  })),
              }
            : {}),
        }),
      });
      setJellyfinApiKey("");
      setWhisparrApiKey("");
      setSaved("Integrations updated.");
      load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) onForbidden();
      else setError(messageOf(err));
    } finally {
      setPending(false);
    }
  };

  if (loadError)
    return (
      <ErrorPanel
        title="Integrations unavailable"
        message={loadError}
        onRetry={load}
      />
    );
  if (!info)
    return (
      <div className="panel p-4" aria-label="Loading integrations">
        <div className="skel h-40 w-full" />
      </div>
    );

  return (
    <form className="panel p-5" onSubmit={(e) => void save(e)} noValidate>
      <h3 className="font-semibold">Integrations</h3>
      <p className="mt-1 text-sm text-muted">
        Jellyfin server <span className="chip">{info.jellyfin.serverId}</span> ·{" "}
        {info.jellyfin.libraryIds.length} configured librar
        {info.jellyfin.libraryIds.length === 1 ? "y" : "ies"} (grants are not
        changed here)
      </p>

      {error && (
        <div className="mt-4" role="alert">
          <ErrorPanel message={error} />
        </div>
      )}
      {saved && (
        <div className="panel mt-4 p-3 text-sm" role="status">
          {saved}
        </div>
      )}

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="int-jf-url">
            Jellyfin URL
          </label>
          <input
            id="int-jf-url"
            type="text"
            className="input"
            autoComplete="off"
            maxLength={300}
            value={jellyfinUrl}
            onChange={(e) => setJellyfinUrl(e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="int-jf-ext">
            Jellyfin external URL
          </label>
          <input
            id="int-jf-ext"
            type="text"
            className="input"
            autoComplete="off"
            maxLength={300}
            value={externalUrl}
            onChange={(e) => setExternalUrl(e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="int-jf-key">
            Jellyfin API key
          </label>
          <input
            id="int-jf-key"
            type="password"
            className="input"
            autoComplete="off"
            placeholder={
              info.jellyfin.apiKeyConfigured
                ? "Configured — leave blank to keep"
                : "Not set"
            }
            value={jellyfinApiKey}
            onChange={(e) => setJellyfinApiKey(e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="int-w-url">
            Whisparr URL (blank removes it, with delivery settings)
          </label>
          <input
            id="int-w-url"
            type="text"
            className="input"
            autoComplete="off"
            maxLength={300}
            value={whisparrUrl}
            onChange={(e) => setWhisparrUrl(e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="int-w-key">
            Whisparr API key
          </label>
          <input
            id="int-w-key"
            type="password"
            className="input"
            autoComplete="off"
            placeholder={
              info.whisparr?.apiKeyConfigured
                ? "Configured — leave blank to keep"
                : "Not set"
            }
            value={whisparrApiKey}
            onChange={(e) => setWhisparrApiKey(e.target.value)}
          />
        </div>
      </div>

      <fieldset className="mt-4 border-t border-edge pt-4">
        <legend className="label">Whisparr delivery</legend>
        <p className="mt-1 text-sm text-muted">
          With delivery disabled, approved requests are held inside Velvarr —
          never dropped, never sent to Whisparr until you enable this.
        </p>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="check"
                checked={deliveryEnabled}
                disabled={!hasUrl || pending}
                onChange={(e) => setDeliveryEnabled(e.target.checked)}
              />
              Send approved requests to Whisparr
            </label>
          </div>
          <div>
            <label className="label" htmlFor="int-w-root">
              Root folder
            </label>
            {rootChoices.length > 0 ? (
              <select
                id="int-w-root"
                className="input"
                value={effectiveRoot}
                disabled={!hasUrl || pending}
                onChange={(e) => setRootFolderPath(e.target.value)}
              >
                {rootChoices.map((path) => (
                  <option key={path} value={path}>
                    {path}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id="int-w-root"
                type="text"
                className="input"
                autoComplete="off"
                maxLength={1024}
                placeholder="Whisparr download root, e.g. /data/adult"
                value={rootFolderPath}
                disabled={!hasUrl || pending}
                onChange={(e) => setRootFolderPath(e.target.value)}
              />
            )}
          </div>
          <div>
            <label className="label" htmlFor="int-w-profile">
              Quality profile
            </label>
            {profileChoices.length > 0 ? (
              <select
                id="int-w-profile"
                className="input"
                value={effectiveProfile}
                disabled={!hasUrl || pending}
                onChange={(e) => setQualityProfileId(e.target.value)}
              >
                {profileChoices.map((p) => (
                  <option key={p.id} value={String(p.id)}>
                    {p.name}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id="int-w-profile"
                type="number"
                min={1}
                step={1}
                className="input"
                value={qualityProfileId}
                disabled={!hasUrl || pending}
                onChange={(e) => setQualityProfileId(e.target.value)}
              />
            )}
          </div>
          <div className="sm:col-span-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="check"
                checked={searchOnAdd}
                disabled={!hasUrl || pending}
                onChange={(e) => setSearchOnAdd(e.target.checked)}
              />
              Search Whisparr as soon as a request is sent
            </label>
          </div>
        </div>
      </fieldset>

      <fieldset className="mt-4 border-t border-edge pt-4">
        <legend className="label">Path mappings (Whisparr → Jellyfin)</legend>
        <p className="mt-1 text-sm text-muted">
          Prefix pairs that line Whisparr download paths up with Jellyfin
          library paths. Only needed when the two roots differ.
        </p>
        {mappings.map((m, i) => (
          <div key={i} className="mt-2 flex flex-wrap items-end gap-2">
            <div className="min-w-40 flex-1">
              <label className="label" htmlFor={`map-w-${i}`}>
                Whisparr prefix
              </label>
              <input
                id={`map-w-${i}`}
                type="text"
                className="input"
                autoComplete="off"
                maxLength={1024}
                value={m.whisparrPrefix}
                disabled={!hasUrl || pending}
                onChange={(e) =>
                  setMappings((cur) =>
                    cur.map((x, j) =>
                      j === i ? { ...x, whisparrPrefix: e.target.value } : x,
                    ),
                  )
                }
              />
            </div>
            <div className="min-w-40 flex-1">
              <label className="label" htmlFor={`map-j-${i}`}>
                Jellyfin prefix
              </label>
              <input
                id={`map-j-${i}`}
                type="text"
                className="input"
                autoComplete="off"
                maxLength={1024}
                value={m.jellyfinPrefix}
                disabled={!hasUrl || pending}
                onChange={(e) =>
                  setMappings((cur) =>
                    cur.map((x, j) =>
                      j === i ? { ...x, jellyfinPrefix: e.target.value } : x,
                    ),
                  )
                }
              />
            </div>
            <button
              type="button"
              className="btn"
              disabled={!hasUrl || pending}
              onClick={() =>
                setMappings((cur) => cur.filter((_, j) => j !== i))
              }
            >
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn mt-3"
          disabled={!hasUrl || pending || mappings.length >= 50}
          onClick={() =>
            setMappings((cur) => [
              ...cur,
              { whisparrPrefix: "", jellyfinPrefix: "" },
            ])
          }
        >
          Add mapping
        </button>
      </fieldset>

      <button type="submit" className="btn btn-accent mt-4" disabled={pending}>
        {pending ? "Saving…" : "Save integrations"}
      </button>
    </form>
  );
}

function WhisparrCard({ onForbidden }: { onForbidden: () => void }) {
  const [status, setStatus] = useState<WhisparrStatus | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api<WhisparrStatus>("/api/admin/whisparr")
      .then((s) => {
        setStatus(s);
        setCheckedAt(new Date().toLocaleTimeString());
        setReady(true);
        setLoading(false);
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 403) onForbidden();
        else {
          setError(messageOf(e));
          setReady(true);
          setLoading(false);
        }
      });
  }, [onForbidden]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="panel p-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-semibold">Whisparr</h3>
        <button type="button" className="btn" onClick={load} disabled={loading}>
          {loading ? "Checking…" : "Refresh"}
        </button>
      </div>

      {!ready ? (
        <div className="mt-3 space-y-2" aria-label="Checking Whisparr">
          <div className="skel h-5 w-1/2" />
          <div className="skel h-5 w-2/3" />
        </div>
      ) : error ? (
        <div className="mt-3">
          <ErrorPanel
            title="Whisparr unavailable"
            message={error}
            onRetry={load}
          />
        </div>
      ) : !status?.configured ? (
        <p className="mt-3 text-sm text-muted">
          Not configured. Add the Whisparr URL and API key above to enable
          read-only status.
        </p>
      ) : (
        <dl className="mt-3 space-y-2 text-sm">
          <div className="flex gap-2">
            <dt className="text-muted">Application</dt>
            <dd className="font-medium">
              {status.appName ?? "Whisparr"}
              {status.version ? ` ${status.version}` : ""}
            </dd>
          </div>
          {checkedAt && (
            <div className="flex gap-2">
              <dt className="text-muted">Checked</dt>
              <dd>{checkedAt}</dd>
            </div>
          )}
          <div>
            <dt className="text-muted">Root folders</dt>
            <dd className="mt-1">
              {status.rootFolders?.length ? (
                <ul className="space-y-1">
                  {status.rootFolders.map((rf) => (
                    <li key={rf.id} className="chip">
                      {rf.path}
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="text-muted">None returned</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-muted">Quality profiles</dt>
            <dd className="mt-1">
              {status.profiles?.length ? (
                <span className="text-muted">
                  {status.profiles.map((p) => p.name).join(", ")}
                </span>
              ) : (
                <span className="text-muted">None returned</span>
              )}
            </dd>
          </div>
        </dl>
      )}
    </div>
  );
}
function JellyfinCard({ onForbidden }: { onForbidden: () => void }) {
  const [status, setStatus] = useState<JellyfinStatus | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api<JellyfinStatus>("/api/admin/jellyfin")
      .then((s) => {
        setStatus(s);
        setCheckedAt(new Date().toLocaleTimeString());
        setReady(true);
        setLoading(false);
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 403) onForbidden();
        else {
          setError(messageOf(e));
          setReady(true);
          setLoading(false);
        }
      });
  }, [onForbidden]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="panel p-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-semibold">Jellyfin</h3>
        <button type="button" className="btn" onClick={load} disabled={loading}>
          {loading ? "Testing…" : "Test connection"}
        </button>
      </div>

      {!ready ? (
        <div className="mt-3 space-y-2" aria-label="Checking Jellyfin">
          <div className="skel h-5 w-1/2" />
        </div>
      ) : error ? (
        <div className="mt-3">
          <ErrorPanel
            title="Jellyfin unavailable"
            message={error}
            onRetry={load}
          />
        </div>
      ) : !status?.configured ? (
        <p className="mt-3 text-sm text-muted">
          Not configured. Save the Jellyfin URL and API key above to enable the
          connection check.
        </p>
      ) : (
        <dl className="mt-3 space-y-2 text-sm">
          <div className="flex gap-2">
            <dt className="text-muted">Connected</dt>
            <dd className="font-medium">
              {status.serverName ?? "Jellyfin"}
              {status.version ? ` ${status.version}` : ""}
            </dd>
          </div>
          {checkedAt && (
            <div className="flex gap-2">
              <dt className="text-muted">Checked</dt>
              <dd>{checkedAt}</dd>
            </div>
          )}
        </dl>
      )}
    </div>
  );
}

// Shape of one entry in GET /api/admin/integrations → providers.
type ProviderConfigRow = {
  configured: boolean;
  source: "stored" | "environment";
};

// Shape returned by GET /api/admin/providers (ProviderVerification).
type ProviderCheckRow =
  | { provider: "tpdb" | "stashdb"; configured: false }
  | {
      provider: "tpdb" | "stashdb";
      configured: true;
      verified: true;
      account: string;
    };

function ProvidersCard({ providers }: { providers: ProviderStatus | null }) {
  const [check, setCheck] = useState<ProviderCheckRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [shape, setShape] = useState<{
    tpdb: ProviderConfigRow;
    stashdb: ProviderConfigRow;
    typesafe: ProviderConfigRow;
  } | null>(null);
  const [tpdbToken, setTpdbToken] = useState("");
  const [stashdbKey, setStashdbKey] = useState("");
  const [typesafeKey, setTypesafeKey] = useState("");
  const [pending, setPending] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(() => {
    setError(null);
    api<{ providers: ProviderCheckRow[] }>("/api/admin/providers")
      .then((d) => setCheck(d.providers))
      .catch((e) => {
        if (e instanceof ApiError && e.status === 403) setForbidden(true);
        else setError(messageOf(e));
      });
  }, []);

  const loadShape = useCallback(() => {
    api<{
      providers: {
        tpdb: ProviderConfigRow;
        stashdb: ProviderConfigRow;
        typesafe: ProviderConfigRow;
      };
    }>("/api/admin/integrations")
      .then((d) => setShape(d.providers))
      .catch(() => setShape(null));
  }, []);

  useEffect(load, [load]);
  useEffect(loadShape, [loadShape]);

  const apply = async (body: Record<string, string>) => {
    setPending(true);
    setSaveError(null);
    setSaved(false);
    try {
      await api("/api/admin/integrations", {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      setTpdbToken("");
      setStashdbKey("");
      setTypesafeKey("");
      setSaved(true);
      load();
      loadShape();
    } catch (e) {
      setSaveError(messageOf(e));
    } finally {
      setPending(false);
    }
  };

  const save = () => {
    const body: Record<string, string> = {};
    if (tpdbToken.trim() !== "") body.tpdbApiToken = tpdbToken.trim();
    if (stashdbKey.trim() !== "") body.stashdbApiKey = stashdbKey.trim();
    if (typesafeKey.trim() !== "") body.typesafeApiKey = typesafeKey.trim();
    if (Object.keys(body).length > 0) apply(body);
  };

  const rows = [
    {
      id: "tpdb" as const,
      name: "TPDB",
      value: tpdbToken,
      field: "tpdbApiToken" as const,
      setValue: setTpdbToken,
    },
    {
      id: "stashdb" as const,
      name: "StashDB",
      value: stashdbKey,
      field: "stashdbApiKey" as const,
      setValue: setStashdbKey,
    },
    {
      id: "typesafe" as const,
      name: "TypeSafe",
      value: typesafeKey,
      field: "typesafeApiKey" as const,
      setValue: setTypesafeKey,
    },
  ];

  return (
    <div className="panel p-5">
      <h3 className="font-semibold">Metadata providers</h3>
      <p className="mt-1 text-sm text-muted">
        Credentials saved here (encrypted) take precedence over the environment;
        the live check against the provider is the real proof. A failed live
        check is an outage or a bad key, never an empty catalog.
      </p>
      <dl className="mt-3 space-y-2 text-sm">
        {rows.map(({ id, name }) => {
          const state = id === "typesafe" ? undefined : providers?.[id];
          const live = check?.find((r) => r.provider === id);
          const conf = shape?.[id];
          return (
            <div key={id} className="flex flex-wrap items-center gap-2">
              <dt className="font-medium">{name}</dt>
              <dd className="flex flex-wrap items-center gap-2">
                {id === "typesafe" ? (
                  <span className="chip">
                    {conf?.configured
                      ? "AI-assisted matching on"
                      : "Off — no key"}
                  </span>
                ) : (
                  <span className="chip">
                    {state ? PROVIDER_STATE[state] : "Unknown"}
                  </span>
                )}
                {conf && conf.source === "stored" ? (
                  <span className="chip chip-accent">Stored</span>
                ) : conf && conf.configured ? (
                  <span className="chip">From environment</span>
                ) : null}
                {id === "typesafe" || forbidden ? null : live ? (
                  live.configured ? (
                    <span className="chip chip-accent">
                      Verified · {live.account}
                    </span>
                  ) : (
                    <span className="chip">Live check: not configured</span>
                  )
                ) : (
                  <span className="chip">Live check pending</span>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
      {forbidden ? (
        <p className="mt-3 text-sm text-muted">
          Editing and live verification need an administrator account.
        </p>
      ) : (
        <div className="mt-4 space-y-3">
          {rows.map(({ id, name, value, field, setValue }) => {
            const conf = shape?.[id];
            return (
              <div key={field}>
                <label className="label" htmlFor={`provider-${id}`}>
                  {name} {id === "tpdb" ? "API token" : "API key"}
                  {id === "typesafe" ? " (optional)" : ""}
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    id={`provider-${id}`}
                    className="input max-w-md"
                    type="password"
                    autoComplete="off"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    placeholder={
                      conf && conf.source === "stored"
                        ? "Stored — leave blank to keep"
                        : conf && conf.configured
                          ? "Configured via environment"
                          : "Not configured"
                    }
                  />
                  {conf && conf.source === "stored" ? (
                    <button
                      type="button"
                      className="btn"
                      disabled={pending}
                      onClick={() => apply({ [field]: "" })}
                    >
                      Clear stored
                    </button>
                  ) : null}
                </div>
                {id === "typesafe" ? (
                  <p className="mt-1 text-sm text-muted">
                    Enables AI-assisted matching: a Jellyfin item whose title
                    only nearly matches a request is judged &ldquo;same
                    work?&rdquo; and flagged for administrator review instead of
                    counting as missing. Without a key everything still works,
                    just with exact matching only.
                  </p>
                ) : null}
              </div>
            );
          })}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn btn-accent"
              disabled={pending}
              onClick={save}
            >
              Save credentials
            </button>
            <span className="text-sm text-muted">
              Saving stores the key encrypted and re-runs the live check.
            </span>
          </div>
          {saved ? (
            <p className="text-sm text-muted">
              Saved. Live check refreshed below.
            </p>
          ) : null}
          {saveError ? (
            <ErrorPanel
              title="Saving provider credentials failed"
              message={saveError}
              onRetry={save}
            />
          ) : null}
        </div>
      )}
      {forbidden ? null : error ? (
        <div className="mt-3">
          <ErrorPanel
            title="Live provider check failed"
            message={error}
            onRetry={load}
          />
        </div>
      ) : null}
    </div>
  );
}
