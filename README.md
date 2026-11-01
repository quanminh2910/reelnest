# ReelNest

A Chrome extension for saving Instagram Reels individually or in profile batches, with optional download limits, automatic profile folders, and persistent download history. This is an independent extension in a separate folder; the archived ESUIT packages are unchanged.

## Install locally

1. Open `chrome://extensions` in Chrome (or `edge://extensions` in Edge).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this **reelnest** folder, containing `manifest.json`.
4. Pin **ReelNest** using the browser's extensions menu.

There is no build step or dependency installation. Node.js is needed only for development checks.

### Update an existing installation

On the extensions page, click **Reload** for ReelNest, then refresh open Instagram tabs. Allow Instagram site access if Chrome asks. The old ZIP releases are preserved; load the current `reelnest` folder or extract **reelnest-0.5.2.zip**. Refreshing replaces the previous content scripts. Choose your central library folder again after refreshing, then start a new bulk job.

Version **0.5.2** adds persistent Browser Downloads receipts keyed by numeric profile and Reel IDs. Repeated runs recognize coauthored Reels and profile username changes. New filenames preserve the complete shortcode, including leading/trailing underscores. An explicit Browser Downloads report import can recover older ambiguous filenames after matching the report to completed downloads in Chrome.

Version **0.5.1** fixes repeated limited runs in **Browser Downloads**: with **Skip videos already downloaded** enabled, a run that saves 25 can be followed by a limit of 10 to save up to 10 additional Reels. Completed earlier ReelNest downloads are recognized from Chrome's download history, including downloads made before this fix. Update by reloading the existing installation at the same unpacked folder path; recognition checks the extension ID that created each download. Removing/reinstalling at a different path can change that ID.

Version **0.5.0** adds an optional maximum number of newly saved videos for a single-profile bulk run. **Unlimited** preserves the previous behavior. A custom limit applies to both Library folder and Browser Downloads, survives pause/resume, and appears in the exported report. Cached videos and failed attempts do not consume it. Profile queues are planned separately.

Version **0.4.2** renames Reel Saver to **ReelNest**. The project folder is named `reelnest`. If your unpacked extension points to the previous `reel-saver` path, remove that old entry and load the `reelnest` folder, then refresh Instagram. Existing library folder names, `.reel-saver-*.json` metadata, and older download reports remain compatible. Keep using your current library root; it does not need to be renamed. Browser Downloads continues saving under `Downloads/Reel Saver`.

Version **0.4.0** adds profile libraries, verified duplicate skipping, persistent per-profile history, and an explicit report importer for existing videos. Both profile-panel single saves and bulk saves use the same library. Browser Downloads and the toolbar popup keep their existing behavior.

Version **0.4.1** adds **Clear profile history** on profile pages. It clears that profile's saved download records from both cache files while keeping its videos and the other profile collections.

## Profile library and download history

Choose one parent folder, such as **Reel Saver**, with **Choose library folder**. Start a profile download and the extension creates or reuses the appropriate child:

```text
Reel Saver/
  .reel-saver-library.json
  example.creator/
    example_creator_SHORTCODE.mp4
    .reel-saver-cache.json
    .reel-saver-cache.backup.json
  another.creator/
    another_creator_SHORTCODE.mp4
    .reel-saver-cache.json
    .reel-saver-cache.backup.json
```

Select this parent again after a refresh or restart. The stored numeric Instagram profile ID identifies the child, so changing a username or manually renaming a complete profile folder does not create a second collection. Ambiguous identities and nonempty folders without verified ownership are preserved; a safe suffix is used for a new collection when needed. Selecting an existing profile child as the parent produces a clear error.

**Skip videos already downloaded** is enabled by default. A recorded video counts as **Already saved** only when its file exists with the recorded byte size and an MP4 header. Missing, truncated, or invalid files remain eligible to download. Cache hits do not consume the batch size or the new-save limit; cached pages are scanned until the limit is reached or the profile feed ends. Uncheck the option to deliberately download another uniquely named copy, which counts toward the limit. These quick checks do not calculate a full-file hash or test playback.

History is committed after a video file closes successfully. A pending record protects interrupted saves; confirmed complete files can be recovered on the next open. If a file saves but its history update fails, **Resume**, **Record history and release**, or the single-Reel **Retry history update** records that file without downloading it again. Keep the tab open while resolving that error. An uncertain leftover file pauses the library instead of being marked as complete or silently duplicated. Restore a known-good cache backup or resolve that file in its profile folder before retrying. Both corrupt cache files or unsupported schemas require manual recovery; a general repair tool is outside this release.

