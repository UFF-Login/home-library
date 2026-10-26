// Frontend. No framework, no build step: the browser loads exactly the files in
// this folder, which is what keeps a container update to a single `docker pull`.
//
// Fast path that matters: a local ISBN index (isbn -> {title, state}) is kept in
// localStorage, so a scan of a book you own is answered before any network call
// returns - and it still answers with no signal at all.
import { startScanner, stopScanner, setTorch, hasTorch, getTorchState } from './scanner.js';

// Tells index.html's inline guard that the module actually executed, so a failed
// load shows a message instead of an empty page.
window.__appStarted = true;

const INDEX_KEY = 'bookshelf.isbnIndex.v1';
const state = {
  tab: 'scan',
  filter: '',
  query: '',
  books: [],
  series: [],
  stats: null,
  index: new Map(),
  scanning: false,
  torch: false,
  lastScan: null,
  // Loaded once at boot: the book sheet needs these before the More tab is ever
  // opened, and an undefined list was crashing the sheet open.
  owners: [],
  defaultOwner: null,
  // Series are filtered in the browser: the whole list is already loaded.
  seriesQuery: '',
};

const $ = (id) => document.getElementById(id);
const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------------------------------------------------------------- api

class AuthError extends Error {}

async function api(path, { method = 'GET', body, raw = false } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    showGate();
    throw new AuthError('auth required');
  }
  if (raw) return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error ?? `request failed (${res.status})`);
    error.data = data;
    throw error;
  }
  return data;
}

// ---------------------------------------------------------------- toast + sheet

let toastTimer = null;
function toast(message) {
  const node = $('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 2400);
}

function openSheet(html) {
  $('sheet-body').innerHTML = html;
  $('sheet').hidden = false;
  $('sheet-backdrop').hidden = false;
}
function closeSheet() {
  $('sheet').hidden = true;
  $('sheet-backdrop').hidden = true;
  $('sheet-body').innerHTML = '';
}

// ---------------------------------------------------------------- gate

function showGate() {
  stopScanner();
  state.scanning = false;
  $('gate').hidden = false;
  $('app').hidden = true;
  $('tabs').hidden = true;
}

$('gate-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const pin = $('pin').value.trim();
  $('gate-error').textContent = '';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      $('gate-error').textContent =
        data.error === 'too_many_attempts'
          ? 'Too many attempts. Wait ten minutes.'
          : data.error === 'wrong_pin'
            ? 'Wrong PIN.'
            : 'Could not unlock.';
      return;
    }
    $('pin').value = '';
    $('gate').hidden = true;
    boot();
  } catch {
    $('gate-error').textContent = 'Network error.';
  }
});

// ---------------------------------------------------------------- tabs

const TAB_META = {
  scan: { eyebrow: 'Scanning', title: 'Scan a book' },
  shelf: { eyebrow: 'Catalogue', title: 'Your shelf' },
  series: { eyebrow: 'Collections', title: 'Series' },
  more: { eyebrow: 'Settings', title: 'More' },
};

function setTab(tab) {
  state.tab = tab;
  for (const button of document.querySelectorAll('.tab')) {
    button.classList.toggle('active', button.dataset.tab === tab);
  }
  for (const view of document.querySelectorAll('.view')) {
    view.classList.toggle('active', view.id === `view-${tab}`);
  }
  $('eyebrow').textContent = TAB_META[tab].eyebrow;
  $('view-title').textContent = TAB_META[tab].title;

  if (tab === 'scan') startCamera();
  else stopCamera();

  if (tab === 'shelf') renderShelf();
  if (tab === 'series') renderSeries();
  if (tab === 'more') renderMore();
}

for (const button of document.querySelectorAll('.tab')) {
  button.addEventListener('click', () => setTab(button.dataset.tab));
}

// ---------------------------------------------------------------- camera

function setScanStatus(text, kind) {
  const node = $('scan-status');
  node.textContent = text;
  node.style.color = kind === 'error' ? 'var(--warn)' : 'var(--text)';
}

async function startCamera() {
  if (state.scanning) return;
  state.scanning = true;
  $('btn-camera').textContent = 'Stop camera';
  const started = await startScanner({
    video: $('video'),
    onCode: (isbn) => handleScan(isbn),
    onStatus: setScanStatus,
  });
  // No camera (denied, absent, or plain http) leaves the button claiming to be
  // stoppable when nothing is running - put it back.
  if (!started) {
    state.scanning = false;
    $('btn-camera').textContent = 'Try camera again';
    return;
  }
  // Re-evaluate the torch for THIS stream: a previous stream may have had one
  // and this one may not (front vs rear camera), and a stale "No light" label
  // must not survive a restart.
  const torchButton = $('btn-torch');
  const torchAvailable = await hasTorch();
  torchButton.hidden = !torchAvailable;
  if (torchAvailable) {
    torchButton.disabled = false;
    torchButton.title = '';
    torchButton.textContent = (await getTorchState()) ? 'Light off' : 'Light on';
  }
}

function stopCamera() {
  if (!state.scanning) return;
  stopScanner();
  state.scanning = false;
  state.torch = false;
  $('btn-torch').hidden = true;
  $('btn-camera').textContent = 'Start camera';
  setScanStatus('Camera off');
}

$('btn-camera').addEventListener('click', () => (state.scanning ? stopCamera() : startCamera()));

$('btn-torch').addEventListener('click', async () => {
  // Ask the camera what it is doing rather than trusting a remembered boolean:
  // the OS can switch the light off on its own, and then the button's next tap
  // would send "off" to an already-off light and report a false failure.
  const isOn = await getTorchState();
  const want = !isOn;

  let result = await setTorch(want);

  // A stream that has been dropped (backgrounded tab, camera handed to another
  // app) cannot be controlled until it is re-opened. Re-open and try once more.
  if (!result.ok && result.needsRestart) {
    stopCamera();
    await startCamera();
    result = await setTorch(want);
  }

  if (result.ok) {
    state.torch = want;
    $('btn-torch').textContent = want ? 'Light off' : 'Light on';
    toast(want ? 'Light on' : 'Light off');
    return;
  }

  if (!result.supported) {
    // Disable rather than hide: hiding it is what made it seem to vanish
    // permanently after one bad tap.
    $('btn-torch').disabled = true;
    $('btn-torch').textContent = 'No light';
    $('btn-torch').title = 'This camera has no torch';
    return;
  }

  // Supported but refused this time - keep the button live so it can be retried.
  toast('Light did not change — tap again');
});

$('btn-manual').addEventListener('click', () => {
  const panel = $('manual-panel');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) $('manual-isbn').focus();
});

$('btn-manual-go').addEventListener('click', () => {
  const value = $('manual-isbn').value.trim();
  if (value) handleScan(value);
});

$('manual-isbn').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') $('btn-manual-go').click();
});

// ---------------------------------------------------------------- index (offline + instant)

function loadIndex() {
  try {
    const raw = JSON.parse(localStorage.getItem(INDEX_KEY) ?? '{}');
    state.index = new Map(Object.entries(raw));
  } catch {
    state.index = new Map();
  }
}

function saveIndex(books) {
  const map = {};
  for (const book of books) {
    map[book.isbn13] = { title: book.title, state: book.state, author: book.author ?? null };
  }
  state.index = new Map(Object.entries(map));
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(map));
  } catch {
    // A full quota just means no offline index; the app still works online.
  }
}

