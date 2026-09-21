// Velvarr shared records: the vocabulary both the client and the server use.
// Mostly plain records; the few functions here are choke points that must give
// the same answer on both sides (deliverability, the removal ladder).

export type Role = "admin" | "moderator" | "requester";

export type CatalogProvider = "tpdb" | "stashdb";

export type MediaKind = "movie" | "scene";

export type CatalogKind = MediaKind | "performer" | "studio";

/** Provider-scoped external identity. `id` is the provider's external UUID,
 * never the application-owned catalog record id. */
export type CatalogReference = {
  provider: CatalogProvider;
  kind: CatalogKind;
  id: string;
};

/** CatalogReference narrowed to requestable media. */
export type MediaReference = {
  provider: CatalogProvider;
  kind: MediaKind;
  id: string;
};

/** Whisparr routes exactly one metadata source per item type: TPDB for
 * movies, StashDB for scenes. A TPDB scene has no lookup path upstream
 * (`/api/v3/movie/lookup/tpdb` is the movie endpoint, and `term=stash:<id>`
 * only matches StashDB ids), so it can be browsed but never acquired.
 * Checked before a request is filed, not discovered by a worker an hour
 * later. */
export function isDeliverableMedia(ref: {
  provider: CatalogProvider;
  kind: CatalogKind;
}): boolean {
  return (
    (ref.kind === "movie" && ref.provider === "tpdb") ||
    (ref.kind === "scene" && ref.provider === "stashdb")
  );
}

export const UNDELIVERABLE_REASON =
  "Whisparr can acquire TPDB movies and StashDB scenes only — it has no metadata source for this identity.";

export type ExternalLink = { url: string; label?: string };

export type CatalogCredit = {
  /** Performer reference. */
  reference: CatalogReference;
  name: string;
  imageUrl?: string;
  links?: ExternalLink[];
};

/** Full provider detail for one catalog entity. Ephemerally valuable; only a
 * minimal summary is persisted (see CatalogRecord). */
export type CatalogDetail = {
  reference: CatalogReference;
  title: string;
  description?: string;
  /** ISO calendar date (YYYY-MM-DD) when the provider supplies one. */
  releaseDate?: string;
  durationSeconds?: number;
  imageUrl?: string;
  studio?: { name: string; reference?: CatalogReference };
  credits: CatalogCredit[];
  /** Provider-native tags: the provider's own IDs and names. */
  tags: { id: string; name: string }[];
  related: CatalogReference[];
  links: ExternalLink[];
  aliases: string[];
  sourceUrl?: string;
};

/** Application-owned durable catalog summary. `id` is a Velvarr UUID, distinct
 * from any external UUID; holds title/reference/history, not a provider mirror. */
export type CatalogRecord = {
  id: string;
  reference: CatalogReference;
  title: string;
  /** Unix milliseconds. */
  createdAt: number;
  updatedAt: number;
};

/** One account's performer follow. `name`/`imageUrl` are snapshots taken at
 * follow time: a rename or new photo upstream does not silently rewrite
 * history. */
export type PerformerFollow = {
  id: string; // app-owned uuid
  reference: CatalogReference; // kind is always "performer"
  name: string; // snapshot taken at follow time
  imageUrl: string | null; // snapshot taken at follow time
  createdAt: number; // unix ms
  /** The same performer's row on the other provider, when the providers
   * published an explicit link between them. Following one follows both, so
   * the pair is one identity: either side answers "are you following her",
   * and unfollowing either drops both. */
  linked: CatalogReference | null;
};

export type RequestDecision = "pending" | "approved" | "declined" | "cancelled";

/** One user's durable intent. Independent of acquisition and playback state. */
export type RequestRecord = {
  id: string;
  accountId: string;
  media: MediaReference;
  decision: RequestDecision;
  /** Unix milliseconds. */
  createdAt: number;
  decidedAt: number | null;
};

export type RequestAcquisition = {
  state: AcquisitionState;
  lastError: string | null;
  updatedAt: number;
  observationStale: boolean;
  monitored: boolean | null;
  progress: AcquisitionProgress | null;
};

/** GET /api/requests row: the record plus the facts only that list carries. */
export type RequestListItem = RequestRecord & {
  /** Display name of the requesting account; present only for staff viewers. */
  requestedBy?: string;
  acquisition?: RequestAcquisition | null;
};

/** The escalation ladder, least → most destructive. One table: rank orders
 * escalation, `destructive` marks the irreversible rungs, `requiresUserToken`
 * marks the rung the integration worker can never execute because it needs
 * the requester's own media-server session. Every other module reads these
 * facts from here instead of re-testing level names. */
export const REMOVAL_LADDER = [
  { level: "unmonitor", destructive: false, requiresUserToken: false },
  { level: "drop", destructive: false, requiresUserToken: false },
  { level: "exclude", destructive: false, requiresUserToken: false },
  { level: "delete_files", destructive: true, requiresUserToken: false },
  { level: "delete_jellyfin_item", destructive: true, requiresUserToken: true },
] as const;

