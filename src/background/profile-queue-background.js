import "../shared/download-limits.js";
import "../shared/profile-queue-config.js";
import { profileSource } from "../instagram/profile-source.js";
import { queueStore } from "./profile-queue-store.js";
import { getQueueRecovery, reconcileQueue } from "./profile-queue-recovery.js";
import { withJobRegistration, startQueueChild, rebindQueueChild, handleBulkMessage, interruptQueueChild } from "./bulk-background.js";
import { QUEUE_OWNER, MUTATION_OWNER, BULK_ACTIVE, readQueueOwner, readMutationOwner, queueProblem as problem } from "./profile-queue-owner.js";

const config = globalThis.ReelNestProfileQueueConfig;
const DRAFT = "reelnest:queue-draft:v1";
const actions = new Set(["DRAFT_GET", "DRAFT_SET", "LATEST", "START", "ENTRY_START", "PROGRESS", "ENTRY_FINISH",
  "PAUSE", "RESUME", "SKIP", "STOP", "SHOW_SOURCE", "REPORT", "RETRY", "LEASE_BEGIN", "LEASE_END", "RECOVERY_INFO", "RECONCILE"].map(action => `REEL_SAVER_QUEUE_${action}`));
const terminals = new Set(["completed", "completed_with_errors", "stopped", "interrupted"]);
const MAX_SOURCE_WAIT_MS = 86_400_000;
const boundedWait = value => Number.isFinite(value) && value > 0 ? Math.min(Math.ceil(value), MAX_SOURCE_WAIT_MS) : null;
const preparing = new Map();
let ownerTail = Promise.resolve();
export const isProfileQueueMessage = value => actions.has(value?.type);

function context(sender) {
  let url;
  try { url = new URL(sender?.url); } catch {}
  if (sender?.id !== chrome.runtime.id || sender.frameId !== 0 || !Number.isInteger(sender.tab?.id) ||
      !sender.documentId || !url || url.protocol !== "https:" || url.port || url.username || url.password ||
      !["www.instagram.com", "instagram.com"].includes(url.hostname) || sender.tab.url !== sender.url) {
    throw problem("INVALID_SENDER", "Open the profile queue in the Instagram tab that controls this run.");
  }
  return { tabId: sender.tab.id, documentId: sender.documentId, url: sender.url };
}

async function ownerMutation(action) {
  const before = ownerTail; let release;
  ownerTail = new Promise(resolve => { release = resolve; });
  await before;
  try { return await action(); } finally { release(); }
}

async function writeOwner(owner) {
  try { await chrome.storage.session.set({ [QUEUE_OWNER]: owner }); }
  catch { throw problem("STORAGE_FAILED", "The queue's tab ownership could not be recorded. Retry before continuing."); }
  return owner;
}
async function saveOwner(owner, { replace = false } = {}) {
  return ownerMutation(async () => {
    const previous = await readQueueOwner();
    if (previous && ((!replace && previous.runId !== owner.runId) ||
        previous.runId === owner.runId && previous.epoch > owner.epoch)) {
      throw problem("STALE_JOB", "A newer queue command replaced this source operation.");
    }
    return writeOwner(owner);
  });
}

async function current(ctx, runId, { inactive = false } = {}) {
  const owner = await readQueueOwner();
  if (!owner || owner.runId !== runId || owner.tabId !== ctx.tabId || owner.documentId !== ctx.documentId || !inactive && !owner.active) {
    throw problem("STALE_JOB", "This queue belongs to another tab or an older page. Its saved results are still available.");
  }
  return owner;
}

