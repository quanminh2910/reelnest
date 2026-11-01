/** A bounded, self-contained Instagram MAIN-world adapter. Chrome serializes this function alone. */
export async function profileSource(request) {
  const deadline = Date.now() + 14000;
  const adapterVersion = "profile-relay-v5";
  const action = request?.action;
  const stage = action === "page" ? "discovery" : action === "resolve" ? "resolve" : "identify";
  const queryName = "PolarisProfileReelsTabContentQuery_connection";
  const connectionName = "xdt_api__v1__clips__user__connection_v2";
  const ownErrors = new WeakSet();
  let variableNames = [];
  let unsetVariableNames = [];
  let connectionPath = [];
  let executionMethod;
  let queryShape;
  let connectionMatchCount;
  const reserved = new Set(["accounts", "about", "ads", "api", "challenge", "checkpoint", "developer", "direct", "directory", "download", "emails", "explore", "help", "legal", "notifications", "oauth", "p", "privacy", "reel", "reels", "session", "settings", "share", "static", "stories", "terms", "topics", "web", "your_activity"]);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

  function problem(code, message, retryable = false, extra = {}) {
    const error = new Error(message);
    Object.assign(error, { code, retryable, ...extra });
    ownErrors.add(error);
    return error;
  }

  function route() {
    try {
      const url = new URL(window.location.href);
      const match = /^\/([A-Za-z0-9._]{1,30})(?:\/(reels|tagged))?\/?$/.exec(url.pathname);
      if (url.protocol !== "https:" || url.port || url.username || url.password ||
          !["instagram.com", "www.instagram.com"].includes(url.hostname) ||
          !match || reserved.has(match[1].toLowerCase()) || (window.top && window.top !== window)) return null;
      return match[1];
    } catch { return null; }
  }

  function assertRoute() {
    if (!initialUsername || route()?.toLowerCase() !== initialUsername.toLowerCase()) {
      throw problem("PROFILE_CHANGED", "The profile changed. Return to the original profile before continuing.");
    }
  }

  function module(name) {
    try { return typeof window.require === "function" ? window.require(name) : null; } catch { return null; }
  }

  function unwrap(value) { return value?.default || value; }

  function numericId(value) {
    if (typeof value === "number" && !Number.isSafeInteger(value)) return null;
    const id = typeof value === "bigint" || typeof value === "number" || typeof value === "string" ? String(value).split("_")[0] : "";
    return /^[1-9][0-9]{0,29}$/.test(id) ? id : null;
  }

  function codeForId(id) {
    let value = BigInt(id);
    let code = "";
    do { code = alphabet[Number(value % 64n)] + code; value /= 64n; } while (value > 0n);
    return code;
  }

  function idForCode(code) {
    if (typeof code !== "string" || !/^[A-Za-z0-9_-]{1,28}$/.test(code)) return null;
    let value = 0n;
    for (const character of code) value = value * 64n + BigInt(alphabet.indexOf(character));
    return value.toString();
  }

  function mediaUrl(value, video = false) {
    try {
      if (typeof value !== "string") return null;
      const url = new URL(value);
      const trusted = ["cdninstagram.com", "fbcdn.net"].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`)) ||
        ["instagram.com", "www.instagram.com"].includes(url.hostname);
      return trusted && url.protocol === "https:" && !url.username && !url.password && !url.port &&
        (!video || /\.mp4$/i.test(url.pathname)) ? url.href : null;
    } catch { return null; }
  }

  function dimension(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 && number <= 16384 ? Math.round(number) : 0;
  }

  function bestCandidate(values, video = false) {
    if (!Array.isArray(values)) return null;
    return values.map(value => ({ url: mediaUrl(value?.url, video), width: dimension(value?.width), height: dimension(value?.height) }))
      .filter(value => value.url).sort((a, b) => b.width * b.height - a.width * a.height)[0] || null;
  }

  function safeMessage(value, limit = 500) {
    if (typeof value !== "string" && typeof value !== "number") return "";
    return String(value).slice(0, 4000)
      .replace(/\b(?:https?|blob):[^\s\"'<>]+/gi, "[address redacted]")
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
      .replace(/\b(?:set-cookie|cookie)\s*:\s*[^\r\n]*/gi, "Cookie: [redacted]")
      .replace(/([\"']?\b(?:x-csrftoken|csrf[_-]?token|csrftoken|access[_-]?token|refresh[_-]?token|id[_-]?token|sessionid|session_key|token|secret|authorization|cookie|password|lsd|fb_dtsg)\b[\"']?\s*[:=]\s*)(?:\"[^\"]*\"|'[^']*'|[^\s,;]+)/gi, "$1[redacted]")
      .replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, limit);
  }

  function errorFacts(value) {
    // Relay puts GraphQL errors and HTTP details in .source, while Instapi uses
    // response/data envelopes. Inspect only these bounded, known envelopes.
    const pending = [{ value, depth: 0 }];
    const seen = new Set();
    const messages = [];
    const errors = [];
    let status = 0;
    let retryAfter;
    while (pending.length && seen.size < 20) {
      const entry = pending.shift();
      const current = entry.value;
      if (!current || typeof current !== "object" || seen.has(current)) continue;
      seen.add(current);
      for (const key of ["statusCode", "status", "httpStatus"]) {
        const number = Number(current[key]);
        if (Number.isInteger(number) && number >= 100 && number <= 599 && (status < 400 || number >= 400)) status = number;
      }
      for (const key of ["message", "error_type"]) {
        if (typeof current[key] === "string") messages.push(current[key].slice(0, 4000));
      }
      const wait = Number(current.retryAfter || current.retry_after);
      if (Number.isFinite(wait) && wait > 0) retryAfter = wait;
      if (Array.isArray(current.errors)) {
        for (const error of current.errors.slice(0, 8)) {
          if (errors.length >= 12) break;
          if (!error || typeof error !== "object") continue;
          errors.push(error);
          if (typeof error.message === "string") messages.push(error.message.slice(0, 4000));
        }
      }
      if (entry.depth < 3) {
        for (const key of ["source", "response", "responseObject", "data"]) {
          pending.push({ value: current[key], depth: entry.depth + 1 });
        }
      }
    }
    return { status, retryAfter, errors, messages };
  }

  function diagnostic(value) {
    const facts = errorFacts(value);
    const first = facts.errors[0];
    const message = safeMessage(first?.message || facts.messages[0]);
    const code = safeMessage(first?.code ?? first?.extensions?.code ?? /\b(?:responded with error|error code)\s+(\d{3,12})\b/i.exec(message)?.[1], 80);
    return { adapterVersion,
      ...(stage === "discovery" ? { queryName, variableNames: variableNames.slice(0, 40),
        unsetVariableNames: unsetVariableNames.slice(0, 40), connectionPath: connectionPath.slice(),
        ...(queryShape || {}),
        ...(Number.isInteger(connectionMatchCount) ? { connectionMatchCount } : {}),
        ...(executionMethod ? { executionMethod } : {}) } : {}),
      ...(facts.status ? { httpStatus: facts.status } : {}),
      ...(code ? { serverCode: code } : {}),
      ...(message ? { serverMessage: message } : {}),
    };
  }

  function classify(value) {
    const facts = errorFacts(value);
    const status = facts.status;
    const text = facts.messages.join(" ").toLowerCase();
    const failure = (code, message, retryable = false, extra = {}) =>
      problem(code, message, retryable, { ...extra, diagnostic: diagnostic(value) });
    if (/challenge_required|checkpoint_required|checkpoint|challenge/.test(text)) {
      return failure("CHECKPOINT_REQUIRED", "Complete the account check in Instagram, then resume.");
    }
    if (status === 401 || /login_required|not logged in|login required/.test(text)) {
      return failure("LOGIN_REQUIRED", "Sign in to Instagram, then resume this profile.");
    }
    if (status === 429 || /rate.?limit|please wait a few minutes|too many requests/.test(text)) {
      const seconds = facts.retryAfter;
      return failure("RATE_LIMITED", "Instagram asked you to wait. Resume after the wait has ended.", false,
        Number.isFinite(seconds) && seconds > 0 ? { retryAfterMs: Math.min(seconds * 1000, 86400000) } : {});
    }
    if (status >= 500 || (!facts.errors.length && /failed to fetch|network request failed|\bnetworkerror\b|net::err_|\boffline\b|connection (?:refused|reset|timed out)|internet disconnected/.test(text))) {
      return failure("NETWORK_ERROR", status >= 500 ? "Instagram's server could not complete the request. Try again shortly." :
        "Instagram could not be reached. Check your connection, then retry.", true);
    }
    // "connection" is also part of the query and field names. RelayNetwork is
    // a wrapper for server query errors, not evidence of a transport failure.
    if (facts.errors.length || /relaynetwork|graphql|polarisprofilereelstabcontentquery/.test(text)) {
      return failure("QUERY_FAILED", "Instagram rejected the profile query. Export the report for its error details.");
    }
    if (status === 404 || /media.*not found|media.*unavailable|not found|not available/.test(text)) {
      return failure(stage === "resolve" ? "MEDIA_UNAVAILABLE" : "PROFILE_UNAVAILABLE",
        stage === "resolve" ? "This Reel is no longer available." : "This profile is unavailable to the current account.");
    }
    if (status >= 400) {
      return failure("REQUEST_REJECTED", "Instagram rejected this request. Export the report for its error details.");
    }
    return null;
  }

  async function bounded(work, cleanup) {
    const remaining = Math.min(12000, deadline - Date.now());
    if (remaining <= 0) throw problem("LOOKUP_TIMEOUT", "Instagram took too long to respond. Try again.", true);
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(work),
        new Promise((_, reject) => { timer = setTimeout(() => {
          try { cleanup?.(); } catch {}
          reject(problem("LOOKUP_TIMEOUT", "Instagram took too long to respond. Try again.", true));
        }, remaining); }),
      ]);
    } finally { clearTimeout(timer); }
  }

  function profileFromRecord(record, recordId = "") {
    if (!record || typeof record !== "object" || typeof record.username !== "string" ||
        record.username.toLowerCase() !== initialUsername.toLowerCase()) return null;
    const id = numericId(record.pk) || numericId(record.id) || /(?:XDTUserDict|IGUser|User):([1-9][0-9]{0,29})$/.exec(recordId)?.[1];
    return id ? { id, username: record.username } : null;
  }

  function pageProfile() {
    const environment = unwrap(module("PolarisRelayEnvironment"));
    try {
      const source = environment?.getStore?.().getSource?.();
      const ids = source?.getRecordIDs?.() || [];
      for (const id of ids.slice(0, 15000)) {
        const found = profileFromRecord(source.get(id), String(id));
        if (found) return found;
      }
    } catch {}
    let examined = 0;
    let totalText = 0;
    const scripts = Array.from(document.querySelectorAll('script[type="application/json"]')).slice(0, 80);
    for (const script of scripts) {
      const text = script.textContent || "";
      totalText += text.length;
      if (text.length > 2000000 || totalText > 6000000 || !text.toLowerCase().includes(initialUsername.toLowerCase())) continue;
      let data;
      try { data = JSON.parse(text); } catch { continue; }
      const stack = [data];
      while (stack.length && examined++ < 12000 && Date.now() < deadline) {
        const value = stack.pop();
        if (!value || typeof value !== "object") continue;
        const found = profileFromRecord(value);
        if (found) return found;
        for (const child of Object.values(value)) if (child && typeof child === "object") stack.push(child);
      }
    }
    return null;
  }

  async function identify(api) {
    let profile = pageProfile();
    if (!profile && typeof api?.apiGet === "function") {
      const response = await bounded(() => api.apiGet("/api/v1/users/web_profile_info/", { query: { username: initialUsername } }));
      const classified = classify(response);
      if (classified) throw classified;
      // PolarisInstapi wraps the body in .data; this endpoint's body may itself
      // contain {data:{user}}, unlike the media-info endpoint's top-level items.
      profile = profileFromRecord(response?.data?.data?.user || response?.data?.user || response?.user);
    }
    if (!profile) throw problem("PROFILE_UNAVAILABLE", "Could not identify this profile. Open its Reels tab and reload Instagram, then retry.");
    if (request.profile && (numericId(request.profile.id) !== profile.id ||
        request.profile.username?.toLowerCase() !== profile.username.toLowerCase())) {
      throw problem("PROFILE_CHANGED", "The profile identity changed. Start a new scan for this profile.");
    }
    return profile;
  }

  function pageItems(connection, profile) {
    if (!connection || !Array.isArray(connection.edges) || !connection.page_info ||
        typeof connection.page_info.has_next_page !== "boolean") {
      throw problem("SCHEMA_CHANGED", "Instagram's profile pagination changed. The scan is incomplete; no end of profile was assumed.");
    }
    const more = connection.page_info.has_next_page;
    const rawCursor = connection.page_info.end_cursor;
    if (more && (typeof rawCursor !== "string" || !rawCursor || rawCursor.length > 8192 || rawCursor === request.cursor)) {
      throw problem("PAGINATION_STALLED", "Instagram returned an invalid or repeated page cursor. The scan is incomplete.");
    }
    const items = [];
    const seen = new Set();
    for (const edge of connection.edges) {
      const media = edge?.node?.media;
      // The clips connection is the source of membership, including collaborations.
      // A changed edge shape must not be mistaken for an empty completed profile.
      if (!media || typeof media !== "object") throw problem("SCHEMA_CHANGED", "Instagram returned an unfamiliar Reel entry. The scan is incomplete.");
      const id = numericId(media.pk) || numericId(media.id);
      if (!id) throw problem("SCHEMA_CHANGED", "Instagram omitted a Reel ID. The scan is incomplete.");
      if (media.media_type === 1 || media.is_video === false) continue;
      const code = media.code || media.shortcode || codeForId(id);
      if (idForCode(code) !== id) throw problem("SCHEMA_CHANGED", "Instagram returned inconsistent Reel IDs. The scan is incomplete.");
      if (seen.has(id)) continue;
      seen.add(id);
      const thumbnail = bestCandidate(media.image_versions2?.candidates)?.url || mediaUrl(media.display_url);
      items.push({ mediaId: id, shortcode: code,
        username: typeof media.user?.username === "string" ? media.user.username.slice(0, 64) : profile.username,
        ...(thumbnail ? { thumbnailUrl: thumbnail } : {}) });
    }
    return { items, nextCursor: more ? rawCursor : null, hasMore: more };
  }

  function connectionSelections(selections, variables) {
    const matches = new Map();
    let examined = 0;
    function visit(values, ancestors) {
      if (!Array.isArray(values) || ancestors.length >= 8) return;
      for (const selection of values) {
        if (++examined > 2000) throw problem("SCHEMA_CHANGED", "Instagram's profile query is too complex to inspect safely.");
        if (selection?.kind === "LinkedField" && !selection.plural) {
          const key = selection.alias || selection.name;
          if (typeof key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(key)) continue;
          const path = [...ancestors.map(field => field.alias || field.name), key];
          const owner = ancestors[ancestors.length - 1];
          const profileClips = selection.name === "clips_connection" && owner?.name === "fetch__XDTUserDict" &&
            owner.concreteType === "XDTUserDict" && owner.args?.some(argument => argument.name === "id" && argument.kind === "Variable");
          if (selection.name === connectionName || profileClips) matches.set(JSON.stringify(path), { path, ancestors, field: selection });
          else visit(selection.selections, [...ancestors, selection]);
        } else if (["InlineFragment", "Condition", "Defer", "Stream"].includes(selection?.kind)) {
          if (selection.kind === "Condition" && typeof variables[selection.condition] === "boolean" &&
              variables[selection.condition] !== selection.passingValue) continue;
          visit(selection.selections, ancestors);
        } else if (selection?.kind === "RequiredField") visit([selection.field], ancestors);
      }
    }
    visit(selections, []);
    return [...matches.values()];
  }

  function describeQuery(operation) {
    const kinds = new Set();
    const fields = new Set();
    const fragments = new Set();
    const pending = [operation];
    const seen = new Set();
    const identifier = value => typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,199}$/.test(value);
    while (pending.length && seen.size < 2000) {
      const value = pending.pop();
      if (!value || typeof value !== "object" || seen.has(value)) continue;
      seen.add(value);
      if (identifier(value.kind) && kinds.size < 60) kinds.add(value.kind);
      if (value.kind === "LinkedField" && identifier(value.name) && fields.size < 60) fields.add(value.name);
      if (value.kind === "FragmentSpread" && identifier(value.name) && fragments.size < 60) fragments.add(value.name);
      if (value.fragment && identifier(value.fragment.name) && fragments.size < 60) fragments.add(value.fragment.name);
      // Only static descriptor children are inspected. Values, defaults,
      // provider modules, store records, and request data are never copied.
      if (Array.isArray(value.selections)) pending.push(...value.selections.slice(0, Math.max(0, 2000 - pending.length)).reverse());
      for (const key of ["fragment", "field", "linkedField", "backingField"]) {
        if (value[key] && typeof value[key] === "object") pending.push(value[key]);
      }
    }
    return { selectionKinds: [...kinds], fieldNames: [...fields], fragmentNames: [...fragments] };
  }

  function storedGraphId(environment, profile) {
    try {
      const source = environment.getStore?.().getSource?.();
      for (const key of (source?.getRecordIDs?.() || []).slice(0, 15000)) {
        const record = source.get(key);
        if (profileFromRecord(record, String(key))?.id !== profile.id) continue;
        // GraphQL's Node identifier is the selected id field. A normalized
        // record key or the API's numeric pk is not an interchangeable value.
        const id = record.id;
        if (typeof id === "string" && id.length > 0 && id.length <= 512 && !/\s/.test(id)) return id;
        if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) return String(id);
      }
    } catch {}
    return null;
  }

  function selectedIdKeys(selections) {
    const keys = new Set(["id"]);
    const pending = Array.isArray(selections) ? selections.slice(0, 2000) : [];
    let examined = 0;
    while (pending.length && examined++ < 2000) {
      const selection = pending.pop();
      if (selection?.kind === "ScalarField" && selection.name === "id") keys.add(selection.alias || "id");
      // Only wrappers describe the same object; a linked child's id belongs to
      // a different object and must not be compared with the profile's id.
      else if (["InlineFragment", "Condition", "Defer", "Stream"].includes(selection?.kind) && Array.isArray(selection.selections)) {
        pending.push(...selection.selections.slice(0, 2000 - examined));
      } else if (selection?.kind === "RequiredField") pending.push(selection.field);
    }
    return [...keys];
  }

  function unmaskedQuery(query, contract) {
    const scalar = name => ({ kind: "ScalarField", name, alias: null, args: null, storageKey: null });
    const linked = (name, selections, plural = false) => ({ kind: "LinkedField", name, alias: null,
      args: null, concreteType: null, plural, selections, storageKey: null });
    let selection = { ...contract.field, selections: [
      linked("edges", [linked("node", [linked("media", ["pk", "id", "code", "media_type"].map(scalar))])], true),
      linked("page_info", [scalar("end_cursor"), scalar("has_next_page")]),
    ] };
    for (const parent of contract.ancestors.slice().reverse()) {
      const ids = selectedIdKeys(parent.selections).map(key => ({ ...scalar("id"), alias: key === "id" ? null : key }));
      selection = { ...parent, selections: [...ids, selection] };
    }
    // Preserve the real persisted request and normalization operation. Only
    // the local reader changes, so fetchQuery's internal factory still owns
    // providers, network execution, and cache normalization. Read the raw
    // connection field instead of the connection handle that merges pages.
    return { ...query, fragment: { ...query.fragment, kind: "Fragment", selections: [selection] } };
  }

  async function discover(profile) {
    const query = unwrap(module(`${queryName}.graphql`));
    const environment = unwrap(module("PolarisRelayEnvironment"));
    const relay = unwrap(module("CometRelay"));
    if (!query?.params?.id || !environment) {
      throw problem("ADAPTER_UNAVAILABLE", "Open this profile's Reels tab and reload Instagram, then retry. Its current Reels query is not available yet.");
    }
    queryShape = describeQuery(query.operation);
    const variables = {};
    const definitions = [...(query.operation?.argumentDefinitions || []), ...(query.fragment?.argumentDefinitions || [])];
    for (const definition of definitions) {
      if (definition.kind === "LocalArgument" && definition.defaultValue !== undefined && !Object.hasOwn(variables, definition.name)) {
        variables[definition.name] = definition.defaultValue;
      }
    }
    const declared = new Set(definitions.filter(definition => definition.kind === "LocalArgument").map(definition => definition.name));
    variableNames = [...declared].filter(name => /^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(name)).slice(0, 40);
    unsetVariableNames = variableNames.filter(name => variables[name] == null && !Object.hasOwn(query.params.providedVariables || {}, name));
    // Provided-variable defaults are placeholders; Relay's operation factory
    // evaluates their providers. Do not use those placeholders for conditions.
    const conditionVariables = { ...variables };
    for (const name of Object.keys(query.params.providedVariables || {})) delete conditionVariables[name];
    const paths = connectionSelections(query.operation?.selections, conditionVariables);
    connectionMatchCount = paths.length;
    let contract;
    if (Array.isArray(query.operation?.selections)) {
      if (paths.length !== 1) throw problem("SCHEMA_CHANGED", "Instagram's profile query has an unfamiliar or ambiguous Reels path. The scan is incomplete.");
      contract = paths[0];
    } else {
      // Older expanded query descriptors expose the connection directly.
      contract = { path: [connectionName], ancestors: [] };
    }
    connectionPath = contract.path;
    const nodeOwner = contract.ancestors.find(field => (field.name === "node" ||
      (field.name === "fetch__XDTUserDict" && field.concreteType === "XDTUserDict")) &&
      field.args?.some(argument => argument.name === "id" && argument.kind === "Variable"));
    const nodeArgument = nodeOwner?.args.find(argument => argument.name === "id" && argument.kind === "Variable");
    let graphId;
    if (nodeArgument) {
      graphId = storedGraphId(environment, profile);
      if (!graphId || !declared.has(nodeArgument.variableName)) {
        throw problem("ADAPTER_UNAVAILABLE", "Instagram's profile identifier is not available yet. Reload the profile's Reels tab and retry.");
      }
      variables[nodeArgument.variableName] = graphId;
    } else if (declared.has("id")) variables.id = profile.id;
    if (declared.has("first")) variables.first = 12;
    if (definitions.some(definition => definition.kind === "LocalArgument" && definition.name === "scale") &&
        !(typeof variables.scale === "number" && Number.isFinite(variables.scale) && variables.scale > 0)) {
      let scale;
      try { scale = unwrap(module("WebPixelRatio"))?.get?.(); } catch {}
      if (!(typeof scale === "number" && Number.isFinite(scale) && scale > 0)) scale = window.devicePixelRatio;
      variables.scale = typeof scale === "number" && Number.isFinite(scale) && scale > 0 ? scale : 1;
    }
    variables.data = { ...(variables.data && typeof variables.data === "object" ? variables.data : {}),
      include_feed_video: true, page_size: 12, target_user_id: profile.id };
    if (request.cursor) variables.after = request.cursor;
    else if (Object.hasOwn(variables, "after")) variables.after = null;
    variableNames = Object.keys(variables).filter(name => /^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(name)).slice(0, 40);
    unsetVariableNames = variableNames.filter(name => variables[name] == null && !Object.hasOwn(query.params.providedVariables || {}, name));
    const operationModule = unwrap(module("RelayModernOperationDescriptor"));
    const createOperation = typeof relay?.createOperationDescriptor === "function" ? relay.createOperationDescriptor : operationModule?.createOperationDescriptor;
    const rawExecution = typeof environment.execute === "function" && typeof createOperation === "function";
    const readablePaths = connectionSelections(query.fragment?.selections, conditionVariables);
    const readable = !Array.isArray(query.fragment?.selections) ? connectionPath.length === 1 :
      readablePaths.some(value => JSON.stringify(value.path) === JSON.stringify(connectionPath));
    const canUnmask = !!contract.field && query.fragment?.kind === "Fragment" && Array.isArray(query.fragment.argumentDefinitions);
    if (!rawExecution && ((!readable && !canUnmask) || typeof relay?.fetchQuery !== "function")) {
      throw problem("ADAPTER_UNAVAILABLE", "Instagram's profile query runtime is unavailable. Reload the Reels tab and retry.");
    }
    const readerQuery = !rawExecution && !readable ? unmaskedQuery(query, contract) : query;
    executionMethod = rawExecution ? "environment.execute" : "fetchQuery";
    let subscription;
    const response = await bounded(() => new Promise((resolve, reject) => {
      let latest;
      let finished = false;
      // fetchQuery reads the query's fragment snapshot, which can contain only
      // masked fragment references. execute emits the real response while still
      // using Instagram's Relay network, providers, and normalization.
      const observable = rawExecution ? environment.execute({ operation: createOperation(query, variables, { force: true }) }) :
        relay.fetchQuery(environment, readerQuery, variables, { fetchPolicy: "network-only", networkCacheConfig: { force: true } });
      if (typeof observable?.subscribe !== "function") {
        reject(problem("ADAPTER_UNAVAILABLE", "Instagram's profile query client is unavailable. Reload its Reels tab and retry."));
        return;
      }
      const cleanup = () => { try { subscription?.unsubscribe(); } catch {} };
      subscription = observable.subscribe({
        start(value) { subscription = value; },
        next(value) {
          if (finished) return;
          const classified = classify(value);
          if (classified) { finished = true; cleanup(); reject(classified); return; }
          if (rawExecution && (value?.path || value?.incremental || value?.label)) {
            finished = true; cleanup(); reject(problem("SCHEMA_CHANGED", "Instagram returned an unsupported incremental Reels response. The scan is incomplete.")); return;
          }
          if (rawExecution && !value?.data) return;
          latest = value;
        },
        error(error) {
          if (!finished) {
            finished = true;
            const classified = classify(error);
            reject(classified || error);
          }
        },
        complete() { if (!finished) { finished = true; resolve(latest); } },
      });
    }), () => { subscription?.unsubscribe?.(); });
    const data = response?.data || response;
    let connection = data;
    for (let index = 0; index < connectionPath.length; index++) {
      connection = connection?.[connectionPath[index]];
      if (nodeOwner && index === contract.ancestors.indexOf(nodeOwner)) {
        for (const key of selectedIdKeys(nodeOwner.selections)) {
          const returnedId = connection?.[key];
          if (returnedId != null && String(returnedId) !== graphId) throw problem("PROFILE_CHANGED", "Instagram returned a different profile. The scan is incomplete.");
        }
        if (connection?.pk != null && numericId(connection.pk) !== profile.id) throw problem("PROFILE_CHANGED", "Instagram returned a different profile. The scan is incomplete.");
        if (typeof connection?.username === "string" && connection.username.toLowerCase() !== profile.username.toLowerCase()) {
          throw problem("PROFILE_CHANGED", "Instagram returned a different profile. The scan is incomplete.");
        }
      }
    }
    return pageItems(connection, profile);
  }

  async function resolveMedia(api, profile) {
    const expectedId = numericId(request.item?.mediaId);
    const expectedCode = request.item?.shortcode;
    if (!expectedId || idForCode(expectedCode) !== expectedId) throw problem("INVALID_MEDIA", "This queued Reel's identity is invalid.");
    if (typeof api?.apiGet !== "function") throw problem("ADAPTER_UNAVAILABLE", "Instagram's media client is unavailable. Reload the profile and retry.");
    const response = await bounded(() => api.apiGet(`/api/v1/media/${expectedId}/info/`));
    const classified = classify(response);
    if (classified) throw classified;
    const items = response?.data?.items || response?.items;
    if (!Array.isArray(items)) throw problem("SCHEMA_CHANGED", "Instagram's media response changed. Pause and reload the profile before retrying.");
    const record = items.find(item => (numericId(item?.pk) || numericId(item?.id)) === expectedId);
    if (!record) {
      if (!items.length) throw problem("MEDIA_UNAVAILABLE", "This Reel is no longer available.");
      throw problem("MEDIA_MISMATCH", "Instagram returned a different Reel. The queued file was not downloaded.");
    }
    const code = record.code || record.shortcode || codeForId(expectedId);
    if (code !== expectedCode || idForCode(code) !== expectedId) throw problem("MEDIA_MISMATCH", "Instagram returned a different Reel. The queued file was not downloaded.");
    const video = bestCandidate(record.video_versions, true) || (mediaUrl(record.video_url, true) ? {
      url: mediaUrl(record.video_url, true), width: dimension(record.original_width || record.dimensions?.width),
      height: dimension(record.original_height || record.dimensions?.height),
    } : null);
    if (record.media_type === 1 || record.is_video === false || !video) throw problem("MEDIA_UNAVAILABLE", "This Reel has no supported progressive MP4 available.");
    const thumbnail = bestCandidate(record.image_versions2?.candidates)?.url || mediaUrl(record.display_url);
    return { shortcode: expectedCode, mediaId: expectedId, pageUrl: `https://www.instagram.com/reel/${expectedCode}/`,
      username: typeof record.user?.username === "string" ? record.user.username.slice(0, 64) : profile.username,
      width: video.width, height: video.height, url: video.url,
      ...(thumbnail ? { thumbnailUrl: thumbnail } : {}), source: adapterVersion };
  }

  const initialUsername = route();
  try {
    if (!initialUsername) throw problem("NOT_PROFILE", "Open an Instagram profile or its Reels tab to start bulk downloading.");
    if (!["identify", "page", "resolve"].includes(action)) throw problem("INVALID_REQUEST", "The profile request is invalid.");
    if (request.profile && (typeof request.profile.username !== "string" || request.profile.username.toLowerCase() !== initialUsername.toLowerCase() || !numericId(request.profile.id))) {
      throw problem("PROFILE_CHANGED", "Return to the original profile before continuing this batch.");
    }
    if (request.cursor !== undefined && request.cursor !== null && (typeof request.cursor !== "string" || request.cursor.length > 8192)) {
      throw problem("INVALID_CURSOR", "The profile page cursor is invalid. Start a new scan.");
    }
    const api = unwrap(module("PolarisInstapi"));
    let profile;
    if (action === "identify") profile = await identify(api);
    else {
      if (!request.profile) throw problem("INVALID_PROFILE", "Identify the profile before requesting its Reels.");
      const known = pageProfile();
      if (known && known.id !== numericId(request.profile.id)) throw problem("PROFILE_CHANGED", "The profile identity changed. Start a new scan.");
      profile = { id: numericId(request.profile.id), username: request.profile.username };
    }
    assertRoute();
    const result = action === "identify" ? {} : action === "page" ? { page: await discover(profile) } : { media: await resolveMedia(api, profile) };
    assertRoute();
    return { ok: true, profile, ...result, adapterVersion };
  } catch (cause) {
    let error = ownErrors.has(cause) ? cause : classify(cause);
    if (!error) error = problem("ADAPTER_ERROR", "Instagram's profile client could not complete this request. Reload the Reels tab and retry.");
    if (initialUsername && route()?.toLowerCase() !== initialUsername.toLowerCase()) error = problem("PROFILE_CHANGED", "The profile changed. Return to the original profile before continuing.");
    return { ok: false, error: { code: error.code, message: error.message, stage, retryable: !!error.retryable,
      ...(Number.isFinite(error.retryAfterMs) ? { retryAfterMs: error.retryAfterMs } : {}),
      diagnostic: error.diagnostic || diagnostic(cause) } };
  }
}
