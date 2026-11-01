/**
 * Executed by chrome.scripting in Instagram's MAIN world.
 * Keep every helper inside this function: Chrome serializes the function alone.
 */
export async function extractReel(expectedShortcode) {
  const startedAt = Date.now();
  const maxDuration = 10500;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

  function failure(code, message) {
    return { ok: false, error: { code, message } };
  }

  function readReelUrl(value) {
    if (typeof value !== "string" || !value.trim()) return null;
    try {
      const parsed = new URL(value, window.location.href);
      const match = parsed.pathname.match(/^\/reels?\/([A-Za-z0-9_-]{1,28})\/?$/);
      if (parsed.protocol !== "https:" ||
          !["instagram.com", "www.instagram.com"].includes(parsed.hostname) ||
          parsed.username || parsed.password || parsed.port || !match) return null;
      return { shortcode: match[1], pageUrl: `https://www.instagram.com/reel/${match[1]}/` };
    } catch {
      return null;
    }
  }

  function mediaUrl(value, requireMp4 = false) {
    if (typeof value !== "string") return null;
    try {
      const parsed = new URL(value);
      const allowed = /(^|\.)(cdninstagram\.com|fbcdn\.net|instagram\.com)$/.test(parsed.hostname);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password ||
          parsed.port || !allowed || /\.(?:mpd|m3u8)$/i.test(parsed.pathname)) return null;
      if (requireMp4 && !/\.mp4$/i.test(parsed.pathname)) return null;
      return parsed.href;
    } catch {
      return null;
    }
  }

  function dimension(value) {
    const result = Number(value);
    return Number.isFinite(result) && result > 0 && result <= 16384 ? Math.round(result) : 0;
  }

  function bestCandidate(candidates, requireMp4 = false) {
    if (!Array.isArray(candidates)) return null;
    return candidates.map(candidate => ({
      url: mediaUrl(candidate?.url, requireMp4),
      width: dimension(candidate?.width),
      height: dimension(candidate?.height),
      bitrate: Math.max(0, Number(candidate?.bit_rate) || 0),
    })).filter(candidate => candidate.url).sort((left, right) =>
      right.width * right.height - left.width * left.height || right.bitrate - left.bitrate
    )[0] || null;
  }

  function ownerIdentity(value) {
    if (!value || typeof value !== "object" || typeof value.username !== "string" ||
        !/^[A-Za-z0-9._]{1,30}$/.test(value.username)) return null;
    for (const entry of [value.pk, value.id]) {
      const id = typeof entry === "string" ? entry :
        Number.isSafeInteger(entry) && entry > 0 ? String(entry) : "";
      if (/^[1-9][0-9]{0,29}$/.test(id)) return { id, username: value.username };
    }
    return null;
  }

  function normalize(record, source) {
    if (!record || typeof record !== "object" || record.is_video === false || record.media_type === 1) return null;
    const candidate = bestCandidate(record.video_versions, true) ||
      (mediaUrl(record.video_url, true) ? {
        url: mediaUrl(record.video_url, true),
        width: dimension(record.dimensions?.width || record.original_width),
        height: dimension(record.dimensions?.height || record.original_height),
      } : null);
    if (!candidate) return null;
    const thumbnail = bestCandidate(record.image_versions2?.candidates)?.url ||
      mediaUrl(record.display_url || record.thumbnail_src || record.thumbnail_url);
    // Read both fields from the matched media's own author object. Nearby
    // recommendations and the currently visited profile are not its owner.
    const ownerProfile = ownerIdentity(record.user) || ownerIdentity(record.owner);
    return {
      shortcode: initial.shortcode,
      pageUrl: initial.pageUrl,
      username: ownerProfile?.username || (typeof (record.user?.username || record.owner?.username) === "string"
        ? String(record.user?.username || record.owner?.username).slice(0, 150) : ""),
      ...(ownerProfile ? { ownerProfile } : {}),
      width: candidate.width,
      height: candidate.height,
      url: candidate.url,
      ...(thumbnail ? { thumbnailUrl: thumbnail } : {}),
      source,
    };
  }

  function stillOnReel() {
    return readReelUrl(window.location.href)?.shortcode === initial.shortcode;
  }

  function finish(media) {
    if (!stillOnReel()) return failure("PAGE_CHANGED", "The Reel changed. Open the downloader again.");
    return { ok: true, media: media ? { ...media, mediaId: id } : media };
  }

  function classifyError(value) {
    const status = Number(value?.status || value?.response?.status || 0);
    const text = [value?.message, value?.error_type, value?.data?.message,
      value?.data?.error_type, value?.response?.data?.message].filter(Boolean).join(" ").toLowerCase();
    if (/challenge_required|checkpoint_required|checkpoint|challenge/.test(text)) {
      return failure("CHECKPOINT_REQUIRED", "Complete the account check in Instagram, then try again.");
    }
    if (status === 401 || /login_required|not logged in|login required/.test(text)) {
      return failure("LOGIN_REQUIRED", "Log in to Instagram and open the Reel again.");
    }
    if (status === 429 || /rate.?limit|please wait a few minutes/.test(text)) {
      return failure("RATE_LIMITED", "Instagram asked you to wait. Try again in a few minutes.");
    }
    return null;
  }

  const initial = readReelUrl(window.location.href);
  if (!initial || (window.top && window.top !== window)) {
    return failure("NOT_REEL", "Open an Instagram Reel in this tab, then try again.");
  }
  if (typeof expectedShortcode !== "string" || expectedShortcode !== initial.shortcode) {
    return failure("PAGE_CHANGED", "The Reel changed. Open the downloader again.");
  }

  let mediaId = 0n;
  for (const character of initial.shortcode) mediaId = mediaId * 64n + BigInt(alphabet.indexOf(character));
  const id = mediaId.toString();
  let lookupTimedOut = false;

  // Instagram's own client supplies the existing session and request headers.
  // video_versions contains progressive media, unlike the player's blob/MSE URL.
  try {
    const module = typeof window.require === "function" ? window.require("PolarisInstapi") : null;
    const api = typeof module?.apiGet === "function" ? module : module?.default;
    if (typeof api?.apiGet === "function") {
      let timer;
      const timeoutMarker = {};
      try {
        const remaining = Math.max(1, Math.min(8000, maxDuration - (Date.now() - startedAt)));
        const response = await Promise.race([
          Promise.resolve().then(() => api.apiGet(`/api/v1/media/${id}/info/`)),
          new Promise(resolve => { timer = setTimeout(() => resolve(timeoutMarker), remaining); }),
        ]);
        if (response === timeoutMarker) {
          lookupTimedOut = true;
        } else {
          const accountError = classifyError(response);
          if (accountError) return stillOnReel() ? accountError : finish(null);
          const items = response?.data?.items || response?.items || [];
          if (Array.isArray(items)) {
            for (const item of items) {
              const code = item?.code || item?.shortcode;
              const matches = code ? code === initial.shortcode : String(item?.pk || item?.id || "").split("_")[0] === id;
              if (matches) {
                const media = normalize(item, "instagram-api");
                if (media) return finish(media);
              }
            }
          }
        }
      } finally {
        clearTimeout(timer);
      }
    }
  } catch (error) {
    const accountError = classifyError(error);
    if (accountError) return stillOnReel() ? accountError : finish(null);
    // Module availability changes between Instagram deployments. Try page data.
  }

  if (!stillOnReel()) return finish(null);

  // Only accept a media object that explicitly names this Reel. A page can
  // contain recommendations, other Reels, and old data after SPA navigation.
  const scripts = Array.from(document.querySelectorAll('script[type="application/json"], script[type="application/ld+json"]')).slice(0, 80);
  let parsedCharacters = 0;
  let visited = 0;
  for (const script of scripts) {
    if (Date.now() - startedAt > maxDuration || visited >= 12000) break;
    const text = script.textContent || "";
    parsedCharacters += text.length;
    if (text.length > 2000000 || parsedCharacters > 6000000 || !text.includes(initial.shortcode)) continue;
    let data;
    try { data = JSON.parse(text); } catch { continue; }
    const stack = [data];
    while (stack.length && visited < 12000) {
      if (Date.now() - startedAt > maxDuration) break;
      const value = stack.pop();
      visited += 1;
      if (!value || typeof value !== "object") continue;
      if (value.code === initial.shortcode || value.shortcode === initial.shortcode) {
        const media = normalize(value, "page-data");
        if (media) return finish(media);
      }
      for (const child of Object.values(value)) {
        if (child && typeof child === "object") stack.push(child);
      }
    }
  }

  // Open Graph metadata is useful only when it identifies the current Reel.
  const og = property => document.querySelector(`meta[property="${property}"]`)?.content || "";
  if (readReelUrl(og("og:url"))?.shortcode === initial.shortcode) {
    const url = mediaUrl(og("og:video:secure_url") || og("og:video"), true);
    if (url) return finish({
      shortcode: initial.shortcode, pageUrl: initial.pageUrl, username: "", url,
      width: dimension(og("og:video:width")), height: dimension(og("og:video:height")),
      ...(mediaUrl(og("og:image")) ? { thumbnailUrl: mediaUrl(og("og:image")) } : {}),
      source: "page-metadata",
    });
  }

  // A video must belong to an article with this Reel's permalink, be visible,
  // and expose a complete MP4 with an audio track. Never use a blob or an
  // arbitrary nearby <video>: those can be silent tracks or another Reel.
  for (const video of Array.from(document.querySelectorAll("video")).slice(0, 20)) {
    const article = video.closest("article");
    if (!article) continue;
    const belongsToReel = Array.from(article.querySelectorAll("a[href]")).some(anchor =>
      readReelUrl(anchor.href)?.shortcode === initial.shortcode
    );
    if (!belongsToReel) continue;
    const bounds = video.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0 || bounds.bottom <= 0 || bounds.right <= 0 ||
        bounds.top >= window.innerHeight || bounds.left >= window.innerWidth) continue;
    const hasAudio = video.mozHasAudio === true || video.webkitAudioDecodedByteCount > 0 ||
      (video.audioTracks && video.audioTracks.length > 0);
    if (!hasAudio) continue;
    const url = mediaUrl(video.currentSrc || video.src, true);
    if (url) return finish({
      shortcode: initial.shortcode, pageUrl: initial.pageUrl, username: "", url,
      width: dimension(video.videoWidth), height: dimension(video.videoHeight),
      ...(mediaUrl(video.poster) ? { thumbnailUrl: mediaUrl(video.poster) } : {}),
      source: "page-video",
    });
  }

  if (!stillOnReel()) return finish(null);
  return lookupTimedOut
    ? failure("LOOKUP_TIMEOUT", "Instagram took too long to respond. Play the Reel, then try again.")
    : failure("MEDIA_UNAVAILABLE", "Couldn't find this Reel's MP4. Play it in Instagram, then try again.");
}