async function sameGeneration(ctx, captured) {
  const owner = await current(ctx, captured.runId);
  if (owner.epoch !== captured.epoch || owner.entryId !== captured.entryId || owner.control !== "running") {
    throw problem("QUEUE_PAUSED", "The queue paused before another profile could start.");
  }
  return owner;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function failedItems(runId, entryId) {
  const items = []; let offset = 0;
  do {
    const page = await queueStore.getItems(runId, entryId, { states: ["failed"], offset, limit: 1000 });
    items.push(...page.items); offset = page.nextOffset;
  } while (offset !== null);
  return items;
}
function probeSource() {
  const match = /^\/([A-Za-z0-9._]{1,30})\/reels\/?$/.exec(location.pathname);
  let query = false;
  try { query = !!window.require?.("PolarisProfileReelsTabContentQuery_connection.graphql"); } catch {}
  return { username: match?.[1] || null, ready: !!match && query && document.readyState !== "loading" };
}

async function prepareSource(ctx, captured, entry) {
  const url = `https://www.instagram.com/${entry.username}/reels/`;
  let tab = captured.sourceTabId == null ? null : await chrome.tabs.get(captured.sourceTabId).catch(() => null);
  let owner = await sameGeneration(ctx, captured);
  await saveOwner({ ...owner, navigating: true, sourceDocumentId: null });
  if (!tab) {
    tab = await chrome.tabs.create({ url, active: false, openerTabId: ctx.tabId });
    try { owner = await sameGeneration(ctx, captured); }
    catch (error) { await chrome.tabs.remove(tab.id).catch(() => {}); throw error; }
    await saveOwner({ ...owner, navigating: true, sourceTabId: tab.id, sourceDocumentId: null, sourcePreviousAutoDiscardable: tab.autoDiscardable, sourcePreviousMuted: tab.mutedInfo?.muted });
  } else {
    await chrome.tabs.update(tab.id, { url, active: false });
  }
  await chrome.tabs.update(tab.id, { autoDiscardable: false, muted: true }).catch(() => {});
  const deadline = Date.now() + 30_000;
  let documentId;
  while (Date.now() < deadline) {
    await sameGeneration(ctx, captured);
    const sourceTab = await chrome.tabs.get(tab.id).catch(() => null);
    if (!sourceTab) throw problem("SOURCE_CHANGED", "The source tab closed. Resume to reopen it.");
    if (sourceTab.status !== "loading") {
      let frames;
      try { frames = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: probeSource }); } catch {}
      const frame = frames?.find(value => value.frameId === 0);
      if (frame?.result?.ready && frame.result.username?.toLowerCase() === entry.username.toLowerCase() && typeof frame.documentId === "string") {
        documentId = frame.documentId; break;
      }
    }
    await sleep(350);
  }
  if (!documentId) throw problem("ADAPTER_UNAVAILABLE", "The background profile is not ready. Show source tab, allow Instagram to load, then retry.");
  owner = await sameGeneration(ctx, captured);
  await saveOwner({ ...owner, sourceTabId: tab.id, sourceDocumentId: documentId, navigating: false });
  const frames = await chrome.scripting.executeScript({ target: { tabId: tab.id, documentIds: [documentId] }, world: "MAIN", func: profileSource, args: [{ action: "identify" }] });
  const result = frames.find(value => value.frameId === 0)?.result;
  await sameGeneration(ctx, captured);
  if (!result?.ok) {
    const error = problem(result?.error?.code || "PROFILE_UNAVAILABLE", result?.error?.message || "Instagram could not identify this profile.");
    const wait = boundedWait(result?.error?.retryAfterMs);
    if (wait !== null) Object.assign(error, { retryAfterMs: wait, retryAt: Date.now() + wait });
    throw error;
  }
  const profile = result.profile;
  if (!profile || !/^[1-9][0-9]{0,29}$/.test(profile.id) || profile.username?.toLowerCase() !== entry.username.toLowerCase()) {
    throw problem("PROFILE_CHANGED", "Instagram returned a different profile. Review this entry before continuing.");
  }
  if (entry.profile && entry.profile.id !== profile.id) throw problem("PROFILE_CHANGED", "This username now belongs to a different account. Skip it and review the saved profile list.");
  return { profile, sourceTabId: tab.id, sourceDocumentId: documentId };
}