// ---------------------------------------------------------------- scan

function setResult(html) {
  const node = $('scan-result');
  node.innerHTML = html;
  // Bring the verdict into view. The viewfinder is deliberately small, but on a
  // short phone the card can still start below the fold - and a scan you cannot
  // see the result of is a wasted scan.
  const card = node.querySelector('.card');
  if (card) {
    const rect = card.getBoundingClientRect();
    const hiddenBelow = rect.bottom > window.innerHeight - 70;
    if (rect.top < 0 || hiddenBelow) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

let enrichmentToken = 0;

async function handleScan(rawIsbn) {
  const isbn = String(rawIsbn ?? '').replace(/[^0-9Xx]/g, '');
  const token = ++enrichmentToken;

  // Instant answer from the local index: this is what makes a scan feel
  // immediate in a shop, and it works with no signal.
  const known = state.index.get(isbn);
  if (known) {
    setResult(resultCard({ verdict: known.state, isbn13: isbn, book: known, pending: true }));
  } else {
    setResult(`<div class="card"><div class="verdict"><span class="dot"></span>Checking ${esc(isbn)}…</div></div>`);
  }

  let data;
  try {
    data = await api('/api/scan', { method: 'POST', body: { isbn } });
  } catch (error) {
    if (error instanceof AuthError) return;
    if (known) {
      setResult(resultCard({ verdict: known.state, isbn13: isbn, book: known, offline: true }));
      return;
    }
    setResult(`<div class="card"><div class="verdict v-unknown"><span class="dot"></span>No connection</div><p class="book-sub">Could not reach the server and this ISBN is not in the local index.</p></div>`);
    return;
  }

  // The verdict is final at this point. The card may still be missing its
  // title/author, which arrives from a second request.
  state.lastScan = data;
  setResult(resultCard(data));
  if (data.book && data.series) refreshSeriesSoon();

  if (data.verdict === 'missing' && !data.metaReady) {
    enrichMissing(isbn, token);
  }
}

/**
 * Fetch the book details for a book you don't own. Runs after the verdict is on
 * screen, so a slow Open Library never delays the answer the user cares about.
 */
async function enrichMissing(isbn, token) {
  try {
    const meta = await api(`/api/lookup/${isbn}`);
    // Drop the result if another book has been scanned in the meantime.
    if (token !== enrichmentToken || state.lastScan?.isbn13 !== isbn) return;

    state.lastScan = {
      ...state.lastScan,
      preview: meta.found ? meta.work : null,
      series: meta.series ?? null,
      metaReady: true,
      metaFound: meta.found,
      metaCached: meta.cached,
      lookupMs: meta.lookupMs ?? null,
      sources: meta.sources ?? {},
    };
    setResult(resultCard(state.lastScan));
  } catch {
    if (token !== enrichmentToken) return;
    state.lastScan = { ...state.lastScan, metaReady: true, metaFound: false };
    setResult(resultCard(state.lastScan));
  }
}

let seriesRefreshTimer = null;
function refreshSeriesSoon() {
  clearTimeout(seriesRefreshTimer);
  seriesRefreshTimer = setTimeout(() => {
    loadSeries().catch(() => {});
  }, 1200);
}

const VERDICT_TEXT = {
  owned: 'You own this',
  wishlist: 'On your wishlist',
  missing: 'Not in your library',
  unknown: 'No record found',
  invalid: 'Not a book barcode',
};

/**
 * Cover markup.
 *
 * The URL carries the build id, because a browser that once cached a 404 for
 * /cover/<isbn>.jpg will keep showing "no cover" long after the server started
 * returning the image. A new build means a new URL, so the picture appears.
 * If the image still fails, it retries once with a timestamp before giving up -
 * covers are fetched on demand, so the first request can be slow.
 */
function coverHtml(book, fallbackIsbn) {
  // The scan card's preview comes from the lookup API, which historically had no
  // isbn13 - so the fallback is what makes the cover appear before the book is
  // added to the catalogue.
  const isbnValue = book?.isbn13 ?? fallbackIsbn ?? null;
  if (!isbnValue) return `<div class="cover">no cover</div>`;
  const isbn = esc(isbnValue);
  const bust = encodeURIComponent(state.version || 'dev');
  // `e` is the server's cover epoch: when it changes (after a wipe, or a bulk
  // refetch) every cover URL is new, so the phone cannot keep showing pictures of
  // books that no longer exist.
  const epoch = state.coverEpoch ?? 0;
  const src = `/cover/${isbn}.jpg?b=${bust}&e=${epoch}`;
  return `<div class="cover"><img src="${src}" alt="" loading="lazy"
    onerror="if(this.dataset.retry){this.replaceWith(Object.assign(document.createElement('div'),{className:'cover',textContent:'no cover'}))}else{this.dataset.retry=1;this.src='${src}&r='+Date.now()}" /></div>`;
}

/**
 * Web rating and your own, side by side and colour-coded. The web one is only
 * present when a provider had data; yours only exists once you have rated it.
 */
/**
 * Which providers were actually consulted, and what they said.
 *
 * Without this the app is indistinguishable from one that never tries Google:
 * "no record" and "never asked" look the same on screen. The flags come from the
 * server ('ok', 'failed', 'skipped', 'off'), so this is a report of what happened
 * rather than a guess.
 */
function sourcesLine(data) {
  if (!data?.metaReady) return '';
  const google = data.sources?.googleBooks;
  const found = Boolean(data.preview);

  if (found) {
    const via = [data.preview?.workKey ? 'Open Library' : null, google === 'ok' ? 'Google Books' : null]
      .filter(Boolean)
      .join(' + ');
    return `<div class="sources-line">Found via ${esc(via || 'cached record')}</div>`;
  }

  if (google === 'off') {
    return '<div class="sources-line warn">Open Library has no record. No Google Books key is configured, so nothing else was tried.</div>';
  }
  if (google === 'failed') {
    // The reason comes from Google itself, so a key restriction is not mistaken
    // for a quota problem.
    const why = data.sources?.googleReason ? `: ${data.sources.googleReason}` : '';
    return `<div class="sources-line warn">Open Library has no record, and Google Books would not answer${esc(why)}</div>`;
  }
  if (google === 'partial') {
    // Google recognises the ISBN but would not give up the details: say so rather
    // than claiming the book is unknown.
    const why = data.sources?.googleReason ? ` (${data.sources.googleReason})` : '';
    return `<div class="sources-line warn">Open Library has no record. Google knows this book but would not return its details${esc(why)}</div>`;
  }
  if (google === 'ok' || google === 'empty') {
    return '<div class="sources-line warn">No record in Open Library or Google Books.</div>';
  }
  return '<div class="sources-line warn">Open Library has no record.</div>';
}

function ratingPills(book) {
  if (!book) return '';
  const pills = [];
  if (book.rating) {
    pills.push(
      `<span class="rating-pill rating-web">★ ${esc(book.rating)}${book.ratingsCount ? ` <small>${esc(book.ratingsCount)}</small>` : ''}</span>`,
    );
  }
  if (book.myRating) {
    pills.push(`<span class="rating-pill rating-mine">★ ${esc(book.myRating)} <small>yours</small></span>`);
  }
  return pills.length ? `<div class="rating-pills">${pills.join('')}</div>` : '';
}

function seriesNote(series, volume) {
  if (!series) return '';
  const gaps = (series.ranges ?? []).filter((range) => {
    if (!volume) return true;
    const [start, end] = String(range).split('-').map(Number);
    const v = Math.trunc(volume);
    return end ? !(v >= start && v <= end) : v !== start;
  });
  const gapsText = gaps.length ? `You're missing ${gaps.slice(0, -1).join(', ')}${gaps.length > 1 ? ' and ' : ''}${gaps.slice(-1)}` : '';
  const bits = [];
  if (series.ownedCount) bits.push(`You have ${series.ownedCount} of ${series.name}`);
  if (gapsText) bits.push(gapsText);
  if (!bits.length) return '';
  return `<div class="series-note">${esc(bits.join('. '))}</div>`;
}

function resultCard(data) {
  const verdict = data.verdict;
  const book = data.book ?? data.preview ?? null;
  const title =
    (book?.title || (data.verdict === 'invalid' ? 'Not an ISBN barcode' : 'Unknown book'));
  const authors = Array.isArray(book?.authors) ? book.authors : book?.author ? [book.author] : [];
  const volumeLabel = book?.series && book?.volume ? `${book.series} #${book.volume}` : book?.series ?? '';

  // "missing" can be shown before the title is known, because the verdict does
  // not depend on it. Say that plainly instead of showing a fake empty title.
  const awaitingMeta = verdict === 'missing' && !data.metaReady;
  const noRecord = verdict === 'missing' && data.metaReady && !book;

  const meta = [
    authors.slice(0, 2).join(', '),
    volumeLabel,
    book?.published,
    // Community rating, when Open Library has one for the work.
    book?.rating ? `★ ${book.rating}${book.ratingsCount ? ` (${book.ratingsCount})` : ''}` : null,
    awaitingMeta
      ? 'looking up details…'
      : data.lookupMs
        ? // The verdict is local and instant; the details are the slow part, and
          // showing only '13 ms' while the phone waits 40 seconds is a lie.
          `details took ${(data.lookupMs / 1000).toFixed(1)} s`
        : `checked in ${data.elapsedMs ?? 0} ms`,
  ].filter(Boolean);

  /**
   * Exactly three choices, always in the same place: this is mine, put it on the
   * wishlist, or ignore the scan. Everything else (metadata, covers, ratings,
   * ownership) happens without asking.
   */
  const isOwned = verdict === 'owned';
  const isWished = verdict === 'wishlist';
  let actions = '';
  if (verdict === 'invalid') {
    actions = '<p class="book-sub">That code is not a book ISBN. Point at the barcode on the back cover.</p>';
  } else {
    actions = `<div class="btn-row actions">
        <button class="${isOwned ? 'primary active' : 'primary'}" data-act="buy" data-isbn="${esc(data.isbn13)}">${isOwned ? '✓ Owned' : 'I own it'}</button>
        <button class="${isWished ? 'active' : ''}" data-act="wish" data-isbn="${esc(data.isbn13)}">${isWished ? '✓ Wishlist' : 'Wishlist'}</button>
        <button class="ghost" data-act="skip">Ignore</button>
      </div>`;
  }

  return `<div class="card v-${esc(verdict)}">
    <div class="verdict"><span class="dot"></span>${esc(VERDICT_TEXT[verdict] ?? verdict)}</div>
    <div class="book-row"${
      // Once the book is in the library, the card itself is the way into it: tap to
      // open the detail sheet and edit anything.
      isOwned || isWished
        ? ` data-act="detail" data-isbn="${esc(data.isbn13)}" role="button" tabindex="0" title="Open this book"`
        : ''
    }>
      ${coverHtml(book, data.isbn13)}
      <div class="book-meta">
        <div class="book-title">${esc(noRecord ? 'No catalogue record' : title)}</div>
        <div class="book-sub">${esc(meta.join(' · '))}</div>
        <div class="book-extra">${esc(data.isbn13 ?? '')}</div>
      </div>
    </div>
    ${actions}
    ${ratingPills(book)}
    ${sourcesLine(data)}
    ${seriesNote(data.series, book?.volume)}
    ${noRecord ? '<p class="book-sub">No provider knows this ISBN yet. You can still save it now — the details are filled in automatically if they turn up later.</p>' : ''}
  </div>`;
}

$('scan-result').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-act]');
  if (!button) return;
  const act = button.dataset.act;
  const isbn = button.dataset.isbn;

  if (act === 'skip') return setResult('');
  if (act === 'detail') return openDetail(isbn);
  if (act === 'loan') {
    const who = prompt('Lent to (name)? Leave blank to mark as returned.');
    if (who === null) return;
    await saveBook(isbn, { loaned_to: who.trim() || null, loaned_at: who.trim() ? new Date().toISOString() : null });
    toast(who.trim() ? `Lent to ${who.trim()}` : 'Back on the shelf');
    return handleScan(isbn);
  }
  if (act === 'buy' || act === 'wish') {
    const targetState = act === 'buy' ? 'owned' : 'wishlist';
    const scan = state.lastScan;
    const work = scan && scan.isbn13 === isbn ? scan.preview : null;
    try {
      await addBook(isbn, targetState, work);
    } catch (error) {
      // This used to fail silently: an add with no metadata and no title returns
      // 422, the promise rejected into nothing, and the book simply never
      // appeared. Any failure now says so, and the not-found case goes straight
      // to the manual form with the ISBN already filled in.
      if (error?.data?.error === 'not_found' || error?.message === 'not_found') {
        toast('No catalogue record - add the title by hand');
        openManualAdd(isbn);
        return;
      }
      toast(`Could not add: ${error?.message ?? 'unknown error'}`);
      return;
    }
    const alreadyHere = state.lastScan?.verdict === (targetState === 'owned' ? 'owned' : 'wishlist');
    toast(
      alreadyHere
        ? targetState === 'owned'
          ? 'Already in your library'
          : 'Already on your wishlist'
        : targetState === 'owned'
          ? 'Added to your library'
          : 'Added to wishlist',
    );
    await Promise.all([loadShelf(), loadStats(), loadSeries()]);
    return handleScan(isbn);
  }
  if (act === 'manual-add') {
    openManualAdd(isbn);
  }
});

