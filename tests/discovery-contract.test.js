import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { profileSource } from "../src/instagram/profile-source.js";

const profile = { id: "1234567890", username: "example.creator" };
const queryName = "PolarisProfileReelsTabContentQuery_connection";
const connectionName = "xdt_api__v1__clips__user__connection_v2";
const graphId = "graphql-user-1234567890";
const local = (name, defaultValue = null) => ({ kind: "LocalArgument", name, defaultValue });
const variable = name => ({ kind: "Variable", name, variableName: name });
const scalar = name => ({ kind: "ScalarField", name, alias: null, args: null, storageKey: null });
const plain = value => JSON.parse(JSON.stringify(value));

function connectionSelection(alias = null) {
  return {
    kind: "LinkedField", name: connectionName, alias, plural: false,
    args: [variable("after"), variable("data"), variable("first")],
    selections: [
      { kind: "LinkedField", name: "edges", alias: null, plural: true, args: null,
        selections: [{ kind: "LinkedField", name: "node", alias: null, plural: false, args: null,
          selections: [{ kind: "LinkedField", name: "media", alias: null, plural: false, args: null,
            selections: [scalar("pk"), scalar("code"), scalar("media_type")] }] }] },
      { kind: "LinkedField", name: "page_info", alias: null, plural: false, args: null,
        selections: [scalar("has_next_page"), scalar("end_cursor")] },
    ],
  };
}

function fixture({ nodeAlias = null, connectionAlias = null, direct = false,
  masked = true, factory = "relay", execute = true, fetchQuery = true,
  records, response, payloads, failure, queryMutation, assertVariables = () => {} } = {}) {
  const state = { factories: 0, executions: [], fetches: [], providerCalls: 0, unsubscribed: 0 };
  const providerName = "__relay_internal__pv__PolarisShortDramaEnabledrelayprovider";
  const connection = connectionSelection(connectionAlias);
  const nodeField = {
    kind: "LinkedField", name: "node", alias: nodeAlias, plural: false, args: [variable("id")],
    selections: [scalar("id"), { kind: "InlineFragment", type: "XDTUserDict", abstractKey: null,
      selections: [{ kind: "Condition", condition: "includeReels", passingValue: true, selections: [connection] }] }],
  };
  const argumentsList = [local("after"), local("data"), local("first"),
    ...(!direct ? [local("id")] : []), local("includeReels", true), local(providerName, false)];
  const descriptor = {
    kind: "Request", params: { id: "CURRENT_FIRST_PARTY_QUERY", name: queryName, operationKind: "query",
      providedVariables: { [providerName]: { get() { state.providerCalls++; return true; } } } },
    fragment: { kind: "Fragment", name: queryName, type: "Query", metadata: null,
      argumentDefinitions: argumentsList,
      selections: direct ? [connection] : [{ ...nodeField, selections: masked ? [scalar("id"),
        { kind: "FragmentSpread", name: "PolarisProfileReelsTabContentQuery", args: [variable("after"), variable("data"), variable("first")] }] : nodeField.selections }] },
    operation: { kind: "Operation", name: queryName, argumentDefinitions: argumentsList,
      selections: direct ? [connection] : [nodeField] },
  };
  queryMutation?.(descriptor);
  const sourceRecords = records || {
    [`XDTUserDict:${profile.id}`]: { __id: `XDTUserDict:${profile.id}`, id: graphId, pk: profile.id, username: profile.username },
  };
  const resultConnection = { edges: [{ node: { media: { pk: "1", code: "B", media_type: 2 } } }],
    page_info: { has_next_page: true, end_cursor: "NEXT_PROFILE_PAGE" } };
  const resultBody = response ?? (direct ? { [connectionAlias || connectionName]: resultConnection } : {
    [nodeAlias || "node"]: { id: graphId, pk: profile.id, username: profile.username, [connectionAlias || connectionName]: resultConnection },
  });
  function observable(variables, raw = true) {
    return { subscribe(observer) {
      const subscription = { unsubscribe() { state.unsubscribed++; } };
      observer.start?.(subscription);
      if (failure) observer.error(failure);
      else {
        assert.equal(variables.first, 12, "root pagination count must be supplied");
        assert.equal(variables.data.target_user_id, profile.id, "API profile ID stays numeric");
        if (!direct) assert.equal(variables.id, graphId, "node ID must come from this profile's GraphQL identifier field");
        assertVariables(variables);
        for (const payload of payloads || [raw ? { data: resultBody } : resultBody]) observer.next(payload);
        observer.complete();
      }
      return subscription;
    } };
  }
  const environment = { getStore: () => ({ getSource: () => ({
    getRecordIDs: () => Object.keys(sourceRecords), get: id => sourceRecords[id],
  }) }), ...(execute ? { execute({ operation }) {
    assert.equal(operation.request.node, descriptor);
    state.executions.push(operation.request.variables);
    return observable(operation.request.variables);
  } } : {}) };
  function createOperationDescriptor(query, variables, cacheConfig) {
    assert.equal(query, descriptor);
    assert.equal(cacheConfig?.force, true);
    state.factories++;
    const runtimeVariables = Object.fromEntries(query.operation.argumentDefinitions.map(definition =>
      [definition.name, variables[definition.name] ?? definition.defaultValue]));
    for (const [name, provider] of Object.entries(query.params.providedVariables)) runtimeVariables[name] = provider.get();
    return { request: { node: query, variables: runtimeVariables, cacheConfig },
      root: { dataID: "client:root", node: query.operation, variables: runtimeVariables },
      fragment: { dataID: "client:root", node: query.fragment, variables: runtimeVariables } };
  }
  const modules = {
    PolarisRelayEnvironment: environment,
    [`${queryName}.graphql`]: descriptor,
    CometRelay: {
      ...(factory === "relay" ? { createOperationDescriptor } : {}),
      ...(fetchQuery ? { fetchQuery(env, query, variables) {
        assert.equal(env, environment);
        assert.equal(query, descriptor);
        state.fetches.push(variables);
        if (!direct && masked) throw new Error("Masked fetchQuery reader does not expose connection data");
        return observable(variables, false);
      } } : {}),
    },
    ...(factory === "module" ? { RelayModernOperationDescriptor: { createOperationDescriptor } } : {}),
  };
  const window = { location: { href: `https://www.instagram.com/${profile.username}/reels/` },
    require(name) { if (name in modules) return modules[name]; throw new Error(`Module unavailable: ${name}`); } };
  window.top = window;
  return { state, descriptor, environment,
    context: { window, document: { querySelectorAll: () => [] }, URL, setTimeout, clearTimeout } };
}

