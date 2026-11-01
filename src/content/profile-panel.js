(() => {
  "use strict";
  if (globalThis.__reelSaverProfilePanel) return;
  globalThis.__reelSaverProfilePanel = true;

  const reserved = new Set([
    "accounts", "about", "ads", "api", "challenge", "checkpoint", "developer", "direct",
    "directory", "download", "emails", "explore", "help", "legal", "notifications", "oauth",
    "p", "privacy", "reel", "reels", "session", "settings", "share", "static", "stories",
    "terms", "topics", "web", "your_activity",
  ]);
  const defaults = { destination: "downloads" };
  let settings = { ...defaults };
  let selectedDestination = "downloads";
  let skipAlreadyDownloaded = true;
  let settingsLoaded = false;
  let savingSettings = false;
  let directoryHandle = null;
  let libraryDestination = null;
  let nativeReceipt = null;
  let currentMedia = null;
  let currentRoute = null;
  let lastUrl = "";
  let requestVersion = 0;
  let inspecting = false;
  let downloadJob = null;
  let nativeController = null;
  let pollTimer;
  let mutationTimer;
  let previousFocus;
  let bulkPanel = null;
  const activity = [];

  function readRoute() {
    try {
      const url = new URL(location.href);
      if (url.protocol !== "https:" || !["www.instagram.com", "instagram.com"].includes(url.hostname) ||
          url.username || url.password || url.port) return null;
      const reel = /^\/reels?\/([A-Za-z0-9_-]{1,28})\/?$/.exec(url.pathname);
      if (reel) return { type: "reel", shortcode: reel[1] };
      const profile = /^\/([A-Za-z0-9._]{1,30})(?:\/(reels|tagged))?\/?$/.exec(url.pathname);
      return profile && !reserved.has(profile[1].toLowerCase())
        ? { type: "profile", username: profile[1] } : null;
    } catch {
      return null;
    }
  }

  function el(tag, text, attributes = {}) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    return node;
  }

  function installStyles(root, style) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(style.textContent);
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    } catch {
      root.prepend(style);
    }
  }

  const launcherHost = el("div", "", { "data-reel-saver-launcher": "" });
  const launcherRoot = launcherHost.attachShadow({ mode: "open" });
  const launcherStyles = el("style");
  launcherStyles.textContent = `
    :host{all:initial;display:block;font-family:"Segoe UI",system-ui,sans-serif;color-scheme:light}
    button{display:inline-flex;align-items:center;gap:8px;border:1px solid #29634c;border-radius:9px;
      background:#1c523e;color:#fff;min-height:38px;padding:9px 14px;font:600 13px/1.3 "Segoe UI",system-ui,sans-serif;
      cursor:pointer;box-shadow:0 3px 12px #12352514}button:hover{background:#143e2e}
    button:focus-visible{outline:3px solid #8ecba8;outline-offset:3px}.mark{font-size:16px;line-height:1}
  `;
  const launcher = el("button", "", { type: "button", "aria-haspopup": "dialog", "aria-expanded": "false" });
  launcher.append(el("span", "↓", { class: "mark", "aria-hidden": "true" }), el("span", "ReelNest"));
  installStyles(launcherRoot, launcherStyles);
  launcherRoot.append(launcher);

  const panelHost = el("div", "", { "data-reel-saver-panel": "" });
  const panelRoot = panelHost.attachShadow({ mode: "open" });
  const styles = el("style");
  styles.textContent = `
    :host{all:initial;font-family:"Segoe UI",system-ui,-apple-system,sans-serif;color-scheme:light}
    *{box-sizing:border-box}[hidden]{display:none!important}
    dialog{position:fixed;inset:16px 16px 16px auto;margin:0;width:min(420px,calc(100vw - 32px));max-width:none;
      height:calc(100dvh - 32px);max-height:calc(100dvh - 32px);padding:0;border:1px solid #dfe8e2;
      border-radius:18px;color:#203b2e;background:#f8fbf9;box-shadow:0 20px 80px #071e2840;overflow:auto;
      font:13px/1.5 "Segoe UI",system-ui,-apple-system,sans-serif;overscroll-behavior:contain}
    dialog::backdrop{background:#0d211f55;backdrop-filter:blur(2px)}
    header{display:flex;align-items:center;gap:11px;padding:22px 22px 18px;background:white;border-bottom:1px solid #e1eae3}
    .brand-mark{display:grid;place-items:center;flex:none;width:36px;height:36px;background:#1c523e;border-radius:11px;
      color:#fff;font-size:23px;line-height:1}h2{margin:0;font-size:18px;letter-spacing:-.5px;color:#173e2c}
    .subtitle{margin:2px 0 0;color:#72877a;font-size:11px}.close{margin-left:auto;flex:none;border:none;background:transparent;
      color:#718177;width:30px;height:30px;border-radius:7px;font:24px/1 system-ui;cursor:pointer}.close:hover{background:#eff4f0}
    main{padding:20px 22px}section+section{margin-top:22px}.section-heading{display:flex;align-items:center;gap:8px;
      margin-bottom:10px}h3{margin:0;color:#718777;text-transform:uppercase;letter-spacing:1.1px;font-size:10px;font-weight:700}
    .badge{margin-left:auto;color:#688474;font-size:9px;padding:1px 5px;border:1px solid #dbe6de;border-radius:4px}
    .context{margin:0 0 16px;color:#6f8175;font-size:11px;overflow-wrap:anywhere}
    label{display:block;font-size:12px;font-weight:600;margin-bottom:7px}select{width:100%;height:40px;border:1px solid #d6e2d8;
      border-radius:8px;padding:8px 10px;background:white;color:#294536;font:inherit;font-size:12px}
    button{font-family:inherit}button:focus-visible,select:focus-visible{outline:3px solid #8ac29f;outline-offset:2px}
    .choose{width:100%;min-height:38px;margin-top:9px;border:1px solid #cfdfd4;background:#fff;color:#2b5d43;border-radius:8px;
      font-size:12px;font-weight:600;cursor:pointer}.choose:hover:not(:disabled){background:#eff6f0}
    .hint{margin:8px 0 0;color:#7e8f82;font-size:11px;line-height:1.55;overflow-wrap:anywhere}.folder-name{color:#335b42;font-weight:600}
    .skip-existing{display:flex;align-items:center;gap:8px;margin-top:12px;font-size:11px;font-weight:400}.skip-existing input{accent-color:#1c523e}
    .card{border:1px solid #dae6dc;border-radius:11px;background:white;overflow:hidden;display:flex;gap:13px;padding:13px}
    .preview{width:58px;height:76px;flex:none;display:grid;place-items:center;border-radius:7px;background:#194737;color:#c7e3cf;
      font-size:23px;overflow:hidden}.preview img{width:100%;height:100%;object-fit:cover}.details{min-width:0;align-self:center}
    .current-title{margin:0;font-size:13px;font-weight:650;color:#284c36;overflow-wrap:anywhere}.current-meta{margin:4px 0 0;color:#7e8d81;font-size:11px}
    .status{margin:12px 0;min-height:32px;color:#6b8173;font-size:11px;line-height:1.6;overflow-wrap:anywhere}
    .status[data-tone=error]{color:#a04a37}.status[data-tone=success]{color:#2b7b4c}
    .actions{display:flex;gap:8px}.download{flex:1;min-height:42px;border:0;border-radius:8px;background:#1c523e;color:white;
      font-size:12px;font-weight:650;cursor:pointer}.download:hover:not(:disabled){background:#133d2c}
    button:disabled,select:disabled{opacity:.55;cursor:default}.refresh{width:42px;flex:none;border:1px solid #d6e3d9;
      border-radius:8px;background:#fff;color:#547561;font-size:20px;cursor:pointer}.cancel{display:block;width:100%;margin-top:8px;
      border:0;border-radius:7px;background:#f6eae5;color:#995140;padding:9px;font-size:11px;cursor:pointer}
    .activity{list-style:none;margin:0;padding:0}.activity li{padding:8px 0;border-bottom:1px solid #e7eee8;font-size:11px;
      color:#6c8171;overflow-wrap:anywhere}.activity li[data-state=complete]{color:#34734b}.activity li[data-state=error]{color:#a05a45}
    .empty{margin:0;color:#93a093;font-size:11px}.footer{padding:14px 22px 17px;border-top:1px solid #e1eae3;color:#8b9a8e;
      font-size:10px;background:#fff}.footer strong{color:#6c8473;font-weight:600}
    @media(max-width:480px){dialog{inset:8px;width:calc(100vw - 16px);height:calc(100dvh - 16px);max-height:calc(100dvh - 16px)}
      header{padding:18px}main{padding:18px}}
  `;
  const dialog = el("dialog", "", { "data-role": "dialog", "aria-labelledby": "reel-saver-title" });
  const header = el("header");
  const brand = el("div");
  brand.append(el("h2", "ReelNest", { id: "reel-saver-title" }), el("p", "Download control panel", { class: "subtitle" }));
  const close = el("button", "×", { type: "button", class: "close", "aria-label": "Close ReelNest", "data-role": "close" });
  header.append(el("div", "↓", { class: "brand-mark", "aria-hidden": "true" }), brand, close);
  const main = el("main");
  const context = el("p", "", { class: "context", "data-role": "context" });
  const destinationSection = el("section");
  const destinationHeading = el("div", "", { class: "section-heading" });
  destinationHeading.append(el("h3", "Save location"));
  const destinationLabel = el("label", "Save videos to", { for: "reel-saver-destination" });
  const destination = el("select", "", { id: "reel-saver-destination", "data-role": "destination", disabled: "" });
  const chosenOption = el("option", "Library folder (this tab)", { value: "chosen", disabled: "" });
  destination.append(el("option", "Browser Downloads folder", { value: "downloads" }),
    el("option", "Ask where to save each video", { value: "ask" }), chosenOption);
  const chooseFolder = el("button", "Choose library folder…", { type: "button", class: "choose", "data-role": "choose-folder", disabled: "" });
  const folderName = el("p", "Browser Downloads folder", { class: "hint folder-name", "data-role": "folder-name" });
  const destinationHint = el("p", "", { class: "hint", "data-role": "destination-hint" });
  const skipLabel = el("label", "", { class: "skip-existing", hidden: "" });
  const skipExisting = el("input", "", { type: "checkbox", checked: "", "data-role": "skip-existing" });
  skipLabel.append(skipExisting, document.createTextNode("Skip videos already downloaded"));
  destinationSection.append(destinationHeading, destinationLabel, destination, chooseFolder, folderName, destinationHint, skipLabel);
  const reelSection = el("section");
  const reelHeading = el("div", "", { class: "section-heading" });
  reelHeading.append(el("h3", "Current Reel"), el("span", "MP4", { class: "badge" }));
  const card = el("div", "", { class: "card" });
  const preview = el("div", "", { class: "preview", "aria-hidden": "true" });
  const glyph = el("span", "▷");
  const thumbnail = el("img", "", { alt: "", referrerpolicy: "no-referrer", hidden: "" });
  preview.append(glyph, thumbnail);
  const details = el("div", "", { class: "details" });
  const currentTitle = el("p", "Open a Reel", { class: "current-title", "data-role": "current-title" });
  const currentMeta = el("p", "One video at a time", { class: "current-meta" });
  details.append(currentTitle, currentMeta);
  card.append(preview, details);
  const status = el("p", "Open a Reel to download it here.", {
    class: "status", "data-role": "status", role: "status", "aria-live": "polite", "aria-atomic": "true",
  });
  const actions = el("div", "", { class: "actions" });
  const download = el("button", "Download MP4", { type: "button", class: "download", "data-role": "download", disabled: "" });
  const refresh = el("button", "↻", { type: "button", class: "refresh", "data-role": "refresh", "aria-label": "Refresh current Reel" });
  const cancel = el("button", "Cancel folder download", { type: "button", class: "cancel", "data-role": "cancel", hidden: "" });
  const historyRetry = el("button", "Retry history update", { type: "button", class: "choose", "data-role": "history-retry", hidden: "" });
  const historyNotice = el("p", "", { class: "hint", "data-role": "history-notice", hidden: "" });
  actions.append(download, refresh);
  reelSection.append(reelHeading, card, status, actions, cancel, historyNotice, historyRetry);
  const activitySection = el("section");
  const activityHeading = el("div", "", { class: "section-heading" });
  activityHeading.append(el("h3", "This session"));
  const emptyActivity = el("p", "Your downloads will appear here.", { class: "empty" });
  const activityList = el("ul", "", { class: "activity", "data-role": "activity" });
  activitySection.append(activityHeading, emptyActivity, activityList);
  if (globalThis.ReelSaverBulkPanel) {
    bulkPanel = globalThis.ReelSaverBulkPanel.create({
      root: panelRoot, request, readRoute,
      getDestination: () => selectedDestination === "chosen"
        ? { kind: "folder", handle: directoryHandle, name: directoryHandle?.name }
        : { kind: selectedDestination },
      getSkipExisting: () => skipAlreadyDownloaded,
      isSingleBusy: () => !!downloadJob || !!nativeReceipt || inspecting || savingSettings,
      onBusyChange: () => updateControls(),
      onActivity: appendActivity,
      onLibraryDestination: value => { libraryDestination = value; updateControls(); },
    });
  }
  main.append(context, destinationSection);
  if (bulkPanel) main.append(bulkPanel.element);
  main.append(reelSection, activitySection);
  const footer = el("div", "", { class: "footer" });
  footer.append(document.createTextNode("Keep this tab open."));
  dialog.append(header, main, footer);
  installStyles(panelRoot, styles);
  panelRoot.append(dialog);

  function setStatus(message, tone = "neutral") {
    status.textContent = message;
    status.dataset.tone = tone;
  }

  function updateControls() {
    const busy = !!downloadJob || !!nativeReceipt || !!bulkPanel?.isBusy();
    destination.value = selectedDestination;
    destination.disabled = !settingsLoaded || busy || savingSettings;
    chooseFolder.disabled = !settingsLoaded || busy || savingSettings || !globalThis.ReelSaverFolderWriter?.isSupported();
    refresh.disabled = busy || inspecting;
    download.disabled = busy || inspecting || savingSettings || !settingsLoaded || !currentMedia || currentRoute?.type !== "reel";
    skipLabel.hidden = selectedDestination !== "chosen";
    skipExisting.checked = skipAlreadyDownloaded;
    skipExisting.disabled = busy;
    historyRetry.hidden = historyNotice.hidden = !nativeReceipt;
    historyRetry.disabled = !!downloadJob;
    if (nativeReceipt) historyNotice.textContent = `${nativeReceipt.result.filename} is saved. Its download history still needs to be recorded. Retry below before starting another download.`;
    cancel.hidden = downloadJob?.type !== "native";
    if (!busy) download.textContent = inspecting ? "Finding Reel…" : "Download MP4";
    if (selectedDestination === "chosen") {
      folderName.textContent = libraryDestination?.rootHandle === directoryHandle
        ? `${directoryHandle.name} / ${libraryDestination.folderName}` : directoryHandle?.name || "Choose a library folder to continue";
      destinationHint.textContent = "Each profile gets its own folder for videos and download history. Select this root folder again after a tab reload; saved history stays on disk.";
    } else if (selectedDestination === "ask") {
      folderName.textContent = "Choose a location for each video";
      destinationHint.textContent = "Chrome will open its Save As dialog when you download.";
    } else {
      folderName.textContent = "Downloads / Reel Saver";
      destinationHint.textContent = "Uses your browser’s download folder. Existing files get unique names.";
    }
    if (!globalThis.ReelSaverFolderWriter?.isSupported()) {
      chooseFolder.title = "This browser does not support choosing a folder here. Use Ask where to save instead.";
    }
    bulkPanel?.update();
  }

  function appendActivity(key, label, state) {
    let entry = activity.find(value => value.key === key);
    if (!entry) {
      entry = { key, label, state };
      activity.unshift(entry);
      if (activity.length > 8) activity.pop();
    }
    entry.label = label;
    entry.state = state;
    activityList.replaceChildren(...activity.map(value => el("li", value.label, { "data-state": value.state })));
    emptyActivity.hidden = activity.length > 0;
  }

  function friendlyError(error) {
    if (/extension context invalidated|receiving end does not exist|could not establish connection/i.test(error?.message || "")) {
      return "ReelNest was updated. Reload this Instagram tab to reconnect.";
    }
    return error?.message || "Something went wrong. Reload the page and try again.";
  }

  async function request(message) {
    let response;
    try {
      response = await chrome.runtime.sendMessage(message);
    } catch (cause) {
      if (/extension context invalidated|receiving end does not exist|could not establish connection/i.test(cause?.message || "")) {
        const error = new Error(friendlyError(cause));
        error.code = "JOB_LOST";
        error.retryable = false;
        throw error;
      }
      throw cause;
    }
    if (!response?.ok) {
      const error = new Error(response?.error?.message || "ReelNest could not complete the request.");
      error.code = response?.error?.code;
      for (const field of ["stage", "retryable", "retryAfterMs", "reason"]) {
        if (response?.error?.[field] !== undefined) error[field] = response.error[field];
      }
      const diagnostic = globalThis.ReelSaverBulkQueue?.sanitizeDiagnostic(response?.error?.diagnostic);
      if (diagnostic) error.diagnostic = diagnostic;
      throw error;
    }
    return response;
  }

  async function loadSettings() {
    try {
      const response = await request({ type: "REEL_SAVER_SETTINGS_GET" });
      settings = { destination: response.settings.destination === "ask" ? "ask" : "downloads" };
      if (selectedDestination !== "chosen") selectedDestination = settings.destination;
      if (bulkPanel) {
        const bulkSettings = await request({ type: "REEL_SAVER_BULK_SETTINGS_GET" });
        bulkPanel.loadSettings(bulkSettings.settings || {});
      }
      settingsLoaded = true;
    } catch (error) {
      settingsLoaded = false;
      setStatus(friendlyError(error), "error");
    }
    updateControls();
  }

  function clearMedia() {
    currentMedia = null;
    thumbnail.hidden = true;
    thumbnail.removeAttribute("src");
    glyph.hidden = false;
    currentTitle.textContent = "Open a Reel";
    currentMeta.textContent = "One video at a time";
  }

  function renderMedia(media) {
    currentMedia = media;
    currentTitle.textContent = media.username ? `@${media.username}` : `Reel ${media.shortcode}`;
    currentMeta.textContent = media.width && media.height ? `${media.width} × ${media.height} · MP4` : "MP4 video";
    thumbnail.hidden = true;
    thumbnail.removeAttribute("src");
    glyph.hidden = false;
    if (typeof media.thumbnailUrl === "string") {
      try {
        const url = new URL(media.thumbnailUrl);
        if (url.protocol === "https:" && !url.username && !url.password && !url.port &&
            /(^|\.)(cdninstagram\.com|fbcdn\.net|instagram\.com)$/.test(url.hostname)) thumbnail.src = url.href;
      } catch {}
    }
  }

  async function refreshCurrentReel() {
    if (downloadJob || bulkPanel?.isBusy()) return;
    const version = ++requestVersion;
    clearMedia();
    currentRoute = readRoute();
    if (currentRoute?.type !== "reel") {
      inspecting = false;
      setStatus("Open a Reel to download it here.");
      updateControls();
      return;
    }
    const shortcode = currentRoute.shortcode;
    inspecting = true;
    setStatus("Finding the video for this Reel…");
    updateControls();
    try {
      const response = await request({ type: "REEL_SAVER_INSPECT" });
      if (version !== requestVersion || readRoute()?.shortcode !== shortcode) return;
      if (response.media.shortcode !== shortcode) throw new Error("The Reel changed. Refresh the current Reel.");
      renderMedia(response.media);
      if (response.download?.state === "in_progress") {
        downloadJob = { type: "browser", id: response.download.id, media: response.media };
        renderBrowserDownload(response.download);
      } else {
        setStatus("Ready to save this Reel as an MP4.");
      }
    } catch (error) {
      if (version === requestVersion) setStatus(friendlyError(error), "error");
    } finally {
      if (version === requestVersion) {
        inspecting = false;
        updateControls();
      }
    }
  }

  function finishJob() {
    clearTimeout(pollTimer);
    downloadJob = null;
    nativeController = null;
    updateControls();
    if (currentMedia?.shortcode !== readRoute()?.shortcode) {
      clearMedia();
      updateControls();
    }
  }

  function renderBrowserDownload(info) {
    if (!downloadJob || downloadJob.type !== "browser" || info.id !== downloadJob.id) return;
    const label = info.filename || `Reel ${downloadJob.media.shortcode}.mp4`;
    if (info.state === "complete") {
      appendActivity(`browser-${info.id}`, `Saved · ${label}`, "complete");
      finishJob();
      setStatus("Your MP4 is saved.", "success");
    } else if (info.state === "interrupted") {
      appendActivity(`browser-${info.id}`, `Interrupted · ${label}`, "error");
      finishJob();
      setStatus(info.error || "The download was interrupted. Please try again.", "error");
    } else {
      download.textContent = "Downloading…";
      appendActivity(`browser-${info.id}`, `Saving · ${label}`, "saving");
      setStatus("Saving with Chrome. You can close this panel.");
      clearTimeout(pollTimer);
      pollTimer = setTimeout(pollBrowserDownload, 900);
    }
    updateControls();
  }

  async function pollBrowserDownload() {
    if (downloadJob?.type !== "browser") return;
    const job = downloadJob;
    try {
      const response = await request({ type: "REEL_SAVER_STATUS", downloadId: job.id });
      if (downloadJob !== job) return;
      renderBrowserDownload(response.download);
    } catch (error) {
      if (downloadJob !== job) return;
      finishJob();
      setStatus(friendlyError(error), "error");
    }
  }

  async function startDownload(event) {
    if (!event?.isTrusted) return;
    if (downloadJob || nativeReceipt || bulkPanel?.isBusy() || inspecting || savingSettings || !currentMedia || !settingsLoaded) return;
    const media = currentMedia;
    if (readRoute()?.shortcode !== media.shortcode) {
      await refreshCurrentReel();
      return;
    }
    const native = selectedDestination === "chosen";
    const targetDirectory = directoryHandle;
    downloadJob = { type: native ? "native" : "preparing", media };
    download.textContent = "Preparing…";
    updateControls();
    setStatus("Preparing this Reel…");
    let library = null;
    try {
      if (native) {
        if (!targetDirectory) throw new Error("Choose a library folder before downloading.");
        nativeController = new AbortController();
        const signal = nativeController.signal;
        let response = null;
        let identified = media;
        if (!identified.ownerProfile || !identified.mediaId) {
          response = await request({ type: "REEL_SAVER_RESOLVE", shortcode: media.shortcode });
          identified = response.media;
        }
        if (signal.aborted) throw new DOMException("The download was canceled.", "AbortError");
        if (identified.shortcode !== media.shortcode) throw new Error("The Reel changed. Refresh the current Reel.");
        if (!identified.ownerProfile || !identified.mediaId) throw new Error("This Reel's profile identity could not be verified. Open it from its profile and retry, or use Browser Downloads.");
        const item = { mediaId: identified.mediaId, shortcode: identified.shortcode };
        library = await globalThis.ReelSaverProfileCache.openLibrary(targetDirectory, identified.ownerProfile);
        libraryDestination = { rootHandle: targetDirectory, folderName: library.folderName, profile: library.profile };
        if (signal.aborted) throw new DOMException("The download was canceled.", "AbortError");
        if (skipAlreadyDownloaded) {
          const existing = await library.verifyItem(item);
          if (signal.aborted) throw new DOMException("The download was canceled.", "AbortError");
          if (existing) {
            appendActivity(`cached-${item.mediaId}`, `Already downloaded · ${existing.filename}`, "complete");
            finishJob();
            setStatus(`Already downloaded in ${targetDirectory.name} / ${library.folderName}.`, "success");
            return;
          }
        }
        response ||= await request({ type: "REEL_SAVER_RESOLVE", shortcode: media.shortcode });
        if (signal.aborted) throw new DOMException("The download was canceled.", "AbortError");
        if (response.media.shortcode !== media.shortcode || response.media.mediaId !== item.mediaId ||
            response.media.ownerProfile?.id !== identified.ownerProfile.id) throw new Error("The Reel's profile identity changed. Refresh it before downloading.");
        renderMedia(response.media);
        const key = `folder-${Date.now()}`;
        appendActivity(key, `Saving · ${response.filename}`, "saving");
        download.textContent = "Saving to folder…";
        let intentWritten = false;
        let saved;
        try {
          saved = await globalThis.ReelSaverFolderWriter.saveToFolder({
            directoryHandle: library.directoryHandle, media: response.media, filename: response.filename, signal,
            reservedNames: library.reservedNamesFor(item),
            beforeCreate: async reservation => { await library.beginWrite(item, reservation); intentWritten = true; },
            onProgress({ bytesWritten, totalBytes }) {
              const received = (bytesWritten / (1024 * 1024)).toFixed(1);
              const total = totalBytes ? ` of ${(totalBytes / (1024 * 1024)).toFixed(1)} MB` : " MB";
              setStatus(`Saving ${received}${total}. Keep this Instagram tab open.`);
            },
          });
        } catch (error) {
          if (intentWritten && !error.cleanupFailed) await library.abandonWrite(item);
          const canceled = error.name === "AbortError" || error.code === "SAVE_CANCELLED";
          appendActivity(key, `${canceled ? "Canceled" : "Failed"} · ${response.filename}`, canceled ? "canceled" : "error");
          throw error;
        }
        nativeReceipt = { cache: library, item, result: saved, rootHandle: targetDirectory, key };
        await completeSingleHistory();
        finishJob();
        setStatus(`Saved to ${targetDirectory.name} / ${library.folderName}.`, "success");
      } else {
        const response = await request({ type: "REEL_SAVER_DOWNLOAD", shortcode: media.shortcode });
        if (response.media) renderMedia(response.media);
        downloadJob = { type: "browser", id: response.download.id, media };
        renderBrowserDownload(response.download);
      }
    } catch (error) {
      finishJob();
      const canceled = error.name === "AbortError" || error.code === "SAVE_CANCELLED";
      if (nativeReceipt) appendActivity(nativeReceipt.key, `Saved · ${nativeReceipt.result.filename} (history update pending)`, "complete");
      setStatus(nativeReceipt ? "The video is saved, but its history update failed. Use Retry history update; it will not download a second copy." :
        canceled ? "The folder download was canceled." : friendlyError(error), canceled ? "neutral" : "error");
    } finally {
      if (library && nativeReceipt?.cache !== library) library.close();
    }
  }

  async function completeSingleHistory() {
    const receipt = nativeReceipt;
    await receipt.cache.commitSaved(receipt.item, receipt.result);
    appendActivity(receipt.key, `Saved · ${receipt.result.filename}`, "complete");
    nativeReceipt = null;
  }

  async function retrySingleHistory(event) {
    if (!event?.isTrusted || !nativeReceipt || downloadJob) return;
    const receipt = nativeReceipt;
    downloadJob = { type: "history", media: currentMedia };
    updateControls();
    try {
      if (typeof receipt.rootHandle.requestPermission === "function" &&
          await receipt.rootHandle.requestPermission({ mode: "readwrite" }) !== "granted") throw new Error("Allow access to the library folder, then retry its history update.");
      await completeSingleHistory();
      receipt.cache.close();
      finishJob();
      setStatus("The saved video's download history is now recorded.", "success");
    } catch (error) {
      finishJob();
      setStatus(friendlyError(error), "error");
    }
  }

  function closePanel() {
    if (!dialog.open) return;
    dialog.close();
    launcher.setAttribute("aria-expanded", "false");
    if (previousFocus?.isConnected && typeof previousFocus.focus === "function") previousFocus.focus();
  }

  async function openPanel() {
    if (dialog.open) return;
    if (!panelHost.isConnected) document.documentElement.append(panelHost);
    previousFocus = launcherRoot.activeElement || document.activeElement;
    dialog.showModal();
    launcher.setAttribute("aria-expanded", "true");
    close.focus();
    await loadSettings();
    if (!dialog.open) return;
    if (downloadJob?.type === "browser") pollBrowserDownload();
    else if (!downloadJob && !bulkPanel?.isBusy() && settingsLoaded) await refreshCurrentReel();
  }

  launcher.addEventListener("click", () => { if (dialog.open) closePanel(); else openPanel(); });
  close.addEventListener("click", closePanel);
  dialog.addEventListener("cancel", event => { event.preventDefault(); closePanel(); });
  dialog.addEventListener("click", event => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closePanel();
  });
  destination.addEventListener("change", async event => {
    if (!event.isTrusted || downloadJob || nativeReceipt || bulkPanel?.isBusy()) { updateControls(); return; }
    const requestedDestination = destination.value;
    const previousDestination = selectedDestination;
    if (requestedDestination === "chosen" && directoryHandle) {
      selectedDestination = "chosen";
      updateControls();
      return;
    }
    if (!["downloads", "ask"].includes(requestedDestination)) { updateControls(); return; }
    savingSettings = true;
    updateControls();
    try {
      const response = await request({ type: "REEL_SAVER_SETTINGS_SET", settings: { destination: requestedDestination } });
      settings = response.settings;
      selectedDestination = settings.destination === "ask" ? "ask" : "downloads";
      if (!downloadJob && !inspecting) setStatus("Save location updated.", "success");
    } catch (error) {
      selectedDestination = previousDestination;
      setStatus(friendlyError(error), "error");
    } finally {
      savingSettings = false;
      updateControls();
    }
  });
  chooseFolder.addEventListener("click", async event => {
    if (!event.isTrusted || downloadJob || nativeReceipt || bulkPanel?.isBusy()) return;
    try {
      // Keep this call before any await: the browser requires the button's user activation.
      const pending = globalThis.ReelSaverFolderWriter.chooseFolder();
      directoryHandle = await pending;
      libraryDestination = null;
      chosenOption.disabled = false;
      chosenOption.textContent = `Library folder: ${directoryHandle.name}`;
      selectedDestination = "chosen";
      updateControls();
      setStatus(`Library selected: ${directoryHandle.name}. Each profile will use its own child folder.`, "success");
    } catch (error) {
      if (error.code !== "PICKER_CANCELLED" && error.name !== "AbortError") setStatus(friendlyError(error), "error");
    }
  });
  refresh.addEventListener("click", async event => {
    if (!event.isTrusted || bulkPanel?.isBusy()) return;
    if (!settingsLoaded) await loadSettings();
    if (settingsLoaded) await refreshCurrentReel();
  });
  download.addEventListener("click", startDownload);
  skipExisting.addEventListener("change", event => {
    if (!event.isTrusted || downloadJob || nativeReceipt || bulkPanel?.isBusy()) { updateControls(); return; }
    skipAlreadyDownloaded = skipExisting.checked;
    updateControls();
  });
  historyRetry.addEventListener("click", retrySingleHistory);
  cancel.addEventListener("click", event => { if (event.isTrusted) nativeController?.abort(); });
  thumbnail.addEventListener("load", () => { thumbnail.hidden = false; glyph.hidden = true; });
  thumbnail.addEventListener("error", () => { thumbnail.hidden = true; glyph.hidden = false; });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "REEL_SAVER_OPEN_PANEL") {
      openPanel();
      sendResponse({ ok: true });
    }
    return false;
  });
  window.addEventListener("beforeunload", event => {
    if (downloadJob?.type === "native" || nativeReceipt || bulkPanel?.hasNativeJob()) {
      event.preventDefault();
      event.returnValue = "";
    }
  });

  function reconcile() {
    const route = readRoute();
    const changed = location.href !== lastUrl;
    lastUrl = location.href;
    currentRoute = route;
    if (changed && route?.type === "profile" && libraryDestination?.profile.username.toLowerCase() !== route.username.toLowerCase()) libraryDestination = null;
    bulkPanel?.contextChanged();
    if (route?.type === "profile") {
      context.textContent = `Profile · @${route.username}`;
      const profileHeader = document.querySelector("main header");
      if (profileHeader?.parentElement) {
        if (launcherHost.parentElement !== profileHeader.parentElement || launcherHost.previousElementSibling !== profileHeader) profileHeader.after(launcherHost);
        if (launcherHost.dataset.placement !== "profile") {
          launcherHost.dataset.placement = "profile";
          launcherHost.style.cssText = "display:block;margin:12px 0 18px;position:relative;z-index:1;";
        }
      } else {
        mountFloatingLauncher();
      }
      launcherHost.style.display = "block";
    } else if (route?.type === "reel") {
      context.textContent = "Individual Reel";
      mountFloatingLauncher();
      launcherHost.style.display = "block";
    } else {
      launcherHost.style.display = "none";
      if (!downloadJob && !bulkPanel?.isBusy()) closePanel();
    }
    if (!panelHost.isConnected && route) document.documentElement.append(panelHost);
    if (changed && !downloadJob) {
      requestVersion++;
      inspecting = false;
      clearMedia();
      if (dialog.open && settingsLoaded) refreshCurrentReel();
      updateControls();
    }
  }

  function mountFloatingLauncher() {
    if (launcherHost.parentElement !== document.documentElement) document.documentElement.append(launcherHost);
    if (launcherHost.dataset.placement !== "floating") {
      launcherHost.dataset.placement = "floating";
      launcherHost.style.cssText = "display:block;position:fixed;right:24px;bottom:24px;z-index:2147483646;";
    }
  }

  function scheduleReconcile() {
    if (mutationTimer) return;
    mutationTimer = setTimeout(() => { mutationTimer = undefined; reconcile(); }, 100);
  }
  new MutationObserver(scheduleReconcile).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("popstate", scheduleReconcile);
  window.addEventListener("hashchange", scheduleReconcile);
  // Instagram uses same-document navigation without emitting popstate for every change.
  setInterval(() => { if (location.href !== lastUrl) reconcile(); }, 600);
  reconcile();
})();