// ---------------------------------------------------------------- add / edit

async function addBook(isbn, bookState, work) {
  return api('/api/books', { method: 'POST', body: { isbn, state: bookState, work } });
}

async function saveBook(isbn, fields) {
  return api(`/api/books/${isbn}`, { method: 'PATCH', body: fields });
}

function openManualAdd(isbn) {
  openSheet(`
    <h2>Add manually</h2>
    <p class="hint">ISBN ${esc(isbn)} — no catalogue record was found. Fill in at least the title.</p>
    <div class="field"><label for="m-title">Title</label><input id="m-title" /></div>
    <div class="field"><label for="m-author">Author</label><input id="m-author" /></div>
    <div class="inline-fields">
      <div class="field"><label for="m-series">Series</label><input id="m-series" /></div>
      <div class="field"><label for="m-volume">Volume</label><input id="m-volume" inputmode="numeric" /></div>
    </div>
    <div class="btn-row">
      <button class="primary" id="m-save">Add to library</button>
      <button class="ghost" id="m-cancel">Cancel</button>
    </div>
  `);
  $('m-title').focus();
  $('m-cancel').addEventListener('click', closeSheet);
  $('m-save').addEventListener('click', async () => {
    const title = $('m-title').value.trim();
    if (!title) return toast('A title is needed');
    await api('/api/books', {
      method: 'POST',
      body: {
        isbn,
        state: 'owned',
        title,
        author: $('m-author').value.trim(),
        series: $('m-series').value.trim() || null,
        volume: $('m-volume').value ? Number($('m-volume').value) : null,
      },
    });
    closeSheet();
    toast('Added');
    await Promise.all([loadShelf(), loadStats()]);
    handleScan(isbn);
  });
}

