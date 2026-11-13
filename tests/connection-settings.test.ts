import assert from "node:assert/strict";
import { test } from "node:test";
import {
  connectionDraft,
  connectionDraftChanged,
  connectionPatch,
  type ConnectionsInfo,
  type ConnectionDraft,
} from "../src/lib/connection-settings.ts";

const settings = (): ConnectionsInfo => ({
  jellyfin: {
    url: "https://jellyfin.example.test",
    externalUrl: "https://watch.example.test",
    serverId: "saved-server",
    libraryIds: ["saved-library"],
    apiKeyConfigured: true,
  },
  whisparr: {
    url: "https://whisparr.example.test",
    apiKeyConfigured: true,
    delivery: {
      enabled: true,
      rootFolderPath: "/data/media",
      qualityProfileId: 7,
      searchOnAdd: false,
    },
    pathMappings: [{ whisparrPrefix: "/data/media", jellyfinPrefix: "/media" }],
  },
});

test("connection edits send only their service and preserve blank saved keys", () => {
  const info = settings();
  const jellyfin = connectionDraft("jellyfin", info);
  jellyfin.externalUrl = " https://watch.example.test/new ";
  assert.deepEqual(connectionPatch("jellyfin", jellyfin, info), {
    jellyfinUrl: info.jellyfin.url,
    jellyfinExternalUrl: "https://watch.example.test/new",
  });
  const whisparr = connectionDraft("whisparr", info);
  whisparr.apiKey = " replacement-key ";
  assert.deepEqual(connectionPatch("whisparr", whisparr, info), {
    whisparrUrl: info.whisparr!.url,
    whisparrApiKey: "replacement-key",
    delivery: info.whisparr!.delivery,
    pathMappings: info.whisparr!.pathMappings,
  });
  jellyfin.apiKey = " new-jellyfin-key ";
  assert.equal(
    connectionPatch("jellyfin", jellyfin, info).jellyfinApiKey,
    "new-jellyfin-key",
  );
});

test("a mapping draft cannot mutate saved settings and can be discarded", () => {
  const info = settings();
  const draft = connectionDraft("whisparr", info);
  draft.pathMappings[0]!.jellyfinPrefix = "/unsaved";
  assert.equal(info.whisparr!.pathMappings[0]!.jellyfinPrefix, "/media");
  assert.equal(connectionDraftChanged("whisparr", draft, info), true);
  assert.deepEqual(connectionDraft("whisparr", info).pathMappings, [
    { whisparrPrefix: "/data/media", jellyfinPrefix: "/media" },
  ]);
});

test("every editable connection field invalidates the saved diagnosis", () => {
  const info = settings();
  const original = connectionDraft("whisparr", info);
  for (const change of [
    { url: "https://elsewhere.example.test" },
    { apiKey: "replacement" },
    { deliveryEnabled: false },
    { rootFolderPath: "/alt" },
    { qualityProfileId: "8" },
    { searchOnAdd: true },
    { pathMappings: [] },
  ])
    assert.equal(
      connectionDraftChanged("whisparr", { ...original, ...change }, info),
      true,
      JSON.stringify(change),
    );
  const jellyfin = connectionDraft("jellyfin", info);
  assert.equal(
    connectionDraftChanged(
      "jellyfin",
      { ...jellyfin, externalUrl: "https://new.example.test" },
      info,
    ),
    true,
  );
  assert.equal(
    connectionDraftChanged(
      "jellyfin",
      { ...jellyfin, url: "https://new.example.test" },
      info,
    ),
    true,
  );
  assert.equal(
    connectionDraftChanged(
      "jellyfin",
      { ...jellyfin, apiKey: "replacement" },
      info,
    ),
    true,
  );
  assert.equal(
    connectionDraftChanged(
      "jellyfin",
      { ...jellyfin, url: " " + jellyfin.url + " ", apiKey: " " },
      info,
    ),
    false,
  );
  assert.equal(
    connectionDraftChanged(
      "jellyfin",
      { ...jellyfin, rootFolderPath: "/unused" },
      info,
    ),
    false,
  );
  assert.equal(
    connectionDraftChanged(
      "whisparr",
      { ...original, externalUrl: "https://unused.example.test" },
      info,
    ),
    false,
  );
});