The root lookup can be rebuilt from the child cache files. Back up or move each complete profile folder together with its videos and metadata. History contains profile IDs/usernames, Reel IDs/shortcodes, relative filenames, sizes, and timestamps; it contains no credentials or signed media URLs. Metadata is limited to 16 MiB and 50,000 entries per profile. One native library operation at a time is coordinated across tabs in the same browser origin. Concurrent writes from other browser profiles or external programs are unsupported and detected revision changes pause the operation.

### Import existing flat downloads

1. Select the parent folder that contains your existing MP4s, and open the matching Instagram profile.
2. Click **Import download report** and select a previously exported ReelNest or Reel Saver JSON report.
3. Review the counts and destination. Only successful report entries with matching IDs, exact filenames, sizes, and MP4 headers qualify. Already organized files in the resolved child can also be adopted.
4. Click **Import verified videos**. Verified root files are copied into the profile child, their history is recorded, and the original root files are kept. **Cancel** stops further copying; completed copies are kept.

Repeat imports recognize already recorded files. Canceled, failed, missing, and conflicting entries are not treated as downloaded. A report from a stopped job can seed verified history, but its canceled entries do not establish the remaining profile total. The extension does not move or delete existing videos, and filenames alone are not sufficient proof of a completed save.

Folder history applies to **Library folder** downloads. Browser Downloads does not grant access to read or update its directory, so it does not participate in this on-disk cache. Its bulk downloader instead checks Chrome's records for completed MP4s created by this ReelNest installation. This check does not read file bytes or create cache files in the Downloads folder.

### Browser Downloads history

**Skip videos already downloaded** is also enabled by default for bulk Browser Downloads. A matching completed download is shown as **Already saved**, and discovery continues until the new-save limit is reached or the feed ends. Uncheck it to deliberately save another copy.

After a confirmed save, ReelNest stores a receipt in the extension's local storage: numeric profile ID, Reel media ID and full shortcode, Chrome download ID, basename, positive byte size, and timestamp. The numeric identities survive changes to the viewed profile or media owner's username. Receipts contain no signed URLs, credentials, or absolute paths. Storage is bounded to 20,000 receipts in this browser profile; storage/metadata failures pause the run and retry recording the same save instead of writing another video.

Later runs verify a receipt against this extension's completed Chrome download, accepted MP4 type, recorded size, trusted media source, and Chrome's existing-file indication. Interrupted downloads and records marked missing remain eligible. Unambiguous downloads made before receipts were introduced can also be recognized using their exact filename and Chrome's ownership metadata, then recorded as receipts.

This relies on retained Chrome download history, rather than inspecting arbitrary existing files. Clearing that history or changing the extension's installation ID can make earlier files unrecognizable even when a receipt was stored. Chrome can briefly report stale file-existence information after a file is moved or deleted. Ambiguous legacy filenames are left eligible until an explicit report import establishes their identity. For persistent per-profile history with actual file/header checks, use the Library folder destination.

To recover older browser downloads, open the matching profile, select **Browser Downloads**, click **Import download report**, and choose its previous report. Review the verified counts and confirm the import. Only successful entries with matching profile/media identities, exact basenames, positive sizes, and an owned completed Chrome download are recorded. Confirmation checks the records again. This records history without copying or downloading an MP4; missing or conflicting records stay eligible. The Library folder import continues to verify/copy files into profile children.

### Clear the current profile's cache

1. Open the Instagram profile, open ReelNest, and select the library parent folder containing that profile's collection.
2. In **Profile downloads**, click **Clear profile history**.
3. Review the username, destination, and recorded count, then click **Clear history**. **Cancel** keeps the current history.

The operation clears saved records from the profile cache and its automatic backup. Videos, the profile folder, the library lookup, and other profiles are kept. Future jobs can download these Reels again and use unique filenames to preserve existing copies. Previously exported reports remain available for explicit re-import.

The option is disabled during active or paused downloads, imports, and other library operations. Stop the job and finish any pending history update first. Navigating away cancels an unconfirmed clear. The confirmation rechecks the numeric profile ID before writing. If recording the reset fails, **Retry clearing history** retries the metadata operation; video files are kept throughout. Unresolved interrupted files or corrupt history require recovery before this reset can proceed.