const READ_OPTIONS = [
  ['unread', 'Unread'],
  ['reading', 'Reading'],
  ['read', 'Read'],
];

function openDetail(isbn) {
  const book = state.books.find((b) => b.isbn13 === isbn) ?? state.lastScan?.book ?? null;
  if (!book) return;

  openSheet(`
    <div class="book-row" style="margin-bottom:14px">
      ${coverHtml(book, isbn)}
      <div class="book-meta">
        <div class="book-title">${esc(book.title)}</div>
        <div class="book-sub">${esc((book.authors ?? []).join(', '))}</div>
        <div class="book-extra">${esc([book.owner, book.publisher, book.published, book.pages ? `${book.pages} pp` : null].filter(Boolean).join(' · '))}</div>
        ${
          book.series
            ? `<button class="link series-link" data-goto-series="${esc(book.series)}">${esc(book.series)}${
                book.volume ? ` #${esc(book.volume)}` : ''
              } →</button>`
            : ''
        }
        ${book.rating ? `<div class="book-extra">★ ${esc(book.rating)} <span>(${esc(book.ratingsCount ?? 0)})</span></div>` : ''}
      </div>
    </div>

    ${book.description ? `<p class="book-description">${esc(book.description)}</p>` : ''}
    ${
      // Placeholder records (saved before any provider identified them) would
      // otherwise stay nameless forever if no source ever answers.
      !book.title
        ? `<p class="hint">This book was saved without a title. It fills in automatically when a source recognises the ISBN.<br /><button class="link" data-act="manual-add" data-isbn="${esc(book.isbn13)}">Name it by hand instead</button></p>`
        : ''
    }

    <div class="field">
      <label>Status</label>
      <div class="btn-row">
        <button class="${book.state === 'owned' ? 'primary' : ''}" data-status="owned">Owned</button>
        <button class="${book.state === 'wishlist' ? 'primary' : ''}" data-status="wishlist">Wishlist</button>
      </div>
    </div>

    <div class="field">
      <label>Reading</label>
      <div class="btn-row">
        ${READ_OPTIONS.map(
          ([value, label]) =>
            `<button class="${book.readState === value ? 'primary' : ''}" data-read="${value}">${label}</button>`,
        ).join('')}
      </div>
    </div>

    <div class="ratings">
      <div class="rating-card rating-web">
        <span class="rating-label">From the web</span>
        <div class="rating-value">${book.rating ? `★ ${esc(book.rating)}` : '—'}</div>
        <div class="rating-count">${book.ratingsCount ? `${esc(book.ratingsCount)} ratings` : 'no data'}</div>
      </div>
      <div class="rating-card rating-mine">
        <span class="rating-label">Your rating</span>
        <div class="stars" id="rating-row">
          ${[1, 2, 3, 4, 5]
            .map((n) => `<button class="star ${book.myRating >= n ? 'on' : ''}" data-rate="${n}" aria-label="${n} of 5">★</button>`)
            .join('')}
        </div>
        <div class="rating-count">${book.myRating ? `you said ${book.myRating}/5` : 'not rated yet'}</div>
      </div>
    </div>

    <div class="field">
      <label for="d-owner">Who owns it</label>
      <select id="d-owner">
        <option value="">Nobody yet</option>
        ${ownerOptions(book.owner)}
      </select>
    </div>
    <div class="field"><label for="d-loan">Lent to</label><input id="d-loan" value="${esc(book.loanedTo ?? '')}" placeholder="Empty = on the shelf" /></div>

    <div class="field">
      <label>Series &amp; volume</label>
      <p class="hint" style="margin:0 0 6px">Filled in from Open Library when it knows them — nothing to type. Only correct it if it is wrong; the missing-number maths uses it.</p>
      <div class="inline-fields">
        <div class="field" style="margin:0"><input id="d-series" placeholder="Series" value="${esc(book.series ?? '')}" /></div>
        <div class="field" style="margin:0"><input id="d-volume" inputmode="numeric" placeholder="Volume" value="${esc(book.volume ?? '')}" /></div>
      </div>
    </div>

    <div class="field"><label for="d-notes">Notes</label><textarea id="d-notes" rows="3" placeholder="Anything worth remembering">${esc(book.notes ?? '')}</textarea></div>

    <div class="btn-row">
      <button class="primary" id="d-save">Save</button>
      <button class="ghost" id="d-close">Close</button>
      <button class="danger" id="d-delete">Delete</button>
    </div>
  `);

  const draft = { state: book.state, readState: book.readState, myRating: book.myRating };

  $('sheet-body').querySelectorAll('[data-status]').forEach((button) =>
    button.addEventListener('click', () => {
      draft.state = button.dataset.status;
      for (const other of $('sheet-body').querySelectorAll('[data-status]')) {
        other.classList.toggle('primary', other.dataset.status === draft.state);
      }
    }),
  );
  $('sheet-body').querySelectorAll('[data-read]').forEach((button) =>
    button.addEventListener('click', () => {
      draft.readState = button.dataset.read;
      for (const other of $('sheet-body').querySelectorAll('[data-read]')) {
        other.classList.toggle('primary', other.dataset.read === draft.readState);
      }
    }),
  );
  $('sheet-body').querySelectorAll('[data-rate]').forEach((button) =>
    button.addEventListener('click', () => {
      const value = Number(button.dataset.rate);
      draft.myRating = draft.myRating === value ? null : value;
      // Fill up to the chosen star; tapping the same star again clears it.
      for (const star of $('sheet-body').querySelectorAll('[data-rate]')) {
        star.classList.toggle('on', Number(star.dataset.rate) <= (draft.myRating ?? 0));
      }
      const note = $('rating-row')?.parentElement?.querySelector('.rating-count');
      if (note) note.textContent = draft.myRating ? `you said ${draft.myRating}/5` : 'not rated yet';
    }),
  );

  $('d-close').addEventListener('click', closeSheet);
  $('d-save').addEventListener('click', async () => {
    await saveBook(book.isbn13, {
      state: draft.state,
      read_state: draft.readState,
      my_rating: draft.myRating,
      owner: $('d-owner').value.trim() || null,
      loaned_to: $('d-loan').value.trim() || null,
      loaned_at: $('d-loan').value.trim() ? book.loanedAt ?? new Date().toISOString() : null,
      notes: $('d-notes').value.trim() || null,
      series: $('d-series').value.trim() || null,
      volume: $('d-volume').value ? Number($('d-volume').value) : null,
    });
    closeSheet();
    toast('Saved');
    await Promise.all([loadShelf(), loadStats(), loadSeries()]);
  });
  $('d-delete').addEventListener('click', async () => {
    if (!confirm(`Remove "${book.title}" from the catalogue?`)) return;
    await api(`/api/books/${book.isbn13}`, { method: 'DELETE' });
    closeSheet();
    toast('Removed');
    await Promise.all([loadShelf(), loadStats(), loadSeries()]);
  });
}