async function closeSource(owner) {
  if (owner?.sourceTabId != null) {
    const tab = await chrome.tabs.get(owner.sourceTabId).catch(() => null);
    if (tab) {
      if (typeof owner.sourcePreviousAutoDiscardable === "boolean") await chrome.tabs.update(tab.id, { autoDiscardable: owner.sourcePreviousAutoDiscardable }).catch(() => {});
      if (typeof owner.sourcePreviousMuted === "boolean") await chrome.tabs.update(tab.id, { muted: owner.sourcePreviousMuted }).catch(() => {});
      let managed = false;
      try { const url = new URL(tab.url); managed = url.origin === "https://www.instagram.com" && /^\/[A-Za-z0-9._]{1,30}\/reels\/?$/.test(url.pathname); } catch {}
      if (managed && !owner.sourceLost) await chrome.tabs.remove(tab.id).catch(() => {});
    }
  }
  if (typeof owner?.hostPreviousAutoDiscardable === "boolean") await chrome.tabs.update(owner.tabId, { autoDiscardable: owner.hostPreviousAutoDiscardable }).catch(() => {});
}

async function finishRun(ctx, run, reason, state) {
  if (run.reservation) throw problem("RECONCILIATION_REQUIRED", "Record the current video's outcome before releasing the queue.");
  for (const entry of run.entries) {
    if (entry.state === "pending") await queueStore.updateEntry(run.id, entry.id, { state: "not_run", completionReason: reason });
  }
  const next = await queueStore.updateRun(run.id, { state: state || (run.entries.some(e => e.state === "completed_with_errors") ? "completed_with_errors" : "completed"), completionReason: reason, endedAt: Date.now() });
  const owner = await current(ctx, run.id, { inactive: true });
  await saveOwner({ ...owner, active: false, control: "stopped", epoch: owner.epoch + 1 });
  await closeSource(owner);
  return next;
}

async function advance(ctx, run) {
  if (run.draft.totalLimit != null && run.committedNewSaves >= run.draft.totalLimit) return finishRun(ctx, run, "queue_limit_reached");
  const index = run.entries.findIndex((entry, i) => i > run.currentIndex && entry.state === "pending");
  if (index < 0) return finishRun(ctx, run, "feed_exhausted");
  return queueStore.updateRun(run.id, { currentIndex: index });
}

async function start(ctx, message) {
  return withJobRegistration(async () => {
    const activeOwner = await readQueueOwner();
    if (activeOwner?.active || await readMutationOwner()) throw problem("QUEUE_BUSY", "Finish the active download or library operation first.");
    const bulk = (await chrome.storage.session.get(BULK_ACTIVE))[BULK_ACTIVE];
    if (bulk?.active || bulk?.reservationMediaId) throw problem("JOB_BUSY", "Stop and release the current profile download first.");
    if ((await chrome.downloads.search({ state: "in_progress", limit: 100 })).some(download => download.byExtensionId === chrome.runtime.id)) throw problem("JOB_BUSY", "Wait for the current Chrome download to finish before starting the queue.");
    const draft = config.normalizeDraft(message.draft);
    if (!draft.entries.length) throw problem("INVALID_QUEUE", "Add at least one Instagram profile.");
    if (!["folder", "downloads"].includes(message.options?.destination) || typeof message.options?.skipExisting !== "boolean") throw problem("INVALID_DESTINATION", "Choose a Library folder or Browser Downloads.");
    config.normalizeProfileInput(ctx.url);
    const tab = await chrome.tabs.get(ctx.tabId);
    const run = await queueStore.create(draft, message.options);
    try {
      await saveOwner({ runId: run.id, tabId: ctx.tabId, documentId: ctx.documentId, hostUrl: ctx.url, active: true,
        control: "running", epoch: 1, generation: 0, childJobId: null, entryId: null, sourceTabId: null,
        sourceDocumentId: null, hostPreviousAutoDiscardable: tab.autoDiscardable }, { replace: true });
      await chrome.tabs.update(ctx.tabId, { autoDiscardable: false }).catch(() => {});
    } catch (error) { await queueStore.updateRun(run.id, { state: "interrupted", error: { code: error.code, message: error.message } }); throw error; }
    return { ok: true, run };
  });
}