## Earlier fixes

Version **0.3.5** fixes chosen-folder transfers that pause before saving any file while Browser Downloads works. A live comparison showed that omitting the referrer makes the media CDN redirect this request, which the writer's strict redirect policy then rejects. Folder transfers now use `strict-origin-when-cross-origin`, sending only Instagram's origin to the cross-origin CDN. Credentials remain omitted, redirects remain rejected, and media URL/MP4 validation is unchanged. Errors distinguish fetching, streaming, and writing, so a blocked transfer no longer incorrectly advises choosing the folder again.

Live validation used the actual isolated content-script world and a real `FileSystemDirectoryHandle` in a newly created temporary origin-private directory. The updated writer streamed and closed a complete MP4, verified the file size and `ftyp` header, and removed the temporary directory. This did not write into the user's selected folder. The installed-extension fixture also rejects the old no-referrer request options to prevent this regression.

Version **0.3.4** fixes the runtime mismatch confirmed directly in the signed-in Chrome tab: Instagram exposes `CometRelay.fetchQuery`, but neither of the operation-factory exports expected by the earlier adapter is available. The fallback now supplies a minimal unmasked reader to the existing query client, retaining the original persisted request, normalization operation, arguments, and provider handling. It reads the cursor-specific connection instead of the handle that merges multiple pages.

Live validation fetched two consecutive 12-Reel pages with 24 distinct IDs and an advancing cursor, resolved one Reel to a 720×1280 MP4, and verified an HTTP 206 `video/mp4` response with an `ftyp` header. This validation canceled the 1 KB transfer probe; it did not save files or complete a full live bulk job. The installed-extension fixture also exercises the missing-factory runtime shape and complete simulated saves.

Version **0.3.3** supports the actual query structure copied from the signed-in Instagram tab: **`fetch__XDTUserDict.clips_connection`**. The previous adapter recognized the older connection field name and rejected this structure before sending a request. The new path is bound to the exact stored profile GraphQL ID and the returned profile ID is checked. The sibling Relay connection handle is not treated as a second feed. Earlier direct and Node-query paths remain supported. Regression tests and the installed-extension fixture now include the captured field names, types, arguments, and handle structure; a live signed-in download still needs verification.

Reports also include bounded static query-shape facts (selection kinds, field names, fragment names, and matching-path count), even when the adapter fails before making a request. These facts omit argument values, default values, and session data.

Version **0.3.2** supplies declared profile `id` and pagination `first` arguments, which were left null in the previous adapter. For a Node refetch query, it reads the GraphQL identifier from the exact profile's stored `id` field. It uses the page's Relay operation factory and raw execution when available, so fragment masking cannot hide the returned connection. It locates that connection through the operation's selected path, including aliases, and rejects ambiguous paths or a different returned profile. A server rejection does not trigger an additional fallback request.

The live 0.3.1 report showed Instagram error **1675012**, with declared `id` and `first` and no `scale`. This confirms that the earlier scale change did not apply to this deployment; the server's generic message does not prove a specific rejection reason. Version 0.3.2's request correction is covered by realistic Node-query and direct-query fixtures; a signed-in retry remains necessary. Reports now also identify the execution method, connection path, and unset variable names without exporting variable values.

Version **0.3.1** retained operation and fragment defaults, filled a declared missing `scale`, and fixed query names being mistaken for connection failures. Bounded, redacted diagnostics now preserve the available server error, HTTP status, query name, and variable names.

## Bulk profile downloads

1. Open the profile's **Reels** tab, such as `https://www.instagram.com/USERNAME/reels/`, while signed in.
2. Click **ReelNest** on the profile to open the panel.
3. Choose your central **Library folder** or **Browser Downloads**. Bulk captures that profile's child folder for the job; the per-file Save As option is for single downloads.
4. In **Profile downloads**, leave **Download in batches** selected and set **Reels per batch** (default **35**, supported range 1–500).
5. Leave the new-video limit **Unlimited**, or choose a custom whole number from **1–50,000**.
6. Start the download. The extension discovers a batch, saves its videos sequentially, then discovers the next batch until the limit is reached or the profile feed ends. Page overflow and duplicate IDs are carried/filtered correctly.