test("first-time Whisparr configuration does not require delivery, but retains path mappings", () => {
  const info = { ...settings(), whisparr: null };
  const draft = {
    ...connectionDraft("whisparr", info),
    url: "https://whisparr.example.test",
    apiKey: "new-key",
    pathMappings: [
      { whisparrPrefix: " /downloads ", jellyfinPrefix: " /media " },
      { whisparrPrefix: " ", jellyfinPrefix: "" },
    ],
  };
  assert.deepEqual(connectionPatch("whisparr", draft, info), {
    whisparrUrl: draft.url,
    whisparrApiKey: "new-key",
    pathMappings: [{ whisparrPrefix: "/downloads", jellyfinPrefix: "/media" }],
  });
  assert.throws(
    () => connectionPatch("whisparr", { ...draft, apiKey: " " }, info),
    /API key is required/,
  );
});

test("disabling delivery preserves roots, profiles, mappings and search preference", () => {
  const info = settings();
  const draft = {
    ...connectionDraft("whisparr", info),
    deliveryEnabled: false,
  };
  assert.deepEqual(connectionPatch("whisparr", draft, info).delivery, {
    ...info.whisparr!.delivery,
    enabled: false,
  });
  assert.deepEqual(
    connectionPatch("whisparr", draft, info).pathMappings,
    info.whisparr!.pathMappings,
  );
});

test("incomplete connection and delivery drafts fail before persistence", () => {
  const info = settings();
  const draft = connectionDraft("whisparr", info);
  for (const qualityProfileId of ["", "0", "-1", "1.5", "not-a-number"])
    assert.throws(
      () => connectionPatch("whisparr", { ...draft, qualityProfileId }, info),
      /quality profile/,
    );
  assert.throws(
    () => connectionPatch("whisparr", { ...draft, rootFolderPath: " " }, info),
    /root folder is required/,
  );
  for (const pair of [
    { whisparrPrefix: "/downloads", jellyfinPrefix: "" },
    { whisparrPrefix: " ", jellyfinPrefix: "/media" },
  ])
    assert.throws(
      () =>
        connectionPatch("whisparr", { ...draft, pathMappings: [pair] }, info),
      /both a Whisparr prefix and a Jellyfin prefix/,
    );
  const jf = connectionDraft("jellyfin", info);
  assert.throws(
    () => connectionPatch("jellyfin", { ...jf, url: " " }, info),
    /URLs? are required/,
  );
  assert.throws(
    () => connectionPatch("jellyfin", { ...jf, externalUrl: " " }, info),
    /URLs? are required/,
  );
});

test("blank Whisparr Save cannot silently remove a configured connection", () => {
  const info = settings();
  assert.throws(
    () =>
      connectionPatch(
        "whisparr",
        { ...connectionDraft("whisparr", info), url: "" },
        info,
      ),
    /use Remove connection/,
  );
  const empty = { ...info, whisparr: null };
  assert.throws(
    () =>
      connectionPatch("whisparr", connectionDraft("whisparr", empty), empty),
    /Enter a Whisparr URL and API key/,
  );
});

test("loading a connection without configuration creates an empty, independent draft", () => {
  const expected: ConnectionDraft = {
    url: "",
    externalUrl: "",
    apiKey: "",
    deliveryEnabled: false,
    rootFolderPath: "",
    qualityProfileId: "",
    searchOnAdd: true,
    pathMappings: [],
  };
  const jellyfin = connectionDraft("jellyfin");
  const whisparr = connectionDraft("whisparr");
  assert.deepEqual(jellyfin, expected);
  assert.deepEqual(whisparr, expected);
  whisparr.pathMappings.push({
    whisparrPrefix: "/unsaved",
    jellyfinPrefix: "/draft",
  });
  assert.deepEqual(jellyfin, expected);
  assert.deepEqual(connectionDraft("whisparr"), expected);
});
