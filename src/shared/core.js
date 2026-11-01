export class ReelError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ReelError";
    this.code = code;
  }
}

export function parseReelUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password ||
        url.port || !["instagram.com", "www.instagram.com"].includes(url.hostname)) {
      return null;
    }
    const match = /^\/reels?\/([A-Za-z0-9_-]{1,28})\/?$/.exec(url.pathname);
    if (!match) return null;
    return { shortcode: match[1], pageUrl: `https://www.instagram.com/reel/${match[1]}/` };
  } catch {
    return null;
  }
}

export function isInstagramMediaUrl(value, { video = false } = {}) {
  try {
    const url = new URL(value);
    const host = url.hostname;
    const trusted = ["cdninstagram.com", "fbcdn.net"].some(
      (domain) => host === domain || host.endsWith(`.${domain}`),
    ) || ["instagram.com", "www.instagram.com"].includes(host);
    return url.protocol === "https:" && !url.username && !url.password &&
      !url.port && trusted && (!video || /\.mp4$/i.test(url.pathname));
  } catch {
    return false;
  }
}

export function validateMedia(media, expectedShortcode) {
  const reel = parseReelUrl(media?.pageUrl);
  if (!reel || reel.shortcode !== expectedShortcode || media.shortcode !== expectedShortcode) {
    throw new ReelError("PAGE_CHANGED", "The Reel changed. Open ReelNest again on the Reel you want.");
  }
  if (!isInstagramMediaUrl(media.url, { video: true })) {
    throw new ReelError("NO_MP4", "No downloadable MP4 was found. Play the Reel, then try again.");
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const mediaId = [...reel.shortcode].reduce((id, character) =>
    id * 64n + BigInt(alphabet.indexOf(character)), 0n).toString();
  if (media.mediaId !== undefined && media.mediaId !== null && media.mediaId !== mediaId &&
      !(Number.isSafeInteger(media.mediaId) && String(media.mediaId) === mediaId)) {
    throw new ReelError("MEDIA_MISMATCH", "Instagram returned a different Reel. Reload the Reel, then try again.");
  }
  const owner = media.ownerProfile;
  const ownerId = typeof owner?.id === "string" ? owner.id :
    Number.isSafeInteger(owner?.id) && owner.id > 0 ? String(owner.id) : "";
  const ownerProfile = /^[1-9][0-9]{0,29}$/.test(ownerId) &&
    typeof owner?.username === "string" && /^[A-Za-z0-9._]{1,30}$/.test(owner.username)
    ? { id: ownerId, username: owner.username } : null;
  const dimension = (value) => Number.isFinite(Number(value)) ?
    Math.min(16384, Math.max(0, Math.round(Number(value)))) : 0;
  return {
    shortcode: reel.shortcode,
    mediaId,
    pageUrl: reel.pageUrl,
    username: ownerProfile?.username || (typeof media.username === "string" ? media.username.slice(0, 64) : ""),
    ...(ownerProfile ? { ownerProfile } : {}),
    width: dimension(media.width),
    height: dimension(media.height),
    url: media.url,
    ...(isInstagramMediaUrl(media.thumbnailUrl) ? { thumbnailUrl: media.thumbnailUrl } : {}),
    source: typeof media.source === "string" ? media.source.slice(0, 32) : "",
  };
}

export function sanitizeFilenamePart(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

export function buildFilename(media) {
  const author = sanitizeFilenamePart(media.username);
  const shortcode = sanitizeFilenamePart(media.shortcode);
  if (!shortcode) throw new ReelError("INVALID_REEL", "The Reel address is invalid.");
  return `Reel Saver/${author ? `${author}_` : "reel_"}${shortcode}.mp4`;
}

export function publicMedia(media) {
  const { url, ...display } = media;
  return display;
}

const downloadErrors = {
  USER_CANCELED: "The download was canceled. Click Retry to download it again.",
  NETWORK_FAILED: "The connection failed. Check your connection, then retry.",
  NETWORK_TIMEOUT: "The download timed out. Please retry.",
  NETWORK_DISCONNECTED: "The connection was lost. Reconnect, then retry.",
  SERVER_FORBIDDEN: "The video link expired or was refused. Reload the Reel, then retry.",
  SERVER_UNAUTHORIZED: "Instagram refused the video link. Reload the Reel while signed in, then retry.",
  SERVER_BAD_CONTENT: "Instagram did not return a video. Reload the Reel, then retry.",
  FILE_ACCESS_DENIED: "Chrome could not write the file. Check your download folder, then retry.",
  FILE_NO_SPACE: "Your download drive is full. Free some space, then retry.",
};

export function summarizeDownload(item) {
  let state = item.state;
  let error = item.error ? downloadErrors[item.error] ||
    "Chrome could not finish the download. Check Chrome Downloads, then retry." : undefined;
  if (state === "complete" && item.exists === false) {
    state = "interrupted";
    error = "The saved file has been moved or removed. Click Retry to save it again.";
  }
  // A login/error page saved with an MP4 filename is not a successful video download.
  if (state === "complete" && item.mime &&
      !/^(video\/mp4|application\/(octet-stream|mp4))(?:;|$)/i.test(item.mime)) {
    state = "interrupted";
    error = "Instagram returned a different file instead of an MP4. Reload the Reel, then retry.";
  }
  return {
    id: item.id,
    state,
    ...(error ? { error } : {}),
    ...(item.filename ? { filename: item.filename.replaceAll("\\", "/").split("/").pop() } : {}),
  };
}