async function run(f, cursor = null) {
  f.context.request = { action: "page", profile, cursor };
  return plain(await vm.runInNewContext(`(${profileSource.toString()})(request)`, f.context));
}

// Trimmed structural excerpt of the user's Instagram operation captured on
// 2026-10-31. Persisted query IDs, default values, and account data are fixtures.
// The sibling LinkedHandle is Relay bookkeeping, not another server field.
function capturedProfileFixture({ ownerAlias = null, clipsAlias = null, returnedId = graphId,
  queryMutation, assertVariables } = {}) {
  const clips = { ...connectionSelection(clipsAlias), name: "clips_connection",
    concreteType: "XDTUserProfileClipsConnection" };
  const owner = { kind: "LinkedField", name: "fetch__XDTUserDict", alias: ownerAlias,
    concreteType: "XDTUserDict", plural: false, args: [variable("id")], selections: [clips, {
      kind: "LinkedHandle", name: "clips_connection", alias: clipsAlias, handle: "connection",
      key: "PolarisProfileReelsTabContentQuery_clips_connection", filters: ["data"],
      args: [variable("after"), variable("data"), variable("first")],
    }, scalar("id")] };
  const response = { [ownerAlias || "fetch__XDTUserDict"]: { id: returnedId, pk: profile.id, username: profile.username,
    [clipsAlias || "clips_connection"]: {
      edges: [{ node: { media: { pk: "1", code: "B", media_type: 2 } } }],
      page_info: { has_next_page: true, end_cursor: "NEXT_PROFILE_PAGE" },
    } } };
  return fixture({ response, assertVariables, queryMutation(query) {
    query.operation.selections = [owner];
    query.operation.argumentDefinitions = query.operation.argumentDefinitions.filter(definition => definition.name !== "includeReels");
    query.fragment.argumentDefinitions = query.operation.argumentDefinitions;
    // Keep the reader masked, as in a generated refetch operation. The adapter
    // must use the operation's server selections and raw response.
    query.fragment.selections[0] = { ...query.fragment.selections[0], name: owner.name,
      concreteType: owner.concreteType, alias: ownerAlias };
    queryMutation?.(query);
  } });
}