**Scan all first** discovers the complete list before saving. When the scan finishes, approve the download to begin. A custom limit still applies to saves; it does not shorten this full scan. Batch size controls grouping, not parallel downloads or the total number saved.

The limit counts confirmed successful new saves in this run. For example, batch size **35** with limit **50** saves up to **35**, then **15**; already-saved files, duplicate discovery IDs, unavailable Reels, and failed attempts do not use the allowance. A successful retry does. Browser Downloads skips recognized earlier completed ReelNest downloads when duplicate skipping is enabled; files outside its retained Chrome history cannot be checked.

The selection follows Instagram's returned profile order, which may include pinned items. A limit means **up to N new videos**, rather than a guarantee of the latest N or that N eligible videos exist. Instagram can return a complete page with more IDs than needed; surplus discovered items are deferred when the limit is reached. No further page or media lookup is scheduled after that point. **Limit reached** is distinct from finishing the whole profile, and reports preserve whether the source was actually exhausted.

Mode, batch size, destination, duplicate preference, and limit are captured when the run starts. Pause/resume keeps the same allowance. Stop the run before changing settings. Starting another run resets its allowance; verified Library folder history still skips existing videos. A saved file awaiting its history/status acknowledgement holds its allowance slot until the outcome is settled, preventing a duplicate save or overshoot.

If the Instagram document is refreshed or closed during an unresolved save, its in-tab controller cannot resume. ReelNest keeps the uncertain session record and blocks another bulk run. Check the destination or Chrome Downloads, reload ReelNest at `chrome://extensions`, refresh Instagram, and select the library root again before starting a new run. Reloading the extension resets session allowances; durable library history and pending-file checks still apply. This is an explicit interrupted-run reset, not automatic recovery of the previous run.

- **Pause** finishes the current page/video, then waits. **Resume** continues the same job without repeating completed files.
- **Stop** stops scheduling and cancels an active transfer where possible. Completed files stay saved.
- **Retry failed** retries only failed items from a finished batch job, using its remaining allowance. A run that has reached its limit requires a new run to save more.
- **Export report** saves a version-1 JSON summary with discovered IDs, results, output filenames, failure/deferred reasons, the configured limit, committed new saves, and the completion reason. Existing saved-entry fields remain compatible with the report importer. Reports omit signed media URLs, credentials, and absolute local paths.

The panel shows found/saved/already-saved/failed/skipped counts, the current batch/item, and progress when the transfer provides it. The full total remains unknown until discovery ends. A broken or incomplete scan is reported separately from successful completion. Closing the panel keeps the queue running.

Keep the source Instagram tab open and unrefreshed. Navigating to a different profile pauses the job; return to the original profile to resume. A refresh, discarded document, tab close, or extension reload ends the in-tab job. Only one bulk job can own the queue at a time across tabs.

Instagram errors that need account attention, rate limits, lost folder permission, uncertain transfer results, and systematic save failures pause the queue. The extension never silently changes destinations. Resolve the problem before Resume; if changing from a chosen folder to Downloads, Stop and start a new job with that destination.

Discovery uses Instagram's currently loaded profile query descriptor and Relay client, without ESUIT servers or stored query IDs. Relay supplies its own provided variables. When an exported operation factory is available, the adapter can use raw execution. Otherwise it uses the existing query client, projecting only the verified profile connection and required media/page fields through a minimal reader when the original reader masks them. If it says the query is unavailable, open the profile's **Reels** tab and reload it before retrying. Unexpected paths, pagination/schema changes, and unsupported incremental response patches produce **Scan incomplete** instead of pretending the profile is empty or finished.

Live discovery, consecutive-page handling, media resolution, and a small MP4 transfer probe have been checked on the signed-in profile described above. Browser fixtures separately validate the queue and installed extension messaging with complete simulated transfers. A complete live bulk run remains to be checked. The adapter fails explicitly when the required page modules are unavailable.

## Profile control panel

1. Open an Instagram profile or its Reels tab.
2. Click **ReelNest** near the profile header. If Instagram's layout does not expose a suitable header, the button appears in the corner of the page.
3. Choose a save destination in the panel:
   - **Browser Downloads** uses the browser's download folder, with files under `Reel Saver`.
   - **Ask each time** opens the browser's Save As dialog for each download.
   - **Choose library folder** selects the central parent. Panel downloads and persistent history go into its automatic profile child.
