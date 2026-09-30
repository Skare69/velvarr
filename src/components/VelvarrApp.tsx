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
  AdminAccount,
  CatalogReference,
  Library,
  LibraryItem,
  LibraryPage,
  MediaReference,
  PerformerFollow,
  ProviderStatus,
  RequestRecord,
  Role,
} from "../lib/contracts.ts";
import { countPendingApprovals, REQUESTS_CHANGED } from "../lib/approvals.ts";
import {
  ApiError,
  api,
  CardStatusBadge,
  CardTypeBadge,
  Credit,
  detailParams,
  ErrorPanel,
  FileFacts,
  ForbiddenPanel,
  Icon,
  imgSrc,
  intOr,
  ItemImage,
  legacyBrowsePatch,
  messageOf,
  SessionCtx,
  setParamsClearing,
  useApiGet,
  useParamsSetter,
  useSession,
  useTapReveal,
} from "./shared.tsx";
import { TitlesView, useBrowseTo } from "./catalog.tsx";
import {
  DetailSections,
  type DetailPayload,
  type DetailTarget,
} from "./catalog-detail.tsx";
import { PreferencesDialog } from "./preferences.tsx";
import { PerformerView } from "./performer.tsx";
import { DiscoverShelves, FacetsView, RailSkeleton } from "./discover.tsx";
import { SearchView } from "./search.tsx";
import { RequestsView } from "./requests.tsx";
import { RemovalsView } from "./removals.tsx";
import { SettingsView } from "./settings.tsx";

/* ---------- View helpers ---------- */

const runtime = (ticks?: number) =>
  ticks && ticks > 0 ? `${Math.round(ticks / 600_000_000)} min` : null;

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
        {view === "discover" && (
          <DiscoverShelves onReorder={() => setPrefsOpen(true)} />
        )}
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
  const setP = useParamsSetter();

  const { data, error, reload } = useApiGet<{
    item: LibraryItem;
    catalog?: MediaReference;
    catalogNote?: string;
  }>(`/api/library/${encodeURIComponent(id)}`, [id]);
  const item = data?.item ?? null;
  const catalog = data?.catalog;
  const catalogNote = data?.catalogNote;
  const target: DetailTarget | undefined = catalog
    ? { provider: catalog.provider, kind: catalog.kind, id: catalog.id }
    : undefined;
  const browseTo = useBrowseTo();
  // Honest absence: a 404 here means the provider record is gone — no
  // detail sections render, never fake ones. The failure itself is stated
  // below the hero; discarding it left the page bare (card 440e5b8a).
  const {
    data: catDetail,
    error: catError,
    err: catErr,
    reload: reloadCat,
  } = useApiGet<DetailPayload>(
    catalog
      ? `/api/catalog/${catalog.provider}/${catalog.kind}/${encodeURIComponent(catalog.id)}`
      : null,
    [catalog?.provider, catalog?.kind, catalog?.id],
  );

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
          {(!catalog || catError) && (
            <section className="library-overview" aria-label="Overview">
              <h3 className="mb-3 text-xl font-semibold text-ink">Overview</h3>
              <p>{item.overview || "No synopsis available."}</p>
            </section>
          )}
          {/* ponytail: identity is Whisparr path correspondence only; the
              upgrade path is mapping Jellyfin ProviderIds. */}
          {!catalog && (
            <p className="text-sm text-muted">
              Catalog details unavailable
              {catalogNote
                ? `: ${catalogNote}`
                : " — no provider match was found for this item's file paths."}
            </p>
          )}
          {catalog && catError ? (
            catErr?.status === 404 ? (
              // Authoritative absence, not an outage: stated, no retry.
              <p className="text-sm text-muted">
                Catalog details unavailable — this item is not in the provider
                catalog.
              </p>
            ) : (
              <ErrorPanel
                title="Catalog details unavailable"
                message={catError}
                onRetry={reloadCat}
              />
            )
          ) : null}
          {catalog && catDetail && target && (
            <DetailSections
              payload={catDetail}
              target={target}
              onNavigate={(r) => setP(detailParams(r), { push: true })}
              onBrowse={browseTo}
            />
          )}
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
