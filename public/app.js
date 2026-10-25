// Frontend. No framework, no build step: the browser loads exactly the files in
// this folder, which is what keeps a container update to a single `docker pull`.
//
// Fast path that matters: a local ISBN index (isbn -> {title, state}) is kept in
// localStorage, so a scan of a book you own is answered before any network call
// returns - and it still answers with no signal at all.
import { startScanner, stopScanner, setTorch, hasTorch, getTorchState } from './scanner.js';

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

function coverHtml(book) {
  if (!book) return `<div class="cover">no cover</div>`;
  return `<div class="cover"><img src="/cover/${esc(book.isbn13)}.jpg" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'cover',textContent:'no cover'}))" /></div>`;
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
  const title = book?.title ?? (data.verdict === 'invalid' ? 'Not an ISBN barcode' : 'Unknown book');
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
    awaitingMeta ? 'looking up details…' : `${data.elapsedMs ?? 0} ms`,
  ].filter(Boolean);

  let actions = '';
  if (verdict === 'owned' || verdict === 'wishlist') {
    actions = `<div class="btn-row">
        <button class="primary" data-act="detail" data-isbn="${esc(data.isbn13)}">Open</button>
        <button class="ghost" data-act="loan" data-isbn="${esc(data.isbn13)}">Lend</button>
      </div>`;
  } else if (verdict === 'missing' && noRecord) {
    actions = `<div class="btn-row">
        <button class="primary" data-act="manual-add" data-isbn="${esc(data.isbn13)}">Add manually</button>
        <button class="ghost" data-act="skip">Skip</button>
      </div>`;
  } else if (verdict === 'missing') {
    actions = `<div class="btn-row">
        <button class="primary" data-act="buy" data-isbn="${esc(data.isbn13)}">I bought it</button>
        <button data-act="wish" data-isbn="${esc(data.isbn13)}">Wishlist</button>
        <button class="ghost" data-act="skip">Skip</button>
      </div>`;
  } else if (verdict === 'invalid') {
    actions = `<p class="book-sub">That code is not a book ISBN. Point at the barcode on the back cover.</p>`;
  }

  return `<div class="card v-${esc(verdict)}">
    <div class="verdict"><span class="dot"></span>${esc(VERDICT_TEXT[verdict] ?? verdict)}</div>
    <div class="book-row">
      ${coverHtml(book)}
      <div class="book-meta">
        <div class="book-title">${esc(noRecord ? 'No catalogue record' : title)}</div>
        <div class="book-sub">${esc(meta.join(' · '))}</div>
        <div class="book-extra">${esc(data.isbn13 ?? '')}</div>
      </div>
    </div>
    ${seriesNote(data.series, book?.volume)}
    ${noRecord ? '<p class="book-sub">Open Library has nothing for this ISBN. Add it by hand — title and author are all that is needed.</p>' : ''}
    ${actions}
  </div>`;
}

