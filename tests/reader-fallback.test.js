import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { profileSource } from "../src/instagram/profile-source.js";

// Mandatory serialized regressions. This fixture models reader projection and
// masking; it is not a substitute for the signed-in, real Relay integration run.
const options = {};

const profile = { id: "1234567890", username: "example.creator" };
const graphId = "graphql-user-1234567890";
const queryName = "PolarisProfileReelsTabContentQuery_connection";
const providerName = "__relay_internal__pv__PolarisShortDramaEnabledrelayprovider";
const local = name => ({ kind: "LocalArgument", name, defaultValue: null });
const variable = name => ({ kind: "Variable", name, variableName: name });
const scalar = name => ({ kind: "ScalarField", name, alias: null, args: null, storageKey: null });
const linked = (name, selections, concreteType, plural = false, args = null, alias = null) =>
  ({ kind: "LinkedField", name, alias, concreteType, plural, args, storageKey: null, selections });
const plain = value => JSON.parse(JSON.stringify(value));

function fixture({ ownerAlias = null, connectionAlias = null, failure = null, returnedId = graphId } = {}) {
  const state = { network: [], requests: [], providerCalls: 0, handledIds: [] };
  const definitions = ["after", "data", "first", "id", providerName].map(local);
  const mediaSelection = linked("media", [scalar("pk"), scalar("id"), scalar("code"), scalar("media_type"),
    { kind: "Condition", condition: providerName, passingValue: true,
      selections: [linked("user", [scalar("username"), scalar("id")], "XDTUserDict")] }], "XDTMediaDict");
  const connection = linked("clips_connection", [
    linked("edges", [linked("node", [mediaSelection], "XDTClipsItemDict"), scalar("cursor")], "XDTUserProfileClipsEdge", true),
    linked("page_info", [scalar("end_cursor"), scalar("has_next_page")], "XDTPageInfo"),
  ], "XDTUserProfileClipsConnection", false, [variable("after"), variable("data"), variable("first")], connectionAlias);
  const owner = linked("fetch__XDTUserDict", [connection,
    { kind: "LinkedHandle", name: "clips_connection", alias: connectionAlias, args: connection.args,
      handle: "connection", key: "PolarisProfileReelsTabContentQuery_clips_connection", filters: ["data"] },
    scalar("id")], "XDTUserDict", false, [variable("id")], ownerAlias);
  const descriptor = {
    kind: "Request",
    params: { id: "CURRENT_FIRST_PARTY_FIXTURE_QUERY", cacheID: "fixture-query", text: null,
      name: queryName, operationKind: "query", metadata: {},
      providedVariables: { [providerName]: { get() { state.providerCalls++; return true; } } } },
    operation: { kind: "Operation", name: queryName, argumentDefinitions: definitions, selections: [owner] },
    fragment: { kind: "Fragment", name: queryName, type: "Query", abstractKey: null,
      metadata: null, argumentDefinitions: definitions,
      selections: [{ ...owner, selections: [{ kind: "FragmentSpread", name: "PolarisProfileReelsTabContentFragment", args: null }] }] },
  };
  const records = {
    [graphId]: { __id: graphId, __typename: "XDTUserDict", id: graphId, pk: profile.id, username: profile.username },
  };
  const recordSource = { getRecordIDs: () => Object.keys(records), get: id => records[id] };
  const environment = {
    getStore: () => ({ getSource: () => recordSource }),
    execute() { throw new Error("The private operation factory is not exported to the adapter."); },
  };
  function network(params, variables, cacheConfig) {
    state.network.push({ params, variables: plain(variables), cacheConfig });
    if (failure) throw failure;
    const next = variables.after === "NEXT_PROFILE_PAGE";
    const ids = next ? ["3"] : ["1", "2"];
    state.handledIds = [...new Set([...state.handledIds, ...ids])];
    const media = id => ({ pk: id, id: `${id}_${profile.id}`, code: ["A", "B", "C", "D"][Number(id)],
      media_type: 2, user: { id: profile.id, username: profile.username } });
    return { data: { [ownerAlias || "fetch__XDTUserDict"]: {
      id: returnedId,
      [connectionAlias || "clips_connection"]: {
        edges: ids.map(id => ({ cursor: `ITEM_${id}`, node: { media: media(id) } })),
        page_info: { has_next_page: !next, end_cursor: next ? null : "NEXT_PROFILE_PAGE" },
      },
    } } };
  }
  function project(selections, data, variables) {
    if (data == null) return data;
    const result = {};
    for (const selection of selections) {
      const key = selection.alias || selection.name;
      if (selection.kind === "ScalarField") result[key] = data[key];
      else if (selection.kind === "LinkedField") {
        const args = Object.fromEntries((selection.args || []).map(argument => [argument.name,
          argument.kind === "Variable" ? variables[argument.variableName] : argument.value]));
        if (selection.name === "fetch__XDTUserDict") assert.equal(args.id, variables.id, "reader retains the profile argument");
        if (selection.name === "clips_connection") {
          assert.equal(args.after, variables.after, "reader retains the exact requested cursor");
          assert.equal(args.first, variables.first, "reader retains the page count");
          assert.deepEqual(args.data, variables.data, "reader retains the profile filter");
        }
        const value = data[key];
        result[key] = selection.plural && Array.isArray(value) ? value.map(entry => project(selection.selections, entry, variables)) :
          project(selection.selections, value, variables);
      } else if (selection.kind === "FragmentSpread") {
        result.__fragments = { ...result.__fragments, [selection.name]: {} };
      } else if (selection.kind === "InlineFragment") Object.assign(result, project(selection.selections, data, variables));
      else if (selection.kind === "Condition") {
        if (Boolean(variables[selection.condition]) === selection.passingValue) Object.assign(result, project(selection.selections, data, variables));
      } else throw new Error(`Normalization-only node ${selection.kind} cannot be used as a reader.`);
    }
    return result;
  }
  function fetchQuery(env, query, variables, fetchOptions) {
    assert.equal(env, environment);
    state.requests.push(query);
    const runtimeVariables = Object.fromEntries(query.operation.argumentDefinitions.map(definition =>
      [definition.name, variables[definition.name] ?? definition.defaultValue]));
    for (const [name, provider] of Object.entries(query.params.providedVariables)) runtimeVariables[name] = provider.get();
    const observable = { subscribe(observer) {
      const subscription = { unsubscribe() {} };
      observer.start?.(subscription);
      try {
        const response = network(query.params, runtimeVariables, fetchOptions?.networkCacheConfig);
        observer.next(project(query.fragment.selections, response.data, runtimeVariables));
        observer.complete();
      } catch (error) { observer.error(error); }
      return subscription;
    }, toPromise() {
      return new Promise((resolve, reject) => { let latest;
        observable.subscribe({ next(value) { latest = value; }, error: reject, complete() { resolve(latest); } });
    }); } };
    return observable;
  }
  const modules = {
    PolarisRelayEnvironment: environment,
    [`${queryName}.graphql`]: descriptor,
    CometRelay: { fetchQuery },
    // No exposed operation factory: this matches the confirmed live flags.
  };
  const window = { location: { href: `https://www.instagram.com/${profile.username}/reels/` },
    require(name) { if (name in modules) return modules[name]; throw new Error("Module unavailable"); } };
  window.top = window;
  return { descriptor, state, environment, recordSource, fetchQuery,
    context: { window, document: { querySelectorAll: () => [] }, URL, setTimeout, clearTimeout } };
}