test("the captured profile query reads fetch__XDTUserDict.clips_connection with its LinkedHandle sibling", async () => {
  const f = capturedProfileFixture({ assertVariables(variables) {
    assert.equal(variables.after, null);
    assert.equal(variables.first, 12);
    assert.equal(variables.id, graphId);
    assert.notEqual(variables.id, profile.id, "the GraphQL owner identifier is not the numeric API pk");
    assert.equal(variables.data.target_user_id, profile.id);
    assert.equal(variables.scale, undefined, "this captured operation does not declare scale");
  } });
  const result = await run(f);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.deepEqual(result.page.items.map(item => item.mediaId), ["1"]);
  assert.equal(result.page.hasMore, true);
  assert.equal(result.page.nextCursor, "NEXT_PROFILE_PAGE");
  assert.equal(f.state.executions.length, 1, "LinkedHandle must not create a second candidate connection");
  assert.equal(f.state.fetches.length, 0);
  assert.equal(f.state.providerCalls, 1);
});

test("the captured clips connection keeps cursor pagination at the query root", async () => {
  const f = capturedProfileFixture({ assertVariables(variables) {
    assert.equal(variables.after, "PREVIOUS_PROFILE_PAGE");
    assert.equal(variables.data.after, undefined);
    assert.equal(variables.id, graphId);
    assert.equal(variables.first, 12);
  } });
  const result = await run(f, "PREVIOUS_PROFILE_PAGE");
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(f.state.executions.length, 1);
  assert.equal(result.page.nextCursor, "NEXT_PROFILE_PAGE");
});

test("the captured profile fetch rejects a different returned GraphQL owner identifier", async () => {
  const f = capturedProfileFixture({ returnedId: "different-graphql-profile" });
  const result = await run(f);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "PROFILE_CHANGED");
  assert.equal(f.state.executions.length, 1);
});

test("the captured fetch and clips connection support their selected response aliases", async () => {
  const f = capturedProfileFixture({ ownerAlias: "profileOwner", clipsAlias: "profileReels" });
  const result = await run(f);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.deepEqual(result.page.items.map(item => item.shortcode), ["B"]);
  assert.equal(f.state.executions[0].id, graphId);
});

test("a generic clips_connection under an unrelated root is rejected before querying", async () => {
  const f = capturedProfileFixture({ queryMutation(query) {
    query.operation.selections[0].name = "recommendations";
  } });
  const result = await run(f);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "SCHEMA_CHANGED");
  assert.equal(f.state.executions.length + f.state.fetches.length, 0);
});

test("clips_connection requires the captured profile owner's concrete type", async () => {
  const f = capturedProfileFixture({ queryMutation(query) {
    query.operation.selections[0].concreteType = "DifferentUserType";
  } });
  const result = await run(f);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "SCHEMA_CHANGED");
  assert.equal(f.state.executions.length + f.state.fetches.length, 0);
});

test("clips_connection requires a profile owner bound by the id variable", async () => {
  const f = capturedProfileFixture({ queryMutation(query) {
    query.operation.selections[0].args = null;
  } });
  const result = await run(f);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "SCHEMA_CHANGED");
  assert.equal(f.state.executions.length + f.state.fetches.length, 0);
});

test("node pagination supplies declared id and first using the exact profile's GraphQL identifier", async () => {
  const f = fixture({ assertVariables(variables) {
    assert.equal(variables.after, null);
    assert.equal(variables.data.include_feed_video, true);
    assert.equal(variables.data.page_size, 12);
    assert.equal(variables.scale, undefined, "the deployed query does not declare scale");
  } });
  const result = await run(f);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(f.state.factories, 1);
  assert.equal(f.state.executions.length, 1);
  assert.equal(f.state.fetches.length, 0, "masked reader must not be used to retrieve the page");
  assert.equal(f.state.providerCalls, 1, "provider evaluation belongs to the runtime descriptor factory");
  assert.deepEqual(result.page.items.map(item => item.mediaId), ["1"]);
  assert.equal(result.page.nextCursor, "NEXT_PROFILE_PAGE");
});

