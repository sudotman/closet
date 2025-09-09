/* global window, document, requestAnimationFrame, fetch */
(function () {
  const viewport = document.getElementById('viewport');
  const world = document.getElementById('world');
  const searchInput = document.getElementById('searchInput');
  const searchResults = document.getElementById('searchResults');
  const lightbox = document.getElementById('lightbox');
  const lightboxImg = document.getElementById('lightboxImg');

  const state = {
    panX: 0,
    panY: 0,
    isDragging: false,
    startX: 0,
    startY: 0,
    startPanX: 0,
    startPanY: 0,
    entries: [],
    entryIdToEl: new Map(),
  };

  function setWorldTransform(x, y) {
    world.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }

  function onPointerDown(ev) {
    // ignore drags starting from interactive elements
    const path = ev.composedPath ? ev.composedPath() : ev.path || [];
    const interactive = path.some((el) => el && el.tagName && ['INPUT','A','BUTTON','TEXTAREA','IFRAME'].includes(el.tagName));
    if (interactive) return;
    state.isDragging = true;
    viewport.classList.add('dragging');
    state.startX = ev.clientX;
    state.startY = ev.clientY;
    state.startPanX = state.panX;
    state.startPanY = state.panY;
  }

  function onPointerMove(ev) {
    if (!state.isDragging) return;
    const dx = ev.clientX - state.startX;
    const dy = ev.clientY - state.startY;
    state.panX = state.startPanX + dx;
    state.panY = state.startPanY + dy;
    setWorldTransform(state.panX, state.panY);
  }

  function onPointerUp() {
    state.isDragging = false;
    viewport.classList.remove('dragging');
  }

  function lerp(a, b, t) { return a + (b - a) * t; }

  function animatePanTo(targetX, targetY, duration = 420) {
    const startX = state.panX;
    const startY = state.panY;
    const startTime = performance.now();
    function frame(now) {
      const p = Math.min(1, (now - startTime) / duration);
      const ease = p < 0.5 ? 2 * p * p : -1 + (4 - 2 * p) * p; // easeInOutQuad
      state.panX = lerp(startX, targetX, ease);
      state.panY = lerp(startY, targetY, ease);
      setWorldTransform(state.panX, state.panY);
      if (p < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
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

      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = entry.title || '';

      if (entry.title) card.appendChild(title);

      let contentEl = null;
      if (entry.type === 'image') {
        const img = document.createElement('img');
        img.src = entry.src;
        img.alt = entry.alt || entry.title || '';
        img.addEventListener('click', (e) => {
          e.stopPropagation();
          lightboxImg.src = entry.src;
          lightbox.removeAttribute('hidden');
        });
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
        iframe.src = `https://www.youtube-nocookie.com/embed/${entry.youtubeId}`;
        contentEl = iframe;
      }

      if (contentEl) card.appendChild(contentEl);

      // click to center
      card.addEventListener('click', (e) => {
        // ignore deep clicks on links so navigation works
        if (e.target && (e.target.tagName === 'A' || e.target.tagName === 'IFRAME' || e.target.closest('a'))) return;
        centerOnEntry(entry.id);
      });

      world.appendChild(card);
      state.entryIdToEl.set(entry.id, card);
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
        centerOnEntry(e.id);
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
          if (match) centerOnEntry(match.id);
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
    state.entries = entries;
    renderEntries(entries);
    const start = computeInitialPanToCenter(entries);
    state.panX = start.x; state.panY = start.y; setWorldTransform(state.panX, state.panY);

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
  }

  window.addEventListener('load', init);
})();