export type RemovalLevel = (typeof REMOVAL_LADDER)[number]["level"];

export const REMOVAL_LEVELS: readonly RemovalLevel[] = REMOVAL_LADDER.map(
  (rung) => rung.level,
);

/** Runtime check, never a cast. */
export function isRemovalLevel(value: string): value is RemovalLevel {
  return REMOVAL_LEVELS.includes(value as RemovalLevel);
}

/** Escalation order: a later approval may raise an unstarted shared execution
 * to a level some approver explicitly chose, never lower it. */
export function removalLevelRank(level: RemovalLevel): number {
  return REMOVAL_LADDER.findIndex((rung) => rung.level === level);
}

/** Irreversible rungs: file deletion and Jellyfin item deletion. */
export function isDestructiveLevel(level: RemovalLevel): boolean {
  return REMOVAL_LADDER.some(
    (rung) => rung.level === level && rung.destructive,
  );
}

/** True when the rung can only run under the requester's own media-server
 * session, so the integration worker must refuse it rather than downgrade. */
export function requiresUserToken(level: RemovalLevel): boolean {
  return REMOVAL_LADDER.some(
    (rung) => rung.level === level && rung.requiresUserToken,
  );
}

export type RemovalDecision = "pending" | "approved" | "declined" | "cancelled";

/** One user's durable removal intent. The requester supplies only a reason;
 * the level is chosen by the approver, never by the requester. */
export type RemovalRequest = {
  id: string;
  accountId: string;
  media: MediaReference;
  reason: string;
  decision: RemovalDecision;
  /** Set only at approval; null while pending and after decline or cancel. */
  level: RemovalLevel | null;
  /** Unix milliseconds. */
  createdAt: number;
  decidedAt: number | null;
};

type RemovalExecutionState =
  "unsent" | "executing" | "uncertain" | "done" | "failed" | "blocked";

/** Shared durable removal work for one resolved identity on one logical
 * Whisparr instance; several requests attach to it. Carries no per-user
 * history and stores the external facts observed before the call so a retry
 * can re-resolve by identity and compare. */