test("node pagination binds the next cursor at the query root without changing profile input", async () => {
  const f = fixture({ assertVariables(variables) {
    assert.equal(variables.after, "PREVIOUS_PROFILE_PAGE");
    assert.equal(variables.data.after, undefined);
    assert.equal(variables.id, graphId);
  } });
  assert.equal((await run(f, "PREVIOUS_PROFILE_PAGE")).ok, true);
});

test("raw query paths honor node and connection aliases through inline and condition selections", async () => {
  const f = fixture({ nodeAlias: "profileNode", connectionAlias: "profileReels" });
  const result = await run(f);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.page.items[0].shortcode, "B");
});

test("the loaded Relay operation descriptor module supports the raw execution path", async () => {
  const f = fixture({ factory: "module" });
  assert.equal((await run(f)).ok, true);
  assert.equal(f.state.factories, 1);
  assert.equal(f.state.executions.length, 1);
  assert.equal(f.state.fetches.length, 0);
});

test("raw execution does not require the fetchQuery reader export", async () => {
  const f = fixture({ fetchQuery: false });
  const result = await run(f);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(f.state.executions.length, 1);
});

test("a masked query without either execution client fails before a network request", async () => {
  const f = fixture({ factory: null, fetchQuery: false });
  const result = await run(f);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "ADAPTER_UNAVAILABLE");
  assert.equal(f.state.executions.length + f.state.fetches.length, 0);
});

test("a direct readable query can use the fetchQuery fallback with declared first supplied", async () => {
  const f = fixture({ direct: true, factory: null, execute: false });
  const result = await run(f);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(f.state.fetches.length, 1);
  assert.equal(f.state.executions.length, 0);
});

test("a declared root connection id uses the bound numeric profile ID", async () => {
  const f = fixture({ direct: true, queryMutation(query) {
    query.operation.argumentDefinitions.push(local("id"));
    query.operation.selections[0].args.push(variable("id"));
  }, assertVariables(variables) {
    assert.equal(variables.id, profile.id);
    assert.equal(variables.first, 12);
  } });
  assert.equal((await run(f)).ok, true);
});

test("an expanded node reader can use fetchQuery when raw execution is unavailable", async () => {
  const f = fixture({ masked: false, factory: null, execute: false });
  const result = await run(f);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(f.state.fetches.length, 1);
  assert.equal(f.state.executions.length, 0);
  assert.equal(f.state.fetches[0].id, graphId);
  assert.equal(f.state.fetches[0].first, 12);
});

test("a false ordinary condition excludes an unrelated alternate Reels path", async () => {
  const f = fixture({ queryMutation(query) {
    query.operation.argumentDefinitions.push(local("includeAlternative", false));
    query.operation.selections.push({ kind: "Condition", condition: "includeAlternative", passingValue: true,
      selections: [{ ...query.operation.selections[0], alias: "unrelatedNode" }] });
  } });
  const result = await run(f);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(f.state.executions.length, 1);
});

test("a provided variable placeholder cannot choose an alternate profile branch before runtime evaluation", async () => {
  const f = fixture({ queryMutation(query) {
    const field = query.operation.selections[0];
    const condition = "__relay_internal__pv__PolarisShortDramaEnabledrelayprovider";
    query.operation.selections = [
      { kind: "Condition", condition, passingValue: true, selections: [field] },
      { kind: "Condition", condition, passingValue: false, selections: [{ ...field, alias: "alternateProfile" }] },
    ];
  } });
  const result = await run(f);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "SCHEMA_CHANGED");
  assert.equal(f.state.executions.length + f.state.fetches.length, 0);
  assert.equal(f.state.providerCalls, 0, "adapter must not evaluate a provider outside its runtime factory");
});

test("a different returned node identifier is rejected even when the response copies numeric pk", async () => {
  const f = fixture({ response: { node: { id: "different-profile-node", pk: profile.id, username: profile.username,
    [connectionName]: { edges: [], page_info: { has_next_page: false, end_cursor: null } } } } });
  const result = await run(f);
  assert.equal(result.ok, false);
  assert.ok(["PROFILE_CHANGED", "SCHEMA_CHANGED", "MEDIA_MISMATCH"].includes(result.error.code));
});