$('sheet-backdrop').addEventListener('click', closeSheet);

// ---------------------------------------------------------------- shelf

async function loadShelf() {
  const params = new URLSearchParams();
  if (state.query) params.set('q', state.query);
  if (state.filter === 'owned' || state.filter === 'wishlist') params.set('state', state.filter);
  const data = await api(`/api/books?${params.toString()}`);
  state.books = data.books;
  if (!state.query && !state.filter) saveIndex(data.books);
  renderShelf();
  $('owned-count').textContent = `${data.count} ${data.count === 1 ? 'book' : 'books'}`;
}

/**
 * Tapping a book on the shelf opens it.
 *
 * There was no handler here at all: the only way into a book's details was
 * through a scan result, so the shelf looked inert.
 */
$('shelf-grid').addEventListener('click', (event) => {
  const tile = event.target.closest('[data-isbn]');
  if (tile) openDetail(tile.dataset.isbn);
});

function renderShelf() {
  const books = state.filter === 'loaned' ? state.books.filter((b) => b.loanedTo) : state.books;
  const grid = $('shelf-grid');

  const tile = (book) => `<button class="tile ${book.state === 'wishlist' ? 'badge' : ''}" data-badge="wish" data-isbn="${esc(book.isbn13)}">
        ${coverHtml(book)}
        <div class="tile-title">${esc(book.title || 'Unknown book')}</div>
        <div class="tile-author">${esc((book.authors ?? [])[0] ?? '')}</div>
      </button>`;

  /**
   * Grouping answers "what have I got by this author / in this series" without a
   * search, which is the question a shelf is usually asked.
   */
  const groupOf = (book) =>
    state.groupBy === 'author'
      ? (book.authors ?? [])[0] || 'Unknown author'
      : state.groupBy === 'series'
        ? book.series || 'No series'
        : null;

  grid.classList.toggle('grouped', Boolean(state.groupBy));

  if (!state.groupBy) {
    grid.innerHTML = books.map(tile).join('');
    $('shelf-empty').hidden = books.length > 0;
    $('shelf-empty').textContent = 'Nothing here yet. Scan a barcode to start.';
    return;
  }

  const groups = new Map();
  for (const book of books) {
    const key = groupOf(book);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(book);
  }

  // Series groups in volume order; everything else alphabetically by title.
  const names = [...groups.keys()].sort((a, b) => {
    // "No series" and "Unknown author" sort last: they are the leftovers.
    const leftovers = (name) => name === 'No series' || name === 'Unknown author';
    if (leftovers(a) !== leftovers(b)) return leftovers(a) ? 1 : -1;
    return a.localeCompare(b, undefined, { sensitivity: 'base' });
  });

  grid.innerHTML = names
    .map((name) => {
      const items = groups.get(name).sort((a, b) => {
        if (state.groupBy === 'series') {
          if ((a.volume ?? 0) !== (b.volume ?? 0)) return (a.volume ?? 0) - (b.volume ?? 0);
        }
        return (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' });
      });
      return `<section class="book-group">
        <div class="group-head"><span>${esc(name)}</span><span class="group-count">${items.length}</span></div>
        <div class="grid">${items.map(tile).join('')}</div>
      </section>`;
    })
    .join('');

  $('shelf-empty').hidden = books.length > 0;
  $('shelf-empty').textContent = 'Nothing here yet. Scan a barcode to start.';
}

$('group-by').addEventListener('change', (event) => {
  state.groupBy = event.target.value;
  renderShelf();
});


$('shelf-grid').addEventListener('click', (event) => {
  const tile = event.target.closest('.tile');
  if (tile) openDetail(tile.dataset.isbn);
});

let searchTimer = null;
$('series-search').addEventListener('input', (event) => {
  state.seriesQuery = event.target.value;
  // Client-side: the whole series list is already in memory, so this is immediate.
  renderSeries();
});

$('search').addEventListener('input', (event) => {
  state.query = event.target.value.trim();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadShelf().catch(() => {}), 220);
});

$('shelf-filters').addEventListener('click', (event) => {
  const chip = event.target.closest('.chip');
  if (!chip) return;
  state.filter = chip.dataset.filter;
  for (const other of $('shelf-filters').querySelectorAll('.chip')) {
    other.classList.toggle('active', other === chip);
  }
  loadShelf().catch(() => {});
});

// ---------------------------------------------------------------- series

async function loadSeries() {
  const data = await api('/api/series');
  state.series = data.series;
  renderSeries();
}

function renderSeries() {
  const list = $('series-list');
  const query = (state.seriesQuery ?? '').trim().toLowerCase();
  const withVolumes = state.series
    .filter((s) => s.ownedCount > 0)
    // Matching is on the series name only: that is what the page lists, and it
    // keeps the filter predictable while typing.
    .filter((s) => !query || s.name.toLowerCase().includes(query));

  list.innerHTML = withVolumes
    .map((series) => {
      const owned = new Set(series.ownedVolumes.map((v) => Math.trunc(v)));
      const highest = Math.max(series.highestOwned ?? 0, ...owned, 0);
      const pills = [];
      for (let v = 1; v <= highest; v += 1) {
        pills.push(
          owned.has(v)
            ? `<span class="pill owned">${v}</span>`
            : `<span class="pill gap">${v}</span>`,
        );
      }
      return `<div class="series-card">
        <div class="series-head">
          <div class="series-name">${esc(series.name)}</div>
          <div class="series-count">${series.ownedCount} owned</div>
        </div>
        ${series.ranges?.length ? `<div class="gap">Missing ${esc(series.ranges.join(', '))}</div>` : '<div class="hint" style="margin:0">Complete to the highest volume you own.</div>'}
        <div class="vol-pills">${pills.join('')}</div>
        <button class="ghost series-more-btn" data-series-volumes="${esc(series.key)}">What else is in this series?</button>
        <div class="series-more" hidden></div>
      </div>`;
    })
    .join('');

  $('series-empty').hidden = withVolumes.length > 0;
  // Say which emptiness this is: nothing detected, or nothing matching the search.
  $('series-empty').textContent = query
    ? `No series match “${(state.seriesQuery ?? '').trim()}”.`
    : 'No series detected yet.';
}

// ---------------------------------------------------------------- more

async function loadStats() {
  state.stats = await api('/api/stats');
  const stats = state.stats;
  $('stat-grid').innerHTML = [
    ['Owned', stats.owned],
    ['Wishlist', stats.wishlist],
    ['Read', stats.read],
    ['On loan', stats.loaned],
    ['Series', stats.series],
    ['Authors', stats.authors],
  ]
    .map(([label, value]) => `<div class="stat"><b>${esc(value)}</b><span>${esc(label)}</span></div>`)
    .join('');
}