async function run(f, cursor = null) {
  f.context.request = { action: "page", profile, cursor };
  return plain(await vm.runInNewContext(`(${profileSource.toString()})(request)`, f.context));
}

test("the original masked query reader does not expose the clips connection", options, async () => {
  const f = fixture();
  const result = await f.fetchQuery(f.environment, f.descriptor, {
    id: graphId, first: 12, after: null,
    data: { include_feed_video: true, page_size: 12, target_user_id: profile.id },
  }).toPromise();
  assert.equal(result.fetch__XDTUserDict.clips_connection, undefined);
  assert.ok(result.fetch__XDTUserDict.__fragments.PolarisProfileReelsTabContentFragment);
  assert.equal(f.state.network.length, 1);
});

test("minimal fallback reads a projected snapshot without an exported operation factory", options, async () => {
  const f = fixture();
  const originalFragment = f.descriptor.fragment;
  const originalSelections = originalFragment.selections;
  const result = await run(f);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.deepEqual(result.page.items.map(item => item.mediaId), ["1", "2"]);
  assert.equal(result.page.nextCursor, "NEXT_PROFILE_PAGE");
  assert.equal(result.page.hasMore, true);
  assert.equal(f.state.network.length, 1);
  assert.equal(f.state.providerCalls, 1, "the runtime factory evaluates the provider once");
  assert.equal(f.state.requests.length, 1);
  const request = f.state.requests[0];
  assert.notEqual(request, f.descriptor);
  assert.equal(request.params, f.descriptor.params, "persisted query metadata is unchanged");
  assert.equal(request.operation, f.descriptor.operation, "normalization operation is unchanged");
  assert.notEqual(request.fragment, originalFragment);
  assert.equal(request.fragment.kind, "Fragment");
  assert.equal(request.fragment.type, "Query");
  assert.equal(f.descriptor.fragment, originalFragment);
  assert.equal(f.descriptor.fragment.selections, originalSelections, "the page's compiled reader is never mutated");
  assert.equal(f.state.network[0].params, f.descriptor.params);
  assert.equal(f.state.network[0].variables.id, graphId);
  assert.equal(f.state.network[0].variables.first, 12);
  assert.equal(f.state.network[0].variables[providerName], true);
});

