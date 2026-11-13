import type { WhisparrDelivery, WhisparrPathMapping } from "./contracts.ts";

export type ConnectionService = "jellyfin" | "whisparr";
export type ConnectionsInfo = {
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
};
export type ConnectionDraft = {
  url: string;
  externalUrl: string;
  apiKey: string;
  deliveryEnabled: boolean;
  rootFolderPath: string;
  qualityProfileId: string;
  searchOnAdd: boolean;
  pathMappings: WhisparrPathMapping[];
};
export type ConnectionPatch = {
  jellyfinUrl?: string;
  jellyfinExternalUrl?: string;
  jellyfinApiKey?: string;
  whisparrUrl?: string;
  whisparrApiKey?: string;
  delivery?: WhisparrDelivery;
  pathMappings?: WhisparrPathMapping[];
};

export function connectionDraft(
  service: ConnectionService,
  info?: ConnectionsInfo,
): ConnectionDraft {
  const delivery = info?.whisparr?.delivery;
  return {
    url: info?.[service]?.url ?? "",
    externalUrl: info?.jellyfin.externalUrl ?? "",
    apiKey: "",
    deliveryEnabled: delivery?.enabled ?? false,
    rootFolderPath: delivery?.rootFolderPath ?? "",
    qualityProfileId: delivery ? String(delivery.qualityProfileId) : "",
    searchOnAdd: delivery?.searchOnAdd ?? true,
    pathMappings:
      info?.whisparr?.pathMappings.map((pair) => ({ ...pair })) ?? [],
  };
}

export function connectionDraftChanged(
  service: ConnectionService,
  draft: ConnectionDraft,
  info: ConnectionsInfo,
): boolean {
  const saved = connectionDraft(service, info);
  const values = (value: ConnectionDraft) =>
    service === "jellyfin"
      ? [value.url.trim(), value.externalUrl.trim()]
      : [
          value.url.trim(),
          value.deliveryEnabled,
          value.rootFolderPath.trim(),
          value.qualityProfileId,
          value.searchOnAdd,
          value.pathMappings.map((pair) => [
            pair.whisparrPrefix.trim(),
            pair.jellyfinPrefix.trim(),
          ]),
        ];
  return (
    draft.apiKey.trim() !== "" ||
    JSON.stringify(values(draft)) !== JSON.stringify(values(saved))
  );
}

/** Send only the edited service. Blank credentials preserve saved keys;
 * Whisparr removal uses its separate confirmed action, never a blank Save. */
export function connectionPatch(
  service: ConnectionService,
  draft: ConnectionDraft,
  info: ConnectionsInfo,
): ConnectionPatch {
  const url = draft.url.trim();
  const apiKey = draft.apiKey.trim();
  if (service === "jellyfin") {
    const externalUrl = draft.externalUrl.trim();
    if (!url || !externalUrl)
      throw new Error("Jellyfin URL and external URL are required.");
    return {
      jellyfinUrl: url,
      jellyfinExternalUrl: externalUrl,
      ...(apiKey ? { jellyfinApiKey: apiKey } : {}),
    };
  }
  if (!url)
    throw new Error(
      info.whisparr
        ? "Enter a Whisparr URL, or use Remove connection to remove it."
        : "Enter a Whisparr URL and API key, then save to check the connection.",
    );
  if (!info.whisparr?.apiKeyConfigured && !apiKey)
    throw new Error("A Whisparr API key is required for a new connection.");
  const hasDelivery = draft.deliveryEnabled || Boolean(info.whisparr?.delivery);
  const profile = Number(draft.qualityProfileId);
  if (hasDelivery && (!Number.isInteger(profile) || profile < 1))
    throw new Error("Choose a quality profile (a positive whole number).");
  if (draft.deliveryEnabled && !draft.rootFolderPath.trim())
    throw new Error("A root folder is required while delivery is enabled.");
  const pathMappings = draft.pathMappings.map((pair) => ({
    whisparrPrefix: pair.whisparrPrefix.trim(),
    jellyfinPrefix: pair.jellyfinPrefix.trim(),
  }));
  if (
    pathMappings.some(
      (pair) => (pair.whisparrPrefix === "") !== (pair.jellyfinPrefix === ""),
    )
  )
    throw new Error(
      "Each path mapping needs both a Whisparr prefix and a Jellyfin prefix.",
    );
  return {
    whisparrUrl: url,
    ...(apiKey ? { whisparrApiKey: apiKey } : {}),
    ...(hasDelivery
      ? {
          delivery: {
            enabled: draft.deliveryEnabled,
            rootFolderPath: draft.rootFolderPath.trim(),
            qualityProfileId: profile,
            searchOnAdd: draft.searchOnAdd,
          },
        }
      : {}),
    pathMappings: pathMappings.filter((pair) => pair.whisparrPrefix !== ""),
  };
}