/**
 * Options for the owner drop-down. A name that is no longer in the list (renamed
 * or removed since) is kept as its own option, so opening a book can never
 * silently change who owns it.
 */
function ownerOptions(current) {
  const owners = state.owners ?? [];
  const names = owners.map((owner) => owner.name);
  const extra = current && !names.includes(current) ? [current] : [];
  return [...owners.map((owner) => owner.name), ...extra]
    .map(
      (name) =>
        `<option value="${esc(name)}" ${name === current ? 'selected' : ''}>${esc(name)}</option>`,
    )
    .join('');
}

async function loadOwners() {
  try {
    const data = await api('/api/owners');
    state.owners = data.owners ?? [];
    state.defaultOwner = data.defaultOwner ?? null;
  } catch {
    state.owners = [];
    state.defaultOwner = null;
  }
  renderOwners();
}

function renderOwners() {
  const node = $('owner-list');
  if (!node) return;
  if (!state.owners.length) {
    node.innerHTML = '<p class="hint">No owners yet — add the first one below.</p>';
    return;
  }
  node.innerHTML = state.owners
    .map(
      (owner) => `<div class="owner-row">
        <span class="owner-name">${esc(owner.name)}${owner.isDefault ? ' <small>default</small>' : ''}</span>
        ${owner.isDefault ? '' : `<button class="link" data-owner-default="${owner.id}">Make default</button>`}
        <button class="link danger" data-owner-delete="${owner.id}" data-owner-name="${esc(owner.name)}">Remove</button>
      </div>`,
    )
    .join('');
}

/** Owners are entered once; picking one for a book is a drop-down, never typing. */
async function addOwnerFromInput() {
  const input = $('owner-name');
  const name = input.value.trim();
  if (!name) return;
  try {
    await api('/api/owners', { method: 'POST', body: { name } });
    input.value = '';
    $('owner-status').textContent = '';
    await loadOwners();
  } catch (error) {
    $('owner-status').textContent =
      error?.message === 'owner_exists' ? 'That name is already in the list.' : 'Could not add that name.';
  }
}

async function renderMore() {
  await Promise.all([loadStats(), loadRecentScans(), loadSourceStatus(), loadOwners()]);
}

/**
 * Which metadata sources are actually live. Series comes from Wikidata and needs
 * no key; Google Books is optional and only used for ratings/descriptions.
 */
async function loadSourceStatus() {
  const node = $('sources-status');
  if (!node) return;
  try {
    const settings = await api('/api/settings');
    node.textContent = settings.googleBooks
      ? 'Ratings: Open Library + Google Books. Series: Wikidata.'
      : 'Ratings: Open Library only. Series: Wikidata. (Google Books key not set.)';
  } catch {
    node.textContent = '';
  }
}

async function loadRecentScans() {
  const data = await api('/api/scans');
  $('recent-scans').innerHTML =
    data.scans
      .slice(0, 12)
      .map(
        (scan) => `<div><span>${esc(scan.title ?? scan.isbn13 ?? '—')}</span><b>${esc(scan.verdict)}</b></div>`,
      )
      .join('') || '<div>No scans yet</div>';
}

$('btn-logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  showGate();
});

$('btn-refresh').addEventListener('click', () => refreshApp());

$('btn-covers').addEventListener('click', async () => {
  const button = $('btn-covers');
  const status = $('covers-status');
  button.disabled = true;
  let checked = 0;
  let found = 0;

  try {
    // First call clears the stale "no cover" markers; the rest work through the
    // catalogue in batches so no single request can hang for minutes.
    for (let round = 0; round < 40; round += 1) {
      const result = await api('/api/covers/refresh', {
        method: 'POST',
        body: { reset: round === 0 },
      });
      checked += result.checked;
      found += result.found;
      status.textContent = checked
        ? `Checked ${checked} · found ${found}${result.remaining ? ` · ${result.remaining} to go` : ''}`
        : 'No books are missing a cover.';
      if (result.checked === 0 || result.remaining === 0) break;
    }
    status.textContent = found ? `Added ${found} cover${found === 1 ? '' : 's'}.` : status.textContent;
    // The server bumped its cover epoch when files changed; adopt the new one, or
    // the phone's year-long cache would hide the covers just fetched.
    try {
      const me = await api('/api/me');
      state.coverEpoch = me.coverEpoch ?? state.coverEpoch;
    } catch {
      /* a manual reload will pick it up */
    }
    await loadShelf();
  } catch {
    status.textContent = 'Could not reach the cover sources just now — try again later.';
  } finally {
    button.disabled = false;
  }
});

// ---------------------------------------------------------------- refresh

const PTR_THRESHOLD = 70;
let ptrStartY = null;
let ptrDelta = 0;
let refreshBusy = false;

function ptrRender(delta, label) {
  const node = $('ptr');
  if (!node) return;
  node.style.transform = `translate(-50%, ${Math.max(0, Math.min(delta, 96))}px)`;
  node.style.opacity = delta > 6 ? '1' : '0';
  const text = node.querySelector('.ptr-label');
  if (text && label) text.textContent = label;
}

/**
 * Refresh the app. If the server is serving a different build from the one this
 * page loaded, drop every cache and the service worker and reload - that is the
 * only reliable cure for "I updated but my phone still shows the old app".
 */
async function refreshApp() {
  if (refreshBusy) return;
  refreshBusy = true;
  ptrRender(80, 'Checking for updates…');
  try {
    const me = await fetch('/api/me', { cache: 'no-store' }).then((r) => r.json());
    const serverBuild = me?.build ?? null;
    if (serverBuild && serverBuild !== state.version) {
      ptrRender(80, 'New version — reloading…');
      for (const key of await caches.keys()) await caches.delete(key);
      const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
      for (const reg of regs) {
        if (reg.waiting) reg.waiting.postMessage('skipWaiting');
        await reg.unregister().catch(() => {});
      }
      location.reload();
      return;
    }
    await Promise.all([loadShelf(), loadSeries(), loadStats()]);
    toast('Up to date');
  } catch {
    toast('Could not reach the server');
  } finally {
    refreshBusy = false;
    setTimeout(() => ptrRender(0, 'Pull to refresh'), 300);
  }
}

// Pull-to-refresh gesture.
//
// The first version hijacked scrolling: it armed on touchstart at the top, then
// called preventDefault() as soon as the finger moved down - but scrolling UP a
// page (drag down) is exactly that motion, so scrolling back up triggered a
// refresh. Now a gesture is only claimed once the page is demonstrably at the
// top AND the drag is downward, and it is abandoned immediately if the page
// scrolls at all.
const PTR_DEADZONE = 14;
let ptrPulling = false;

function scrollTopNow() {
  return document.scrollingElement?.scrollTop ?? window.scrollY ?? 0;
}

function abandonPull() {
  ptrStartY = null;
  ptrPulling = false;
  ptrDelta = 0;
  ptrRender(0, 'Pull to refresh');
}

window.addEventListener(
  'touchstart',
  (event) => {
    const blocked = refreshBusy || event.touches.length !== 1 || scrollTopNow() > 0 || !$('sheet').hidden;
    if (blocked) {
      abandonPull();
      return;
    }
    ptrStartY = event.touches[0].clientY;
    ptrPulling = false;
    ptrDelta = 0;
  },
  { passive: true },
);