test("a wrong node identifier selected with an alias inside an inline fragment is rejected", async () => {
  const f = fixture({ queryMutation(query) {
    const node = query.operation.selections[0];
    node.selections[0] = { kind: "InlineFragment", type: "XDTUserDict", abstractKey: null,
      selections: [{ ...scalar("id"), alias: "profileGraphId" }] };
  }, response: { node: { profileGraphId: "another-profile-graphql-id",
    [connectionName]: { edges: [], page_info: { has_next_page: false, end_cursor: null } },
  } } });
  const result = await run(f);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "PROFILE_CHANGED");
  assert.equal(f.state.executions.length, 1);
});

test("connection lookup does not pick unrelated root recommendations when its selected path is missing", async () => {
  const f = fixture({ response: { node: { id: graphId }, recommendations: {
    [connectionName]: { edges: [], page_info: { has_next_page: false, end_cursor: null } },
  } } });
  const result = await run(f);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "SCHEMA_CHANGED");
});

test("ambiguous connection paths are rejected before submitting the query", async () => {
  const f = fixture({ queryMutation(query) {
    query.operation.selections.push({ ...query.operation.selections[0], alias: "anotherProfileNode" });
  } });
  const result = await run(f);
  assert.equal(result.ok, false);
  assert.ok(["SCHEMA_CHANGED", "ADAPTER_UNAVAILABLE"].includes(result.error.code));
  assert.equal(f.state.executions.length + f.state.fetches.length, 0);
});

test("a connection reachable only through a plural recommendation path is unsupported", async () => {
  const f = fixture({ queryMutation(query) {
    query.operation.selections[0].plural = true;
  } });
  const result = await run(f);
  assert.equal(result.ok, false);
  assert.ok(["SCHEMA_CHANGED", "ADAPTER_UNAVAILABLE"].includes(result.error.code));
  assert.equal(f.state.executions.length + f.state.fetches.length, 0);
});

test("a node query never substitutes a normalized record key for a missing GraphQL identifier", async () => {
  const f = fixture({ records: {
    [`XDTUserDict:${profile.id}`]: { __id: `XDTUserDict:${profile.id}`, pk: profile.id, username: profile.username },
  } });
  const result = await run(f);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "ADAPTER_UNAVAILABLE");
  assert.equal(f.state.executions.length + f.state.fetches.length, 0);
});

test("a server rejection on raw execution never triggers a second fallback request", async () => {
  const failure = Object.assign(new Error(`GraphQL operation responded with error 1675012: Try again later. (Operation: ${queryName})`), {
    source: { errors: [{ code: 1675012, message: "There was a problem with this request. Try again later." }] },
  });
  const f = fixture({ failure });
  const result = await run(f);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "QUERY_FAILED");
  assert.equal(String(result.error.diagnostic.serverCode), "1675012");
  assert.equal(f.state.executions.length, 1);
  assert.equal(f.state.fetches.length, 0);
});

test("plain GraphQL wrapper errors preserve server code and safe query contract diagnostics", async () => {
  const f = fixture({ failure: new Error(`GraphQL operation responded with error 1675012: There was a problem with this request. (Operation: ${queryName})`) });
  const result = await run(f);
  assert.equal(result.error.code, "QUERY_FAILED");
  const diagnostic = result.error.diagnostic;
  assert.equal(diagnostic.serverCode, "1675012");
  assert.equal(diagnostic.executionMethod, "environment.execute");
  assert.deepEqual(diagnostic.connectionPath, ["node", connectionName]);
  assert.deepEqual(diagnostic.unsetVariableNames, ["after"]);
  assert.ok(diagnostic.variableNames.includes("id"));
  assert.ok(diagnostic.variableNames.includes("first"));
  assert.equal(Object.hasOwn(diagnostic, "variables"), false);
  assert.equal(JSON.stringify(diagnostic).includes(graphId), false, "report does not export identifier values");
  assert.equal(f.state.executions[0].id, graphId);
  assert.equal(f.state.executions[0].first, 12);
});

test("unsupported incremental payloads never appear as an exhausted complete page", async () => {
  const f = fixture({ payloads: [
    { data: { node: { id: graphId, [connectionName]: { edges: [], page_info: { has_next_page: false, end_cursor: null } } } }, hasNext: true },
    { path: ["node", connectionName, "edges", 0], label: "DeferredReels", data: { node: { media: { pk: "1", code: "B", media_type: 2 } } } },
  ] });
  const result = await run(f);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "SCHEMA_CHANGED");
  assert.equal(result.error.stage, "discovery");
  assert.equal(f.state.unsubscribed, 1);
});