test("fallback reads the requested raw page independently from merged connection state", options, async () => {
  const f = fixture();
  const first = await run(f);
  assert.equal(first.ok, true, JSON.stringify(first.error));
  const second = await run(f, first.page.nextCursor);
  assert.equal(second.ok, true, JSON.stringify(second.error));
  assert.deepEqual(second.page.items.map(item => item.mediaId), ["3"], "previous handled edges must not leak into this page");
  assert.equal(second.page.hasMore, false);
  assert.equal(second.page.nextCursor, null);
  assert.equal(f.state.network.length, 2);
  assert.equal(f.state.network[1].variables.after, "NEXT_PROFILE_PAGE");
  assert.equal(f.state.providerCalls, 2);
  assert.deepEqual(f.state.handledIds, ["1", "2", "3"], "merged state retains all pages while the page reader returns only its own items");
});

test("fallback preserves aliases and field arguments in the reader snapshot", options, async () => {
  const f = fixture({ ownerAlias: "profileOwner", connectionAlias: "profileReels" });
  const result = await run(f);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.deepEqual(result.page.items.map(item => item.mediaId), ["1", "2"]);
  const owner = f.state.requests[0].fragment.selections.find(field => field.kind === "LinkedField");
  assert.equal(owner.alias, "profileOwner");
  assert.deepEqual(plain(owner.args), [variable("id")]);
  const connection = owner.selections.find(field => field.name === "clips_connection");
  assert.equal(connection.alias, "profileReels");
  assert.deepEqual(plain(connection.args), [variable("after"), variable("data"), variable("first")]);
});

test("fallback reader excludes normalization handles and resolver-only selections", options, async () => {
  const f = fixture();
  const result = await run(f);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  const pending = [...f.state.requests[0].fragment.selections];
  while (pending.length) {
    const selection = pending.pop();
    assert.ok(["ScalarField", "LinkedField", "InlineFragment", "Condition"].includes(selection.kind), selection.kind);
    if (selection.selections) pending.push(...selection.selections);
  }
});

test("a server rejection in reader fallback starts only one request and preserves its query error", options, async () => {
  const failure = new Error(`GraphQL operation responded with error 1675012: Request rejected. (Operation: ${queryName})`);
  const f = fixture({ failure });
  const result = await run(f);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "QUERY_FAILED");
  assert.equal(String(result.error.diagnostic.serverCode), "1675012");
  assert.equal(f.state.network.length, 1);
});

test("fallback rejects a different returned profile identifier from the projected snapshot", options, async () => {
  const f = fixture({ returnedId: "different-profile-identifier" });
  const result = await run(f);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "PROFILE_CHANGED");
  assert.equal(f.state.network.length, 1);
});
