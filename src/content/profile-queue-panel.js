// Queue controls live in the stable Instagram host. Folder capabilities never
// leave that document; the worker owns source navigation, identity and limits.
(() => {
  "use strict";
  if (globalThis.ReelNestProfileQueuePanel) return;
  const M = "REEL_SAVER_QUEUE_";
  const terminal = new Set(["completed", "completed_with_errors", "stopped", "interrupted"]);
  const labels = { pending: "Waiting", running: "Downloading", paused: "Paused", completed: "Finished",
    completed_with_errors: "Finished with errors", stopped: "Stopped", interrupted: "Interrupted",
    duplicate: "Duplicate profile", skipped: "Skipped", not_run: "Not run", needs_attention: "Needs attention" };
  const make = (tag, text, attributes = {}) => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    return node;
  };
  const asError = value => value?.message || "The profile queue could not continue.";
  const id = () => globalThis.crypto?.randomUUID?.() || `entry-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  function create({ root, request, readRoute, getDestination, getSkipExisting = () => true, isSingleBusy = () => false,
    onBusyChange = () => {}, onActivity, onLibraryDestination }) {
    const config = globalThis.ReelNestProfileQueueConfig;
    let draft = { schemaVersion: 1, batchSize: 35, defaultLimit: null, totalLimit: null, entries: [] };
    let run = null, runner = null, activeJob = null, activeEntry = null, destination = null;
    let loaded = false, loading = null, starting = false, ownsRun = false, pumping = null;
    let desired = null, controlPending = false, releaseError = null, progressError = null, pendingHandoff = null, startedHere = false, recoveryLease = null;
    let saveTail = Promise.resolve(), progressTail = Promise.resolve(), latestSnapshot = null;
    let progressTimer, gateResolve, hostUrl = null, navigating = false, sourceAttempt = 0;
    let defaultMode = "unlimited", defaultText = "", totalMode = "unlimited", totalText = "";
    let messageText = "Add profiles in the order you want to download them.", messageTone = "neutral";

    const section = make("section", "", { class: "profile-queue", "data-role": "profile-queue" });
    const heading = make("div", "", { class: "section-heading" });
    heading.append(make("h3", "Profile queue"), make("span", "ONE AT A TIME", { class: "badge" }));
    const inputLabel = make("label", "Profiles, one per line", { for: "reelnest-queue-input" });
    const input = make("textarea", "", { id: "reelnest-queue-input", "data-role": "queue-input", rows: "4", maxlength: "16000",
      placeholder: "@creator\nhttps://www.instagram.com/another_creator/reels/" });
    const add = make("button", "Add profiles", { type: "button", "data-role": "queue-add" });
    const addCurrent = make("button", "Add current profile", { type: "button", "data-role": "queue-add-current" });
    const addActions = make("div", "", { class: "queue-actions" }); addActions.append(add, addCurrent);
    const inputErrors = make("p", "", { class: "queue-errors", "data-role": "queue-input-errors", hidden: "", role: "status" });
    const draftList = make("ol", "", { class: "queue-draft", "data-role": "queue-draft", "aria-label": "Profiles in download order" });
    const empty = make("p", "No profiles added yet.", { class: "hint", "data-role": "queue-empty" });
    const settings = make("div", "", { class: "queue-settings" });
    const batchLabel = make("label", "Reels per batch", { for: "reelnest-queue-batch" });
    const batch = make("input", "", { id: "reelnest-queue-batch", "data-role": "queue-batch", type: "number", min: "1", max: "500", step: "1", value: "35" });
    const batchRow = make("div", "", { class: "queue-inline" }); batchRow.append(batchLabel, batch);
    function limitControl(title, role) {
      const label = make("label", title, { for: `reelnest-${role}-mode` });
      const mode = make("select", "", { id: `reelnest-${role}-mode`, "data-role": `${role}-mode` });
      mode.append(make("option", "Unlimited", { value: "unlimited" }), make("option", "Custom limit", { value: "custom" }));
      const value = make("input", "", { type: "text", inputmode: "numeric", pattern: "[0-9]*", maxlength: "5",
        "data-role": role, "aria-label": title, hidden: "" });
      const row = make("div", "", { class: "queue-limit" }); row.append(label, mode, value);
      return { row, mode, value };
    }
    const defaultLimit = limitControl("Default new videos per profile", "queue-default-limit");
    const totalLimit = limitControl("Maximum new videos for this queue", "queue-total-limit");
    settings.append(batchRow, defaultLimit.row, totalLimit.row);
    const explanation = make("p", "Counts confirmed new saves. Already saved videos and failures do not use either limit. Profiles follow Instagram’s returned order.", { class: "hint" });
    const tabNotice = make("p", "Starting opens one background Instagram tab. Keep this control tab open; each profile uses the selected save location.", { class: "hint" });
    const replaceNotice = make("p", "Starting a new queue replaces its previous saved results. Export reports below first if you want to keep them.", { class: "hint", "data-role": "queue-replace-notice", hidden: "" });
    const status = make("p", "", { class: "status", "data-role": "queue-status", role: "status", "aria-live": "polite", "aria-atomic": "true" });
    const progress = make("p", "", { class: "hint queue-progress", "data-role": "queue-progress", hidden: "" });
    const start = make("button", "Start queue", { type: "button", class: "download", "data-role": "queue-start" });
    const pause = make("button", "Pause queue", { type: "button", "data-role": "queue-pause", hidden: "" });
    const resume = make("button", "Resume", { type: "button", "data-role": "queue-resume", hidden: "" });
    const skip = make("button", "Skip profile", { type: "button", "data-role": "queue-skip", hidden: "" });
    const stop = make("button", "Stop queue", { type: "button", "data-role": "queue-stop", hidden: "" });
    const source = make("button", "Show source tab", { type: "button", "data-role": "queue-show-source", hidden: "" });
    const retry = make("button", "Retry failed", { type: "button", "data-role": "queue-retry", hidden: "" });
    const exportQueue = make("button", "Export queue report", { type: "button", "data-role": "queue-report", hidden: "" });
    const controls = make("div", "", { class: "queue-actions" }); controls.append(pause, resume, skip, stop, source, retry, exportQueue);
    const results = make("ol", "", { class: "queue-results", "data-role": "queue-results", "aria-label": "Latest queue results" });
    section.append(heading, inputLabel, input, addActions, inputErrors, empty, draftList, settings, explanation,
      tabNotice, replaceNotice, progress, status, start, controls, results);
    const css = `
      .profile-queue{margin-top:22px;padding:16px;border:1px solid #d6e4da;border-radius:12px;background:#f0f7f2}
      .profile-queue textarea,.profile-queue input{width:100%;border:1px solid #d1dfd5;border-radius:7px;background:#fff;color:#284d35;padding:8px;font:inherit;font-size:12px}
      .profile-queue textarea{resize:vertical;min-height:92px}.profile-queue textarea:focus-visible,.profile-queue input:focus-visible{outline:3px solid #8ac29f;outline-offset:2px}
      .queue-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:9px}.queue-actions button,.queue-draft button,.queue-results button{min-height:32px;padding:6px 9px;border:1px solid #cfdfd4;border-radius:7px;background:#fff;color:#335d43;font-size:11px;cursor:pointer}
      .queue-actions button{flex:1;min-width:95px}.queue-draft,.queue-results{list-style:none;margin:12px 0;padding:0;max-height:380px;overflow:auto}
      .queue-draft li,.queue-results li{padding:10px;border:1px solid #dce7df;background:#fff;border-radius:8px;margin:7px 0;overflow-wrap:anywhere}
      .queue-row-heading{display:flex;align-items:center;gap:6px;margin-bottom:7px}.queue-row-heading strong{flex:1;font-size:12px}.queue-draft .queue-move{min-width:28px;padding:4px}
      .queue-row-limit{display:flex;gap:6px;align-items:center}.queue-row-limit select{flex:1;font-size:11px}.queue-row-limit input{width:80px}
      .queue-inline{display:flex;align-items:center;gap:10px;justify-content:space-between;margin:14px 0}.queue-inline label{margin:0}.queue-inline input{width:75px}
      .queue-limit{margin:12px 0}.queue-limit input{margin-top:7px}.queue-errors{color:#a04a37;font-size:11px;white-space:pre-line}.profile-queue>.download{width:100%}
      .queue-results .queue-result-meta{margin:5px 0;color:#6f8175;font-size:11px}.queue-results .queue-result-state{font-size:11px;font-weight:600;color:#335d43}.queue-progress{color:#335d43;font-weight:600}
      .profile-queue [hidden]{display:none!important}.profile-queue input:disabled,.profile-queue textarea:disabled{opacity:.55}
    `;
    try { const sheet = new CSSStyleSheet(); sheet.replaceSync(css); root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet]; }
    catch { section.prepend(make("style", css)); }

    function busy() { return starting || controlPending || ownsRun || !!runner; }
    function editable() { return loaded && !busy() && !isSingleBusy(); }
    function notify() { render(); onBusyChange(); }
    function message(text, tone = "neutral") { messageText = text; messageTone = tone; render(); }
    function accept(next) {
      if (!next) return false;
      if (run && (next.id || next.runId) === (run.id || run.runId)) {
        if (Number.isSafeInteger(next.revision) && Number.isSafeInteger(run.revision)) { if (next.revision < run.revision) return false; }
        else if (next.updatedAt && run.updatedAt && next.updatedAt < run.updatedAt) return false;
      }
      run = next;
      return true;
    }
    const runId = () => run?.id || run?.runId;
    function validDraft() {
      if (!config) throw new Error("Reload Instagram to load the queue controls.");
      const value = { ...draft, batchSize: Number(batch.value),
        defaultLimit: defaultMode === "unlimited" ? null : (/^\d+$/.test(defaultText) ? Number(defaultText) : NaN),
        totalLimit: totalMode === "unlimited" ? null : (/^\d+$/.test(totalText) ? Number(totalText) : NaN) };
      return config.normalizeDraft(value);
    }
    function setDraft(value) {
      draft = config?.normalizeDraft(value) || draft;
      defaultMode = draft.defaultLimit == null ? "unlimited" : "custom";
      defaultText = draft.defaultLimit == null ? "" : String(draft.defaultLimit);
      totalMode = draft.totalLimit == null ? "unlimited" : "custom";
      totalText = draft.totalLimit == null ? "" : String(draft.totalLimit);
      batch.value = String(draft.batchSize);
      defaultLimit.mode.value = defaultMode; defaultLimit.value.value = defaultText;
      totalLimit.mode.value = totalMode; totalLimit.value.value = totalText;
      renderDraft();
    }
    function persistDraft() {
      let value;
      try { value = validDraft(); } catch (cause) { message(asError(cause), "error"); return; }
      saveTail = saveTail.catch(() => {}).then(() => request({ type: M + "DRAFT_SET", draft: value }));
      saveTail.catch(cause => message(`The queue draft could not be saved. ${asError(cause)}`, "error"));
    }
    function renderDraft() {
      empty.hidden = draft.entries.length > 0;
      draftList.replaceChildren(...draft.entries.map((entry, index) => {
        const row = make("li", "", { "data-entry-id": entry.id });
        const line = make("div", "", { class: "queue-row-heading" });
        const up = make("button", "↑", { type: "button", class: "queue-move", "data-action": "up", "aria-label": `Move @${entry.username} up` });
        const down = make("button", "↓", { type: "button", class: "queue-move", "data-action": "down", "aria-label": `Move @${entry.username} down` });
        const remove = make("button", "Remove", { type: "button", "data-action": "remove", "aria-label": `Remove @${entry.username}` });
        line.append(make("strong", `${index + 1}. @${entry.username}`), up, down, remove);
        const mode = make("select", "", { "data-action": "limit-mode", "aria-label": `New-video limit for @${entry.username}` });
        mode.append(make("option", "Use default", { value: "inherit" }), make("option", "Custom limit", { value: "custom" }), make("option", "Unlimited", { value: "unlimited" }));
        mode.value = entry.limitMode;
        const value = make("input", "", { type: "text", inputmode: "numeric", pattern: "[0-9]*", maxlength: "5", "data-action": "limit-value", "aria-label": `Custom limit for @${entry.username}` });
        value.value = entry.maxNewVideos == null ? "" : String(entry.maxNewVideos); value.hidden = entry.limitMode !== "custom";
        const limits = make("div", "", { class: "queue-row-limit" }); limits.append(mode, value); row.append(line, limits);
        const edit = action => event => {
          if (!event.isTrusted || !editable()) return;
          if (action === "up" && index > 0) [draft.entries[index - 1], draft.entries[index]] = [draft.entries[index], draft.entries[index - 1]];
          if (action === "down" && index < draft.entries.length - 1) [draft.entries[index + 1], draft.entries[index]] = [draft.entries[index], draft.entries[index + 1]];
          if (action === "remove") draft.entries.splice(index, 1);
          renderDraft(); persistDraft(); render();
        };
        up.addEventListener("click", edit("up")); down.addEventListener("click", edit("down")); remove.addEventListener("click", edit("remove"));
        mode.addEventListener("change", event => {
          if (!event.isTrusted || !editable()) { mode.value = entry.limitMode; return; }
          entry.limitMode = mode.value; entry.maxNewVideos = null; value.value = ""; value.hidden = mode.value !== "custom";
          if (mode.value === "custom") { value.focus(); message("Enter a whole-number profile limit from 1 to 50,000."); }
          else persistDraft();
          render();
        });
        value.addEventListener("input", event => {
          if (!event.isTrusted || !editable()) return;
          entry.maxNewVideos = /^\d+$/.test(value.value) ? Number(value.value) : NaN; render();
        });
        value.addEventListener("change", event => { if (event.isTrusted && editable()) persistDraft(); });
        up.disabled = index === 0; down.disabled = index === draft.entries.length - 1;
        return row;
      }));
      render();
    }
    function renderResults() {
      results.replaceChildren(...(run?.entries || []).map((entry, index) => {
        const row = make("li", "", { "data-result-entry": entry.id });
        const state = terminal.has(run.state) && entry.state === "pending" ? "not_run" : entry.state;
        const count = entry.committedNewSaves || 0;
        row.append(make("strong", `${index + 1}. @${entry.profile?.username || entry.username}`),
          make("div", labels[state] || state, { class: "queue-result-state" }),
          make("p", `${entry.effectiveLimit == null ? "Unlimited" : `Up to ${entry.effectiveLimit} new`} · ${count} new saved · ${entry.counts?.alreadyDownloaded || 0} already saved · ${entry.counts?.failed || 0} failed`, { class: "queue-result-meta" }));
        if (entry.error?.message) row.append(make("p", entry.error.message, { class: "queue-result-meta" }));
        if (entry.profile?.id) {
          const exportProfile = make("button", "Export profile report", { type: "button", "data-role": "queue-profile-report", "data-entry-id": entry.id });
          exportProfile.disabled = !!controlPending;
          exportProfile.addEventListener("click", event => { if (event.isTrusted) exportReport(entry.id); });
          row.append(exportProfile);
        }
        return row;
      }));
    }
    function render() {
      const active = busy();
      const allowed = editable();
      input.disabled = add.disabled = !allowed;
      addCurrent.disabled = !allowed || readRoute()?.type !== "profile";
      batch.disabled = defaultLimit.mode.disabled = defaultLimit.value.disabled = totalLimit.mode.disabled = totalLimit.value.disabled = !allowed;
      defaultLimit.value.hidden = defaultMode !== "custom"; totalLimit.value.hidden = totalMode !== "custom";
      for (const row of draftList.children) {
        const index = draft.entries.findIndex(entry => entry.id === row.dataset.entryId);
        for (const control of row.querySelectorAll("button,select,input")) {
          control.disabled = !allowed || control.dataset.action === "up" && index === 0 || control.dataset.action === "down" && index === draft.entries.length - 1;
        }
      }
      let valid = false;
      try { valid = validDraft().entries.length > 0; } catch {}
      start.hidden = active; start.disabled = !allowed || !valid || !["folder", "downloads"].includes(getDestination().kind);
      const paused = desired === "pause" || run?.state === "paused" || latestSnapshot && ["paused", "incomplete"].includes(latestSnapshot.state) || !!releaseError;
      pause.hidden = !ownsRun || !!paused; pause.disabled = controlPending;
      resume.hidden = !ownsRun || !paused; resume.disabled = controlPending;
      resume.textContent = releaseError || pendingHandoff ? "Retry release" : "Resume";
      skip.hidden = stop.hidden = source.hidden = !ownsRun;
      skip.disabled = stop.disabled = controlPending || desired === "stop" || desired === "skip" || !!pendingHandoff;
      source.disabled = controlPending;
      retry.hidden = !startedHere || ownsRun || !run || !(run.entries || []).some(entry => entry.counts?.failed > 0);
      retry.disabled = active || isSingleBusy() || run?.completionReason === "queue_limit_reached";
      exportQueue.hidden = !run; exportQueue.disabled = controlPending;
      replaceNotice.hidden = !run || ownsRun;
      progress.hidden = !run;
      if (run) progress.textContent = `Profile ${Math.min((run.currentIndex || 0) + 1, run.entries.length)} of ${run.entries.length} · ${run.committedNewSaves || 0} new videos saved${run.draft?.totalLimit == null ? "" : ` of ${run.draft.totalLimit}`}${latestSnapshot?.active ? ` · ${latestSnapshot.active.shortcode}` : ""}`;
      status.textContent = messageText; status.dataset.tone = messageTone;
    }
    function updateRun(next) { accept(next); renderResults(); notify(); }
    function completionMessage() {
      const count = run?.committedNewSaves || 0;
      if (run?.completionReason === "queue_limit_reached") {
        const unrun = run.entries.some(entry => ["not_run", "pending"].includes(entry.state));
        return `Queue limit reached · ${count} new videos saved.${unrun ? " Remaining profiles were not run." : ""}`;
      }
      if (run?.state === "stopped") return `Queue stopped. ${count} saved videos were kept.`;
      return `${labels[run?.state] || "Queue finished"} · ${count} new videos saved. Saved reports are available below.`;
    }
    async function load() {
      if (loading) return loading;
      loading = (async () => {
        try {
          const [saved, latest] = await Promise.all([request({ type: M + "DRAFT_GET" }), request({ type: M + "LATEST" })]);
          if (!busy()) setDraft(saved.draft);
          if (!ownsRun) {
            accept(latest.run);
            if (run) messageText = terminal.has(run.state) ? completionMessage()
              : "An earlier queue needs attention. Review its saved results before starting a new run.";
          }
          loaded = true; renderResults(); render();
        } catch (cause) { message(asError(cause), "error"); }
        finally { loading = null; }
      })();
      return loading;
    }
    function appendProfiles(values, errors = []) {
      const existing = new Set(draft.entries.map(entry => entry.username.toLowerCase()));
      let added = 0, duplicates = 0;
      for (const value of values) {
        const entry = typeof value === "string" ? { username: value } : value;
        if (existing.has(entry.username.toLowerCase())) { duplicates++; continue; }
        if (draft.entries.length >= (config.MAX_PROFILES || 100)) { errors.push({ message: "A queue supports up to 100 profiles." }); break; }
        existing.add(entry.username.toLowerCase());
        draft.entries.push({ id: entry.id || id(), username: entry.username, limitMode: "inherit", maxNewVideos: null }); added++;
      }
      inputErrors.hidden = errors.length === 0;
      inputErrors.textContent = errors.map(error => `${error.line ? `Line ${error.line}: ` : ""}${error.message}`).join("\n");
      renderDraft(); persistDraft();
      message(`${added} profile${added === 1 ? "" : "s"} added${duplicates ? `; ${duplicates} already in the queue` : ""}.${errors.length ? " Review the input errors above." : ""}`, errors.length ? "error" : "neutral");
      return { added, errors };
    }
    add.addEventListener("click", event => {
      if (!event.isTrusted || !editable()) return;
      try { const parsed = config.parseLines(input.value); const added = appendProfiles(parsed.entries, [...parsed.errors]); if (!added.errors.length) input.value = ""; }
      catch (cause) { message(asError(cause), "error"); }
    });
    addCurrent.addEventListener("click", event => {
      if (!event.isTrusted || !editable() || readRoute()?.type !== "profile") return;
      try { appendProfiles([{ username: config.normalizeProfileInput(readRoute().username) }]); }
      catch (cause) { message(asError(cause), "error"); }
    });
    batch.addEventListener("change", event => { if (event.isTrusted && editable()) persistDraft(); });
    for (const [control, kind] of [[defaultLimit, "default"], [totalLimit, "total"]]) {
      control.mode.addEventListener("change", event => {
        if (!event.isTrusted || !editable()) return;
        if (kind === "default") defaultMode = control.mode.value; else totalMode = control.mode.value;
        render();
        if (control.mode.value === "custom" && !control.value.value) { control.value.focus(); message("Enter a whole-number limit from 1 to 50,000."); }
        else persistDraft();
      });
      control.value.addEventListener("input", event => {
        if (!event.isTrusted || !editable()) return;
        if (kind === "default") defaultText = control.value.value; else totalText = control.value.value;
        render();
      });
      control.value.addEventListener("change", event => { if (event.isTrusted && editable()) persistDraft(); });
    }
    function wake() { gateResolve?.(); gateResolve = null; }
    function waitForControl() { return new Promise(resolve => { gateResolve = resolve; }); }
    function pauseRunner(reason) {
      if (runner && runner.snapshot().state !== "idle" && !terminal.has(runner.snapshot().state)) runner.pause(reason);
    }
    function queueProgress(snapshot) {
      latestSnapshot = snapshot; render();
      if (terminal.has(snapshot.state)) { clearTimeout(progressTimer); progressTimer = null; }
      if (progressTimer) return;
      progressTimer = setTimeout(() => { progressTimer = null; flushProgress().catch(cause => {
        progressError = cause; desired = "pause"; pauseRunner("The queue report could not be saved.");
        request({ type: M + "PAUSE", runId: runId() }).then(response => updateRun(response.run)).catch(() => {});
        message(`The queue report could not be saved. ${asError(cause)} Resume to retry its history update.`, "error");
      }); }, terminal.has(snapshot.state) ? 0 : 400);
    }
    async function flushProgress() {
      clearTimeout(progressTimer); progressTimer = null;
      const snapshot = latestSnapshot, job = activeJob, entry = activeEntry, currentRunId = runId();
      if (!snapshot || !job || !entry || !currentRunId) return;
      const next = progressTail.catch(() => {}).then(async () => {
        const response = await request({ type: M + "PROGRESS", runId: currentRunId, entryId: entry.id, jobId: job.jobId, snapshot });
        progressError = null; accept(response.run); renderResults(); render();
      });
      progressTail = next; await next;
    }
    async function finishRunner() {
      if (!runner) return latestSnapshot;
      try {
        const result = await runner.finalize();
        latestSnapshot = result?.snapshot || (result?.state ? result : runner.snapshot());
        await flushProgress(); releaseError = null;
        return latestSnapshot;
      } catch (cause) { releaseError = cause; throw cause; }
    }
    function releaseLocal() {
      clearTimeout(progressTimer); ownsRun = false; runner = null; activeJob = null; activeEntry = null;
      destination = null; latestSnapshot = null; desired = null; releaseError = null; progressError = null; pendingHandoff = null;
      if (run) onActivity?.(`queue-${runId()}`, completionMessage(), run.state === "completed" ? "complete" : "error");
      wake(); notify();
    }
    async function processControl() {
      if (!desired || desired === "pause") return false;
      const action = desired.toUpperCase();
      const summary = runner ? await finishRunner() : latestSnapshot;
      pendingHandoff = { type: M + action, runId: runId(), ...(activeEntry ? { entryId: activeEntry.id } : {}),
        ...(activeJob ? { jobId: activeJob.jobId } : {}), ...(summary ? { summary } : {}) };
      const response = await request(pendingHandoff); pendingHandoff = null;
      accept(response.run); runner = null; activeJob = null; activeEntry = null; latestSnapshot = null; releaseError = null;
      const stopped = action === "STOP"; desired = null; renderResults();
      if (stopped || terminal.has(run?.state)) { const text = completionMessage(); releaseLocal(); message(text, "success"); return true; }
      return false;
    }
    async function pump() {
      if (pumping) return pumping;
      pumping = (async () => {
        while (ownsRun) {
          let entryRequestEpoch = null;
          try {
            if (await processControl()) break;
            if (desired === "pause" || run?.state === "paused" || progressError) { notify(); await waitForControl(); continue; }
            if (terminal.has(run?.state)) { const text = completionMessage(); releaseLocal(); message(text, "success"); break; }
            if (!runner) {
              activeEntry = run.entries[run.currentIndex || 0];
              if (!activeEntry) { const response = await request({ type: M + "STOP", runId: runId() }); accept(response.run); releaseLocal(); break; }
              message(`Loading @${activeEntry.username} in the background…`);
              entryRequestEpoch = ++sourceAttempt;
              const response = await request({ type: M + "ENTRY_START", runId: runId(), entryId: activeEntry.id });
              if (entryRequestEpoch !== sourceAttempt) continue;
              accept(response.run);
              if (!ownsRun) continue;
              if (response.duplicate || !response.job) { activeEntry = null; renderResults(); continue; }
              activeJob = response.job;
              runner = await globalThis.ReelNestProfileJobRunner.create({ request, job: activeJob, target: destination,
                skipExisting: destination.skipExisting, onChange: queueProgress, onLibraryDestination });
              if (desired) { if (desired !== "pause") runner.stop(); continue; }
              latestSnapshot = runner.start();
            }
            if (runner.snapshot().state === "idle") latestSnapshot = runner.start();
            latestSnapshot = await runner.waitForIdle();
            if (desired === "skip" || desired === "stop") continue;
            if (["paused", "incomplete", "pausing"].includes(latestSnapshot.state)) {
              desired = "pause";
              const response = await request({ type: M + "PAUSE", runId: runId() }); accept(response.run);
              await flushProgress();
              message(latestSnapshot.error?.message || latestSnapshot.pauseReason || "Queue paused. Resume to continue the same run.", latestSnapshot.error ? "error" : "neutral");
              continue;
            }
            if (!terminal.has(latestSnapshot.state)) throw new Error("The profile runner stopped without a confirmed result.");
            const summary = await finishRunner();
            if (desired === "skip" || desired === "stop") continue;
            pendingHandoff = { type: M + "ENTRY_FINISH", runId: runId(), entryId: activeEntry.id, jobId: activeJob.jobId, summary };
            const response = await request(pendingHandoff); pendingHandoff = null;
            accept(response.run); runner = null; activeJob = null; activeEntry = null; latestSnapshot = null;
            renderResults(); notify();
          } catch (cause) {
            if (!ownsRun) break;
            if (pendingHandoff) releaseError = cause;
            if (entryRequestEpoch !== null && entryRequestEpoch !== sourceAttempt) continue;
            if (desired === "pause" && !runner && !releaseError) { message("Queue paused. Resume to continue the same run."); continue; }
            if (desired === "stop" || desired === "skip") {
              try { if (await processControl()) break; continue; } catch (releaseCause) { releaseError = releaseCause; }
            }
            desired = "pause"; pauseRunner(asError(cause));
            try { const response = await request({ type: M + "PAUSE", runId: runId() }); accept(response.run); } catch {}
            message(`${asError(releaseError || cause)}${releaseError ? " Retry release to settle saved files before another profile starts." : " Resolve the issue, then Resume or Skip profile."}`, "error");
          }
        }
      })();
      try { await pumping; } finally { pumping = null; notify(); }
    }
    async function startQueue(event) {
      if (!event?.isTrusted || !editable()) return;
      let next;
      try { next = validDraft(); if (!next.entries.length) throw new Error("Add at least one Instagram profile."); }
      catch (cause) { message(asError(cause), "error"); return; }
      const target = getDestination();
      if (!["folder", "downloads"].includes(target.kind) || target.kind === "folder" && !target.handle) { message("Choose a library folder or Browser Downloads for the queue.", "error"); return; }
      let permission;
      try { permission = target.kind === "folder" && typeof target.handle.requestPermission === "function" ? target.handle.requestPermission({ mode: "readwrite" }) : Promise.resolve("granted"); }
      catch (cause) { message(asError(cause), "error"); return; }
      const previousRunId = runId();
      starting = true; notify();
      try {
        if (await permission !== "granted") throw new Error("Allow access to the selected library folder before starting.");
        await saveTail;
        const latest = await request({ type: M + "LATEST" });
        accept(latest.run);
        await recoverInterrupted(target);
        const interruptedStart = latest.owned && latest.run?.state === "running" && latest.run.entries.every(entry => entry.state === "pending") &&
          latest.run.options?.destination === target.kind && latest.run.options.skipExisting === (getSkipExisting() !== false) && JSON.stringify(latest.run.draft) === JSON.stringify(next);
        const response = interruptedStart ? { run: latest.run } : await request({ type: M + "START", draft: next, options: { destination: target.kind, skipExisting: getSkipExisting() !== false } });
        accept(response.run); ownsRun = true; startedHere = true; desired = null; hostUrl = location.href; navigating = false;
        destination = { ...target, skipExisting: getSkipExisting() !== false }; latestSnapshot = null;
        onActivity?.(`queue-${runId()}`, `Queue started · ${next.entries.length} profiles`, "saving");
        renderResults();
      } catch (cause) {
        if (!cause.code || cause.code === "JOB_LOST") {
          try {
            const latest = await request({ type: M + "LATEST" });
            if (latest.owned && latest.run && (latest.run.id || latest.run.runId) !== previousRunId && latest.run.state === "running" &&
                latest.run.entries.every(entry => entry.state === "pending") && latest.run.options?.destination === target.kind &&
                latest.run.options.skipExisting === (getSkipExisting() !== false) && JSON.stringify(latest.run.draft) === JSON.stringify(next)) {
              accept(latest.run); ownsRun = true; startedHere = true; desired = null; hostUrl = location.href; navigating = false;
              destination = { ...target, skipExisting: getSkipExisting() !== false }; latestSnapshot = null;
              message("The queue started. Continuing after its response was interrupted.");
            }
          } catch {}
        }
        if (!ownsRun) message(asError(cause), "error");
      }
      finally { starting = false; notify(); }
      if (ownsRun) pump();
    }
    async function releaseRecoveryLease() {
      if (!recoveryLease) return;
      await request({ type: M + "LEASE_END", kind: "recovery", ...(recoveryLease.leaseId ? { leaseId: recoveryLease.leaseId } : {}) });
      recoveryLease = null;
    }
    async function recoverInterrupted(target) {
      // A lost release acknowledgement is retried before creating a new owner.
      await releaseRecoveryLease();
      if (run?.state !== "interrupted" || !run.reservation) return;
      const previousId = runId();
      let cache;
      recoveryLease = { runId: previousId, leaseId: null };
      try {
        try {
          const lease = await request({ type: M + "LEASE_BEGIN", kind: "recovery", runId: previousId });
          if (!lease.leaseId) throw new Error("The interrupted save's recovery session could not be confirmed.");
          recoveryLease.leaseId = lease.leaseId;
        } catch (cause) {
          if (cause.code && cause.code !== "JOB_LOST") recoveryLease = null;
          throw cause;
        }
        const { recovery } = await request({ type: M + "RECOVERY_INFO", runId: previousId });
        if (!recovery) return;
        accept(recovery.run);
        const item = recovery.item;
        if (recovery.run.options.destination === "downloads" || item.state === "resolving" && !item.filename && item.downloadId == null) {
          const response = await request({ type: M + "RECONCILE", runId: previousId }); accept(response.run); return;
        }
        if (target.kind !== "folder" || !target.handle) throw new Error("Choose the original library folder to verify the previous queue's interrupted save before starting another queue.");
        if (!recovery.entry.profile?.id || !item.filename || !/^[A-Za-z0-9_-]{1,28}$/.test(item.shortcode || "")) {
          throw new Error("The interrupted file has incomplete identity information. Resolve its saved history before starting another queue.");
        }
        cache = await globalThis.ReelSaverProfileCache.openLibrary(target.handle, recovery.entry.profile, { existingOnly: true });
        const saved = await cache.verifyItem(item);
        let result;
        if (saved && saved.filename === item.filename) {
          result = { state: "saved", filename: saved.filename, bytesWritten: saved.bytesWritten };
        } else {
          let absent = false;
          try { await cache.directoryHandle.getFileHandle(item.filename); }
          catch (cause) { if (cause?.name === "NotFoundError") absent = true; else throw cause; }
          if (!absent) throw new Error("The interrupted video is present but could not be verified against its history. Resolve that file before starting another queue.");
          result = { state: "canceled", filename: item.filename };
        }
        const response = await request({ type: M + "RECONCILE", runId: previousId, result });
        accept(response.run);
      } finally {
        cache?.close();
        await releaseRecoveryLease();
        renderResults();
      }
    }
    start.addEventListener("click", startQueue);
    pause.addEventListener("click", async event => {
      if (!event.isTrusted || !ownsRun || controlPending) return;
      desired = "pause"; pauseRunner(); controlPending = true; notify();
      try { const response = await request({ type: M + "PAUSE", runId: runId() }); accept(response.run); message("Pausing after the current operation. No further profile will start."); }
      catch (cause) { message(asError(cause), "error"); }
      finally { controlPending = false; notify(); }
    });
    resume.addEventListener("click", async event => {
      if (!event.isTrusted || !ownsRun || controlPending) return;
      let permission;
      try { permission = destination?.kind === "folder" && typeof destination.handle?.requestPermission === "function"
        ? destination.handle.requestPermission({ mode: "readwrite" }) : Promise.resolve("granted"); }
      catch (cause) { message(asError(cause), "error"); return; }
      controlPending = true; notify();
      try {
        if (hostUrl !== location.href) throw new Error("Return to the original control page before resuming the queue.");
        if (await permission !== "granted") throw new Error("Allow access to the original library folder before resuming.");
        if (pendingHandoff) {
          const response = await request(pendingHandoff); accept(response.run); pendingHandoff = null;
          runner = null; activeJob = null; activeEntry = null; latestSnapshot = null; releaseError = null;
          if (terminal.has(run?.state)) { const text = completionMessage(); releaseLocal(); message(text, "success"); return; }
        }
        await flushProgress();
        const response = await request({ type: M + "RESUME", runId: runId() }); accept(response.run);
        desired = null; releaseError = null; progressError = null; navigating = false;
        if (runner && runner.snapshot().state !== "idle" && !terminal.has(runner.snapshot().state)) await runner.resume();
        message("Queue resumed with its existing limits and saved counts."); wake();
      } catch (cause) { message(asError(cause), "error"); }
      finally { controlPending = false; notify(); }
      if (ownsRun) pump();
    });
    async function control(event, action) {
      if (!event.isTrusted || !ownsRun || controlPending) return;
      desired = action; runner?.stop(); controlPending = true; notify(); wake();
      try {
        // Source readiness may still be pending. Fence that attempt immediately;
        // when a child exists its receipts must settle before Skip/Stop commits.
        if (!runner) {
          sourceAttempt++;
          const response = await request({ type: M + action.toUpperCase(), runId: runId(), ...(activeEntry ? { entryId: activeEntry.id } : {}) });
          accept(response.run); activeEntry = null; activeJob = null; desired = null;
          if (action === "stop" || terminal.has(run?.state)) { const count = run?.committedNewSaves || 0; releaseLocal(); message(`Queue stopped. ${count} saved videos were kept.`, "success"); }
        } else await request({ type: M + "PAUSE", runId: runId() });
      } catch (cause) { releaseError = cause; message(asError(cause), "error"); }
      finally { controlPending = false; notify(); wake(); }
      if (ownsRun) pump();
    }
    skip.addEventListener("click", event => control(event, "skip")); stop.addEventListener("click", event => control(event, "stop"));
    source.addEventListener("click", async event => {
      if (!event.isTrusted || !runId()) return;
      try { await request({ type: M + "SHOW_SOURCE", runId: runId() }); }
      catch (cause) { message(asError(cause), "error"); }
    });
    retry.addEventListener("click", async event => {
      if (!event.isTrusted || busy() || isSingleBusy() || !runId()) return;
      const target = getDestination();
      if (target.kind !== run.options?.destination || target.kind === "folder" && !target.handle) { message("Select the original destination before retrying failed items.", "error"); return; }
      let permission;
      try { permission = target.kind === "folder" && typeof target.handle.requestPermission === "function" ? target.handle.requestPermission({ mode: "readwrite" }) : Promise.resolve("granted"); }
      catch (cause) { message(asError(cause), "error"); return; }
      starting = true; notify();
      try {
        if (await permission !== "granted") throw new Error("Allow access to the library folder before retrying.");
        const response = await request({ type: M + "RETRY", runId: runId() }); accept(response.run);
        ownsRun = true; desired = null; hostUrl = location.href; destination = { ...target, skipExisting: run.options.skipExisting !== false }; latestSnapshot = null;
      } catch (cause) { message(asError(cause), "error"); }
      finally { starting = false; notify(); }
      if (ownsRun) pump();
    });
    async function exportReport(entryId) {
      if (!runId()) return;
      try {
        const response = await request({ type: M + "REPORT", runId: runId(), ...(entryId ? { entryId } : {}) });
        const url = URL.createObjectURL(new Blob([JSON.stringify(response.report, null, 2)], { type: "application/json" }));
        const name = entryId ? `reelnest-${response.report.profile.username}-${response.report.jobId}-report.json` : `reelnest-queue-${runId()}-report.json`;
        const link = make("a", "", { href: url, download: name }); link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
      } catch (cause) { message(asError(cause), "error"); }
    }
    exportQueue.addEventListener("click", event => { if (event.isTrusted) exportReport(); });
    function contextChanged() {
      if (ownsRun && hostUrl !== location.href && !navigating) {
        navigating = true; desired = "pause"; pauseRunner("Return to the original control page before resuming the queue.");
        request({ type: M + "PAUSE", runId: runId() }).then(response => updateRun(response.run)).catch(() => {});
        message("The control page changed. Return to its original page, then Resume the queue.", "error");
      }
      render();
    }
    function handleEvent(next) {
      if (!ownsRun || !next || (next.id || next.runId) !== runId()) return;
      if (!accept(next)) return;
      if (next.state === "paused") {
        desired = "pause";
        pauseRunner(next.error?.message || "Queue paused.");
        message(next.error?.message || "Queue paused. Resume to continue.", next.error ? "error" : "neutral");
      }
      renderResults(); notify();
    }
    render();
    return Object.freeze({ element: section, load, update: render, contextChanged, handleEvent, isBusy: busy,
      hasNativeJob: () => busy() && destination?.kind === "folder", snapshot: () => run });
  }
  Object.defineProperty(globalThis, "ReelNestProfileQueuePanel", { value: Object.freeze({ create }), configurable: true });
})();
