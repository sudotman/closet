/* global window, document, requestAnimationFrame, fetch */
(function () {
  const viewport = document.getElementById('viewport');
  const world = document.getElementById('world');
  const searchInput = document.getElementById('searchInput');
  const searchResults = document.getElementById('searchResults');
  const shuffleBtn = document.getElementById('shuffleBtn');
  const lightbox = document.getElementById('lightbox');
  const lightboxImg = document.getElementById('lightboxImg');

  const state = {
    panX: 0,
    panY: 0,
    targetPanX: 0,
    targetPanY: 0,
    rafId: null,
    isDragging: false,
    dragMoved: false,
    justDragged: false,
    startX: 0,
    startY: 0,
    startPanX: 0,
    startPanY: 0,
    lastPointerX: 0,
    lastPointerY: 0,
    lastPointerT: 0,
    vx: 0,
    vy: 0,
    entries: [],
    viewEntries: [],
    entryIdToEl: new Map(),
    activeUid: null,
    viewMode: 'grid',
    selectedTags: [],
  };

  const LAYOUT = {
    columnWidth: 420, // card width in px (fits youtube); others scale within
    gap: 60,          // gap between cards in px
    minCols: 2,
    maxCols: 8,
  };

  function setWorldTransform(x, y) {
    world.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }

  function onPointerDown(ev) {
    // ignore drags starting from interactive elements
    const path = ev.composedPath ? ev.composedPath() : ev.path || [];
    const interactive = path.some((el) => el && el.tagName && ['INPUT','A','BUTTON','TEXTAREA','IFRAME'].includes(el.tagName));
    if (interactive) return;
    // prevent native text selection and image dragging
    ev.preventDefault();
    if (window.getSelection && typeof window.getSelection().removeAllRanges === 'function') {
      try { window.getSelection().removeAllRanges(); } catch (_) {}
    }
    state.isDragging = true;
    state.dragMoved = false;
    state.justDragged = false;
    viewport.classList.add('dragging');
    state.startX = ev.clientX;
    state.startY = ev.clientY;
    state.startPanX = state.panX;
    state.startPanY = state.panY;
    state.lastPointerX = ev.clientX;
    state.lastPointerY = ev.clientY;
    state.lastPointerT = performance.now();
    state.vx = 0; state.vy = 0;
    state.targetPanX = state.panX;
    state.targetPanY = state.panY;
    ensureRenderLoop();
  }

  function onPointerMove(ev) {
    if (!state.isDragging) return;
    ev.preventDefault();
    const dx = ev.clientX - state.startX;
    const dy = ev.clientY - state.startY;
    if (!state.dragMoved && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
      state.dragMoved = true;
    }
    state.targetPanX = state.startPanX + dx;
    state.targetPanY = state.startPanY + dy;
    const now = performance.now();
    const dt = Math.max(1, now - state.lastPointerT);
    const vX = (ev.clientX - state.lastPointerX) / dt;
    const vY = (ev.clientY - state.lastPointerY) / dt;
    state.vx = vX * 16;
    state.vy = vY * 16;
    state.lastPointerX = ev.clientX;
    state.lastPointerY = ev.clientY;
    state.lastPointerT = now;
    ensureRenderLoop();
  }

  function onPointerUp() {
    const wasDragging = state.isDragging;
    const moved = state.dragMoved;
    state.isDragging = false;
    viewport.classList.remove('dragging');
    // briefly suppress click actions that may fire after a drag release
    if (wasDragging && moved) {
      state.justDragged = true;
      setTimeout(() => { state.justDragged = false; }, 120);
    }
    ensureRenderLoop();
  }

  function lerp(a, b, t) { return a + (b - a) * t; }

  // Elastic smoothing and inertia render loop
  function ensureRenderLoop() {
    if (state.rafId != null) return;
    const SMOOTHING = 0.18;
    const FRICTION = 0.86;
    const EPS = 0.05;
    function step() {
      // advance target by inertial velocity
      if (Math.abs(state.vx) > EPS || Math.abs(state.vy) > EPS) {
        state.targetPanX += state.vx;
        state.targetPanY += state.vy;
        state.vx *= FRICTION;
        state.vy *= FRICTION;
      } else {
        state.vx = state.vy = 0;
      }
      // smooth current pan towards target
      state.panX = lerp(state.panX, state.targetPanX, SMOOTHING);
      state.panY = lerp(state.panY, state.targetPanY, SMOOTHING);
      setWorldTransform(state.panX, state.panY);
      const nearTarget = Math.abs(state.panX - state.targetPanX) < 0.3 && Math.abs(state.panY - state.targetPanY) < 0.3;
      const stillMoving = state.isDragging || Math.abs(state.vx) > EPS || Math.abs(state.vy) > EPS;
      if (!stillMoving && nearTarget) {
        state.rafId = null;
        return;
      }
      state.rafId = requestAnimationFrame(step);
    }
    state.rafId = requestAnimationFrame(step);
  }

  function animatePanTo(targetX, targetY) {
    state.targetPanX = targetX;
    state.targetPanY = targetY;
    ensureRenderLoop();
  }

  function centerOnEntry(entryId) {
    const el = state.entryIdToEl.get(entryId);
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vp = viewport.getBoundingClientRect();
    const currentWorldRect = world.getBoundingClientRect();
    // compute element center relative to world origin
    const elCenterXInWorld = rect.left - currentWorldRect.left + rect.width / 2;
    const elCenterYInWorld = rect.top - currentWorldRect.top + rect.height / 2;
    const vpCenterX = vp.width / 2;
    const vpCenterY = vp.height / 2;
    // target pan moves world so that element center aligns with viewport center
    const targetX = vpCenterX - elCenterXInWorld;
    const targetY = vpCenterY - elCenterYInWorld;
    animatePanTo(targetX, targetY);
  }

  function renderEntries(entries) {
    world.innerHTML = '';
    state.entryIdToEl.clear();
    for (const entry of entries) {
      const card = document.createElement('div');
      card.className = `entry ${entry.type}`;
      card.style.left = `${entry.x}px`;
      card.style.top = `${entry.y}px`;
      card.dataset.id = entry.id;
      card.dataset.uid = entry.__uid;

      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = entry.title || '';

      if (entry.title) card.appendChild(title);

      let contentEl = null;
      let bodyEl = null;
      if (entry.type === 'image') {
        const img = document.createElement('img');
        img.src = entry.src;
        img.alt = entry.alt || entry.title || '';
        img.loading = 'lazy';
        // avoid native drag-image ghosting
        img.draggable = false;
        img.addEventListener('click', (e) => {
          e.stopPropagation();
          // ignore clicks that immediately follow a drag
          if (state.isDragging || state.dragMoved || state.justDragged) return;
          lightboxImg.src = entry.src;
          lightbox.removeAttribute('hidden');
        });
        img.addEventListener('load', scheduleRelayout);
        contentEl = img;
      } else if (entry.type === 'text') {
        const text = document.createElement('div');
        text.className = 'content';
        text.textContent = entry.text;
        contentEl = text;
      } else if (entry.type === 'link') {
        const a = document.createElement('a');
        a.href = entry.url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = entry.linkText || entry.title || entry.url;
        contentEl = a;
      } else if (entry.type === 'text_link') {
        const wrap = document.createElement('div');
        wrap.className = 'content';
        const span = document.createElement('span');
        span.textContent = (entry.text || '') + ' ';
        const a = document.createElement('a');
        a.href = entry.url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = entry.linkText || entry.url;
        wrap.appendChild(span);
        wrap.appendChild(a);
        contentEl = wrap;
      } else if (entry.type === 'youtube') {
        const iframe = document.createElement('iframe');
        iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
        iframe.allowFullscreen = true;
        iframe.loading = 'lazy';
        iframe.src = `https://www.youtube-nocookie.com/embed/${entry.youtubeId}`;
        iframe.addEventListener('load', scheduleRelayout);
        contentEl = iframe;
      }

      if (state.viewMode === 'compact') {
        card.classList.add('compact', 'collapsed');
        const summary = document.createElement('div');
        summary.className = 'summary';
        const titleWrap = document.createElement('div');
        titleWrap.className = 'title';
        titleWrap.textContent = entry.title || entry.linkText || entry.url || entry.text || entry.id;
        const meta = document.createElement('div');
        meta.className = 'meta';
        const type = document.createElement('span');
        type.textContent = entry.type;
        meta.appendChild(type);
        if (entry.tags && entry.tags.length) {
          for (const t of entry.tags) {
            const tag = document.createElement('span');
            tag.className = 'tag';
            tag.textContent = t;
            meta.appendChild(tag);
          }
        }
        summary.appendChild(titleWrap);
        summary.appendChild(meta);
        card.appendChild(summary);

        bodyEl = document.createElement('div');
        bodyEl.className = 'body';
        if (entry.title) bodyEl.appendChild(title);
        if (contentEl) bodyEl.appendChild(contentEl);
        card.appendChild(bodyEl);

        card.addEventListener('click', (e) => {
          if (state.isDragging || state.dragMoved || state.justDragged) return;
          // ignore link clicks inside
          if (e.target && (e.target.tagName === 'A' || e.target.closest('a'))) return;
          card.classList.toggle('expanded');
          if (card.classList.contains('expanded')) {
            card.classList.remove('collapsed');
            bodyEl.style.display = 'block';
          } else {
            card.classList.add('collapsed');
            bodyEl.style.display = 'none';
          }
          scheduleRelayout();
        });
        // start collapsed
        if (bodyEl) bodyEl.style.display = 'none';
      } else {
        if (entry.title) card.appendChild(title);
        if (contentEl) card.appendChild(contentEl);
      }

      // NOTE: Previously, clicking a card centered the view. This is disabled to
      // keep dragging responsive and avoid accidental recenters.

      world.appendChild(card);
      state.entryIdToEl.set(entry.__uid, card);
    }
  }

  function debounce(fn, wait) {
    let t = null;
    return function (...args) {
      if (t) clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  function measureAndAssignPositions(entries, { shuffle = false } = {}) {
    const vp = viewport.getBoundingClientRect();
    const order = shuffle ? [...entries].sort(() => Math.random() - 0.5) : [...entries];

    if (state.viewMode === 'list') {
      const listWidth = Math.min(720, Math.floor(vp.width * 0.9));
      let y = 0;
      const gapY = 26;
      for (const entry of order) {
        const el = state.entryIdToEl.get(entry.__uid);
        if (!el) continue;
        el.style.width = `${listWidth}px`;
        const rect = el.getBoundingClientRect();
        const height = rect.height;
        const x = Math.round(-listWidth / 2);
        entry.x = x;
        entry.y = Math.round(y);
        y += height + gapY;
      }
    } else if (state.viewMode === 'compact') {
      const tableWidth = Math.min(900, Math.floor(vp.width * 0.95));
      let y = 0;
      const rowGap = 14;
      for (const entry of order) {
        const el = state.entryIdToEl.get(entry.__uid);
        if (!el) continue;
        el.style.width = `${tableWidth}px`;
        const rect = el.getBoundingClientRect();
        const height = rect.height;
        const x = Math.round(-tableWidth / 2);
        entry.x = x;
        entry.y = Math.round(y);
        y += height + rowGap;
      }
    } else {
      const gapX = LAYOUT.gap;
      const gapY = LAYOUT.gap + 20; // extra vertical breathing room
      const effectiveCardWidth = Math.min(LAYOUT.columnWidth, Math.floor(vp.width * 0.86));
      const columns = Math.max(
        LAYOUT.minCols,
        Math.min(LAYOUT.maxCols, Math.floor((vp.width - gapX) / (effectiveCardWidth + gapX)) || 1)
      );

      const totalWidth = columns * effectiveCardWidth + (columns - 1) * gapX;
      const xStart = -totalWidth / 2;
      const colHeights = new Array(columns).fill(0);

      for (const entry of order) {
        const el = state.entryIdToEl.get(entry.__uid);
        if (!el) continue;
        el.style.width = `${effectiveCardWidth}px`;
        const rect = el.getBoundingClientRect();
        const height = rect.height;

        // pick shortest column
        let colIndex = 0;
        for (let i = 1; i < columns; i++) {
          if (colHeights[i] < colHeights[colIndex]) colIndex = i;
        }
        const x = Math.round(xStart + colIndex * (effectiveCardWidth + gapX));
        const y = Math.round(colHeights[colIndex]);

        entry.x = x;
        entry.y = y;
        colHeights[colIndex] += height + gapY;
      }
    }
  }

  function computePanToCenterFromDOM(entries) {
    if (!entries.length) return { x: 0, y: 0 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const e of entries) {
      const el = state.entryIdToEl.get(e.__uid);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      minX = Math.min(minX, e.x);
      minY = Math.min(minY, e.y);
      maxX = Math.max(maxX, e.x + w);
      maxY = Math.max(maxY, e.y + h);
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const vp = viewport.getBoundingClientRect();
    return { x: vp.width / 2 - cx, y: vp.height / 2 - cy };
  }

  function layoutAndApply(entries, opts) {
    measureAndAssignPositions(entries, opts);
    applyPositions(entries);
  }

  const scheduleRelayout = debounce(() => {
    if (!state.viewEntries.length) return;
    layoutAndApply(state.viewEntries);
  }, 60);

  function approximateSizeForEntry(entry) {
    // Rough dimensions used for layout spacing and centering
    const width = entry.type === 'youtube' ? 420 : 360; // px content width
    const height = entry.type === 'image' ? 260 : (entry.type === 'youtube' ? 236 : 180);
    return { width, height };
  }

  function assignPositions(entries, { shuffle = false } = {}) {
    const vp = viewport.getBoundingClientRect();
    const baseColumnWidth = 460; // column width including typical padding
    const gap = 60; // spacing between cards
    const maxCols = 6;
    const minCols = 2;
    const columns = Math.max(minCols, Math.min(maxCols, Math.floor((vp.width - gap) / (baseColumnWidth + gap)) || 3));

    const totalWidth = columns * baseColumnWidth + (columns - 1) * gap;
    const xStart = -totalWidth / 2; // center around 0
    const colHeights = new Array(columns).fill(0);

    const items = shuffle ? [...entries].sort(() => Math.random() - 0.5) : [...entries];

    for (const entry of items) {
      const { width, height } = approximateSizeForEntry(entry);
      // find column with smallest accumulated height
      let colIndex = 0;
      let minH = colHeights[0];
      for (let i = 1; i < columns; i++) {
        if (colHeights[i] < minH) { minH = colHeights[i]; colIndex = i; }
      }
      const colX = xStart + colIndex * (baseColumnWidth + gap);
      const insetX = (baseColumnWidth - width) / 2; // center narrower cards in the column
      const x = Math.round(colX + insetX);
      const y = Math.round(colHeights[colIndex]);

      entry.x = x;
      entry.y = y;

      colHeights[colIndex] += height + gap;
    }
  }

  function applyPositions(entries) {
    for (const entry of entries) {
      const el = state.entryIdToEl.get(entry.__uid);
      if (!el) continue;
      el.style.left = `${entry.x}px`;
      el.style.top = `${entry.y}px`;
    }
  }

  function computeInitialPanToCenter(entries) {
    if (!entries.length) return { x: 0, y: 0 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const e of entries) {
      minX = Math.min(minX, e.x);
      minY = Math.min(minY, e.y);
      // approximate card size
      const w = e.type === 'youtube' ? 420 : 360;
      const h = e.type === 'image' ? 260 : (e.type === 'youtube' ? 236 : 180);
      maxX = Math.max(maxX, e.x + w);
      maxY = Math.max(maxY, e.y + h);
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const vp = viewport.getBoundingClientRect();
    return { x: vp.width / 2 - cx, y: vp.height / 2 - cy };
  }

  function normalize(str) { return (str || '').toLowerCase(); }

  function updateSearchResults(query) {
    const q = normalize(query);
    const results = !q ? [] : state.entries.filter(e => {
      const inTitle = normalize(e.title).includes(q);
      const inTags = (e.tags || []).some(t => normalize(t).includes(q));
      const inText = normalize(e.text).includes(q);
      return inTitle || inTags || inText;
    }).slice(0, 12);

    searchResults.innerHTML = '';
    if (!results.length) {
      searchResults.classList.remove('show');
      return;
    }
    for (const e of results) {
      const li = document.createElement('li');
      const title = document.createElement('div');
      title.className = 'result-title';
      title.textContent = e.title || e.linkText || e.url || e.text?.slice(0, 60) || e.id;
      const type = document.createElement('div');
      type.className = 'result-type';
      type.textContent = e.type;
      li.appendChild(title);
      li.appendChild(type);
      li.addEventListener('click', () => {
        centerOnEntry(e.__uid);
        searchResults.classList.remove('show');
      });
      searchResults.appendChild(li);
    }
    searchResults.classList.add('show');
  }

  async function init() {
    // events
    viewport.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    // block native dragstart on any descendants (images/links)
    window.addEventListener('dragstart', (e) => { e.preventDefault(); }, { capture: true });

    searchInput.addEventListener('input', (e) => updateSearchResults(e.target.value));
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = searchResults.querySelector('li');
        if (first) {
          const idx = Array.from(searchResults.children).indexOf(first);
          const match = state.entries.filter(en => {
            const q = searchInput.value.toLowerCase();
            const inTitle = (en.title || '').toLowerCase().includes(q);
            const inTags = (en.tags || []).some(t => (t || '').toLowerCase().includes(q));
            const inText = (en.text || '').toLowerCase().includes(q);
            return inTitle || inTags || inText;
          })[idx];
          if (match) centerOnEntry(match.__uid);
          searchResults.classList.remove('show');
        }
      } else if (e.key === 'Escape') {
        searchResults.classList.remove('show');
        searchInput.blur();
      }
    });

    // data
    const res = await fetch('entries.json', { cache: 'no-store' });
    const json = await res.json();
    const entries = Array.isArray(json) ? json : (json.root || []);
    entries.forEach((e, i) => { e.__uid = `${e.id || 'item'}__${i}`; });
    state.entries = entries;
    state.viewEntries = entries;
    renderEntries(state.viewEntries);
    // First layout pass after DOM nodes exist (uses measured heights)
    layoutAndApply(state.viewEntries, { shuffle: false });
    const start = computePanToCenterFromDOM(state.viewEntries);
    state.panX = start.x; state.panY = start.y; setWorldTransform(state.panX, state.panY);
    state.targetPanX = state.panX; state.targetPanY = state.panY;

    // lightbox interactions
    lightbox.addEventListener('click', () => {
      lightbox.setAttribute('hidden', '');
      lightboxImg.src = '';
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !lightbox.hasAttribute('hidden')) {
        lightbox.setAttribute('hidden', '');
        lightboxImg.src = '';
      }
    });

    const modes = ['grid', 'list', 'compact'];
    const viewSlider = document.getElementById('viewSlider');
    const trackEl = viewSlider ? viewSlider.querySelector('.track') : null;
    const thumbEl = viewSlider ? viewSlider.querySelector('.thumb') : null;
    const fillEl = viewSlider ? viewSlider.querySelector('.fill') : null;
    const labelEls = viewSlider ? Array.from(viewSlider.querySelectorAll('.labels span')) : [];

    function updateSliderVisual(mode) {
      if (!viewSlider || !trackEl || !thumbEl || !fillEl) return;
      const idx = Math.max(0, modes.indexOf(mode));
      const steps = modes.length - 1 || 1;
      const pct = (idx / steps) * 100;
      thumbEl.style.left = `${pct}%`;
      fillEl.style.width = `${pct}%`;
      labelEls.forEach((el, i) => el.classList.toggle('active', i === idx));
    }

    function applyFiltersAndRender({ shuffle = false, recenter = true } = {}) {
      const sortSelect = document.getElementById('sortSelect');
      let list = state.entries;
      const effectiveTags = state.selectedTags || [];
      if (effectiveTags.length) {
        list = list.filter(e => {
          const tags = e.tags || [];
          return tags.some(t => effectiveTags.includes(t));
        });
      }
      const sortVal = sortSelect ? sortSelect.value : 'original';
      list = [...list];
      if (sortVal === 'title') {
        list.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
      } else if (sortVal === 'type') {
        list.sort((a, b) => (a.type || '').localeCompare(b.type || ''));
      }
      state.viewEntries = list;
      renderEntries(state.viewEntries);
      layoutAndApply(state.viewEntries, { shuffle });
      updateSliderVisual(state.viewMode);
      if (recenter) {
        const center = computePanToCenterFromDOM(state.viewEntries);
        animatePanTo(center.x, center.y);
      }
    }

    if (shuffleBtn) {
      shuffleBtn.addEventListener('click', () => {
        layoutAndApply(state.viewEntries, { shuffle: true });
      });
    }

    function setViewMode(mode, { recenter = true } = {}) {
      if (!modes.includes(mode)) return;
      state.viewMode = mode;
      applyFiltersAndRender({ shuffle: false, recenter });
    }

    if (viewSlider && trackEl && thumbEl) {
      let dragging = false;
      function modeFromClientX(clientX) {
        const rect = trackEl.getBoundingClientRect();
        const clampedX = Math.min(Math.max(clientX, rect.left), rect.right);
        const steps = modes.length - 1 || 1;
        const ratio = (clampedX - rect.left) / (rect.width || 1);
        const idx = Math.round(ratio * steps);
        return modes[idx];
      }
      function pointerMove(ev) {
        if (!dragging) return;
        ev.preventDefault();
        const mode = modeFromClientX(ev.clientX);
        setViewMode(mode, { recenter: true });
      }
      trackEl.addEventListener('pointerdown', (ev) => {
        dragging = true;
        const mode = modeFromClientX(ev.clientX);
        setViewMode(mode, { recenter: true });
        window.addEventListener('pointermove', pointerMove);
        window.addEventListener('pointerup', () => {
          dragging = false;
          window.removeEventListener('pointermove', pointerMove);
        }, { once: true });
      });
      thumbEl.addEventListener('pointerdown', (ev) => {
        dragging = true;
        ev.preventDefault();
        window.addEventListener('pointermove', pointerMove);
        window.addEventListener('pointerup', () => {
          dragging = false;
          window.removeEventListener('pointermove', pointerMove);
        }, { once: true });
      });
      labelEls.forEach((el) => {
        el.addEventListener('click', () => {
          const mode = el.dataset.mode;
          setViewMode(mode, { recenter: true });
        });
      });
      updateSliderVisual(state.viewMode);
    }

    const sortSelectEl = document.getElementById('sortSelect');
    const tagPillsEl = document.getElementById('tagPills');
    function rebuildTagPills() {
      if (!tagPillsEl) return;
      tagPillsEl.innerHTML = '';
      const tagSet = new Set();
      for (const e of state.entries) {
        (e.tags || []).forEach(t => tagSet.add(t));
      }
      const tagsSorted = Array.from(tagSet).sort((a, b) => a.localeCompare(b));
      const allPill = document.createElement('button');
      allPill.type = 'button';
      allPill.className = 'tag-pill';
      if (!state.selectedTags.length) allPill.classList.add('active');
      allPill.textContent = 'all tags';
      allPill.addEventListener('click', () => {
        state.selectedTags = [];
        rebuildTagPills();
        applyFiltersAndRender({ shuffle: false, recenter: true });
      });
      tagPillsEl.appendChild(allPill);
      for (const t of tagsSorted) {
        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = 'tag-pill';
        if (state.selectedTags.includes(t)) pill.classList.add('active');
        pill.textContent = t;
        pill.addEventListener('click', () => {
          if (state.selectedTags.includes(t)) {
            state.selectedTags = state.selectedTags.filter(x => x !== t);
          } else {
            state.selectedTags = [...state.selectedTags, t];
          }
          rebuildTagPills();
          applyFiltersAndRender({ shuffle: false, recenter: true });
        });
        tagPillsEl.appendChild(pill);
      }
      // enable wheel and drag scrolling (prevent bubbling to viewport)
      tagPillsEl.addEventListener('wheel', (e) => {
        if (Math.abs(e.deltaX) < Math.abs(e.deltaY)) {
          tagPillsEl.scrollLeft += e.deltaY;
          e.preventDefault();
          e.stopPropagation();
        }
      }, { passive: false });
      let dragging = false;
      let dragStartX = 0;
      let scrollStart = 0;
      tagPillsEl.addEventListener('pointerdown', (e) => {
        dragging = true;
        dragStartX = e.clientX;
        scrollStart = tagPillsEl.scrollLeft;
      });
      window.addEventListener('pointerup', () => { dragging = false; });
      window.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - dragStartX;
        tagPillsEl.scrollLeft = scrollStart - dx;
      });
    }

    rebuildTagPills();
    if (sortSelectEl) {
      sortSelectEl.addEventListener('change', () => applyFiltersAndRender({ shuffle: false, recenter: true }));
    }

    // initial apply to ensure any filters/sort/view take effect
    applyFiltersAndRender({ shuffle: false, recenter: false });

    // relayout on resize
    window.addEventListener('resize', scheduleRelayout);
  }

  window.addEventListener('load', init);

  function onWheel(ev) {
    // allow pinch-zoom gestures/etc to pass if ctrlKey (browser zoom)
    if (ev.ctrlKey) return;
    ev.preventDefault();
    // accumulate velocity; invert so wheel direction feels natural
    const scale = 0.45; // reduced sensitivity for smoother feel
    const clamp = 40;   // cap large deltas from fast wheels/trackpads
    const dx = -Math.sign(ev.deltaX) * Math.min(Math.abs(ev.deltaX), clamp) * scale;
    const dy = -Math.sign(ev.deltaY) * Math.min(Math.abs(ev.deltaY), clamp) * scale;
    state.vx += dx;
    state.vy += dy;
    ensureRenderLoop();
  }
  // attach non-passive so we can preventDefault
  document.addEventListener('wheel', onWheel, { passive: false });

  // Keyboard navigation between entries and Ctrl/Cmd+K for search
  function getEntryCenters() {
    const list = [];
    for (const e of state.viewEntries) {
      const el = state.entryIdToEl.get(e.__uid);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      list.push({ uid: e.__uid, x: e.x + w / 2, y: e.y + h / 2, w, h });
    }
    return list;
  }

  function getWorldViewportCenter() {
    const vp = viewport.getBoundingClientRect();
    return { x: vp.width / 2 - state.panX, y: vp.height / 2 - state.panY };
  }

  function pickInitialActive() {
    const centers = getEntryCenters();
    if (!centers.length) return null;
    const c = getWorldViewportCenter();
    let best = centers[0], bestD2 = Infinity;
    for (const it of centers) {
      const dx = it.x - c.x;
      const dy = it.y - c.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; best = it; }
    }
    return best?.uid || null;
  }

  function moveFocus(direction) {
    if (!state.entries.length) return;
    if (!state.activeUid) {
      state.activeUid = pickInitialActive();
      if (state.activeUid) centerOnEntry(state.activeUid);
      return;
    }
    const centers = getEntryCenters();
    const current = centers.find(c => c.uid === state.activeUid);
    if (!current) {
      state.activeUid = pickInitialActive();
      if (state.activeUid) centerOnEntry(state.activeUid);
      return;
    }
    const dir = {
      left:  { x: -1, y:  0 },
      right: { x:  1, y:  0 },
      up:    { x:  0, y: -1 },
      down:  { x:  0, y:  1 },
    }[direction];
    if (!dir) return;
    let best = null;
    let bestScore = Infinity;
    for (const it of centers) {
      if (it.uid === current.uid) continue;
      const dx = it.x - current.x;
      const dy = it.y - current.y;
      const dot = dx * dir.x + dy * dir.y;
      if (dot <= 0) continue; // only consider items in the intended direction
      // favor alignment in the chosen axis
      const axisPenalty = (dir.x !== 0 ? Math.abs(dy) : Math.abs(dx));
      const dist = Math.hypot(dx, dy);
      const score = dist + axisPenalty * 0.5;
      if (score < bestScore) { bestScore = score; best = it; }
    }
    if (!best) {
      // wrap: pick nearest overall in that direction from viewport center
      const c = getWorldViewportCenter();
      let wrapBest = null, wrapScore = Infinity;
      for (const it of centers) {
        const dx = it.x - c.x;
        const dy = it.y - c.y;
        const dot = dx * dir.x + dy * dir.y;
        if (dot <= 0) continue;
        const axisPenalty = (dir.x !== 0 ? Math.abs(dy) : Math.abs(dx));
        const dist = Math.hypot(dx, dy);
        const score = dist + axisPenalty * 0.5;
        if (score < wrapScore) { wrapScore = score; wrapBest = it; }
      }
      best = wrapBest;
    }
    if (best) {
      state.activeUid = best.uid;
      centerOnEntry(best.uid);
    }
  }

  window.addEventListener('keydown', (e) => {
    // Ignore when typing in inputs or when lightbox is open
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    const isEditing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (document.activeElement && document.activeElement.isContentEditable);
    const lightboxOpen = !lightbox.hasAttribute('hidden');
    if (lightboxOpen) return;

    // Ctrl/Cmd+K to focus search
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
      searchResults.classList.add('show');
      return;
    }
    if (isEditing) return;

    if (e.key === 'ArrowLeft') { e.preventDefault(); moveFocus('left'); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); moveFocus('right'); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveFocus('up'); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); moveFocus('down'); }
  });
})();