4. Close the panel, open an individual Reel in the same Instagram tab, then click the floating **ReelNest** button to reopen it and use **Download MP4**. Your chosen folder stays selected across Instagram's same-tab page navigation.

The chosen folder stays available in the current Instagram tab until it is refreshed or closed. It is not uploaded or stored in extension settings. Browser Downloads/Ask each time is remembered between browser sessions and also applies to downloads from the toolbar popup.

Downloads to a chosen folder run in the Instagram tab: keep that tab open until saving finishes. Closing the panel does not cancel them. Browser-managed downloads continue if the tab closes. The panel shows progress and provides cancellation for direct folder saves.

If a browser does not support the native folder picker or folder permission is denied, choose the folder again or use **Ask each time** for individual downloads. If Instagram's CDN refuses a transfer, the error identifies the transfer stage; Browser Downloads remains available for bulk jobs. The extension never silently changes the selected destination. Files receive unique names instead of overwriting existing videos.

The profile panel includes both bulk controls and the existing currently opened Reel controls.

## Toolbar download

1. Sign in to Instagram in your browser.
2. Open an individual Reel, with a URL like `https://www.instagram.com/reel/SHORTCODE/`. From a profile or the feed, open the Reel's own page first.
3. Click **ReelNest** in the browser toolbar. It will show the detected Reel.
4. Click **Download MP4**. The file is saved under **Reel Saver** inside your browser's download folder. Chrome may prompt for a location if your browser settings require it.

The download continues when the popup closes. Open the popup again on the same Reel to check its status. A successful status means Chrome reports the file as complete; interrupted downloads have a Retry button. Existing files are given unique names instead of being overwritten.

## Scope and limitations

- Version 0.4 adds native profile libraries, per-profile history, duplicate skipping, and report migration to the bulk queue. The history survives a restart; the queue and pagination cursor do not. Pasted-link downloading and separate audio/video merging are outside this version.
- It uses the current Instagram session and an available progressive MP4. It does not sign in for you or access media unavailable to your account.
- Instagram's internal media API and page structure can change. The extractor uses Instagram's existing media-info module when available and falls back to media data explicitly matched to the current Reel. Uncertain or mismatched media is rejected.
- The selected quality is the highest-resolution progressive MP4 candidate found. Higher-resolution DASH-only sources are not merged in this version.
- If Instagram displays a sign-in, challenge, unavailable-media page, or no supported MP4, resolve it in the tab and reopen the popup. If extraction fails, play the Reel, reload the page, and retry.
- Verification includes serialized page-source tests, generated pagination/queue cases, cache corruption/recovery and worker journal tests, browser UI tests, and an unpacked Edge extension using real runtime/storage/scripting and origin-private directory handles. Instagram source responses are fixtures. Live folder-limit, history-skip, and Stop behavior were checked against three user reports and the running extension. The new Browser Downloads receipt and migration behavior is verified with browser fixtures.

## Permissions and data

| Permission | Purpose |
| --- | --- |
| `activeTab` | Keep the toolbar's current-Reel workflow available. |
| Instagram host access | Show profile controls and resolve the Reel opened in that tab. |
| `scripting` | Run the media lookup in that page. |
| `downloads` | Save the MP4 and check Chrome's download status. |
| `storage` | Remember the browser destination preference and keep tab download IDs in session memory. |

The extension runs content scripts only on `instagram.com` and `www.instagram.com`, in the isolated extension world. It has no backend service, account system, analytics, or ESUIT server dependency, and it does not read cookies or passwords. Media requests and thumbnail loads go to Instagram/Meta hosts. A chosen folder handle stays inside the current tab's isolated script. Signed URLs are held briefly in worker memory and, for chosen-folder saves, passed only to the matching tab. Browser destination, bulk preferences, and bounded browser download receipts are stored locally in the extension. Receipts retain numeric identity, Chrome download ID, basename, size, and timestamp. The latest bulk ownership, discovered IDs, operation attempts, download IDs, file results, and normalized import preview are session-only; they support worker restart and prevent uncertain transfers from being blindly repeated. They do not automatically restore the queue after a refresh/restart. Chrome maintains normal browser download history. Direct folder writes appear in the panel instead of Chrome Downloads.

## Development

Use Node.js 20 or newer. No npm packages are required.

```powershell
cd reelnest
npm run check
npm test
# Optional: popup smoke test in an isolated Chromium browser
npm run test:browser
npm run test:profile
npm run test:bulk
npm run test:extension
```