export type RemovalExecution = {
  id: string;
  instanceId: string;
  media: MediaReference;
  state: RemovalExecutionState;
  level: RemovalLevel;
  /** Compare-and-set tokens; stale workers holding old tokens fail writes. */
  claimToken: string | null;
  claimedAt: number | null;
  attemptToken: string | null;
  attemptAt: number | null;
  /** External facts observed before the call: Whisparr item id, path, file
   * count, size, and the item's added timestamp. A retry re-resolves by
   * identity and compares these before touching anything. */
  whisparrItemId: number | null;
  whisparrPath: string | null;
  whisparrFileCount: number | null;
  whisparrSize: number | null;
  whisparrAdded: string | null;
  /** Parties who created this execution: the first requester and the approver
   * whose approval attached it. Later attachments live on their own requests. */
  requesterId: string;
  approverId: string;
  /** Next due attempt, unix milliseconds. */
  dueAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type RemovalAttemptOutcome = "done" | "failed" | "uncertain";

/** External facts a worker observes before any removal call. */
export type RemovalObservedFacts = {
  whisparrItemId?: number;
  path?: string;
  fileCount?: number;
  size?: number;
  added?: string;
};

export type AcquisitionState =
  | "unsent"
  | "submitting"
  | "uncertain"
  | "monitoring"
  | "downloading"
  | "imported"
  | "failed"
  | "blocked";

/** Shared durable work for one resolved identity on one logical Whisparr
 * instance; several requests attach to it. Carries no per-user history. */
export type AcquisitionRecord = {
  id: string;
  instanceId: string;
  media: MediaReference;
  state: AcquisitionState;

  /** Compare-and-set tokens; stale workers holding old tokens fail their writes. */
  claimToken: string | null;
  attemptToken: string | null;
  claimedAt: number | null;
  attemptAt: number | null;
  /** Next due check, unix milliseconds. */
  dueAt: number | null;
  submittedAt: number | null;
  /** Last successful external observation, unix milliseconds. Kept separate
   * from check health: an outage never overwrites it. */
  lastObservedAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  /** Last observed external item facts, kept so per-user availability can be
   * resolved without calling Whisparr on every read. Only overwritten by a
   * successful observation. */
  whisparrId: number | null;
  whisparrPath: string | null;
  whisparrTitle: string | null;
  /** Whether Whisparr is still monitoring the item. `false` means an operator
   * (or an M7 unmonitor) paused it: no release will ever be grabbed, which is
   * not the same as "watching for a release". */
  whisparrMonitored: boolean | null;
  /** Download progress of the current grab, observed with the state. Non-null
   * only while downloading; cleared by any other observed state so a stale
   * percentage can never outlive its download. */
  progress: AcquisitionProgress | null;
  createdAt: number;
  updatedAt: number;
};

/** Progress of one in-flight Whisparr grab, as observed. Never recomputed
 * against the client clock: `timeleft` is Whisparr's own remaining-time
 * string, passed through verbatim. */
export type AcquisitionProgress = {
  /** Integer 0–100 from (size - sizeleft) / size. Absent when the queue
   * record carries no usable size, rather than a fake 0. */
  percent: number | null;
  /** Whisparr's `timeleft`, e.g. "00:12:34". */
  timeleft: string | null;
};

export type AttemptOutcome = "accepted" | "failed" | "uncertain";

/** Result of one external acquisition check: a real observed state, a proven
 * absence from a successful check (authoritative — recorded item facts are
 * cleared), or an unavailable/error check that must not touch recorded
 * state. */
export type AcquisitionObservation =
  | {
      state: "monitoring" | "downloading" | "imported";
      /** Observed external item facts to persist alongside the state. */
      item?: {
        whisparrId?: number;
        path?: string;
        title?: string;
        monitored?: boolean;
      };
      /** Progress of the observed grab. Only meaningful for `downloading`;
       * any other state clears the stored progress. */
      progress?: AcquisitionProgress;
    }
  | { absent: true; reason: string }
  | { unavailable: true; reason: string };

/** Per-user playback verdict. An exact Jellyfin match plus the current user's
 * authorization; never a global property of a download. */
export type PlaybackAccess =
  | { outcome: "available"; item: LibraryItem; watchUrl?: string }
  | { outcome: "missing" }
  // Imported in Whisparr but Jellyfin has not yet produced an authorized
  // exact match — distinct from missing and from unavailable.
  | { outcome: "awaiting_scan"; reason?: string }
  | { outcome: "denied"; reason?: string }
  | { outcome: "ambiguous"; reason?: string }
  | { outcome: "unavailable"; reason?: string };

export type WhisparrDelivery = {
  enabled: boolean;
  rootFolderPath: string;
  qualityProfileId: number;
  searchOnAdd: boolean;
};

export type WhisparrPathMapping = {
  whisparrPrefix: string;
  jellyfinPrefix: string;
};

export type IntegrationConfig = {
  jellyfin: {
    url: string;
    externalUrl: string;
    apiKey: string;
    serverId: string;
    libraryIds: string[];
  };
  whisparr?: {
    url: string;
    apiKey: string;
    /** Application-owned logical connection identity. Storage generates and
     * preserves it; a changed endpoint conservatively receives a new identity. */
    instanceId?: string;
    /** Absent delivery means delivery is disabled. */
    delivery?: WhisparrDelivery;
    pathMappings?: WhisparrPathMapping[];
  };
  /** Stored metadata-provider credentials (admin UI). Absent or empty
   * fields fall back to the environment variables. */
  providers?: {
    tpdbApiToken?: string;
    stashdbApiKey?: string;
  };
};

export type Account = {
  id: string;
  name: string;
  role: Role;
  enabled: boolean;
  libraryIds: string[];
  isOwner: boolean;
  /** Explicit auto-approve grant for requests; independent of library grants. */
  autoApprove: boolean;
  /** Explicit removal grant, required (with the operator flag) to create or
   * approve removal requests; default false, set by an administrator. */
  canRemove: boolean;
  /** Unix milliseconds the account row was created (Jellyfin import time). */
  joinedAt: number;
};

export type ExternalUser = {
  id: string;
  name: string;
  isDisabled: boolean;
  enableRemoteAccess: boolean;
  enableMediaPlayback: boolean;
  isAdministrator: boolean;
  /** Jellyfin PrimaryImageTag; absent when the user has no avatar upstream. */
  imageTag?: string;
};

/** One account as the admin user list sees it: the stored account plus two
 *  live facts (request volume, Jellyfin avatar) that no other surface needs. */
export type AdminAccount = Account & {
  /** Request intents this account has filed, all decisions included. */
  requestCount: number;
  /** Present only when Jellyfin has an avatar for this user. */
  avatarTag?: string;
};

export type Library = { id: string; name: string };

export type LibraryItem = {
  id: string;
  name: string;
  kind: string;
  year?: number;
  overview?: string;
  durationTicks?: number;
  /** File facts as the media server reports them; each field is absent rather
   * than guessed when Jellyfin omits it. */
  file?: {
    sizeBytes?: number;
    container?: string;
    /** Release-style label, e.g. "2160p". */
    resolution?: string;
    videoCodec?: string;
    /** On-disk path; only ever sent to Jellyfin administrators. */
    path?: string;
  };
  image?: string;
  canPlay: boolean;
  watchUrl?: string;
};

export type LibraryPage = {
  items: LibraryItem[];
  total: number;
  start: number;
  limit: number;
};

export type Session = {
  account: Account;
  jellyfinToken: string;
};

export type SessionGrant = {
  token: string;
  /** Unix milliseconds. */
  expiresAt: number;
  account: Account;
};

export type ProviderStatus = {
  tpdb: "not_configured" | "not_verified";
  stashdb: "not_configured" | "not_verified";
};
