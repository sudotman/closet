/* ------------------------------------------------------------------
   closet · script.js
   A pan/zoom canvas over a masonry of cards.

   Transform model:  screen = world * zoom + pan   (origin 0 0)
   Everything measured in world units via offsetWidth/offsetHeight,
   which are immune to the ancestor scale.
   ------------------------------------------------------------------ */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var Card = window.ClosetCard;

  var viewport   = $('viewport');
  var world      = $('world');
  var gridEl     = $('grid');
  var consoleEl  = $('console');
  var qInput     = $('q');
  var resultsEl  = $('results');
  var tagIndexEl = $('tagIndex');
  var tagClearEl = $('tagClear');
  var countEl    = $('count');
  var coordEl    = $('coord');
  var zoomValEl  = $('zoomVal');
  var statusEl   = $('status');
  var statusLine = $('statusLine');
  var statusNote = $('statusNote');
  var statusBtn  = $('statusAction');
  var sheetEl    = $('sheet');
  var helpBtn    = $('helpBtn');
  var lightbox   = $('lightbox');
  var lightboxImg = $('lightboxImg');
  var lightboxCap = $('lightboxCap');

  var MIN_ZOOM = 0.22;
  var MAX_ZOOM = 2.6;
  var GRID_BASE = 28;
  var VIEWS = ['grid', 'list', 'compact'];
  var SORTS = ['original', 'title', 'type'];

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var state = {
    entries: [],          // every entry, in file order
    visible: [],          // what is on the canvas right now
    nodes: new Map(),     // uid -> positioned .node element
    view: 'grid',
    sort: 'original',
    tags: [],
    query: '',
    activeUid: null,
    cursor: -1,           // highlighted row in the results list
    results: [],
    pan: { x: 0, y: 0 },
    panTarget: { x: 0, y: 0 },
    zoom: 1,
    zoomTarget: 1,
    vel: { x: 0, y: 0 },
    raf: null,
    dragging: false,
    moved: false,
    suppressClick: false,
    pointers: new Map(),
    pinch: null,
    touched: false   // has the reader taken over the view?
  };

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }

  function debounce(fn, wait) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      if (t) clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, wait);
    };
  }

  /* ==============================================================
     transform + render loop
     ============================================================== */

  function applyTransform() {
    world.style.transform =
      'translate3d(' + state.pan.x + 'px,' + state.pan.y + 'px,0) scale(' + state.zoom + ')';
    paintGrid();
    paintHud();
  }

  /* The grid holds a constant on-screen density by jumping octaves,
     so it stays readable from 22% to 260%. */
  function paintGrid() {
    var step = GRID_BASE * state.zoom;
    while (step < 15) step *= 2;
    while (step > 60) step /= 2;
    gridEl.style.setProperty('--g1', step + 'px');
    gridEl.style.setProperty('--g2', step * 6 + 'px');
    gridEl.style.setProperty('--gx', state.pan.x + 'px');
    gridEl.style.setProperty('--gy', state.pan.y + 'px');
  }

  function paintHud() {
    var vp = viewportSize();
    var wx = Math.round((vp.w / 2 - state.pan.x) / state.zoom);
    var wy = Math.round((vp.h / 2 - state.pan.y) / state.zoom);
    var sign = function (n) { return (n < 0 ? '−' : '+') + Math.abs(n); };
    coordEl.textContent = sign(wx) + ' ' + sign(wy);
    zoomValEl.textContent = Math.round(state.zoom * 100) + '%';
  }

  function viewportSize() {
    return { w: viewport.clientWidth, h: viewport.clientHeight };
  }

  function ensureLoop() {
    if (state.raf != null) return;
    var SMOOTH = reduceMotion ? 1 : 0.19;
    var FRICTION = 0.86;
    var EPS = 0.05;

    function step() {
      if (!reduceMotion && (Math.abs(state.vel.x) > EPS || Math.abs(state.vel.y) > EPS)) {
        state.panTarget.x += state.vel.x;
        state.panTarget.y += state.vel.y;
        state.vel.x *= FRICTION;
        state.vel.y *= FRICTION;
      } else {
        state.vel.x = state.vel.y = 0;
      }

      state.pan.x = lerp(state.pan.x, state.panTarget.x, SMOOTH);
      state.pan.y = lerp(state.pan.y, state.panTarget.y, SMOOTH);
      state.zoom = lerp(state.zoom, state.zoomTarget, SMOOTH);
      applyTransform();

      var settled =
        Math.abs(state.pan.x - state.panTarget.x) < 0.3 &&
        Math.abs(state.pan.y - state.panTarget.y) < 0.3 &&
        Math.abs(state.zoom - state.zoomTarget) < 0.0015;
      var moving = state.dragging || Math.abs(state.vel.x) > EPS || Math.abs(state.vel.y) > EPS;

      if (settled && !moving) {
        state.pan.x = state.panTarget.x;
        state.pan.y = state.panTarget.y;
        state.zoom = state.zoomTarget;
        applyTransform();
        state.raf = null;
        return;
      }
      state.raf = requestAnimationFrame(step);
    }
    state.raf = requestAnimationFrame(step);
  }

  function panTo(x, y) {
    state.panTarget.x = x;
    state.panTarget.y = y;
    state.vel.x = state.vel.y = 0;
    ensureLoop();
  }

  /* Zoom while holding the world point under (sx, sy) still. */
  function zoomAt(next, sx, sy) {
    var z0 = state.zoomTarget;
    var z1 = clamp(next, MIN_ZOOM, MAX_ZOOM);
    if (Math.abs(z1 - z0) < 0.0001) return;
    state.touched = true;
    var wx = (sx - state.panTarget.x) / z0;
    var wy = (sy - state.panTarget.y) / z0;
    state.zoomTarget = z1;
    state.panTarget.x = sx - wx * z1;
    state.panTarget.y = sy - wy * z1;
    ensureLoop();
  }

  function zoomBy(factor) {
    var vp = viewportSize();
    zoomAt(state.zoomTarget * factor, vp.w / 2, vp.h / 2);
  }

  /* ==============================================================
     pointer input — drag to pan, two fingers to pinch
     ============================================================== */

  function isInteractive(ev) {
    var t = ev.target;
    return !!(t && t.closest && t.closest('a, button, input, textarea, select, iframe, .card--compact'));
  }

  viewport.addEventListener('pointerdown', function (ev) {
    state.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });

    if (state.pointers.size === 2) { beginPinch(); return; }
    if (state.pointers.size > 2) return;
    if (isInteractive(ev)) return;

    ev.preventDefault();
    try { viewport.setPointerCapture(ev.pointerId); } catch (e) {}
    var sel = window.getSelection && window.getSelection();
    if (sel && sel.removeAllRanges) { try { sel.removeAllRanges(); } catch (e2) {} }

    state.dragging = true;
    state.moved = false;
    state.drag = {
      sx: ev.clientX, sy: ev.clientY,
      px: state.panTarget.x, py: state.panTarget.y,
      lx: ev.clientX, ly: ev.clientY, lt: performance.now()
    };
    state.vel.x = state.vel.y = 0;
    viewport.classList.add('is-dragging');
    ensureLoop();
  });

  window.addEventListener('pointermove', function (ev) {
    if (state.pointers.has(ev.pointerId)) {
      state.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    }
    if (state.pinch) { updatePinch(); return; }
    if (!state.dragging) return;

    ev.preventDefault();
    var d = state.drag;
    var dx = ev.clientX - d.sx;
    var dy = ev.clientY - d.sy;
    if (!state.moved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
      state.moved = true;
      state.touched = true;
    }

    state.panTarget.x = d.px + dx;
    state.panTarget.y = d.py + dy;

    var now = performance.now();
    var dt = Math.max(1, now - d.lt);
    state.vel.x = ((ev.clientX - d.lx) / dt) * 16;
    state.vel.y = ((ev.clientY - d.ly) / dt) * 16;
    d.lx = ev.clientX; d.ly = ev.clientY; d.lt = now;
    ensureLoop();
  }, { passive: false });

  function endPointer(ev) {
    state.pointers.delete(ev.pointerId);
    if (state.pointers.size < 2) state.pinch = null;
    if (!state.dragging) return;

    var moved = state.moved;
    state.dragging = false;
    viewport.classList.remove('is-dragging');
    if (moved) {
      /* swallow the click that a drag-release would otherwise fire */
      state.suppressClick = true;
      setTimeout(function () { state.suppressClick = false; }, 130);
    }
    ensureLoop();
  }
  window.addEventListener('pointerup', endPointer);
  window.addEventListener('pointercancel', endPointer);

  function pinchPoints() {
    var pts = Array.from(state.pointers.values());
    var a = pts[0], b = pts[1];
    return {
      dist: Math.hypot(b.x - a.x, b.y - a.y),
      mx: (a.x + b.x) / 2,
      my: (a.y + b.y) / 2
    };
  }

  function beginPinch() {
    state.dragging = false;
    viewport.classList.remove('is-dragging');
    var p = pinchPoints();
    state.pinch = { dist: p.dist || 1, zoom: state.zoomTarget };
  }

  function updatePinch() {
    var p = pinchPoints();
    if (!p.dist) return;
    zoomAt(state.pinch.zoom * (p.dist / state.pinch.dist), p.mx, p.my);
  }

  /* Wheel pans; ctrl/cmd-wheel (and trackpad pinch, which browsers
     report as ctrlKey) zooms. */
  document.addEventListener('wheel', function (ev) {
    var t = ev.target;
    if (t && t.closest && t.closest('.console, .sheet, .dock, .hud, .lightbox')) return;
    ev.preventDefault();

    if (ev.ctrlKey || ev.metaKey) {
      zoomAt(state.zoomTarget * Math.exp(-ev.deltaY * 0.0022), ev.clientX, ev.clientY);
      return;
    }
    state.touched = true;
    var cap = 40, scale = 0.45;
    state.vel.x += -Math.sign(ev.deltaX) * Math.min(Math.abs(ev.deltaX), cap) * scale;
    state.vel.y += -Math.sign(ev.deltaY) * Math.min(Math.abs(ev.deltaY), cap) * scale;
    if (reduceMotion) {
      state.panTarget.x += state.vel.x * 6;
      state.panTarget.y += state.vel.y * 6;
      state.vel.x = state.vel.y = 0;
    }
    ensureLoop();
  }, { passive: false });

  /* ==============================================================
     rendering
     ============================================================== */

  /* Re-measure, then re-frame only while the view is still ours —
     once the reader has panned or zoomed, leave them where they are. */
  var scheduleLayout = debounce(function () {
    layout();
    if (!state.touched) frame(false);
  }, 70);

  function renderVisible() {
    world.innerHTML = '';
    state.nodes.clear();

    var frag = document.createDocumentFragment();
    state.visible.forEach(function (entry, i) {
      var node = document.createElement('div');
      node.className = 'node';
      node.dataset.uid = entry.__uid;

      var card = Card.createCard(entry, {
        index: entry.__index + 1,
        compact: state.view === 'compact',
        interactive: true,
        onLoad: scheduleLayout,
        isDragging: function () { return state.dragging || state.moved || state.suppressClick; },
        onToggle: scheduleLayout,
        onImageClick: function (e) { openLightbox(e); }
      });

      if (entry.__uid === state.activeUid) card.classList.add('is-active');
      if (!reduceMotion) {
        /* on the card, not the node — the node's transform is its position */
        card.style.animation = 'card-in 520ms var(--ease) both';
        card.style.animationDelay = Math.min(i * 16, 380) + 'ms';
      }

      node.appendChild(card);
      frag.appendChild(node);
      state.nodes.set(entry.__uid, node);
    });
    world.appendChild(frag);
  }

  /* The strip of screen the canvas actually gets. An open drawer owns
     the left edge on desktop, so both layout and framing work against
     what is left — otherwise the wall is laid out under the panel and
     then zoomed out to compensate. */
  function contentArea() {
    var vp = viewportSize();
    var narrow = vp.w < 560;
    var insetL = (vp.w > 720 && consoleIsOpen()) ? consoleEl.offsetWidth + 28 : 0;
    var padX = narrow ? 20 : 48;
    return {
      vw: vp.w,
      vh: vp.h,
      narrow: narrow,
      left: insetL,
      width: Math.max(260, vp.w - insetL - padX * 2)
    };
  }

  /* Two passes: set the width, measure the real height, then place. */
  function layout(opts) {
    opts = opts || {};
    if (!state.visible.length) return;

    /* A hidden or not-yet-sized pane measures zero, which would bake
       nonsense positions in permanently. Wait for a real width. */
    if (!viewport.clientWidth) { scheduleLayout(); return; }

    var area = contentArea();
    var order = opts.shuffle ? shuffled(state.visible) : state.visible;

    if (state.view === 'list' || state.view === 'compact') {
      var colW = Math.min(state.view === 'list' ? 660 : 880, area.width);
      var gap = state.view === 'list' ? 28 : 12;
      var y = 0;
      order.forEach(function (entry) {
        var node = state.nodes.get(entry.__uid);
        if (!node) return;
        node.style.width = colW + 'px';
        entry.__x = Math.round(-colW / 2);
        entry.__y = Math.round(y);
        y += node.offsetHeight + gap;
      });
    } else {
      /* Pick the column count from how wide a card wants to be, then
         let the cards stretch to fill the row — so a wide screen gets
         more columns rather than more emptiness. */
      var gapX = area.narrow ? 28 : 56;
      var gapY = area.narrow ? 36 : 72;
      var TARGET = 340;
      var cols = clamp(
        Math.floor((area.width + gapX) / (TARGET + gapX)),
        area.narrow ? 1 : 2,
        6
      );
      var cardW = clamp(Math.floor((area.width - (cols - 1) * gapX) / cols), 280, 460);
      var totalW = cols * cardW + (cols - 1) * gapX;
      var x0 = -totalW / 2;
      var heights = new Array(cols).fill(0);

      order.forEach(function (entry) {
        var node = state.nodes.get(entry.__uid);
        if (!node) return;
        node.style.width = cardW + 'px';
        var h = node.offsetHeight;

        var col = 0;
        for (var i = 1; i < cols; i++) if (heights[i] < heights[col]) col = i;

        entry.__x = Math.round(x0 + col * (cardW + gapX));
        entry.__y = Math.round(heights[col]);
        heights[col] += h + gapY;
      });
    }

    place();
  }

  function place() {
    state.visible.forEach(function (entry) {
      var node = state.nodes.get(entry.__uid);
      if (!node) return;
      node.style.transform = 'translate3d(' + entry.__x + 'px,' + entry.__y + 'px,0)';
    });
  }

  function shuffled(list) {
    var out = list.slice();
    for (var i = out.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = out[i]; out[i] = out[j]; out[j] = tmp;
    }
    return out;
  }

  /* World-space bounding box of everything currently placed. */
  function bounds() {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    state.visible.forEach(function (entry) {
      var node = state.nodes.get(entry.__uid);
      if (!node || entry.__x == null) return;
      minX = Math.min(minX, entry.__x);
      minY = Math.min(minY, entry.__y);
      maxX = Math.max(maxX, entry.__x + node.offsetWidth);
      maxY = Math.max(maxY, entry.__y + node.offsetHeight);
    });
    if (minX === Infinity) return null;
    return { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
  }

  /* Frame the archive: fit its width, and top-align when the stack is
     taller than the screen. Fitting the *height* of a masonry wall
     means zooming to 12%, which shows nothing worth seeing. */
  function frame(animate) {
    var b = bounds();
    var vp = viewportSize();
    if (!b || !vp.w || !vp.h) return;

    var padY = 72;
    var area = contentArea();

    var bw = Math.max(1, b.maxX - b.minX);
    var bh = Math.max(1, b.maxY - b.minY);

    var z = clamp(Math.min(area.width / bw, 1), MIN_ZOOM, 1);
    var cx = (b.minX + b.maxX) / 2;
    var x = area.left + (vp.w - area.left) / 2 - cx * z;
    var y = bh * z <= vp.h - padY * 2
      ? vp.h / 2 - ((b.minY + b.maxY) / 2) * z   /* it all fits — centre it */
      : padY - b.minY * z;                        /* taller than the screen — start at the top */

    state.zoomTarget = z;
    state.panTarget.x = x;
    state.panTarget.y = y;
    state.vel.x = state.vel.y = 0;
    state.touched = false;

    if (animate === false) {
      state.pan.x = x;
      state.pan.y = y;
      state.zoom = z;
      applyTransform();
    } else {
      ensureLoop();
    }
  }

  /* Centre the viewport on one entry, keeping the current zoom. */
  function centerOn(uid, opts) {
    opts = opts || {};
    var entry = state.visible.find(function (e) { return e.__uid === uid; });
    var node = state.nodes.get(uid);
    if (!entry || !node || entry.__x == null) return;

    var z = opts.zoom != null ? clamp(opts.zoom, MIN_ZOOM, MAX_ZOOM) : state.zoomTarget;
    var vp = viewportSize();
    var cx = entry.__x + node.offsetWidth / 2;
    var cy = entry.__y + node.offsetHeight / 2;

    state.zoomTarget = z;
    state.touched = true;
    panTo(vp.w / 2 - cx * z, vp.h / 2 - cy * z);
    setActive(uid);
  }

  function setActive(uid) {
    if (state.activeUid === uid) return;
    var prev = state.nodes.get(state.activeUid);
    if (prev) prev.firstChild.classList.remove('is-active');
    state.activeUid = uid;
    var next = state.nodes.get(uid);
    if (next) next.firstChild.classList.add('is-active');
  }

  /* ==============================================================
     filtering, sorting, the list the canvas shows
     ============================================================== */

  function computeVisible() {
    var list = state.entries;
    if (state.tags.length) {
      list = list.filter(function (e) {
        return (e.tags || []).some(function (t) { return state.tags.indexOf(t) !== -1; });
      });
    }
    list = list.slice();
    if (state.sort === 'title') {
      list.sort(function (a, b) {
        return Card.entryTitle(a).localeCompare(Card.entryTitle(b));
      });
    } else if (state.sort === 'type') {
      list.sort(function (a, b) {
        var d = (a.type || '').localeCompare(b.type || '');
        return d !== 0 ? d : Card.entryTitle(a).localeCompare(Card.entryTitle(b));
      });
    }
    return list;
  }

  function refresh(opts) {
    opts = opts || {};
    state.visible = computeVisible();
    renderVisible();
    layout({ shuffle: opts.shuffle });

    countEl.textContent = state.visible.length === state.entries.length
      ? state.entries.length + ' items'
      : state.visible.length + ' / ' + state.entries.length;

    paintTagIndex();
    syncUrl();
    showStatus(state.visible.length ? null : 'empty');
    if (state.query) dimUnmatched(state.query.toLowerCase());

    if (opts.recenter !== false) frame(opts.animate !== false);
    else place();
  }

  /* ==============================================================
     tag index
     ============================================================== */

  function tagCounts() {
    var counts = new Map();
    state.entries.forEach(function (e) {
      (e.tags || []).forEach(function (t) {
        counts.set(t, (counts.get(t) || 0) + 1);
      });
    });
    return counts;
  }

  function paintTagIndex() {
    var counts = tagCounts();
    var names = Array.from(counts.keys()).sort(function (a, b) { return a.localeCompare(b); });
    var q = state.query.toLowerCase();

    tagIndexEl.innerHTML = '';
    names.forEach(function (name) {
      var on = state.tags.indexOf(name) !== -1;

      /* When a search is running, grey out tags it cannot reach. */
      var reachable = !q || state.entries.some(function (e) {
        return (e.tags || []).indexOf(name) !== -1 && Card.searchText(e).indexOf(q) !== -1;
      });

      var li = document.createElement('li');
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tag-row' + (on ? ' is-on' : '') + (reachable ? '' : ' is-empty');
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');

      var mark = document.createElement('span');
      mark.className = 'tag-row__mark';
      var nameEl = document.createElement('span');
      nameEl.className = 'tag-row__name';
      nameEl.textContent = name;
      var leader = document.createElement('span');
      leader.className = 'u-leader';
      var count = document.createElement('span');
      count.className = 'tag-row__count';
      count.textContent = String(counts.get(name)).padStart(2, '0');

      btn.append(mark, nameEl, leader, count);
      btn.addEventListener('click', function () { toggleTag(name); });
      li.appendChild(btn);
      tagIndexEl.appendChild(li);
    });

    tagClearEl.hidden = state.tags.length === 0;
  }

  function toggleTag(name) {
    var i = state.tags.indexOf(name);
    if (i === -1) state.tags = state.tags.concat(name);
    else state.tags = state.tags.filter(function (t) { return t !== name; });
    refresh();
  }

  /* ==============================================================
     search
     ============================================================== */

  function runSearch(raw) {
    state.query = (raw || '').trim();
    var q = state.query.toLowerCase();
    document.querySelector('.search').classList.toggle('is-busy', !!q);

    if (!q) {
      state.results = [];
      state.cursor = -1;
      resultsEl.classList.remove('is-open');
      resultsEl.innerHTML = '';
      paintTagIndex();
      undimAll();
      return;
    }

    /* Search the whole archive, not just what the tag filter shows,
       so a hidden entry is still findable. */
    state.results = state.entries.filter(function (e) {
      return Card.searchText(e).indexOf(q) !== -1;
    }).slice(0, 24);
    state.cursor = state.results.length ? 0 : -1;

    paintResults(q);
    paintTagIndex();
    dimUnmatched(q);
  }

  function paintResults(q) {
    resultsEl.innerHTML = '';
    resultsEl.classList.add('is-open');

    if (!state.results.length) {
      var none = document.createElement('li');
      none.className = 'results__empty';
      none.textContent = 'nothing in the closet matches that';
      resultsEl.appendChild(none);
      return;
    }

    state.results.forEach(function (entry, i) {
      var li = document.createElement('li');
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'result' + (i === state.cursor ? ' is-cursor' : '');

      var sigil = document.createElement('span');
      sigil.className = 'result__sigil';
      sigil.textContent = Card.typeInfo(entry.type).sigil;

      var title = document.createElement('span');
      title.className = 'result__title';
      highlight(title, Card.entryTitle(entry), q);

      btn.append(sigil, title);
      btn.addEventListener('click', function () { gotoResult(i); });
      btn.addEventListener('mouseenter', function () { moveCursor(i, false); });
      li.appendChild(btn);
      resultsEl.appendChild(li);
    });
  }

  function highlight(host, text, q) {
    var at = text.toLowerCase().indexOf(q);
    if (at === -1) { host.textContent = text; return; }
    host.appendChild(document.createTextNode(text.slice(0, at)));
    var mark = document.createElement('mark');
    mark.textContent = text.slice(at, at + q.length);
    host.appendChild(mark);
    host.appendChild(document.createTextNode(text.slice(at + q.length)));
  }

  function moveCursor(i, scroll) {
    if (!state.results.length) return;
    state.cursor = (i + state.results.length) % state.results.length;
    var rows = resultsEl.querySelectorAll('.result');
    rows.forEach(function (r, n) { r.classList.toggle('is-cursor', n === state.cursor); });
    if (scroll !== false && rows[state.cursor]) {
      rows[state.cursor].scrollIntoView({ block: 'nearest' });
    }
  }

  function gotoResult(i) {
    var entry = state.results[i];
    if (!entry) return;

    /* If the tag filter is hiding it, drop the filter rather than
       silently doing nothing. */
    var onCanvas = state.visible.some(function (e) { return e.__uid === entry.__uid; });
    if (!onCanvas) {
      state.tags = [];
      refresh({ recenter: false });
    }
    resultsEl.classList.remove('is-open');
    centerOn(entry.__uid, { zoom: Math.max(state.zoomTarget, 0.8) });
  }

  function dimUnmatched(q) {
    state.visible.forEach(function (e) {
      var node = state.nodes.get(e.__uid);
      if (!node) return;
      node.firstChild.classList.toggle('is-dimmed', Card.searchText(e).indexOf(q) === -1);
    });
  }

  function undimAll() {
    state.nodes.forEach(function (node) { node.firstChild.classList.remove('is-dimmed'); });
  }

  /* ==============================================================
     lightbox
     ============================================================== */

  function openLightbox(entry) {
    if (state.suppressClick || state.moved) return;
    lightboxImg.src = Card.resolveSrc(entry.src);
    lightboxImg.alt = entry.alt || entry.title || '';
    lightboxCap.textContent = [entry.title, entry.alt].filter(Boolean).join(' · ');
    lightbox.hidden = false;
    $('lightboxClose').focus();
  }

  function closeLightbox() {
    lightbox.hidden = true;
    lightboxImg.src = '';
  }

  lightbox.addEventListener('click', function (ev) {
    if (ev.target === lightboxImg) return;
    closeLightbox();
  });

  /* ==============================================================
     status overlay
     ============================================================== */

  function showStatus(kind, detail) {
    if (!kind) { statusEl.hidden = true; return; }
    statusEl.hidden = false;
    statusBtn.hidden = true;

    if (kind === 'loading') {
      statusLine.textContent = 'opening the closet';
      statusNote.textContent = '';
    } else if (kind === 'empty') {
      statusLine.textContent = 'nothing here';
      statusNote.textContent = 'No entry carries ' +
        (state.tags.length > 1 ? 'any of those tags.' : 'that tag.');
      statusBtn.hidden = false;
      statusBtn.textContent = 'clear filters';
    } else if (kind === 'error') {
      statusLine.textContent = 'could not read entries.json';
      statusNote.textContent = detail || 'Check the file and reload.';
      statusBtn.hidden = false;
      statusBtn.textContent = 'retry';
    }
    statusEl.dataset.kind = kind;
  }

  statusBtn.addEventListener('click', function () {
    if (statusEl.dataset.kind === 'error') { location.reload(); return; }
    state.tags = [];
    refresh();
  });

  /* ==============================================================
     url state — shareable filters and a link to one entry
     ============================================================== */

  function syncUrl() {
    var p = new URLSearchParams();
    if (state.tags.length) p.set('tag', state.tags.join(','));
    if (state.view !== 'grid') p.set('view', state.view);
    if (state.sort !== 'original') p.set('sort', state.sort);
    var qs = p.toString();
    history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
  }

  function readUrl() {
    var p = new URLSearchParams(location.search);
    var tag = p.get('tag');
    if (tag) state.tags = tag.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    var view = p.get('view');
    if (VIEWS.indexOf(view) !== -1) state.view = view;
    var sort = p.get('sort');
    if (SORTS.indexOf(sort) !== -1) state.sort = sort;
  }

  /* ==============================================================
     chrome wiring
     ============================================================== */

  function paintSegs() {
    document.querySelectorAll('#viewSeg button').forEach(function (b) {
      var on = b.dataset.view === state.view;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    document.querySelectorAll('#sortSeg button').forEach(function (b) {
      var on = b.dataset.sort === state.sort;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function setConsoleOpen(open) {
    consoleEl.dataset.open = open ? 'true' : 'false';
    $('consoleToggle').setAttribute('aria-expanded', open ? 'true' : 'false');
    $('consoleToggle').title = open ? 'collapse the index' : 'open the index';
  }

  function consoleIsOpen() { return consoleEl.dataset.open === 'true'; }

  function wireChrome() {
    $('consoleToggle').addEventListener('click', function () {
      setConsoleOpen(!consoleIsOpen());
      /* the drawer changes how much canvas there is, so re-flow */
      layout();
      frame(true);
    });

    document.querySelectorAll('#viewSeg button').forEach(function (b) {
      b.addEventListener('click', function () {
        state.view = b.dataset.view;
        paintSegs();
        refresh();
      });
    });

    document.querySelectorAll('#sortSeg button').forEach(function (b) {
      b.addEventListener('click', function () {
        state.sort = b.dataset.sort;
        paintSegs();
        refresh();
      });
    });

    $('shuffleBtn').addEventListener('click', function () {
      layout({ shuffle: true });
      frame(true);
    });
    $('fitBtn').addEventListener('click', function () { frame(true); });
    tagClearEl.addEventListener('click', function () { state.tags = []; refresh(); });

    document.querySelectorAll('[data-zoom]').forEach(function (b) {
      b.addEventListener('click', function () {
        zoomBy(b.dataset.zoom === 'in' ? 1.25 : 1 / 1.25);
      });
    });
    zoomValEl.addEventListener('click', function () {
      var vp = viewportSize();
      zoomAt(1, vp.w / 2, vp.h / 2);
    });

    qInput.addEventListener('input', function (e) { runSearch(e.target.value); });
    qInput.addEventListener('focus', function () {
      if (state.results.length) resultsEl.classList.add('is-open');
    });
    qInput.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveCursor(state.cursor + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveCursor(state.cursor - 1); }
      else if (e.key === 'Enter') { e.preventDefault(); gotoResult(state.cursor); }
      else if (e.key === 'Escape') {
        e.preventDefault();
        if (qInput.value) { qInput.value = ''; runSearch(''); }
        else qInput.blur();
      }
    });

    helpBtn.addEventListener('click', function () { toggleSheet(); });
    $('sheetClose').addEventListener('click', function () { toggleSheet(false); });
    $('lightboxClose').addEventListener('click', closeLightbox);

    /* Observe the viewport, not the window: the pane can change size
       without a window resize event, and starts at zero width. */
    var lastW = 0, lastH = 0;
    var onResize = debounce(function () {
      var vp = viewportSize();
      if (!vp.w || (vp.w === lastW && vp.h === lastH)) return;
      lastW = vp.w; lastH = vp.h;
      layout();
      if (!state.touched) frame(false);
    }, 120);

    if (window.ResizeObserver) new ResizeObserver(onResize).observe(viewport);
    window.addEventListener('resize', onResize);
  }

  function toggleSheet(force) {
    var open = force != null ? force : sheetEl.hidden;
    sheetEl.hidden = !open;
    helpBtn.classList.toggle('is-on', open);
  }

  /* ==============================================================
     keyboard
     ============================================================== */

  function editing() {
    var el = document.activeElement;
    if (!el) return false;
    var tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }

  /* Nearest entry to the middle of the screen, used as the starting
     point for arrow navigation. */
  function nearestToCenter() {
    var vp = viewportSize();
    var cx = (vp.w / 2 - state.pan.x) / state.zoom;
    var cy = (vp.h / 2 - state.pan.y) / state.zoom;
    var best = null, bestD = Infinity;
    state.visible.forEach(function (e) {
      var node = state.nodes.get(e.__uid);
      if (!node || e.__x == null) return;
      var dx = e.__x + node.offsetWidth / 2 - cx;
      var dy = e.__y + node.offsetHeight / 2 - cy;
      var d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = e.__uid; }
    });
    return best;
  }

  function stepFocus(dir) {
    if (!state.visible.length) return;
    if (!state.activeUid || !state.nodes.has(state.activeUid)) {
      var first = nearestToCenter();
      if (first) centerOn(first);
      return;
    }
    var cur = state.visible.find(function (e) { return e.__uid === state.activeUid; });
    var curNode = state.nodes.get(state.activeUid);
    if (!cur || !curNode) return;

    var vec = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[dir];
    var cx = cur.__x + curNode.offsetWidth / 2;
    var cy = cur.__y + curNode.offsetHeight / 2;

    var best = null, bestScore = Infinity;
    state.visible.forEach(function (e) {
      if (e.__uid === state.activeUid) return;
      var node = state.nodes.get(e.__uid);
      if (!node) return;
      var dx = e.__x + node.offsetWidth / 2 - cx;
      var dy = e.__y + node.offsetHeight / 2 - cy;
      if (dx * vec[0] + dy * vec[1] <= 0) return;      // wrong direction
      var offAxis = vec[0] !== 0 ? Math.abs(dy) : Math.abs(dx);
      var score = Math.hypot(dx, dy) + offAxis * 1.4;  // prefer staying in lane
      if (score < bestScore) { bestScore = score; best = e.__uid; }
    });
    if (best) centerOn(best);
  }

  /* Enter on the held entry does the obvious thing for its type. */
  function openActive() {
    var entry = state.visible.find(function (e) { return e.__uid === state.activeUid; });
    if (!entry) return;
    if (entry.type === 'image') { openLightbox(entry); return; }
    if (entry.url) { window.open(entry.url, '_blank', 'noopener'); return; }
    var node = state.nodes.get(entry.__uid);
    if (node && state.view === 'compact') {
      node.firstChild.classList.toggle('is-open');
      scheduleLayout();
    }
  }

  function focusSearch(seed) {
    setConsoleOpen(true);
    qInput.focus();
    if (seed) { qInput.value = seed; runSearch(seed); }
    else qInput.select();
  }

  window.addEventListener('keydown', function (e) {
    if (!lightbox.hidden) {
      if (e.key === 'Escape') { e.preventDefault(); closeLightbox(); }
      return;
    }

    var mod = e.ctrlKey || e.metaKey;

    if (mod && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); focusSearch(); return; }

    if (e.key === 'Escape') {
      if (!sheetEl.hidden) { toggleSheet(false); return; }
      if (qInput.value) { qInput.value = ''; runSearch(''); qInput.blur(); return; }
      if (state.tags.length) { state.tags = []; refresh(); return; }
      if (document.activeElement !== document.body) document.activeElement.blur();
      return;
    }

    if (editing() || mod || e.altKey) return;

    switch (e.key) {
      case 'ArrowLeft':  e.preventDefault(); stepFocus('left');  return;
      case 'ArrowRight': e.preventDefault(); stepFocus('right'); return;
      case 'ArrowUp':    e.preventDefault(); stepFocus('up');    return;
      case 'ArrowDown':  e.preventDefault(); stepFocus('down');  return;
      case 'Enter':      e.preventDefault(); openActive();  return;
      case '0':          e.preventDefault(); frame(true);   return;
      case '+': case '=': e.preventDefault(); zoomBy(1.25); return;
      case '-': case '_': e.preventDefault(); zoomBy(1 / 1.25); return;
      case '\\':         e.preventDefault(); setConsoleOpen(!consoleIsOpen()); return;
      case '?':          e.preventDefault(); toggleSheet(); return;
    }

    /* Type anywhere to search — the README's original promise. */
    if (e.key.length === 1 && /\S/.test(e.key)) {
      e.preventDefault();
      focusSearch(e.key);
    }
  });

  /* ==============================================================
     boot
     ============================================================== */

  async function init() {
    showStatus('loading');
    wireChrome();
    readUrl();
    paintSegs();
    setConsoleOpen(window.innerWidth > 720);

    var json;
    try {
      var res = await fetch('entries.json', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      json = await res.json();
    } catch (err) {
      showStatus('error', String(err.message || err));
      return;
    }

    var raw = Array.isArray(json) ? json : (json.root || []);
    raw.forEach(function (e, i) {
      e.__uid = 'e' + i;
      e.__index = i;
      if (!e.id) e.id = Card.slugify(Card.entryTitle(e)) || 'item-' + i;
    });
    state.entries = raw;

    if (!state.entries.length) {
      showStatus('empty');
      countEl.textContent = '0 items';
      return;
    }

    showStatus(null);
    refresh({ animate: false });

    /* #some-entry-id deep link */
    var hash = decodeURIComponent(location.hash.replace(/^#/, ''));
    if (hash) {
      var target = state.visible.find(function (e) { return e.id === hash; });
      if (target) {
        requestAnimationFrame(function () { centerOn(target.__uid, { zoom: 1 }); });
      }
    }

    /* Late-loading fonts change every card's height. */
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () { layout(); });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