`check` validates the manifest, referenced assets, icon sizes, and JavaScript syntax. Tests cover media identity, extraction in a serialized page context, URL validation, navigation changes, duplicate requests, retries, and real download-state handling through mocked Chrome APIs.

`test:browser` uses an installed Chrome/Edge/Chromium browser, a temporary profile, and local fixture data. It checks the rendered popup and its download states, then writes `artifacts/popup-preview.png`. It does not test a real Instagram download. Set `REEL_SAVER_BROWSER` to a browser executable if automatic discovery does not find yours.

`test:profile` exercises the injected profile panel against local browser fixtures, including Instagram-style navigation and folder/download controls. The picker returns a real temporary origin-private directory handle. Media requests use fixtures, so the tests do not touch personal folders or Instagram accounts.

`test:bulk` exercises the actual queue, panel, and stream writer against a local 82-item feed, including 35/35/12 batching, scan-all mode, pause/resume, retries, stops, lost acknowledgement recovery, and report import. It also checks custom-limit validation, cached/failed items, remaining allowance, Stop/completion races, consecutive limited Browser Downloads runs, and explicit browser report preview/confirm/cancel. `test:extension` loads the unpacked extension into an isolated Edge/Chromium profile and checks worker/content messaging, real origin-private filesystem writes, cache skips without new media requests, missing-file recovery, reload persistence, and two-profile isolation. Its limit cases verify no extra page/media lookup after the cap, compatible reports, a lost failure acknowledgement followed by Resume, and Stop during media lookup. A synthetic Chrome-download-history adapter additionally exercises the real worker/source/UI path for 25 saves followed by 10 different Reels, coauthor/underscore receipts in real extension local storage, profile/owner username changes, missing-file handling, and report-based recovery of old trimmed filenames. Report exports go only into the temporary browser profile. Instagram modules and browser-history records are fixtures; neither suite accesses your personal browser profile or account. Set `REEL_SAVER_BROWSER` to a compatible unpacked-extension-capable Chromium executable if needed.

Files:

```text
reelnest/
  manifest.json             Extension entry points and permissions
  package.json              Development commands
  README.md
  icons/                    Extension and popup icons
  src/
    background/             Service worker, messaging, and browser downloads
      background.js
      bulk-background.js
      browser-receipts.js    Persistent browser download identity and report verification
    content/                Instagram page controls, queue, and local library
      profile-panel.js
      bulk-panel.js
      bulk-queue.js
      folder-writer.js
      profile-cache.js
    instagram/              Self-contained functions injected into Instagram
      extractor.js
      profile-source.js
    popup/                  Toolbar popup layout, styles, and behavior
      popup.html
      popup.css
      popup.js
    shared/
      core.js               Media validation, filenames, and download messages
      download-limits.js    Shared limit validation and allowance calculation
  scripts/                  Development checks and browser tools
  tests/                    Automated tests and fixtures
  plans/                    Local design notes (ignored by Git)
  artifacts/                Generated diagnostics/screenshots (ignored by Git)
```

Continue loading the project root containing `manifest.json` in Chrome. The manifest loads the source files from their subfolders; no build step is required.

To edit the Instagram dialog, use `src/content/profile-panel.js` for the main layout/styles and `src/content/bulk-panel.js` for bulk/history controls. The toolbar popup lives in `src/popup/`. Update the name in `manifest.json` and icons in `icons/`. Reload the extension and refresh Instagram after editing source files.

Chrome platform references: [load an unpacked extension](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked), [temporary tab access](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab), [content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts), [folder access](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access), [downloads](https://developer.chrome.com/docs/extensions/reference/api/downloads), and [storage](https://developer.chrome.com/docs/extensions/reference/api/storage).

Relay runtime references: [operation defaults and providers](https://github.com/facebook/relay/blob/main/packages/relay-runtime/store/RelayConcreteVariables.js), [raw environment execution](https://github.com/facebook/relay/blob/main/packages/relay-runtime/store/RelayModernEnvironment.js), [fetchQuery reader snapshots](https://github.com/facebook/relay/blob/main/packages/relay-runtime/query/fetchQuery.js), and [refetch identifier handling](https://github.com/facebook/relay/blob/main/packages/react-relay/relay-hooks/useRefetchableFragmentInternal.js).