window.addEventListener(
  'touchmove',
  (event) => {
    if (ptrStartY === null) return;

    // The page moved, or the drag is upward: this is a scroll, not a pull.
    if (scrollTopNow() > 0 || event.touches[0].clientY - ptrStartY <= 0) {
      abandonPull();
      return;
    }

    const delta = event.touches[0].clientY - ptrStartY;
    if (delta < PTR_DEADZONE) return; // ignore jitter

    ptrPulling = true;
    ptrDelta = delta;
    ptrRender(delta, delta > PTR_THRESHOLD ? 'Release to refresh' : 'Pull to refresh');
    event.preventDefault();
  },
  { passive: false },
);

window.addEventListener('touchend', () => {
  if (!ptrPulling) {
    abandonPull();
    return;
  }
  const trigger = ptrDelta > PTR_THRESHOLD;
  ptrStartY = null;
  ptrPulling = false;
  ptrDelta = 0;
  if (trigger) refreshApp();
  else ptrRender(0, 'Pull to refresh');
});

window.addEventListener('touchcancel', abandonPull);

document.addEventListener('visibilitychange', () => {
  // Coming back to the app is a good moment to notice a new build.
  if (!document.hidden && !refreshBusy) {
    fetch('/api/me', { cache: 'no-store' })
      .then((r) => r.json())
      .then((me) => {
        if (me?.build && state.version && me.build !== state.version) {
          toast('New version available — pull down to refresh');
        }
      })
      .catch(() => {});
  }
});

// ---------------------------------------------------------------- boot

async function boot() {
  $('gate').hidden = true;
  $('app').hidden = false;
  $('tabs').hidden = false;
  loadIndex();
  setTab('scan');
  try {
    await Promise.all([loadStats(), loadShelf(), loadSeries(), loadOwners()]);
  } catch (error) {
    if (!(error instanceof AuthError)) toast('Could not load the catalogue');
  }
}

/**
 * The chip shows the human version (v1.0, v1.3, v2.0). The exact build - the
 * commit SHA - lives in the tooltip, and is what pull-to-refresh compares.
 */
function setVersion(version, build) {
  state.version = build ?? version ?? null;
  for (const id of ['version-chip', 'gate-version']) {
    const node = document.getElementById(id);
    if (!node) continue;
    node.textContent = version || 'v?';
    node.title = build ? `build ${build.slice(0, 7)}` : 'build unknown';
  }
}

async function init() {
  try {
    const me = await (await fetch('/api/me')).json();
    setVersion(me.version, me.build);
    state.coverEpoch = me.coverEpoch ?? 0;
    if (me.authed) return boot();
  } catch {
    // fall through to the gate
  }
  showGate();
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

init();

// "Rebuild book data": clears the lookup cache and the negative cover cache. The
// catalogue is untouched, so this is safe to press whenever enrichment looks stale.
$('btn-rebuild').addEventListener('click', async () => {
  const button = $('btn-rebuild');
  button.disabled = true;
  try {
    const result = await api('/api/cache/reset', { method: 'POST' });
    $('covers-status').textContent = `Cleared ${result.lookups} cached lookups and ${result.coverMisses} "no cover" results. Rescan a book to fetch it fresh.`;
    await loadShelf();
  } catch {
    $('covers-status').textContent = 'Could not rebuild — try again.';
  } finally {
    button.disabled = false;
  }
});


// Owners: add, choose a default, remove. Removing never touches books that were
// attributed to that person - their name stays on the record.
$('btn-owner-add').addEventListener('click', addOwnerFromInput);
$('owner-name').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') addOwnerFromInput();
});

$('owner-list').addEventListener('click', async (event) => {
  const makeDefault = event.target.closest('[data-owner-default]');
  const remove = event.target.closest('[data-owner-delete]');
  try {
    if (makeDefault) {
      await api(`/api/owners/${makeDefault.dataset.ownerDefault}`, { method: 'PATCH', body: { isDefault: true } });
      await loadOwners();
    }
    if (remove) {
      const name = remove.dataset.ownerName;
      if (!confirm(`Remove ${name} from the list? Books already marked as theirs keep that name.`)) return;
      await api(`/api/owners/${remove.dataset.ownerDelete}`, { method: 'DELETE' });
      await loadOwners();
    }
  } catch {
    $('owner-status').textContent = 'Could not update the owner list.';
  }
});


// "Test Google Books key": prints Google's own answer, so a restricted key (403)
// is never confused with an exhausted quota (429) or a dead key (400).
$('btn-test-google').addEventListener('click', async () => {
  const out = $('google-test');
  out.textContent = 'Asking Google…';
  try {
    const probe = await api('/api/diagnostics/google');
    if (!probe.configured) {
      out.textContent = 'No Google Books key reached the container.';
    } else if (probe.ok) {
      out.textContent = `Working: ${probe.items} result(s) for the test ISBN${
        probe.sampleTitle ? `, e.g. "${probe.sampleTitle}"` : ''
      }.`;
    } else {
      out.textContent = `Google answered HTTP ${probe.httpStatus}${
        probe.error?.message ? ` — ${probe.error.message}` : ''
      }`;
    }
  } catch {
    out.textContent = 'Could not reach the diagnostic endpoint.';
  }
});


/**
 * Delete everything - in three deliberate steps.
 *
 * This is the only action in the app that cannot be undone by tapping again, so it
 * is never a single button: a warning, a summary with a backup link, then a typed
 * word. The server also refuses the request unless it carries the confirmation
 * string, and writes a backup before deleting.
 */
function startWipe() {
  openSheet(`
    <h2>Step 1 of 3 — delete everything?</h2>
    <p class="hint">This removes every book, rating, note, series entry, scan history and cover image from the server. Nothing in the app can undo it.</p>
    <p class="hint">You will be asked twice more, and a backup is saved on the server first.</p>
    <div class="btn-row">
      <button class="ghost" id="wipe-cancel1">Cancel</button>
      <button class="danger" id="wipe-step1">Yes, continue</button>
    </div>
  `);
  $('wipe-cancel1').addEventListener('click', closeSheet);
  $('wipe-step1').addEventListener('click', wipeSecondStep);
}

function wipeSecondStep() {
  const owned = state.stats?.owned ?? 0;
  const wished = state.stats?.wishlist ?? 0;
  openSheet(`
    <h2>Step 2 of 3 — this is what goes</h2>
    <p class="hint">${esc(owned)} owned and ${esc(wished)} wishlisted book(s), with their ratings, notes, loans and covers.</p>
    <p class="hint">A backup is written on the server automatically. You can also take one now and keep it.</p>
    <div class="btn-row">
      <button class="ghost" id="wipe-cancel2">Cancel</button>
      <a class="button ghost" href="/api/export" download>Download backup</a>
      <button class="danger" id="wipe-step2">Continue</button>
    </div>
  `);
  $('wipe-cancel2').addEventListener('click', closeSheet);
  $('wipe-step2').addEventListener('click', wipeThirdStep);
}