async function pauseSourcePreparation(run, entry, captured, error) {
  const latest = await readQueueOwner();
  if (latest?.runId !== run.id || latest.epoch !== captured.epoch || !latest.active || latest.control !== "running") return;
  const wait = boundedWait(error.retryAfterMs);
  const details = { code: error.code || "SOURCE_UNAVAILABLE", message: error.message,
    ...(wait !== null ? { retryAfterMs: wait, retryAt: error.retryAt } : {}) };
  await saveOwner({ ...latest, control: "paused", navigating: false });
  await queueStore.updateEntry(run.id, entry.id, { state: "needs_attention", error: details });
  await queueStore.updateRun(run.id, { state: "paused", error: details });
}

async function entryStart(ctx, message) {
  const observed = await current(ctx, message.runId);
  if (observed.control !== "running") throw problem("QUEUE_PAUSED", "Resume the queue before starting another profile.");
  const existingRun = await queueStore.getRun(message.runId);
  const existingEntry = existingRun.entries[existingRun.currentIndex];
  if (existingEntry?.id === message.entryId && existingEntry.childJobId === observed.childJobId && observed.childJobId) {
    const child = (await chrome.storage.session.get(BULK_ACTIVE))[BULK_ACTIVE];
    if (child?.jobId === observed.childJobId && child.active) {
      return { ok: true, run: existingRun, job: { jobId: child.jobId, profile: child.profile, options: child.options, queue: child.queue,
        ...(observed.retryPass ? { retryItems: await failedItems(existingRun.id, existingEntry.id) } : {}) } };
    }
  }
  if (preparing.has(message.runId)) {
    const previous = preparing.get(message.runId);
    if (previous.epoch === observed.epoch) return previous.promise;
    await previous.promise.catch(() => {});
  }
  const promise = (async () => {
    let run = await queueStore.getRun(message.runId);
    const entry = run.entries[run.currentIndex];
    if (!entry || entry.id !== message.entryId || !["pending", "paused", "needs_attention"].includes(entry.state)) throw problem("STALE_JOB", "This is not the queue's next profile.");
    const captured = await ownerMutation(async () => {
      const owner = await current(ctx, run.id);
      if (owner.control !== "running") throw problem("QUEUE_PAUSED", "Resume the queue first.");
      return writeOwner({ ...owner, entryId: entry.id, childJobId: null, generation: owner.generation + 1 });
    });
    try {
      const source = await prepareSource(ctx, captured, entry);
      await sameGeneration(ctx, captured);
      if (run.entries.some(previous => previous.id !== entry.id && previous.profile?.id === source.profile.id && previous.state !== "pending")) {
        await queueStore.updateEntry(run.id, entry.id, { profile: source.profile, state: "duplicate", completionReason: "duplicate_profile" });
        return { ok: true, duplicate: true, run: await advance(ctx, await queueStore.getRun(run.id)) };
      }
      const profileRemaining = entry.effectiveLimit == null ? Infinity : Math.max(0, entry.effectiveLimit - entry.committedNewSaves);
      const queueRemaining = run.draft.totalLimit == null ? Infinity : Math.max(0, run.draft.totalLimit - run.committedNewSaves);
      const budget = Math.min(profileRemaining, queueRemaining);
      if (!budget) return { ok: true, run: await finishRun(ctx, run, "queue_limit_reached") };
      const jobId = crypto.randomUUID();
      const owner = await sameGeneration(ctx, captured);
      await saveOwner({ ...owner, ...source, profile: undefined, childJobId: jobId, sourceLost: false });
      run = await queueStore.updateEntry(run.id, entry.id, { profile: source.profile, childJobId: jobId, state: "running", error: null, startedAt: entry.startedAt || Date.now() });
      const retryItems = owner.retryPass ? await failedItems(run.id, entry.id) : undefined;
      const job = await startQueueChild(ctx, { jobId, profile: source.profile,
        options: { mode: "batches", batchSize: run.draft.batchSize, destination: run.options.destination, skipExisting: run.options.skipExisting, maxNewVideos: Number.isFinite(budget) ? budget : null },
        queue: { runId: run.id, entryId: entry.id, generation: owner.generation, sourceTabId: source.sourceTabId, sourceDocumentId: source.sourceDocumentId }, retryItems });
      return { ok: true, run, job };
    } catch (error) {
      await pauseSourcePreparation(run, entry, captured, error);
      throw error;
    }
  })();
  preparing.set(message.runId, { epoch: observed.epoch, promise });
  try { return await promise; } finally { if (preparing.get(message.runId)?.promise === promise) preparing.delete(message.runId); }
}

