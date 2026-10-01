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
  RequestRecord,
} from "../lib/contracts.ts";
import { countPendingApprovals, REQUESTS_CHANGED } from "../lib/approvals.ts";
import {
  ApiError,
  api,
  Credit,
  ErrorPanel,
  ForbiddenPanel,
  Icon,
  legacyBrowsePatch,
  messageOf,
  SessionCtx,
  setParamsClearing,
  useApiGet,
  useParamsSetter,
  useSession,
  useTapReveal,
} from "./shared.tsx";
import { TitlesView } from "./catalog.tsx";
import { PreferencesDialog } from "./preferences.tsx";
import { DiscoverShelves, FacetsView, RailSkeleton } from "./discover.tsx";
import { SearchView } from "./search.tsx";
import { RequestsView } from "./requests.tsx";
import { RemovalsView } from "./removals.tsx";
import { SettingsView } from "./settings.tsx";
import { AdminView } from "./admin.tsx";
import { FollowingView } from "./following.tsx";
import { LibraryView } from "./library.tsx";

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
        <Credit />
      </div>
    </div>
  );
}

/* ---------- Shell ---------- */

const VIEWS = [
  "discover",
  "facets",
  "titles",
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);
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
    { id: "removals", label: "Removals", icon: "removals", group: "manage" },
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
        <img src="/velvarr-logo.png" alt="" />
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
      <PreferencesDialog open={prefsOpen} onClose={() => setPrefsOpen(false)} />
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