function wipeThirdStep() {
  openSheet(`
    <h2>Step 3 of 3 — confirm</h2>
    <p class="hint">Type <b>DELETE</b> below. The button stays disabled until it matches exactly.</p>
    <div class="field"><input id="wipe-word" autocomplete="off" autocapitalize="characters" placeholder="DELETE" /></div>
    <div class="btn-row">
      <button class="ghost" id="wipe-cancel3">Cancel</button>
      <button class="danger" id="wipe-go" disabled>Delete everything</button>
    </div>
  `);
  $('wipe-cancel3').addEventListener('click', closeSheet);
  $('wipe-word').addEventListener('input', (event) => {
    $('wipe-go').disabled = event.target.value.trim() !== 'DELETE';
  });
  $('wipe-word').focus();
  $('wipe-go').addEventListener('click', async () => {
    const button = $('wipe-go');
    button.disabled = true;
    button.textContent = 'Deleting…';
    try {
      const result = await api('/api/admin/wipe', {
        method: 'POST',
        body: { confirm: 'DELETE_ALL' },
      });
      closeSheet();
      setResult('');
      // The wipe bumped the server's cover epoch; adopt it before re-rendering so
      // the shelf does not ask for the old (cached) cover URLs.
      try {
        const me = await api('/api/me');
        state.coverEpoch = me.coverEpoch ?? state.coverEpoch;
      } catch {
        /* the reload below will sort the shelf out either way */
      }
      await Promise.all([loadShelf(), loadStats(), loadSeries(), loadOwners(), loadRecentScans()]);
      toast(`Catalogue cleared. Backup saved as ${result.backup}`);
    } catch {
      button.disabled = false;
      button.textContent = 'Delete everything';
      toast('Could not clear the catalogue');
    }
  });
}

$('btn-wipe').addEventListener('click', startWipe);

/**
 * Name the gaps in a series.
 *
 * "Missing 1, 4, 5" is only half an answer; standing in a bookshop you need the
 * titles. Wikidata supplies them (cached server-side for a month), so this shows
 * what is not on your shelf yet.
 */
$('series-list').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-series-volumes]');
  if (!button) return;
  const card = button.closest('.series-card');
  const out = card.querySelector('.series-more');

  if (out.dataset.loaded === '1') {
    out.hidden = !out.hidden;
    return;
  }

  button.disabled = true;
  button.textContent = 'Asking Wikidata…';
  try {
    const data = await api(`/api/series/${encodeURIComponent(button.dataset.seriesVolumes)}/volumes`);
    const missing = data.missing ?? [];

    if (!missing.length) {
      // Every route, and what each said. Without this, "no titles" cannot be told
      // apart from "the search never ran".
      const google = (data.tried ?? []).filter((entry) => entry.source === 'google');
      const wiki = (data.tried ?? []).find((entry) => entry.source === 'wikidata');
      const shortQuery = (query) => String(query ?? '').replace(/\s+/g, ' ').slice(0, 32);

      const routes = [
        `Wikidata: ${wiki?.ok ? `${wiki.volumes} volume(s) via ${wiki.matchedBy}` : 'no match'}`,
        google.length
          ? `Google: ${google
              .map((entry) =>
                entry.ok
                  ? `${shortQuery(entry.query)} → ${entry.results} found, ${entry.matched ?? 0} matched`
                  : `${shortQuery(entry.query)} → ${entry.reason ?? 'request failed'}`,
              )
              .join(' · ')}`
          : 'Google: not attempted',
      ].join('  |  ');

      let message;
      if (data.total) {
        message = 'Nothing else is known for this series — you have them all.';
      } else if (google.length && google.every((entry) => !entry.ok)) {
        message = `No titles found. Every Google search was rejected — that is the key or its quota.`;
      } else {
        message =
          'No source lists the other books in this series, so the titles cannot be filled in. The numbered gaps above still show what you are missing.';
      }
      out.innerHTML = `<p class="hint" style="margin:0 0 6px">${message}</p>
        <p class="hint" style="margin:0;opacity:0.7;font-size:11px">${esc(routes)}</p>`;
    } else {

      // Name the source: these titles came from Google here, not Wikidata, and
      // saying otherwise would send the reader to the wrong place to fix it.
      const source = data.matchedBy === 'google' ? 'Google Books' : 'Wikidata';
      const sparse = data.total > 0 && data.total <= 3
        ? `<p class="hint" style="margin:0 0 6px">${source} lists only ${data.total} of this series' books, so this list is incomplete — the numbered gaps above remain the reliable count.</p>`
        : '';
      out.innerHTML = `${sparse}<div class="more-head">Not on your shelf yet · ${missing.length}
          ${data.total ? `<span>of ${data.total} known</span>` : ''}</div>
        <div class="more-list">${missing
          .slice(0, 80)
          .map(
            (volume) => `<div class="more-row">
              <span class="more-vol">${volume.volume ? `#${esc(volume.volume)}` : '–'}</span>
              <span class="more-title">${esc(volume.title)}</span>
              <span class="more-year">${esc(volume.year ?? '')}</span>
              ${
                // Only sources that gave us an ISBN can be added without typing.
                volume.isbn13
                  ? `<button class="link more-add" data-wish-isbn="${esc(volume.isbn13)}" title="Add to wishlist">+ wishlist</button>`
                  : '<span></span>'
              }
            </div>`,
          )
          .join('')}</div>`;
    }
    out.dataset.loaded = '1';
    out.hidden = false;
    // Only promise a list when there is one.
    button.textContent = missing.length ? 'Hide the missing titles' : 'Hide';
  } catch {
    button.textContent = 'Could not reach Wikidata — try again';
  } finally {
    button.disabled = false;
  }
});


// Adding a missing volume to the wishlist, straight from the series card. Only
// possible when the source supplied an ISBN - which the Google fallback does.
$('series-list').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-wish-isbn]');
  if (!button) return;
  const isbn = button.dataset.wishIsbn;
  button.disabled = true;
  button.textContent = 'adding…';
  try {
    await api('/api/books', { method: 'POST', body: { isbn, state: 'wishlist' } });
    button.textContent = '✓ wishlisted';
    await Promise.all([loadShelf(), loadStats(), loadSeries()]);
  } catch {
    button.disabled = false;
    button.textContent = '+ wishlist';
    toast('Could not add that one');
  }
});

/**
 * "Andromache #1 →" in the book sheet: jump to the Series tab with that series
 * selected, and open its list of missing titles.
 */
$('sheet-body').addEventListener('click', async (event) => {
  const link = event.target.closest('[data-goto-series]');
  if (!link) return;
  const name = link.dataset.gotoSeries;
  closeSheet();
  setTab('series');
  const search = $('series-search');
  if (search) search.value = name;
  state.seriesQuery = name;
  renderSeries();
  // Open the matching card straight away: the point of the jump is the gap list.
  requestAnimationFrame(() => {
    const card = [...document.querySelectorAll('.series-card')].find(
      (node) => node.querySelector('.series-name')?.textContent.trim() === name,
    );
    card?.querySelector('[data-series-volumes]')?.click();
  });
});

/**
 * Clicking anywhere on a series card opens it, not just the button - the card is
 * the obvious thing to tap.
 */
$('series-list').addEventListener('click', (event) => {
  if (event.target.closest('button, a, [data-wish-isbn]')) return;
  const card = event.target.closest('.series-card');
  card?.querySelector('[data-series-volumes]')?.click();
});