async function progress(ctx, message) {
  const owner = await current(ctx, message.runId, { inactive: true });
  const run = await queueStore.getRun(message.runId);
  const entry = run.entries.find(value => value.id === message.entryId);
  if (entry?.childJobId === message.jobId && ["completed", "completed_with_errors", "skipped", "stopped"].includes(entry.state)) return { ok: true, run };
  if (owner.entryId !== message.entryId || owner.childJobId !== message.jobId) throw problem("STALE_JOB", "This progress belongs to an older profile.");
  const snapshot = message.snapshot;
  if (!snapshot || snapshot.jobId !== message.jobId || !Array.isArray(snapshot.items) || snapshot.items.length > 50_000) throw problem("INVALID_RESULT", "The profile progress is invalid.");
  await queueStore.recordItems(message.runId, message.entryId, snapshot.items);
  const updated = await queueStore.updateEntry(message.runId, message.entryId, { phase: snapshot.phase,
    sourceExhausted: owner.retryPass ? entry.sourceExhausted : snapshot.sourceExhausted === true });
  return { ok: true, run: updated };
}

async function finishEntry(ctx, message, reason) {
  const owner = await current(ctx, message.runId, { inactive: true });
  const previousRun = await queueStore.getRun(message.runId);
  const previousEntry = previousRun.entries.find(value => value.id === message.entryId);
  if (previousEntry?.childJobId === message.jobId && ["completed", "completed_with_errors", "skipped", "stopped"].includes(previousEntry.state)) {
    if (previousRun.entries[previousRun.currentIndex]?.id !== previousEntry.id || !owner.active) return { ok: true, run: previousRun };
    await saveOwner({ ...owner, childJobId: null });
    return { ok: true, run: terminals.has(previousRun.state)
      ? await finishRun(ctx, previousRun, previousRun.completionReason || "feed_exhausted", previousRun.state)
      : await advance(ctx, previousRun) };
  }
  if (owner.entryId !== message.entryId || owner.childJobId !== message.jobId) throw problem("STALE_JOB", "This profile has already been released.");
  const bulk = (await chrome.storage.session.get(BULK_ACTIVE))[BULK_ACTIVE];
  if (bulk?.jobId === message.jobId && (bulk.active || bulk.reservationMediaId)) throw problem("RECONCILIATION_REQUIRED", "Release the current profile and record its saved files before advancing.");
  const summary = message.summary || {};
  const snapshotReason = previousRun.draft.totalLimit != null && previousRun.committedNewSaves >= previousRun.draft.totalLimit
    ? "queue_limit_reached" : reason || summary.completionReason || "feed_exhausted";
  const run = await queueStore.finishEntry(message.runId, message.entryId, { state: reason === "user_skipped" ? "skipped" : summary.state === "completed_with_errors" ? "completed_with_errors" : "completed",
    completionReason: snapshotReason, sourceExhausted: owner.retryPass ? previousEntry.sourceExhausted : summary.sourceExhausted === true, endedAt: Date.now() });
  await saveOwner({ ...owner, childJobId: null });
  return { ok: true, run: await advance(ctx, run) };
}