$('scan-result').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-act]');
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
    await addBook(isbn, targetState, work);
    toast(targetState === 'owned' ? 'Added to your library' : 'Added to wishlist');
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
      ${coverHtml(book)}
      <div class="book-meta">
        <div class="book-title">${esc(book.title)}</div>
        <div class="book-sub">${esc((book.authors ?? []).join(', '))}</div>
        <div class="book-extra">${esc([book.series && book.volume ? `${book.series} #${book.volume}` : book.series, book.published, book.pages ? `${book.pages} pp` : null].filter(Boolean).join(' · '))}</div>
        ${book.rating ? `<div class="book-extra">★ ${esc(book.rating)} <span>(${esc(book.ratingsCount ?? 0)})</span></div>` : ''}
      </div>
    </div>

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

    <div class="field">
      <label>My rating</label>
      <div class="btn-row" id="rating-row">
        ${[1, 2, 3, 4, 5]
          .map((n) => `<button class="${book.myRating === n ? 'primary' : ''}" data-rate="${n}">${'★'.repeat(n)}</button>`)
          .join('')}
      </div>
    </div>

    <div class="field"><label for="d-location">Where it is</label><input id="d-location" value="${esc(book.location ?? '')}" placeholder="Study, shelf 3" /></div>
    <div class="field"><label for="d-loan">Lent to</label><input id="d-loan" value="${esc(book.loanedTo ?? '')}" placeholder="Empty = on the shelf" /></div>

    <div class="inline-fields">
      <div class="field"><label for="d-series">Series</label><input id="d-series" value="${esc(book.series ?? '')}" /></div>
      <div class="field"><label for="d-volume">Volume</label><input id="d-volume" inputmode="numeric" value="${esc(book.volume ?? '')}" /></div>
    </div>

    <div class="field"><label for="d-notes">Notes</label><input id="d-notes" value="${esc(book.notes ?? '')}" /></div>

    <div class="btn-row">
      <button class="primary" id="d-save">Save</button>
      <button class="ghost" id="d-close">Close</button>
      <button class="danger" id="d-delete">Delete</button>
    </div>
    <p class="hint" style="margin-top:10px">Fixing series or volume here changes the missing-number maths for the whole series.</p>
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
      for (const other of $('sheet-body').querySelectorAll('[data-rate]')) {
        other.classList.toggle('primary', Number(other.dataset.rate) === draft.myRating);
      }
    }),
  );

  $('d-close').addEventListener('click', closeSheet);
  $('d-save').addEventListener('click', async () => {
    await saveBook(book.isbn13, {
      state: draft.state,
      read_state: draft.readState,
      my_rating: draft.myRating,
      location: $('d-location').value.trim() || null,
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

function renderShelf() {
  const books = state.filter === 'loaned' ? state.books.filter((b) => b.loanedTo) : state.books;
  const grid = $('shelf-grid');
  grid.innerHTML = books
    .map(
      (book) => `<button class="tile ${book.state === 'wishlist' ? 'badge' : ''}" data-badge="wish" data-isbn="${esc(book.isbn13)}">
        ${coverHtml(book)}
        <div class="tile-title">${esc(book.title)}</div>
        <div class="tile-author">${esc((book.authors ?? [])[0] ?? '')}</div>
      </button>`,
    )
    .join('');
  $('shelf-empty').hidden = books.length > 0;
}

$('shelf-grid').addEventListener('click', (event) => {
  const tile = event.target.closest('.tile');
  if (tile) openDetail(tile.dataset.isbn);
});

let searchTimer = null;
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
  const withVolumes = state.series.filter((s) => s.ownedCount > 0);

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
      </div>`;
    })
    .join('');

  $('series-empty').hidden = withVolumes.length > 0;
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

async function renderMore() {
  await Promise.all([loadStats(), loadRecentScans()]);
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
    const serverVersion = me?.version ?? null;
    if (serverVersion && serverVersion !== state.version) {
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

// Drag down anywhere at the top of the page to refresh. `passive: false` on move
// so the gesture does not also trigger the browser's own bounce.
window.addEventListener(
  'touchstart',
  (event) => {
    if (refreshBusy || window.scrollY > 0) {
      ptrStartY = null;
      return;
    }
    ptrStartY = event.touches[0].clientY;
    ptrDelta = 0;
  },
  { passive: true },
);

window.addEventListener(
  'touchmove',
  (event) => {
    if (ptrStartY === null) return;
    const delta = event.touches[0].clientY - ptrStartY;
    if (delta <= 0 || window.scrollY > 0) {
      ptrDelta = 0;
      ptrRender(0, 'Pull to refresh');
      return;
    }
    ptrDelta = delta;
    ptrRender(delta, delta > PTR_THRESHOLD ? 'Release to refresh' : 'Pull to refresh');
    if (delta > 8) event.preventDefault();
  },
  { passive: false },
);

window.addEventListener('touchend', () => {
  if (ptrStartY === null) return;
  const trigger = ptrDelta > PTR_THRESHOLD;
  ptrStartY = null;
  ptrDelta = 0;
  if (trigger) refreshApp();
  else ptrRender(0, 'Pull to refresh');
});

document.addEventListener('visibilitychange', () => {
  // Coming back to the app is a good moment to notice a new build.
  if (!document.hidden && !refreshBusy) {
    fetch('/api/me', { cache: 'no-store' })
      .then((r) => r.json())
      .then((me) => {
        if (me?.version && state.version && me.version !== state.version) {
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
    await Promise.all([loadStats(), loadShelf(), loadSeries()]);
  } catch (error) {
    if (!(error instanceof AuthError)) toast('Could not load the catalogue');
  }
}

/**
 * Build version, so "did the update land on my phone?" is answered by looking at
 * the screen. CI passes the commit SHA; a local run reports the package version.
 */
function prettyVersion(value) {
  if (!value) return 'v?';
  if (/^[0-9a-f]{7,40}$/i.test(value)) return `v${value.slice(0, 7)}`;
  return value.startsWith('v') ? value : `v${value}`;
}

function setVersion(value) {
  state.version = value ?? null;
  for (const id of ['version-chip', 'gate-version']) {
    const node = document.getElementById(id);
    if (!node) continue;
    node.textContent = prettyVersion(value);
    node.title = `build ${value ?? 'unknown'}`;
  }
}

async function init() {
  try {
    const me = await (await fetch('/api/me')).json();
    setVersion(me.version);
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
