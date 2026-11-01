// Profile bulk controls run only in the extension's isolated content-script world.
(() => {
  "use strict";
  if (globalThis.ReelSaverBulkPanel) return;

  function buildReport(snapshot) {
    const sanitize = globalThis.ReelSaverBulkQueue.sanitizeDiagnostic;
    const redact = value => sanitize({ serverMessage: String(value || "") }).serverMessage;
    const reportError = value => {
      const diagnostic = sanitize(value.diagnostic);
      return { code: value.code, ...(value.stage ? { stage: value.stage } : {}), message: redact(value.message),
        ...(diagnostic ? { diagnostic } : {}),
        ...(value.cleanupFailed ? { cleanupFailed: true, leftoverFilename: String(value.leftoverFilename || "").replaceAll("\\", "/").split("/").pop() } : {}) };
    };
    return {
      version: 1, jobId: snapshot.jobId, profile: snapshot.profile, mode: snapshot.mode, batchSize: snapshot.batchSize,
      maxNewVideos: snapshot.maxNewVideos ?? null, committedNewSaves: snapshot.committedNewSaves ?? snapshot.counts.saved,
      ...(snapshot.completionReason ? { completionReason: snapshot.completionReason } : {}),
      state: snapshot.state, sourceExhausted: snapshot.sourceExhausted, startedAt: snapshot.startedAt, endedAt: snapshot.endedAt,
      phase: snapshot.phase,
      ...(snapshot.error ? { error: reportError(snapshot.error) } : {}),
      counts: snapshot.counts,
      items: snapshot.items.map(item => ({ mediaId: item.mediaId, shortcode: item.shortcode, state: item.state,
        attempts: item.attempts, filename: String(item.result?.filename || item.filename || "").replaceAll("\\", "/").split("/").pop(),
        ...(item.state === "already_downloaded" ? { reason: "already_downloaded" } :
          item.reason === "profile_limit_reached" ? { reason: "profile_limit_reached" } : {}),
        ...((item.bytesWritten ?? item.result?.bytesWritten) !== undefined ? { bytesWritten: item.bytesWritten ?? item.result.bytesWritten } : {}),
        ...(item.error ? { error: reportError(item.error) } : {}) })),
    };
  }

  function create({ root, request, readRoute, getDestination, getSkipExisting = () => true, isSingleBusy, onBusyChange, onActivity, onLibraryDestination }) {
    const make = (tag, text, attributes = {}) => {
      const node = document.createElement(tag);
      if (text) node.textContent = text;
      for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
      return node;
    };
    const error = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
    const aborted = () => error("SAVE_CANCELLED", "The download was canceled.");
    const terminal = new Set(["completed", "completed_with_errors", "stopped"]);
    const M = "REEL_SAVER_BULK_";
    let modeValue = "batches";
    let batchValue = 35;
    let limitModeValue = "unlimited";
    let limitInputValue = "";
    let settingsReady = false;
    let preferencesBusy = false;
    let starting = false;
    let workerJob = null;
    let retryRetired = false;
    let jobDestination = null;
    let controller = null;
    let snapshot = null;
    let terminalNotified = false;
    let releasePending = false;
    let releaseFailed = false;
    let releaseError = null;
    let renderTimer;
    let lastRender = 0;
    let importing = false;
    let importContext = null;
    let importAbortController = null;
    let clearingHistory = false;
    let clearContext = null;
    const nativeReceipts = new Map();
    const failedNativeReceipts = new Map();

    const section = make("section", "", { class: "bulk", "data-role": "bulk-section" });
    const heading = make("div", "", { class: "section-heading" });
    const scopeBadge = make("span", "ALL REELS", { class: "badge" });
    heading.append(make("h3", "Profile downloads"), scopeBadge);
    const modeLabel = make("label", "Download mode", { for: "reel-saver-bulk-mode" });
    const mode = make("select", "", { id: "reel-saver-bulk-mode", "data-role": "bulk-mode" });
    mode.append(make("option", "Download in batches", { value: "batches" }), make("option", "Scan all first", { value: "scan_all" }));
    const batchRow = make("div", "", { class: "bulk-batch-row" });
    const batchLabel = make("label", "Reels per batch", { for: "reel-saver-bulk-size" });
    const batch = make("input", "", { type: "number", min: "1", max: "500", step: "1", value: "35", id: "reel-saver-bulk-size", "data-role": "bulk-size", inputmode: "numeric" });
    batchRow.append(batchLabel, batch);
    const limitLabel = make("label", "New videos per run", { for: "reel-saver-bulk-limit-mode" });
    const limitMode = make("select", "", { id: "reel-saver-bulk-limit-mode", "data-role": "bulk-limit-mode" });
    limitMode.append(make("option", "Unlimited", { value: "unlimited" }), make("option", "Custom limit", { value: "custom" }));
    const limitRow = make("div", "", { class: "bulk-batch-row", hidden: "" });
    const limitNumberLabel = make("label", "Maximum new videos", { for: "reel-saver-bulk-limit" });
    const limitInput = make("input", "", { type: "text", inputmode: "numeric", pattern: "[0-9]*",
      id: "reel-saver-bulk-limit", "data-role": "bulk-limit", "aria-describedby": "reel-saver-bulk-limit-help", autocomplete: "off" });
    limitRow.append(limitNumberLabel, limitInput);
    const limitHint = make("p", "Counts successful saves in this run. Already saved videos and failed downloads do not use the limit.",
      { class: "hint", id: "reel-saver-bulk-limit-help", "data-role": "bulk-limit-hint" });
    const hint = make("p", "Find a batch, save its videos one at a time, then continue. Keep this Instagram tab open.", { class: "hint" });
    const summary = make("div", "", { class: "bulk-summary", "data-role": "bulk-summary" });
    const summaryCells = {};
    for (const [key, label] of [["discovered", "Found"], ["saved", "Saved"], ["alreadyDownloaded", "Already saved"], ["failed", "Failed"], ["skipped", "Skipped"]]) {
      const cell = make("div");
      const value = make("strong", "0", { "data-count": key });
      cell.append(value, make("span", label));
      summaryCells[key] = value;
      summary.append(cell);
    }
    const message = make("p", "Choose a folder or browser Downloads, then start from this profile.", {
      class: "status bulk-status", "data-role": "bulk-status", role: "status", "aria-live": "polite", "aria-atomic": "true",
    });
    const progress = make("progress", "", { max: "100", value: "0", hidden: "", "aria-label": "Current video download progress", "data-role": "bulk-progress" });
    const primary = make("button", "Download all Reels", { type: "button", class: "download", "data-role": "bulk-start" });
    const secondary = make("div", "", { class: "bulk-secondary" });
    const pause = make("button", "Pause", { type: "button", "data-role": "bulk-pause", hidden: "" });
    const stop = make("button", "Stop", { type: "button", "data-role": "bulk-stop", hidden: "" });
    const retry = make("button", "Retry failed", { type: "button", "data-role": "bulk-retry", hidden: "" });
    const report = make("button", "Export report", { type: "button", "data-role": "bulk-report", hidden: "" });
    secondary.append(pause, stop, retry, report);
    const history = make("div", "", { class: "bulk-history", "data-role": "bulk-history", hidden: "" });
    const historyInfo = make("p", "Downloads are organized into a profile folder with persistent history.", { class: "hint", "data-role": "history-info" });
    const importButton = make("button", "Import download report", { type: "button", "data-role": "cache-import" });
    const importFile = make("input", "", { type: "file", accept: ".json,application/json", hidden: "", "data-role": "cache-import-file" });
    const importSummary = make("p", "", { class: "hint", "data-role": "cache-import-summary", hidden: "" });
    const importCommit = make("button", "Import verified videos", { type: "button", "data-role": "cache-import-commit", hidden: "" });
    const importCancel = make("button", "Cancel import", { type: "button", "data-role": "cache-import-cancel", hidden: "" });
    const clearButton = make("button", "Clear profile history", { type: "button", "data-role": "cache-clear" });
    const clearSummary = make("p", "", { class: "hint", "data-role": "cache-clear-summary", hidden: "", role: "status", "aria-live": "polite" });
    const clearConfirm = make("button", "Clear history", { type: "button", "data-role": "cache-clear-confirm", hidden: "" });
    const clearCancel = make("button", "Cancel", { type: "button", "data-role": "cache-clear-cancel", hidden: "" });
    history.append(historyInfo, importButton, importFile, importSummary, importCommit, importCancel, clearButton, clearSummary, clearConfirm, clearCancel);
    const results = make("ul", "", { class: "activity bulk-results", "data-role": "bulk-results", "aria-label": "Recent bulk results" });
    section.append(heading, modeLabel, mode, batchRow, limitLabel, limitMode, limitRow, limitHint, hint, history, summary, message, progress, primary, secondary, results);
    const styles = `
      .bulk{padding:16px;border:1px solid #d6e4da;border-radius:12px;background:#f0f7f2}
      .bulk-batch-row{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:11px}
      .bulk-batch-row label{margin:0;font-size:11px}.bulk-batch-row input{width:76px;min-height:34px;border:1px solid #d1dfd5;
        border-radius:7px;background:#fff;color:#284d35;padding:6px 8px;font:inherit;font-size:12px}
      .bulk input:focus-visible{outline:3px solid #8ac29f;outline-offset:2px}
      .bulk-summary{display:grid;grid-template-columns:repeat(5,1fr);gap:5px;margin:15px 0 0}
      .bulk-summary div{display:flex;flex-direction:column;align-items:center;padding:8px 2px;border-radius:7px;background:#fff}
      .bulk-summary strong{font-size:16px;color:#28563b}.bulk-summary span{font-size:9px;color:#768b7b}
      .bulk-status{margin:10px 0;min-height:34px}.bulk>.download{width:100%}
      .bulk-secondary{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.bulk-secondary button{flex:1;min-width:90px;min-height:34px;
        border:1px solid #cfdfd4;border-radius:7px;color:#335d43;background:#fff;font-size:11px;cursor:pointer}
      .bulk-secondary button[data-role=bulk-stop]{color:#9a5140}.bulk-results{max-height:180px;overflow:auto;margin-top:9px}
      .bulk-results li{font-size:10px;padding:6px 0}.bulk progress{display:block;width:100%;height:6px;accent-color:#2b7750;margin:5px 0 12px}
      .bulk input:disabled{opacity:.55}.bulk [hidden]{display:none!important}
      .bulk-history{margin-top:12px}.bulk-history button{margin:5px 5px 0 0;padding:8px 10px;border:1px solid #cfdfd4;border-radius:7px;background:#fff;color:#335d43;font:inherit;font-size:11px;cursor:pointer}
      .bulk-history button[data-role=cache-clear-confirm]{border-color:#d9b3a8;color:#963f2d;background:#fff8f5}
    `;
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(styles);
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    } catch {
      const style = make("style", styles);
      root.append(style);
    }

    function hasJob() { return !!workerJob && !!snapshot && !terminal.has(snapshot.state); }
    function busy() { return starting || importing || !!importContext || clearingHistory || !!clearContext || releasePending || releaseFailed || hasJob(); }
    function sameProfile() {
      const route = readRoute();
      return route?.type === "profile" && (!workerJob || route.username.toLowerCase() === workerJob.profile.username.toLowerCase());
    }
    function setMessage(value, tone = "neutral") {
      message.textContent = value;
      message.dataset.tone = tone;
    }
    function selectedLimit() {
      if (limitModeValue === "unlimited") return null;
      if (!/^\d+$/.test(limitInputValue)) throw error("INVALID_LIMIT", "Enter a whole-number limit from 1 to 50,000, or choose Unlimited.");
      return globalThis.ReelSaverDownloadLimits.normalize(Number(limitInputValue));
    }
    function limitReached(state = snapshot) {
      return state?.maxNewVideos != null && (state.committedNewSaves ?? state.counts.saved) >= state.maxNewVideos;
    }
    function update() {
      const active = busy();
      section.hidden = readRoute()?.type !== "profile" && !workerJob && !importContext && !importing && !clearContext && !clearingHistory;
      mode.value = modeValue;
      batch.value = String(batchValue);
      limitMode.value = limitModeValue;
      limitInput.value = limitInputValue;
      mode.disabled = batch.disabled = limitMode.disabled = limitInput.disabled = !settingsReady || active || preferencesBusy || isSingleBusy();
      batchRow.hidden = modeValue !== "batches";
      limitRow.hidden = limitModeValue !== "custom";
      let configuredLimit = null;
      let validLimit = true;
      try { configuredLimit = selectedLimit(); } catch { validLimit = false; }
      limitInput.setAttribute("aria-invalid", String(!validLimit));
      scopeBadge.textContent = limitModeValue === "custom" ? "LIMITED" : "ALL REELS";
      const countHelp = getDestination().kind === "folder"
        ? "Already saved videos and failed downloads do not use the limit."
        : "Failed downloads do not use the limit. Existing files in Browser Downloads are not checked.";
      limitHint.textContent = snapshot && active && snapshot.maxNewVideos != null
        ? `This run: ${snapshot.committedNewSaves ?? snapshot.counts.saved} of ${snapshot.maxNewVideos} new videos saved. ${countHelp}`
        : `Counts successful saves in this run. ${countHelp}`;
      history.hidden = getDestination().kind !== "folder";
      importButton.disabled = active || isSingleBusy() || readRoute()?.type !== "profile";
      importCommit.hidden = importCancel.hidden = !importContext;
      importCommit.disabled = importing || !importContext?.preview;
      importCancel.disabled = false;
      importCancel.textContent = importing ? "Cancel import" : "Cancel";
      clearButton.disabled = active || isSingleBusy() || readRoute()?.type !== "profile";
      clearConfirm.hidden = clearCancel.hidden = clearSummary.hidden = !clearContext;
      clearConfirm.disabled = clearCancel.disabled = clearingHistory;
      hint.textContent = modeValue === "batches"
        ? "Find a batch, save its videos one at a time, then continue. Keep this Instagram tab open."
        : configuredLimit == null ? "Find the full list first, then review the count and start downloading. Keep this tab open."
          : `Find the full list first, then save up to ${configuredLimit} new videos. The limit does not shorten the scan. Keep this tab open.`;
      const ready = snapshot?.state === "paused" && snapshot.phase === "ready";
      const recover = ["paused", "incomplete"].includes(snapshot?.state) && !ready;
      primary.hidden = active && !ready && !recover;
      const downloadLabel = value => value == null ? "Download all Reels" : `Download up to ${value} new Reels`;
      primary.textContent = ready ? snapshot.maxNewVideos == null ? `Download all ${snapshot.counts.discovered} Reels` : downloadLabel(snapshot.maxNewVideos)
        : recover ? "Resume" : modeValue === "scan_all" ? "Scan all Reels" : downloadLabel(configuredLimit);
      primary.disabled = !settingsReady || !validLimit || preferencesBusy || starting || importing || !!importContext || clearingHistory || !!clearContext || releasePending || releaseFailed || isSingleBusy() || readRoute()?.type !== "profile" || (hasJob() && !sameProfile()) || (!hasJob() && getDestination().kind === "ask");
      pause.hidden = !["running", "pausing"].includes(snapshot?.state);
      pause.disabled = snapshot?.state === "pausing";
      pause.textContent = snapshot?.state === "pausing" ? "Pausing…" : "Pause";
      stop.hidden = !hasJob() && !releaseFailed && !releasePending;
      stop.disabled = releasePending || snapshot?.state === "stopping";
      stop.textContent = releasePending ? "Releasing…" : releaseFailed ? nativeReceipts.size ? "Record history and release" : "Release batch" : "Stop";
      retry.hidden = retryRetired || !(snapshot?.counts.failed > 0) || snapshot?.state !== "completed_with_errors";
      retry.disabled = limitReached() || starting || importing || !!importContext || clearingHistory || !!clearContext || releasePending || releaseFailed || !sameProfile() || isSingleBusy();
      report.hidden = !snapshot;
      if (!workerJob && getDestination().kind === "ask") {
        setMessage("For bulk downloads, choose one folder or select Browser Downloads first.");
      }
    }

    function describe(state) {
      if (terminal.has(state.state) && state.completionReason === "profile_limit_reached") {
        return `Limit reached · ${state.committedNewSaves ?? state.counts.saved} new videos saved.${state.counts.failed ? ` ${state.counts.failed} failed; start a new run to retry.` : ""}`;
      }
      if (state.state === "completed") return `Completed. Saved ${state.counts.saved} Reels${state.counts.alreadyDownloaded ? `; already downloaded ${state.counts.alreadyDownloaded}` : ""}${state.counts.skipped ? `; skipped ${state.counts.skipped}` : ""}.`;
      if (state.state === "completed_with_errors") return `Finished with ${state.counts.failed} failed. Saved ${state.counts.saved} Reels. You can retry the failed items.`;
      if (state.state === "stopped") return `Stopped. ${state.counts.saved} saved videos were kept.`;
      if (state.state === "incomplete") return state.error?.message || "Scan incomplete. Resume to retry discovery; the end of this profile has not been confirmed.";
      if (state.state === "paused") return state.phase === "ready" ? `${state.counts.discovered} Reels found. Review the destination, then ${state.maxNewVideos == null ? "download all" : `save up to ${state.maxNewVideos} new videos`}.` : state.pauseReason || state.error?.message || "Paused. Resume when you are ready.";
      if (state.state === "pausing") return state.phase === "discovering" ? "Finishing this page, then pausing…" : "Finishing this video, then pausing…";
      if (state.state === "stopping") return "Stopping the active transfer…";
      if (state.phase === "discovering") return `Finding Reels${state.batchNumber ? ` for batch ${state.batchNumber}` : ""}… ${state.counts.discovered} found. The total is not known yet.`;
      if (state.active) {
        const p = state.active.progress;
        const amount = p?.bytesWritten ? ` · ${(p.bytesWritten / 1048576).toFixed(1)} MB saved` : "";
        return `Batch ${state.batchNumber || 1} · Saving ${state.active.filename || state.active.shortcode}${amount}. ${state.counts.queued} discovered items queued.`;
      }
      return "Preparing the next Reel…";
    }
    function render() {
      clearTimeout(renderTimer);
      renderTimer = undefined;
      lastRender = Date.now();
      if (!snapshot) { update(); return; }
      for (const [key, value] of Object.entries(summaryCells)) value.textContent = String(snapshot.counts[key] || 0);
      const tone = ["incomplete", "completed_with_errors"].includes(snapshot.state) ? "error" : snapshot.state === "completed" ? "success" : "neutral";
      setMessage(releaseFailed ? releaseError || "This batch could not be released. Click Release batch to retry." : describe(snapshot), releaseFailed ? "error" : tone);
      const p = snapshot.active?.progress;
      progress.hidden = !(p && p.totalBytes > 0);
      if (!progress.hidden) progress.value = Math.min(100, 100 * p.bytesWritten / p.totalBytes);
      const entries = snapshot.items.filter(item => ["saved", "already_downloaded", "failed", "skipped", "canceled"].includes(item.state)).slice(-8).reverse();
      results.replaceChildren(...entries.map(item => {
        const label = item.result?.filename || item.filename || item.shortcode || item.mediaId;
        const li = make("li", `${item.state === "saved" ? "Saved" : item.state === "already_downloaded" ? "Already downloaded" : item.state === "failed" ? "Failed" : item.state === "skipped" ? "Skipped" : "Canceled"} · ${label}${item.error?.message ? ` · ${item.error.message}` : ""}`);
        li.dataset.state = ["saved", "already_downloaded"].includes(item.state) ? "complete" : item.state === "failed" ? "error" : item.state;
        return li;
      }));
      update();
      onBusyChange();
    }
    async function releaseJob() {
      if (!workerJob || releasePending) return;
      releasePending = true;
      releaseFailed = false;
      releaseError = null;
      update();
      onBusyChange();
      try {
        for (const [key, receipt] of failedNativeReceipts) {
          if (key.startsWith(`${workerJob.jobId}:`)) await settleFailedNativeReceipt(workerJob, receipt, key, jobDestination);
        }
        for (const [key, receipt] of nativeReceipts) {
          if (key.startsWith(`${workerJob.jobId}:`)) {
            await settleNativeReceipt(workerJob, receipt.item, receipt, key, jobDestination);
            controller?.recordSaved(receipt.item.mediaId, receipt.result);
          }
        }
        const released = await request({ type: M + "END", jobId: workerJob.jobId, state: snapshot?.state || "stopped" });
        if (jobDestination?.kind === "downloads") {
          const recorded = new Map((snapshot?.items || []).map(item => [item.mediaId, item]));
          for (const receipt of released.savedResults || []) {
            const previous = recorded.get(receipt.mediaId);
            if (previous?.state === "saved" && previous.filename === receipt.filename && previous.downloadId === receipt.downloadId &&
                (receipt.bytesWritten === undefined || receipt.bytesWritten === previous.bytesWritten)) continue;
            controller?.recordSaved(receipt.mediaId, receipt);
          }
        }
        jobDestination?.cache?.close();
        terminalNotified = true;
      } catch (cause) {
        releaseFailed = true;
        releaseError = nativeReceipts.size
          ? "A video is already saved. Its history or acknowledgement still needs recording; use Record history and release to retry without another download. Return to the original profile if you navigated away."
          : failedNativeReceipts.size ? "The interrupted video's result or pending history still needs recording. Click Release batch to retry without writing another video."
          : `This batch could not be released. ${cause.message ? `${cause.message} ` : ""}Click Release batch to retry.`;
      } finally {
        releasePending = false;
        render();
        onBusyChange();
      }
    }
    function change(state) {
      snapshot = state;
      if (!renderTimer) renderTimer = setTimeout(render, Math.max(0, 120 - (Date.now() - lastRender)));
      if (terminal.has(state.state) && workerJob && !terminalNotified) {
        releaseJob();
        onActivity?.(`bulk-${workerJob.jobId}`, `Bulk ${state.state === "completed" ? "saved" : state.state.replaceAll("_", " ")} · ${state.counts.saved} Reels saved`, state.state === "completed" ? "complete" : "error");
      }
    }

    const wait = (milliseconds, signal) => new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(aborted());
      const done = () => { signal?.removeEventListener("abort", cancel); resolve(); };
      const timer = setTimeout(done, milliseconds);
      const cancel = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); reject(aborted()); };
      signal?.addEventListener("abort", cancel, { once: true });
    });
    async function cancelBrowser(jobId, item, attemptId) {
      await request({ type: M + "CANCEL_ITEM", jobId, mediaId: item.mediaId, attemptId }).catch(() => {});
    }
    function showLibrary(cache, target) {
      historyInfo.textContent = `${target.name || "Library"} / ${cache.folderName} · ${cache.recordedCount} videos recorded.`;
      onLibraryDestination?.({ rootHandle: target.rootHandle || target.handle, folderName: cache.folderName, profile: cache.profile });
    }
    async function settleNativeReceipt(job, item, receipt, receiptKey, target) {
      if (!receipt.cacheCommitted) {
        try {
          await target.cache.commitSaved(item, receipt.result);
          receipt.cacheCommitted = true;
          showLibrary(target.cache, target);
        } catch {
          throw error("CACHE_WRITE_FAILED", `The video ${receipt.result.filename} was saved, but its history could not be updated. Resume to retry the history update without downloading it again.`, { stage: "cache" });
        }
      }
      try {
        await request({ type: M + "ITEM_RESULT", jobId: job.jobId, mediaId: item.mediaId,
          attemptId: receipt.attemptId, result: { state: "saved", ...receipt.result } });
      } catch {
        throw error("RECONCILIATION_REQUIRED", `The file ${receipt.result.filename} is already saved. Its result still cannot be recorded; no second file was written.`);
      }
      nativeReceipts.delete(receiptKey);
      return receipt.result;
    }
    async function settleFailedNativeReceipt(job, receipt, receiptKey, target) {
      let cleanupError;
      if (receipt.needsAbandon) {
        try {
          await target.cache.abandonWrite(receipt.item);
          receipt.needsAbandon = false;
          if (receipt.cleanupFailed) {
            // abandonWrite verifies that no pending output file remains.
            receipt.cleanupFailed = false;
            receipt.acknowledged = false;
          }
        } catch (cause) { cleanupError = cause; }
      }
      if (!receipt.acknowledged) {
        try {
          await request({ type: M + "ITEM_RESULT", jobId: job.jobId, mediaId: receipt.item.mediaId,
            attemptId: receipt.attemptId, result: { state: receipt.state, error: { ...receipt.error,
              ...(receipt.cleanupFailed ? { cleanupFailed: true, leftoverFilename: receipt.leftoverFilename } : {}) } } });
        } catch (cause) {
          // A rejected lookup may fail before any operation is registered. No
          // file writer was invoked, and the original lookup error still wins.
          if (!(receipt.beforeWriter && receipt.error.code && cause.code === "STALE_OPERATION")) {
            throw error("RECONCILIATION_REQUIRED", "The interrupted video's result could not be recorded. Resume or Stop to retry its acknowledgement before downloading again.");
          }
        }
        receipt.acknowledged = true;
      }
      if (cleanupError) throw error("CACHE_WRITE_FAILED", "The transfer stopped, but its pending history could not be updated. Resume or Stop to retry the history update before downloading again.", { stage: "cache" });
      if (receipt.cleanupFailed) throw error("RECONCILIATION_REQUIRED", "Partial-file cleanup still needs confirmation. Check the destination, then retry releasing this batch.");
      failedNativeReceipts.delete(receiptKey);
    }
    function failedNativeReceipt(item, attemptId, cause, signal, details = {}) {
      return { item, attemptId, state: signal.aborted ? "canceled" : "failed", acknowledged: false,
        cleanupFailed: cause.cleanupFailed === true, leftoverFilename: cause.leftoverFilename,
        error: { code: cause.code || cause.name || "SAVE_FAILED", message: cause.message }, ...details };
    }
    async function saveItem({ item, attemptId, signal, onProgress }) {
      const job = workerJob;
      const target = jobDestination;
      if (!job || !sameProfile()) throw error("PROFILE_CHANGED", "Return to the original profile before resuming this batch.");
      if (signal.aborted) throw aborted();
      if (target.kind === "folder") {
        const receiptKey = `${job.jobId}:${item.mediaId}`;
        const receipt = nativeReceipts.get(receiptKey);
        if (receipt) return settleNativeReceipt(job, item, receipt, receiptKey, target);
        const failedReceipt = failedNativeReceipts.get(receiptKey);
        if (failedReceipt) await settleFailedNativeReceipt(job, failedReceipt, receiptKey, target);
        if (signal.aborted) throw aborted();
        if (target.skipExisting) {
          const existing = await target.cache.verifyItem(item);
          if (signal.aborted) throw aborted();
          if (existing) return existing;
        }
        let response;
        try {
          response = await request({ type: M + "RESOLVE", jobId: job.jobId, item, attemptId });
          if (response.alreadySaved) return response.result;
          if (signal.aborted) throw aborted();
        } catch (cause) {
          const failed = failedNativeReceipt(item, attemptId, cause, signal, { beforeWriter: true, needsAbandon: false });
          failedNativeReceipts.set(receiptKey, failed);
          await settleFailedNativeReceipt(job, failed, receiptKey, target);
          throw cause;
        }
        let saved;
        let intentStarted = false;
        try {
          saved = await globalThis.ReelSaverFolderWriter.saveToFolder({ directoryHandle: target.handle, media: response.media, filename: response.filename, signal, onProgress,
            reservedNames: target.cache.reservedNamesFor(item),
            beforeCreate: async reservation => {
              intentStarted = true;
              await target.cache.beginWrite(item, reservation);
            } });
        } catch (cause) {
          const failed = failedNativeReceipt(item, attemptId, cause, signal, { beforeWriter: false, needsAbandon: intentStarted });
          failedNativeReceipts.set(receiptKey, failed);
          await settleFailedNativeReceipt(job, failed, receiptKey, target);
          throw cause;
        }
        // Keep physical completion independently of its worker acknowledgement.
        // Resume retries only the acknowledgement, not the filesystem write.
        const completed = { attemptId, item, result: saved, cacheCommitted: false };
        nativeReceipts.set(receiptKey, completed);
        return settleNativeReceipt(job, item, completed, receiptKey, target);
      }
      let response;
      try {
        response = await request({ type: M + "DOWNLOAD", jobId: job.jobId, item, attemptId });
      } catch (cause) {
        if (signal.aborted) await cancelBrowser(job.jobId, item, attemptId);
        throw cause;
      }
      let info = response.download;
      if (!info) throw error("RECONCILIATION_REQUIRED", "Chrome's download result is uncertain. Pause and check Downloads before retrying.");
      const cancel = () => { cancelBrowser(job.jobId, item, attemptId); };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        while (info.state === "in_progress") {
          if (signal.aborted) { await cancelBrowser(job.jobId, item, attemptId); throw aborted(); }
          await wait(800, signal);
          response = await request({ type: M + "STATUS", jobId: job.jobId, mediaId: item.mediaId, attemptId });
          info = response.download;
          if (!info) throw error("RECONCILIATION_REQUIRED", "Chrome's download result is uncertain. Check Downloads before retrying.");
          if (info.bytesReceived !== undefined) onProgress({ bytesWritten: info.bytesReceived, totalBytes: info.totalBytes });
        }
        if (info.state !== "complete") {
          const reason = info.reason || info.errorCode || "DOWNLOAD_INTERRUPTED";
          throw error(reason, info.error || "Chrome could not finish this video.", { retryable: /^NETWORK_|SERVER_FAILED|DOWNLOAD_INTERRUPTED/.test(reason), stage: "download" });
        }
        return { filename: info.filename || response.filename || `reel_${item.shortcode}.mp4`, downloadId: info.id,
          ...(info.totalBytes > 0 ? { bytesWritten: info.totalBytes } : {}) };
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    }
    function buildController() {
      return globalThis.ReelSaverBulkQueue.create({
        discoverPage: async ({ cursor, signal }) => {
          if (signal.aborted) throw aborted();
          if (!sameProfile()) throw error("PROFILE_CHANGED", "Return to the original profile before resuming discovery.");
          const response = await request({ type: M + "PAGE", jobId: workerJob.jobId, cursor });
          if (signal.aborted) throw aborted();
          return response.page;
        },
        ...(jobDestination?.kind === "folder" && jobDestination.skipExisting ? {
          checkExisting: async ({ item, signal }) => {
            if (signal.aborted) throw aborted();
            const result = await jobDestination.cache.verifyItem(item);
            if (signal.aborted) throw aborted();
            return result;
          },
        } : {}),
        saveItem,
        onChange: change,
      });
    }
    async function start(event) {
      if (!event?.isTrusted || starting || importing || importContext || clearingHistory || clearContext || releasePending || releaseFailed || isSingleBusy()) return;
      if (hasJob()) {
        if (!sameProfile()) { setMessage("Return to the original profile before resuming this batch.", "error"); return; }
        if (jobDestination?.kind === "folder" && typeof jobDestination.handle?.requestPermission === "function") {
          try {
            // Invoke directly from the trusted Resume click, before any other await.
            const permission = jobDestination.handle.requestPermission({ mode: "readwrite" });
            if (await permission !== "granted") {
              setMessage("Folder access is required to resume. Allow access to the original folder, then try again.", "error");
              return;
            }
          } catch (cause) {
            setMessage(cause.message || "Folder access could not be restored.", "error");
            return;
          }
        }
        controller.resume();
        return;
      }
      const route = readRoute();
      const target = getDestination();
      if (route?.type !== "profile") return;
      let maxNewVideos;
      try { maxNewVideos = selectedLimit(); }
      catch (cause) { setMessage(cause.message, "error"); update(); limitInput.focus(); return; }
      if (!["folder", "downloads"].includes(target.kind) || (target.kind === "folder" && !target.handle)) {
        setMessage("Choose a folder or select Browser Downloads before starting bulk downloads.", "error"); return;
      }
      if (!globalThis.ReelSaverBulkQueue) { setMessage("Reload this Instagram tab to load the bulk downloader.", "error"); return; }
      starting = true;
      onBusyChange();
      update();
      setMessage("Checking this profile and preparing the batch…");
      let registeredJob = null;
      let controllerStarted = false;
      try {
        if (workerJob && !terminalNotified) await request({ type: M + "END", jobId: workerJob.jobId, state: snapshot?.state || "stopped" });
        const response = await request({ type: M + "START", options: { mode: modeValue, batchSize: batchValue, destination: target.kind, maxNewVideos } });
        workerJob = response.job;
        registeredJob = workerJob;
        retryRetired = false;
        if (!workerJob?.jobId || !workerJob.profile?.id) throw new Error("The profile could not be identified. Reload it and try again.");
        snapshot = null;
        controller = null;
        jobDestination = { ...target, skipExisting: getSkipExisting() };
        terminalNotified = false;
        releaseFailed = false;
        releaseError = null;
        nativeReceipts.clear();
        failedNativeReceipts.clear();
        if (target.kind === "folder") {
          if (!globalThis.ReelSaverProfileCache) throw error("CACHE_UNAVAILABLE", "Reload this Instagram tab to load library history.");
          const cache = await globalThis.ReelSaverProfileCache.openLibrary(target.handle, workerJob.profile);
          jobDestination = { ...jobDestination, rootHandle: target.handle, handle: cache.directoryHandle, cache };
          showLibrary(cache, jobDestination);
        }
        controller = buildController();
        snapshot = controller.start({ jobId: workerJob.jobId, profile: workerJob.profile, mode: modeValue, batchSize: batchValue, maxNewVideos });
        controllerStarted = true;
        render();
      } catch (cause) {
        if (registeredJob && !controllerStarted) {
          try {
            await request({ type: M + "END", jobId: registeredJob.jobId, state: "stopped" });
            jobDestination?.cache?.close();
            terminalNotified = true;
            workerJob = null;
          } catch { releaseFailed = true; releaseError = "This batch could not be released. Click Release batch before trying again."; }
        }
        setMessage(`${cause.message || "The batch could not be started."}${releaseFailed ? " Click Release batch to release this session before trying again." : ""}`, "error");
      } finally {
        starting = false;
        update();
        onBusyChange();
      }
    }
    function atClearProfile(profile) {
      const route = readRoute();
      return route?.type === "profile" && route.username.toLowerCase() === profile.username.toLowerCase();
    }
    function closeClearContext() {
      const context = clearContext;
      clearContext = null;
      context?.cache.close();
      clearSummary.hidden = true;
    }
    async function prepareClear(event) {
      if (!event?.isTrusted || busy() || isSingleBusy()) return;
      const target = getDestination();
      if (target.kind !== "folder" || !target.handle || readRoute()?.type !== "profile") return;
      clearingHistory = true;
      onBusyChange(); update();
      setMessage("Checking download history for this profile…");
      let cache;
      try {
        const { profile } = await request({ type: M + "IDENTIFY" });
        if (!atClearProfile(profile)) throw new Error("The profile changed. Open its history again before clearing it.");
        cache = await globalThis.ReelSaverProfileCache.openLibrary(target.handle, profile);
        if (!atClearProfile(profile)) throw new Error("The profile changed. No history was cleared.");
        clearContext = { cache, profile: cache.profile, target, attempted: false };
        showLibrary(cache, target);
        clearSummary.textContent = `Clear download history for @${cache.profile.username} in ${target.name || "Library"} / ${cache.folderName}? ${cache.recordedCount} recorded videos will become eligible to download again. Existing video files will be kept; future downloads receive unique names.`;
        clearConfirm.textContent = "Clear history";
        setMessage("Review the profile and folder above, then confirm or cancel.");
      } catch (cause) {
        cache?.close();
        clearContext = null;
        setMessage(cause.message || "This profile's history could not be opened.", "error");
      } finally {
        clearingHistory = false;
        update(); onBusyChange();
        if (clearContext) clearCancel.focus();
      }
    }
    async function confirmClear(event) {
      if (!event?.isTrusted || clearingHistory || !clearContext) return;
      const context = clearContext;
      if (!atClearProfile(context.profile) || getDestination().handle !== context.target.handle) {
        closeClearContext();
        setMessage(context.attempted ? "The profile or library changed. Video files were kept. Open its history again to check the recorded count." : "The profile or library changed. No history was cleared.");
        update(); onBusyChange(); return;
      }
      clearingHistory = true;
      update(); onBusyChange();
      setMessage(`Clearing download history for @${context.profile.username}…`);
      try {
        // Request renewed access directly from the trusted confirmation click.
        if (typeof context.target.handle.requestPermission === "function" &&
            await context.target.handle.requestPermission({ mode: "readwrite" }) !== "granted") throw new Error("Allow access to the library folder before clearing this profile's history.");
        const { profile } = await request({ type: M + "IDENTIFY" });
        if (profile.id !== context.profile.id || profile.username.toLowerCase() !== context.profile.username.toLowerCase() ||
            !atClearProfile(context.profile)) throw new Error("The profile identity changed. No history was cleared. Cancel and open its history again.");
        context.attempted = true;
        const result = await context.cache.clearHistory();
        retryRetired = true;
        if (atClearProfile(context.profile)) showLibrary(context.cache, context.target);
        closeClearContext();
        setMessage(`Cleared ${result.cleared} download records for @${context.profile.username}. Video files were kept. The next job can download these Reels again.`, "success");
        onActivity?.(`history-clear-${Date.now()}`, `History cleared · @${context.profile.username} · ${result.cleared} records; videos kept`, "complete");
      } catch (cause) {
        clearConfirm.textContent = "Retry clearing history";
        setMessage(`${cause.message || "Download history could not be fully cleared."} Video files were kept.`, "error");
      } finally {
        clearingHistory = false;
        if (clearContext && !atClearProfile(clearContext.profile)) closeClearContext();
        update(); onBusyChange();
      }
    }
    function cancelClear(event) {
      if (!event?.isTrusted || clearingHistory || !clearContext) return;
      const attempted = clearContext.attempted;
      closeClearContext();
      setMessage(attempted ? "History operation closed. Video files were kept. Open the profile history again to check its recorded count." : "History clear canceled. No download records were cleared.");
      update(); onBusyChange();
    }
    async function closeImport() {
      if (!importContext) return;
      await request({ type: M + "END", jobId: importContext.job.jobId, state: "stopped" });
      importContext.cache?.close();
      importContext = null;
      importAbortController = null;
      importSummary.hidden = true;
    }
    async function previewImport(event) {
      if (!event?.isTrusted || busy() || isSingleBusy()) return;
      const file = importFile.files?.[0];
      importFile.value = "";
      if (!file) return;
      const target = getDestination();
      if (target.kind !== "folder" || !target.handle || readRoute()?.type !== "profile") return;
      importing = true;
      importAbortController = new AbortController();
      const signal = importAbortController.signal;
      onBusyChange(); update();
      setMessage("Checking the report and the saved files…");
      let registered = null;
      let cache = null;
      try {
        if (file.size > 16 * 1024 * 1024) throw new Error("This report is too large. Choose a ReelNest report smaller than 16 MB.");
        let report;
        try { report = JSON.parse(await file.text()); }
        catch { throw new Error("This file is not a valid JSON download report."); }
        const response = await request({ type: M + "START", options: { mode: "batches", batchSize: batchValue, destination: "folder" } });
        registered = response.job;
        if (!registered?.jobId || !registered.profile?.id) throw new Error("The profile could not be identified. Reload it and try again.");
        retryRetired = true;
        importContext = { job: registered, cache: null, target, preview: null };
        update();
        cache = await globalThis.ReelSaverProfileCache.openLibrary(target.handle, registered.profile);
        importContext.cache = cache;
        showLibrary(cache, target);
        const preview = await cache.previewReport(report, { signal });
        importContext.preview = preview;
        const result = preview.summary;
        importSummary.textContent = `@${registered.profile.username}: ${result.saved} saved entries; ${result.ready} verified and ready (${result.copies} to copy, ${result.adopted} already in this profile folder). ${result.alreadyRecorded} already recorded; ${result.missing} missing; ${result.conflicts} need review. Original files will be kept.`;
        importSummary.hidden = false;
        importCommit.textContent = "Import verified videos";
        setMessage("Review the verified files above before importing. Missing or conflicting entries will not be marked as downloaded.");
      } catch (cause) {
        if (importContext) {
          try { await closeImport(); }
          catch { importSummary.textContent = "The import could not be prepared. Cancel to release this session before trying again."; importSummary.hidden = false; }
        } else {
          cache?.close();
          if (registered?.jobId) await request({ type: M + "END", jobId: registered.jobId, state: "stopped" }).catch(() => {});
        }
        setMessage(cause.message || "The report could not be checked.", cause.code === "CACHE_IMPORT_CANCELLED" ? "neutral" : "error");
      } finally {
        importing = false;
        importAbortController = null;
        onBusyChange(); update();
      }
    }
    async function commitImport(event) {
      if (!event?.isTrusted || importing || !importContext?.preview) return;
      if (readRoute()?.username?.toLowerCase() !== importContext.job.profile.username.toLowerCase()) {
        setMessage("Return to the original profile to import this report.", "error"); return;
      }
      const context = importContext;
      importing = true;
      importAbortController = new AbortController();
      onBusyChange(); update();
      try {
        const result = await context.cache.importReport(context.preview, {
          signal: importAbortController.signal,
          onProgress: progress => {
            importSummary.textContent = `Importing verified videos for @${context.job.profile.username}… ${progress.imported ?? progress.completed ?? 0} recorded. Original files are kept.`;
          },
        });
        showLibrary(context.cache, context.target);
        await closeImport();
        setMessage(`Import complete: ${result.imported} recorded, ${result.copied} copied. ${result.alreadyRecorded} already recorded, ${result.missing} missing, ${result.conflicts} need review.`);
        onActivity?.(`cache-import-${context.job.jobId}`, `${result.imported} verified videos added to profile history.`, "complete");
      } catch (cause) {
        importCommit.textContent = "Retry import";
        setMessage(cause.message || "The import stopped. You can retry or cancel; completed copies are kept.", "error");
      } finally {
        importing = false;
        importAbortController = null;
        onBusyChange(); update();
      }
    }
    async function cancelImport(event) {
      if (!event?.isTrusted || !importContext) return;
      if (importing) { importAbortController?.abort(); return; }
      importing = true; onBusyChange(); update();
      try { await closeImport(); setMessage("Import closed. Previously imported videos were kept."); }
      catch (cause) { setMessage(cause.message || "The import session could not be closed. Try Cancel again.", "error"); }
      finally { importing = false; onBusyChange(); update(); }
    }
    async function savePreferences() {
      preferencesBusy = true;
      update();
      onBusyChange();
      try {
        await request({ type: M + "SETTINGS_SET", settings: { mode: modeValue, batchSize: batchValue, maxNewVideos: selectedLimit() } });
      } catch (cause) { setMessage(cause.message || "Download options could not be saved.", "error"); }
      finally { preferencesBusy = false; update(); onBusyChange(); }
    }
    mode.addEventListener("change", event => {
      if (!event.isTrusted || busy()) { update(); return; }
      if (!["batches", "scan_all"].includes(mode.value)) { update(); return; }
      modeValue = mode.value;
      savePreferences();
    });
    batch.addEventListener("change", event => {
      if (!event.isTrusted || busy()) { update(); return; }
      const value = Number(batch.value);
      if (!Number.isInteger(value) || value < 1 || value > 500) {
        setMessage("Enter a batch size from 1 to 500.", "error"); update(); return;
      }
      batchValue = value;
      savePreferences();
    });
    limitMode.addEventListener("change", event => {
      if (!event.isTrusted || busy() || preferencesBusy || isSingleBusy()) { update(); return; }
      if (!["unlimited", "custom"].includes(limitMode.value)) { update(); return; }
      limitModeValue = limitMode.value;
      try { selectedLimit(); }
      catch (cause) { update(); setMessage(cause.message, "error"); limitInput.focus(); return; }
      savePreferences();
    });
    limitInput.addEventListener("input", event => {
      if (!event.isTrusted || busy() || preferencesBusy || isSingleBusy()) { update(); return; }
      limitInputValue = limitInput.value;
      update();
      try { selectedLimit(); setMessage("The limit counts successful new saves in this run."); }
      catch (cause) { setMessage(cause.message, "error"); }
    });
    limitInput.addEventListener("change", event => {
      if (!event.isTrusted || busy() || preferencesBusy || isSingleBusy()) { update(); return; }
      limitInputValue = limitInput.value;
      try { selectedLimit(); }
      catch (cause) { update(); setMessage(cause.message, "error"); return; }
      savePreferences();
    });
    primary.addEventListener("click", start);
    importButton.addEventListener("click", event => { if (event.isTrusted && !busy() && !isSingleBusy()) importFile.click(); });
    importFile.addEventListener("change", previewImport);
    importCommit.addEventListener("click", commitImport);
    importCancel.addEventListener("click", cancelImport);
    clearButton.addEventListener("click", prepareClear);
    clearConfirm.addEventListener("click", confirmClear);
    clearCancel.addEventListener("click", cancelClear);
    pause.addEventListener("click", event => { if (event.isTrusted) controller?.pause(); });
    stop.addEventListener("click", event => { if (event.isTrusted) { if (releaseFailed) releaseJob(); else controller?.stop(); } });
    retry.addEventListener("click", async event => {
      if (!event.isTrusted || starting || importing || importContext || clearingHistory || clearContext || retryRetired || releaseFailed || releasePending || !controller || !sameProfile() || limitReached()) return;
      starting = true;
      update();
      onBusyChange();
      let reopened = false;
      try {
        await request({ type: M + "REOPEN", jobId: workerJob.jobId });
        reopened = true;
        if (jobDestination?.kind === "folder") {
          const cache = await globalThis.ReelSaverProfileCache.openLibrary(jobDestination.rootHandle, workerJob.profile);
          jobDestination = { ...jobDestination, handle: cache.directoryHandle, cache };
          showLibrary(cache, jobDestination);
        }
        terminalNotified = false;
        controller.retryFailed();
      } catch (cause) {
        if (reopened) {
          try {
            await request({ type: M + "END", jobId: workerJob.jobId, state: snapshot?.state || "stopped" });
            jobDestination?.cache?.close();
            terminalNotified = true;
          } catch {
            terminalNotified = false;
            releaseFailed = true;
            releaseError = "The retry could not be prepared or released. Click Release batch before starting another job.";
          }
        }
        setMessage(cause.message || "Failed items could not be retried.", "error");
      }
      finally { starting = false; update(); onBusyChange(); }
    });
    report.addEventListener("click", event => {
      if (!event.isTrusted || !snapshot) return;
      const reportData = buildReport(snapshot);
      const url = URL.createObjectURL(new Blob([JSON.stringify(reportData, null, 2)], { type: "application/json" }));
      const link = make("a", "", { href: url, download: `reelnest-${snapshot.profile.username}-${snapshot.jobId}-report.json` });
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    });

    function contextChanged() {
      if (hasJob() && !sameProfile()) controller?.pause("Return to the original profile before resuming this batch.");
      if (clearContext && !clearingHistory && !atClearProfile(clearContext.profile)) {
        const attempted = clearContext.attempted;
        closeClearContext();
        setMessage(attempted ? "History operation closed because the profile changed. Videos were kept. Open its history again to check the recorded count." : "History clear canceled because the profile changed. No download records were cleared.");
        onBusyChange();
      }
      update();
    }
    function loadSettings(settings) {
      if (!busy()) {
        modeValue = settings?.mode === "scan_all" ? "scan_all" : "batches";
        const value = Number(settings?.batchSize);
        batchValue = Number.isInteger(value) && value >= 1 && value <= 500 ? value : 35;
        let maxNewVideos = null;
        try { maxNewVideos = globalThis.ReelSaverDownloadLimits.normalize(settings?.maxNewVideos); } catch {}
        limitModeValue = maxNewVideos == null ? "unlimited" : "custom";
        limitInputValue = maxNewVideos == null ? "" : String(maxNewVideos);
      }
      settingsReady = true;
      update();
    }
    update();
    return Object.freeze({ element: section, update, contextChanged, loadSettings, isBusy: busy,
      hasNativeJob: () => (hasJob() && jobDestination?.kind === "folder") || (importing && !!importContext) || (clearingHistory && !!clearContext), snapshot: () => snapshot });
  }

  Object.defineProperty(globalThis, "ReelSaverBulkPanel", { value: Object.freeze({ create, buildReport }), configurable: true });
})();
