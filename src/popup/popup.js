const elements = {
  card: document.querySelector('#reel-card'),
  title: document.querySelector('#reel-title'),
  meta: document.querySelector('#reel-meta'),
  thumbnail: document.querySelector('#thumbnail'),
  placeholder: document.querySelector('#preview-placeholder'),
  previewLabel: document.querySelector('#preview-label'),
  status: document.querySelector('#status'),
  indicator: document.querySelector('#status-indicator'),
  message: document.querySelector('#status-message'),
  button: document.querySelector('#download-button'),
  buttonLabel: document.querySelector('#button-label'),
};

let activeTabId;
let currentMedia;
let currentDownloadId;
let busy = false;
let closed = false;
let pollTimer;

function setStatus(message, tone = 'neutral', spinning = false) {
  elements.message.textContent = message;
  elements.status.dataset.tone = tone;
  elements.indicator.classList.toggle('is-spinning', spinning);
}

function setButton(label, disabled, complete = false) {
  elements.buttonLabel.textContent = label;
  elements.button.disabled = disabled;
  elements.button.dataset.complete = String(complete);
}

function resetPreview() {
  elements.thumbnail.hidden = true;
  elements.thumbnail.removeAttribute('src');
  elements.placeholder.hidden = false;
}

function safeThumbnail(value) {
  try {
    const url = new URL(value);
    const domains = ['cdninstagram.com', 'fbcdn.net', 'instagram.com'];
    return url.protocol === 'https:' && domains.some((domain) =>
      url.hostname === domain || url.hostname.endsWith(`.${domain}`)) ? url.href : null;
  } catch {
    return null;
  }
}

function renderMedia(media) {
  currentMedia = media;
  elements.title.textContent = media.username ? `@${media.username}` : 'Your Reel is ready';
  elements.title.title = elements.title.textContent;
  const dimensions = Number(media.width) > 0 && Number(media.height) > 0
    ? `${media.width} × ${media.height} · ` : '';
  elements.meta.textContent = `${dimensions}MP4 video`;
  elements.previewLabel.textContent = 'A little moment worth keeping.';
  resetPreview();
  const thumbnailUrl = safeThumbnail(media.thumbnailUrl);
  if (thumbnailUrl) elements.thumbnail.src = thumbnailUrl;
  elements.card.setAttribute('aria-busy', 'false');
}

function showError(error, duringDownload = false) {
  busy = false;
  clearTimeout(pollTimer);
  elements.card.setAttribute('aria-busy', 'false');
  if (!currentMedia) {
    elements.title.textContent = 'Open an Instagram Reel';
    elements.meta.textContent = 'Then click ReelNest to download it.';
    elements.previewLabel.textContent = 'Your next saved moment starts here.';
    resetPreview();
  }
  setStatus(error?.message || (duringDownload
    ? 'The download did not finish. Please try again.'
    : 'Could not read this Reel. Refresh Instagram and try again.'), 'error');
  setButton('Retry', false);
}

async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) {
    const error = new Error(response?.error?.message || 'ReelNest could not complete this request. Please try again.');
    error.code = response?.error?.code;
    throw error;
  }
  return response;
}

function renderDownload(download) {
  currentDownloadId = download.id;
  if (download.state === 'complete') {
    busy = false;
    setStatus('Your MP4 is saved. Enjoy it anytime.', 'success');
    setButton('Downloaded', true, true);
    return;
  }
  if (download.state === 'interrupted') {
    showError({ message: download.error || 'The download was interrupted. Please try again.' }, true);
    return;
  }
  busy = true;
  setStatus('Saving your MP4. You can close this popup.', 'neutral', true);
  setButton('Downloading…', true);
  pollTimer = setTimeout(pollDownload, 700);
}

async function pollDownload() {
  if (closed || currentDownloadId === undefined) return;
  try {
    const response = await request({ type: 'REEL_SAVER_STATUS', downloadId: currentDownloadId });
    if (!closed) renderDownload(response.download);
  } catch (error) {
    if (!closed) showError(error, true);
  }
}

async function inspectCurrentReel() {
  busy = true;
  currentMedia = undefined;
  currentDownloadId = undefined;
  clearTimeout(pollTimer);
  resetPreview();
  elements.card.setAttribute('aria-busy', 'true');
  elements.title.textContent = 'Finding your Reel…';
  elements.meta.textContent = 'Keep this Instagram tab open.';
  setStatus('Checking the current page…', 'neutral', true);
  setButton('Finding Reel…', true);
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) throw new Error('Open an Instagram Reel in a browser tab first.');
    activeTabId = tab.id;
    const response = await request({ type: 'REEL_SAVER_INSPECT', tabId: activeTabId });
    if (closed) return;
    renderMedia(response.media);
    if (response.download) {
      renderDownload(response.download);
    } else {
      busy = false;
      setStatus('Ready when you are. Save this Reel as an MP4.');
      setButton('Download MP4', false);
    }
  } catch (error) {
    if (!closed) showError(error);
  }
}

async function downloadCurrentReel() {
  if (busy) return;
  if (!currentMedia) return inspectCurrentReel();
  busy = true;
  clearTimeout(pollTimer);
  setStatus('Preparing your MP4…', 'neutral', true);
  setButton('Downloading…', true);
  try {
    const response = await request({
      type: 'REEL_SAVER_DOWNLOAD',
      tabId: activeTabId,
      shortcode: currentMedia.shortcode,
    });
    if (closed) return;
    if (response.media) renderMedia(response.media);
    renderDownload(response.download);
  } catch (error) {
    if (closed) return;
    if (['REEL_CHANGED', 'PAGE_CHANGED', 'INVALID_PAGE', 'NOT_A_REEL', 'NOT_REEL', 'TAB_CLOSED', 'PAGE_UNAVAILABLE'].includes(error.code)) currentMedia = undefined;
    showError(error, true);
  }
}

elements.thumbnail.addEventListener('load', () => {
  elements.thumbnail.hidden = false;
  elements.placeholder.hidden = true;
});
elements.thumbnail.addEventListener('error', resetPreview);
elements.button.addEventListener('click', downloadCurrentReel);
window.addEventListener('pagehide', () => {
  closed = true;
  clearTimeout(pollTimer);
});

inspectCurrentReel();