async function control(ctx, message, action, sender) {
  const initial = await current(ctx, message.runId, { inactive: true });
  const before = await queueStore.getRun(message.runId);
  if (action === "RESUME") {
    const now = Date.now();
    const retryAt = Math.max(...[before.error?.retryAt, before.entries[before.currentIndex]?.error?.retryAt]
      .map(value => Number.isSafeInteger(value) && value > 0 ? value : 0));
    if (retryAt > now) throw Object.assign(problem("RATE_LIMITED", "Instagram asked you to wait. Resume after the wait has ended."),
      { retryAt, retryAfterMs: Math.min(retryAt - now, MAX_SOURCE_WAIT_MS) });
  }
  if (action === "STOP" && !initial.active && terminals.has(before.state)) return { ok: true, run: before };
  if (action === "SKIP" && message.entryId && before.entries[before.currentIndex]?.id !== message.entryId) return { ok: true, run: before };
  if (action === "SKIP" && before.entries[before.currentIndex]?.state === "skipped") {
    if (!initial.active) return { ok: true, run: before };
    await saveOwner({ ...initial, childJobId: null, control: "running" });
    const repaired = await queueStore.updateRun(before.id, { state: "running" });
    return { ok: true, run: await advance(ctx, repaired) };
  }
  let owner = await ownerMutation(async () => {
    const old = await current(ctx, message.runId);
    return writeOwner({ ...old, control: action === "RESUME" ? "running" : action === "PAUSE" ? "paused" : "stopping", epoch: old.epoch + 1 });
  });
  let run = await queueStore.getRun(message.runId);
  if (action === "PAUSE") return { ok: true, run: await queueStore.updateRun(run.id, { state: "paused" }) };
  if (action === "RESUME") {
    if (owner.sourceLost && owner.childJobId) {
      const entry = run.entries[run.currentIndex];
      try {
        const source = await prepareSource(ctx, owner, entry);
        owner = await current(ctx, run.id);
        await saveOwner({ ...owner, ...source, profile: undefined, sourceLost: false });
        await rebindQueueChild(ctx, owner.childJobId, { runId: run.id, entryId: entry.id, generation: owner.generation, ...source, profile: undefined });
        await queueStore.updateEntry(run.id, entry.id, { state: "running", error: null });
      } catch (error) {
        await pauseSourcePreparation(run, entry, owner, error);
        throw error;
      }
    }
    return { ok: true, run: await queueStore.updateRun(run.id, { state: "running", error: null }) };
  }
  if (owner.childJobId) {
    const bulk = (await chrome.storage.session.get(BULK_ACTIVE))[BULK_ACTIVE];
    if (bulk?.jobId === owner.childJobId && bulk.active) {
      const released = await handleBulkMessage({ type: "REEL_SAVER_BULK_END", jobId: owner.childJobId, state: "stopped" }, sender);
      if (!released.ok) throw problem(released.error.code, released.error.message);
    }
  }
  run = await queueStore.getRun(run.id);
  if (run.reservation) throw problem("RECONCILIATION_REQUIRED", "A saved file or interrupted transfer still needs its history recorded.");
  if (action === "STOP") {
    const entry = run.entries[run.currentIndex];
    if (entry && ["running", "needs_attention", "paused"].includes(entry.state)) await queueStore.finishEntry(run.id, entry.id, { state: "stopped", completionReason: "user_stopped", sourceExhausted: owner.retryPass ? entry.sourceExhausted : message.summary?.sourceExhausted === true });
    return { ok: true, run: await finishRun(ctx, await queueStore.getRun(run.id), "user_stopped", "stopped") };
  }
  if (action === "SKIP") {
    const entry = run.entries[run.currentIndex];
    if (message.entryId && message.entryId !== entry?.id) return { ok: true, run };
    await queueStore.finishEntry(run.id, entry.id, { state: "skipped", completionReason: "user_skipped", sourceExhausted: owner.retryPass ? entry.sourceExhausted : message.summary?.sourceExhausted === true });
    owner = await current(ctx, run.id);
    await saveOwner({ ...owner, childJobId: null, control: "running" });
    await queueStore.updateRun(run.id, { state: "running" });
    return { ok: true, run: await advance(ctx, await queueStore.getRun(run.id)) };
  }
}

export async function cleanupMutationLease(tabId) {
  await withJobRegistration(async () => {
    const lease = await readMutationOwner();
    if (lease?.tabId !== tabId) return;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const frames = tab ? await chrome.scripting.executeScript({ target: { tabId }, func: () => true }).catch(() => []) : [];
    if (!tab || frames.find(frame => frame.frameId === 0)?.documentId !== lease.documentId) await chrome.storage.session.remove(MUTATION_OWNER);
  });
}

export async function cleanupProfileQueueTab(tabId, change = {}) {
  await cleanupMutationLease(tabId);
  const owner = await readQueueOwner();
  if (!owner?.active) return;
  if (tabId === owner.tabId) {
    await saveOwner({ ...owner, active: false, control: "stopped", epoch: owner.epoch + 1 });
    if (owner.childJobId) await interruptQueueChild(owner.childJobId);
    await queueStore.updateRun(owner.runId, { state: "interrupted", completionReason: "host_lost", endedAt: Date.now() });
    await closeSource(owner);
  } else if (tabId === owner.sourceTabId && !owner.navigating) {
    await saveOwner({ ...owner, control: "paused", sourceLost: true, generation: owner.generation + 1, epoch: owner.epoch + 1 });
    const run = await queueStore.updateRun(owner.runId, { state: "paused", error: { code: "SOURCE_CHANGED", message: change.closed ? "The source tab closed. Resume to reopen it." : "The source tab changed. Return to the queue and Resume." } });
    await chrome.tabs.sendMessage?.(owner.tabId, { type: "REEL_SAVER_QUEUE_EVENT", run }, { documentId: owner.documentId }).catch(() => {});
  }
}

export async function handleProfileQueueMessage(message, sender) {
  if (!isProfileQueueMessage(message)) return undefined;
  try {
    const ctx = context(sender), action = message.type.slice("REEL_SAVER_QUEUE_".length);
    if (message.tabId !== undefined && message.tabId !== ctx.tabId) throw problem("INVALID_SENDER", "A queue can control only its registered tabs.");
    if (action === "DRAFT_GET") return { ok: true, draft: config.normalizeDraft((await chrome.storage.local.get(DRAFT))[DRAFT] || {}) };
    if (action === "DRAFT_SET") { const draft = config.normalizeDraft(message.draft); await chrome.storage.local.set({ [DRAFT]: draft }); return { ok: true, draft }; }
    if (action === "LATEST") {
      let run = await queueStore.getLatest();
      const owner = await readQueueOwner();
      if (run && !terminals.has(run.state) && (!owner?.active || owner.runId !== run.id)) run = await queueStore.updateRun(run.id, { state: "interrupted", completionReason: "host_lost", endedAt: Date.now() });
      return { ok: true, run, owned: !!owner?.active && owner.runId === run?.id && owner.tabId === ctx.tabId && owner.documentId === ctx.documentId };
    }
    if (action === "LEASE_BEGIN") return await withJobRegistration(async () => {
      if ((await readQueueOwner())?.active || await readMutationOwner()) throw problem("QUEUE_BUSY", "Finish the active queue or library operation first.");
      const bulk = (await chrome.storage.session.get(BULK_ACTIVE))[BULK_ACTIVE];
      const recovery = message.kind === "recovery" ? await getQueueRecovery(message.runId) : null;
      const ownInterrupted = recovery && recovery.entry.childJobId === bulk?.jobId && !bulk?.active;
      if ((bulk?.active || bulk?.reservationMediaId) && !ownInterrupted) throw problem("JOB_BUSY", "Finish the active profile download first.");
      if (!["single", "clear", "recovery"].includes(message.kind) || message.kind === "recovery" && !recovery) throw problem("INVALID_OPTIONS", "The library operation is invalid.");
      const leaseId = crypto.randomUUID();
      await chrome.storage.session.set({ [MUTATION_OWNER]: { leaseId, tabId: ctx.tabId, documentId: ctx.documentId, kind: message.kind, ...(recovery ? { runId: message.runId } : {}) } });
      return { ok: true, leaseId };
    });
    if (action === "LEASE_END") return await withJobRegistration(async () => {
      const lease = await readMutationOwner();
      if (lease && (lease.tabId !== ctx.tabId || lease.documentId !== ctx.documentId ||
          (message.leaseId ? lease.leaseId !== message.leaseId : lease.kind !== message.kind))) throw problem("INVALID_SENDER", "This operation belongs to another tab.");
      if (lease) await chrome.storage.session.remove(MUTATION_OWNER);
      return { ok: true };
    });
    if (action === "START") return await start(ctx, message);
    if (action === "RECOVERY_INFO") return { ok: true, recovery: await getQueueRecovery(message.runId) };
    if (action === "RECONCILE") {
      const lease = await readMutationOwner();
      if (lease?.kind !== "recovery" || lease.runId !== message.runId || lease.tabId !== ctx.tabId || lease.documentId !== ctx.documentId) throw problem("INVALID_SENDER", "Open the interrupted save's recovery from the current queue panel.");
      const run = await reconcileQueue(message.runId, { result: message.result });
      const bulk = (await chrome.storage.session.get(BULK_ACTIVE))[BULK_ACTIVE];
      if (!run.reservation && bulk?.queue?.runId === run.id && !bulk.active) await chrome.storage.session.set({ [BULK_ACTIVE]: { ...bulk, reservationMediaId: null } });
      return { ok: true, run };
    }
    if (action === "ENTRY_START") return await entryStart(ctx, message);
    if (action === "PROGRESS") return await progress(ctx, message);
    if (action === "ENTRY_FINISH") return await finishEntry(ctx, message);
    if (["PAUSE", "RESUME", "SKIP", "STOP"].includes(action)) return await control(ctx, message, action, sender);
    if (action === "SHOW_SOURCE") { const owner = await current(ctx, message.runId); if (owner.sourceTabId == null) throw problem("SOURCE_CHANGED", "No source tab is open yet."); await chrome.tabs.update(owner.sourceTabId, { active: true }); return { ok: true }; }
    if (action === "REPORT") { const latest = await queueStore.getLatest(); const id = message.runId || latest?.id; if (!id) throw problem("REPORT_MISSING", "There are no queue results yet."); return { ok: true, report: message.entryId ? await queueStore.getProfileReport(id, message.entryId) : await queueStore.getQueueReport(id) }; }
    if (action === "RETRY") return await withJobRegistration(async () => {
      const activeOwner = await readQueueOwner();
      const activeBulk = (await chrome.storage.session.get(BULK_ACTIVE))[BULK_ACTIVE];
      if (activeOwner?.active || activeBulk?.active || activeBulk?.reservationMediaId || await readMutationOwner()) throw problem("QUEUE_BUSY", "Finish the active download or library operation before retrying this queue.");
      const owner = await current(ctx, message.runId, { inactive: true });
      let run = await queueStore.getRun(message.runId);
      if (!terminals.has(run.state) || run.reservation || run.draft.totalLimit != null && run.committedNewSaves >= run.draft.totalLimit) throw problem("LIMIT_REACHED", "This queue cannot retry more videos. Start a new run to reset its allowance.");
      const retry = [];
      for (const entry of run.entries) {
        if ((entry.effectiveLimit == null || entry.committedNewSaves < entry.effectiveLimit) && (await queueStore.getItems(run.id, entry.id, { states: ["failed"], offset: 0, limit: 1 })).items.length) {
          await queueStore.updateEntry(run.id, entry.id, { state: "pending" }); retry.push(run.entries.indexOf(entry));
        }
      }
      if (!retry.length) throw problem("NO_FAILED_ITEMS", "No failed videos have remaining allowance.");
      await saveOwner({ ...owner, active: true, control: "running", childJobId: null, sourceTabId: null, sourceDocumentId: null, retryPass: true, epoch: owner.epoch + 1 });
      run = await queueStore.updateRun(run.id, { state: "running", currentIndex: retry[0], error: null });
      return { ok: true, run };
    });
  } catch (error) {
    return { ok: false, error: { code: error.code || "QUEUE_ERROR", message: error.message || "The profile queue could not continue.", stage: error.stage || "queue",
      ...(boundedWait(error.retryAfterMs) !== null ? { retryAfterMs: boundedWait(error.retryAfterMs) } : {}),
      ...(Number.isSafeInteger(error.retryAt) && error.retryAt > 0 ? { retryAt: error.retryAt } : {}) } };
  }
}
