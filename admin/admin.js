/* ------------------------------------------------------------------
   closet · admin/admin.js
   A static CMS. It reads entries.json from GitHub, lets you edit it
   with the real card renderer as the preview, and writes it back
   either as a commit or as a pull request.
   ------------------------------------------------------------------ */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var Card = window.ClosetCard;
  var GH = window.ClosetGitHub;

  var FILE = 'entries.json';
  var MEDIA_DIR = 'uploads';
  var LS_CONFIG = 'closet.console.config';
  var LS_TOKEN = 'closet.console.token';
  var LS_DRAFT = 'closet.console.draft';

  /* Written in this order so the file stays readable and diffs stay
     small. Anything not listed is preserved untouched at the end. */
  var KEY_ORDER = ['id', 'type', 'title', 'text', 'url', 'linkText', 'src', 'alt', 'youtubeId', 'tags'];

  var state = {
    client: null,
    access: null,       // what the token is allowed to do
    entries: [],        // working copy
    baseline: [],       // what GitHub had when we loaded
    baseText: '',       // exact text we loaded, for the dirty check
    sha: null,          // blob sha of entries.json
    selected: null,     // __key of the entry being edited
    filter: '',
    typeFilter: '',
    uploads: [],        // existing files in /uploads
    pending: new Map(), // path -> { base64, dataUrl } waiting to be committed
    mode: 'direct',
    keySeed: 0
  };

  /* ==============================================================
     small helpers
     ============================================================== */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function toast(msg, kind, holdMs) {
    var t = $('toast');
    t.className = 'toast' + (kind ? ' is-' + kind : '');
    t.innerHTML = '';
    if (msg instanceof Node) t.appendChild(msg);
    else t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.hidden = true; }, holdMs || 3600);
  }

  function newKey() { return 'k' + (++state.keySeed); }

  function deepClone(v) { return JSON.parse(JSON.stringify(v)); }

  /* Strip our bookkeeping and drop empties, keeping the canonical
     field order and any field we do not model. */
  function clean(entry) {
    var out = {};
    KEY_ORDER.forEach(function (k) {
      var v = entry[k];
      if (v == null) return;
      if (typeof v === 'string' && !v.trim()) return;
      if (Array.isArray(v)) {
        var arr = v.filter(function (x) { return x != null && String(x).trim(); });
        if (!arr.length) return;
        out[k] = arr;
        return;
      }
      out[k] = v;
    });
    Object.keys(entry).forEach(function (k) {
      if (k.slice(0, 2) === '__') return;
      if (KEY_ORDER.indexOf(k) !== -1) return;
      out[k] = entry[k];
    });
    return out;
  }

  function serialize(list) {
    return JSON.stringify({ root: list.map(clean) }, null, 2) + '\n';
  }

  function isDirty() {
    return serialize(state.entries) !== state.baseText || state.pending.size > 0;
  }

  function uniqueId(base, exceptKey) {
    var root = Card.slugify(base) || 'item';
    var id = root;
    var n = 2;
    var taken = function (candidate) {
      return state.entries.some(function (e) {
        return e.__key !== exceptKey && e.id === candidate;
      });
    };
    while (taken(id)) id = root + '-' + n++;
    return id;
  }

  /* ==============================================================
     config + token
     ============================================================== */

  function loadConfig() {
    var raw = null;
    try { raw = JSON.parse(localStorage.getItem(LS_CONFIG) || 'null'); } catch (e) {}
    return raw || { owner: 'sudotman', repo: 'closet', branch: 'main' };
  }

  function saveConfig(cfg) {
    try { localStorage.setItem(LS_CONFIG, JSON.stringify(cfg)); } catch (e) {}
  }

  function readToken() {
    try { return sessionStorage.getItem(LS_TOKEN) || localStorage.getItem(LS_TOKEN) || ''; }
    catch (e) { return ''; }
  }

  function saveToken(token, remember) {
    try {
      sessionStorage.removeItem(LS_TOKEN);
      localStorage.removeItem(LS_TOKEN);
      (remember ? localStorage : sessionStorage).setItem(LS_TOKEN, token);
    } catch (e) {}
  }

  function forgetToken() {
    try {
      sessionStorage.removeItem(LS_TOKEN);
      localStorage.removeItem(LS_TOKEN);
    } catch (e) {}
  }

  /* ==============================================================
     drafts — a refresh should never lose an afternoon of edits
     ============================================================== */

  function saveDraft() {
    try {
      if (!isDirty()) { localStorage.removeItem(LS_DRAFT); return; }
      localStorage.setItem(LS_DRAFT, JSON.stringify({
        at: Date.now(),
        sha: state.sha,
        text: serialize(state.entries)
      }));
    } catch (e) {}
  }

  function readDraft() {
    try { return JSON.parse(localStorage.getItem(LS_DRAFT) || 'null'); }
    catch (e) { return null; }
  }

  function clearDraft() {
    try { localStorage.removeItem(LS_DRAFT); } catch (e) {}
  }

  /* ==============================================================
     boot
     ============================================================== */

  function init() {
    var cfg = loadConfig();
    $('cfgOwner').value = cfg.owner || '';
    $('cfgRepo').value = cfg.repo || '';
    $('cfgBranch').value = cfg.branch || 'main';
    $('cfgToken').value = readToken();

    wire();

    if (readToken()) connect({ silent: true });
  }

  function wire() {
    $('connectBtn').addEventListener('click', function () { connect({}); });
    $('offlineBtn').addEventListener('click', startOffline);
    $('cfgToken').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') connect({});
    });

    $('addBtn').addEventListener('click', addEntry);
    $('addBtn2').addEventListener('click', addEntry);
    $('dupBtn').addEventListener('click', duplicateEntry);
    $('delBtn').addEventListener('click', deleteEntry);
    $('backBtn').addEventListener('click', function () { $('work').dataset.view = 'list'; });

    $('listFilter').addEventListener('input', function (e) {
      state.filter = e.target.value.toLowerCase();
      renderList();
    });
    $('listType').addEventListener('change', function (e) {
      state.typeFilter = e.target.value;
      renderList();
    });

    $('jsonBtn').addEventListener('click', function () {
      var showing = $('jsonOut').hidden;
      $('jsonOut').hidden = !showing;
      $('preview').hidden = showing;
      this.setAttribute('aria-pressed', showing ? 'true' : 'false');
      this.classList.toggle('is-on', showing);
    });

    $('publishBtn').addEventListener('click', openPublish);
    $('reloadBtn').addEventListener('click', function () {
      if (isDirty() && !confirm('Discard local edits and re-read from GitHub?')) return;
      clearDraft();
      state.pending.clear();
      loadEntries();
    });

    $('settingsBtn').addEventListener('click', openSettings);
    $('forgetBtn').addEventListener('click', function () {
      forgetToken();
      location.reload();
    });
    $('exportBtn').addEventListener('click', downloadJson);
    $('copyBtn').addEventListener('click', copyJson);

    document.querySelectorAll('[data-close]').forEach(function (b) {
      b.addEventListener('click', closeModals);
    });
    $('scrim').addEventListener('click', closeModals);

    document.querySelectorAll('#modeSeg button').forEach(function (b) {
      b.addEventListener('click', function () {
        state.mode = b.dataset.mode;
        paintMode();
      });
    });
    $('confirmPublish').addEventListener('click', doPublish);

    window.addEventListener('keydown', function (e) {
      var mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        if (!$('publishBtn').hidden) openPublish();
        return;
      }
      if (mod && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        $('listFilter').focus();
        $('listFilter').select();
        return;
      }
      if (e.key === 'Escape' && !$('scrim').hidden) closeModals();

      /* Reorder without a mouse — and a fallback for browsers where
         dragging a <button> is unreliable. */
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        if (!state.selected) return;
        e.preventDefault();
        moveSelected(e.key === 'ArrowUp' ? -1 : 1);
      }
    });

    window.addEventListener('beforeunload', function (e) {
      if (!isDirty()) return;
      e.preventDefault();
      e.returnValue = '';
    });
  }

  async function connect(opts) {
    var cfg = {
      owner: $('cfgOwner').value.trim(),
      repo: $('cfgRepo').value.trim(),
      branch: $('cfgBranch').value.trim() || 'main'
    };
    var token = $('cfgToken').value.trim();

    if (!cfg.owner || !cfg.repo) return gateError('Owner and repo are required.');
    if (!token) return gateError('Paste a token, or choose “work offline”.');

    gateError(null);
    $('connectBtn').disabled = true;
    $('connectBtn').textContent = 'connecting…';

    var client = new GH.Client({
      owner: cfg.owner, repo: cfg.repo, branch: cfg.branch, token: token
    });

    try {
      var info = await client.verify();
      state.client = client;
      state.access = info;
      saveConfig(cfg);
      saveToken(token, $('cfgRemember').checked);

      $('gate').hidden = true;
      $('work').hidden = false;
      $('publishBtn').hidden = false;
      $('reloadBtn').hidden = false;
      $('barWhere').textContent = client.slug() + ' · ' + client.branch;

      if (!info.canPush) {
        toast('That token can read this repo but not write to it.', 'bad', 6000);
      }
      await loadEntries();
    } catch (err) {
      if (!opts.silent) gateError(err.message);
      else {
        gateError(err.message);
        $('gate').hidden = false;
      }
    } finally {
      $('connectBtn').disabled = false;
      $('connectBtn').textContent = 'connect';
    }
  }

  function gateError(msg) {
    var box = $('gateError');
    box.hidden = !msg;
    box.textContent = msg || '';
  }

  /* Offline: edit the file that ships with this checkout and export it. */
  async function startOffline() {
    state.client = null;
    state.access = null;
    $('gate').hidden = true;
    $('work').hidden = false;
    $('publishBtn').hidden = false;
    $('publishBtn').textContent = 'review';
    $('reloadBtn').hidden = true;
    $('barWhere').textContent = 'offline · export only';
    await loadEntries();
  }

  /* ==============================================================
     loading
     ============================================================== */

  async function loadEntries() {
    var text, sha = null;
    try {
      if (state.client) {
        var file = await state.client.readFile(FILE);
        if (!file) throw new Error(FILE + ' does not exist on this branch.');
        text = file.text;
        sha = file.sha;
      } else {
        var res = await fetch('../' + FILE, { cache: 'no-store' });
        if (!res.ok) throw new Error('Could not read ../' + FILE);
        text = await res.text();
      }
    } catch (err) {
      toast(err.message, 'bad', 7000);
      return;
    }

    var parsed;
    try { parsed = JSON.parse(text); }
    catch (e) { toast(FILE + ' is not valid JSON: ' + e.message, 'bad', 8000); return; }

    var list = Array.isArray(parsed) ? parsed : (parsed.root || []);
    state.keySeed = 0;
    list.forEach(function (e) { e.__key = newKey(); });

    state.entries = list;
    state.baseline = deepClone(list);
    state.baseText = serialize(list);
    state.sha = sha;
    state.selected = null;

    /* An unsaved draft from a previous visit, if it still applies. */
    var draft = readDraft();
    if (draft && draft.text && draft.text !== state.baseText && draft.sha === sha) {
      var when = new Date(draft.at).toLocaleString();
      if (confirm('You have unpublished edits from ' + when + '. Restore them?')) {
        try {
          var dp = JSON.parse(draft.text);
          var dl = Array.isArray(dp) ? dp : (dp.root || []);
          state.keySeed = 0;
          dl.forEach(function (e) { e.__key = newKey(); });
          state.entries = dl;
        } catch (e) { /* keep what GitHub gave us */ }
      } else {
        clearDraft();
      }
    }

    paintTypeFilter();
    renderList();
    renderEditor();
    paintDirty();
    if (state.client) loadUploads();
  }

  async function loadUploads() {
    try {
      var files = await state.client.listDir(MEDIA_DIR);
      state.uploads = files
        .filter(function (f) { return f.type === 'file' && /\.(png|jpe?g|gif|webp|avif|jfif|svg)$/i.test(f.name); })
        .map(function (f) { return f.name; })
        .sort();
    } catch (e) {
      state.uploads = [];
    }
    if (state.selected) renderEditor();
  }

  /* ==============================================================
     list
     ============================================================== */

  function visibleEntries() {
    return state.entries.filter(function (e) {
      if (state.typeFilter && e.type !== state.typeFilter) return false;
      if (!state.filter) return true;
      return Card.searchText(e).indexOf(state.filter) !== -1;
    });
  }

  function paintTypeFilter() {
    var sel = $('listType');
    sel.innerHTML = '';
    sel.appendChild(new Option('all types', ''));
    Card.TYPE_ORDER.forEach(function (t) {
      sel.appendChild(new Option(Card.TYPES[t].label, t));
    });
    sel.value = state.typeFilter;
  }

  function renderList() {
    var list = $('list');
    var shown = visibleEntries();
    list.innerHTML = '';
    $('listCount').textContent = state.entries.length;
    $('listEmpty').hidden = shown.length > 0;

    var baseByKey = new Map(state.baseline.map(function (b) { return [b.__key, b]; }));

    shown.forEach(function (entry) {
      var pos = state.entries.indexOf(entry);
      var base = baseByKey.get(entry.__key);
      var li = el('li');
      var row = el('button', 'row');
      row.type = 'button';
      row.dataset.key = entry.__key;
      if (entry.__key === state.selected) row.classList.add('is-on');
      if (!base) row.classList.add('is-new', 'is-dirty');
      else if (JSON.stringify(clean(base)) !== JSON.stringify(clean(entry))) row.classList.add('is-dirty');

      var grip = el('span', 'row__grip', '⠿');
      grip.title = 'drag to reorder';
      row.append(
        grip,
        el('span', 'row__idx', String(pos + 1).padStart(3, '0')),
        el('span', 'row__sigil', Card.typeInfo(entry.type).sigil),
        el('span', 'row__title', Card.entryTitle(entry)),
        el('span', 'row__dot')
      );

      row.addEventListener('click', function () { select(entry.__key); });
      wireDrag(row, entry);
      li.appendChild(row);
      list.appendChild(li);
    });
  }

  /* Reorder by dragging a row onto another. Only meaningful while the
     list is unfiltered, so the grip is disabled otherwise. */
  function wireDrag(row, entry) {
    var filtered = !!(state.filter || state.typeFilter);
    var grip = row.querySelector('.row__grip');
    if (filtered) {
      grip.style.opacity = '0.25';
      grip.title = 'clear the filter to reorder';
      return;
    }
    row.draggable = true;

    row.addEventListener('dragstart', function (ev) {
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/plain', entry.__key);
      row.classList.add('is-drag');
    });
    row.addEventListener('dragend', function () {
      row.classList.remove('is-drag');
      document.querySelectorAll('.row.is-over').forEach(function (r) { r.classList.remove('is-over'); });
    });
    row.addEventListener('dragover', function (ev) {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
      row.classList.add('is-over');
    });
    row.addEventListener('dragleave', function () { row.classList.remove('is-over'); });
    row.addEventListener('drop', function (ev) {
      ev.preventDefault();
      row.classList.remove('is-over');
      var fromKey = ev.dataTransfer.getData('text/plain');
      if (!fromKey || fromKey === entry.__key) return;
      var from = state.entries.findIndex(function (e) { return e.__key === fromKey; });
      var to = state.entries.indexOf(entry);
      if (from < 0 || to < 0) return;
      var moved = state.entries.splice(from, 1)[0];
      state.entries.splice(to, 0, moved);
      touched();
    });
  }

  function moveSelected(delta) {
    if (state.filter || state.typeFilter) {
      return toast('Clear the filter first — order only means anything on the whole list.', 'bad', 5000);
    }
    var from = state.entries.findIndex(function (e) { return e.__key === state.selected; });
    var to = from + delta;
    if (from < 0 || to < 0 || to >= state.entries.length) return;
    var moved = state.entries.splice(from, 1)[0];
    state.entries.splice(to, 0, moved);
    touched();
  }

  function select(key) {
    state.selected = key;
    $('work').dataset.view = 'edit';
    renderList();
    renderEditor();
  }

  function current() {
    return state.entries.find(function (e) { return e.__key === state.selected; }) || null;
  }

  /* ==============================================================
     mutations
     ============================================================== */

  function touched() {
    renderList();
    renderPreview();
    paintDirty();
    saveDraft();
  }

  function paintDirty() {
    var dirty = isDirty();
    var n = computeDiff().length;
    $('barDirty').hidden = !dirty;
    $('barDirty').textContent = n === 1 ? '1 change' : n + ' changes';
    $('publishBtn').classList.toggle('btn--primary', dirty);
  }

  function addEntry() {
    var entry = { __key: newKey(), type: 'text', title: '', text: '', tags: [] };
    var after = state.selected
      ? state.entries.findIndex(function (e) { return e.__key === state.selected; })
      : -1;
    if (after >= 0) state.entries.splice(after + 1, 0, entry);
    else state.entries.push(entry);
    state.selected = entry.__key;
    $('work').dataset.view = 'edit';
    renderList();
    renderEditor();
    paintDirty();
    saveDraft();
  }

  function duplicateEntry() {
    var entry = current();
    if (!entry) return;
    var copy = deepClone(clean(entry));
    copy.__key = newKey();
    copy.id = uniqueId((entry.id || Card.entryTitle(entry)) + '-copy', copy.__key);
    var at = state.entries.indexOf(entry);
    state.entries.splice(at + 1, 0, copy);
    state.selected = copy.__key;
    renderList();
    renderEditor();
    paintDirty();
    saveDraft();
  }

  function deleteEntry() {
    var entry = current();
    if (!entry) return;
    if (!confirm('Delete “' + Card.entryTitle(entry) + '”? It comes back only if you do not publish.')) return;
    var at = state.entries.indexOf(entry);
    state.entries.splice(at, 1);
    var next = state.entries[Math.min(at, state.entries.length - 1)];
    state.selected = next ? next.__key : null;
    renderList();
    renderEditor();
    paintDirty();
    saveDraft();
  }

  /* ==============================================================
     editor
     ============================================================== */

  function renderEditor() {
    var entry = current();
    var host = $('editor');
    host.innerHTML = '';

    $('editorBlank').hidden = !!entry;
    host.hidden = !entry;
    $('dupBtn').disabled = !entry;
    $('delBtn').disabled = !entry;
    $('editWhich').textContent = entry
      ? 'editing · ' + Card.typeInfo(entry.type).label
      : 'editing';

    if (!entry) { renderPreview(); return; }

    host.appendChild(typeField(entry));
    Card.typeInfo(entry.type).fields.forEach(function (name) {
      var f = buildField(entry, name);
      if (f) host.appendChild(f);
    });
    host.appendChild(tagsField(entry));
    host.appendChild(idField(entry));

    renderPreview();
  }

  function labelled(label, control, hint) {
    var wrap = el('div', 'field');
    wrap.appendChild(el('span', 'u-label', label));
    wrap.appendChild(control);
    if (hint) wrap.appendChild(el('p', 'hint', hint));
    return wrap;
  }

  function typeField(entry) {
    var seg = el('div', 'seg seg--wrap');
    Card.TYPE_ORDER.forEach(function (t) {
      var b = el('button', entry.type === t ? 'is-on' : '', Card.TYPES[t].label);
      b.type = 'button';
      b.addEventListener('click', function () {
        if (entry.type === t) return;
        entry.type = t;
        renderList();
        renderEditor();
        paintDirty();
        saveDraft();
      });
      seg.appendChild(b);
    });
    return labelled('type', seg,
      'Switching type keeps every field you have filled in, so nothing is lost going back and forth.');
  }

  function buildField(entry, name) {
    if (name === 'text') {
      var ta = el('textarea');
      ta.value = entry.text || '';
      ta.placeholder = 'the words';
      ta.addEventListener('input', function () { entry.text = ta.value; touched(); });
      return labelled('text', ta, 'Line breaks are kept exactly as typed.');
    }

    if (name === 'src') return mediaField(entry);
    if (name === 'youtubeId') return youtubeField(entry);

    var input = el('input');
    input.type = name === 'url' ? 'url' : 'text';
    input.value = entry[name] || '';
    input.spellcheck = name === 'title' || name === 'alt';

    var meta = {
      title:    { label: 'title',     ph: 'the small label above the thing' },
      url:      { label: 'url',       ph: 'https://…' },
      linkText: { label: 'link text', ph: 'what the link reads as' },
      alt:      { label: 'alt text',  ph: 'describe the image', hint: 'Read aloud by screen readers, and shown if the image fails.' }
    }[name] || { label: name, ph: '' };

    input.placeholder = meta.ph;
    input.addEventListener('input', function () { entry[name] = input.value; touched(); });
    return labelled(meta.label, input, meta.hint);
  }

  function idField(entry) {
    var input = el('input', 'input--mono');
    input.value = entry.id || '';
    input.spellcheck = false;
    input.placeholder = 'auto from the title';
    input.addEventListener('input', function () { entry.id = input.value.trim(); touched(); });
    input.addEventListener('blur', function () {
      if (!entry.id) return;
      entry.id = uniqueId(entry.id, entry.__key);
      input.value = entry.id;
      touched();
    });
    return labelled('id', input,
      'Used by #deep-links on the canvas. Left blank, one is generated when you publish.');
  }

  /* ---------- tags ---------- */

  function allTags() {
    var set = new Set();
    state.entries.forEach(function (e) { (e.tags || []).forEach(function (t) { set.add(t); }); });
    return Array.from(set).sort();
  }

  function tagsField(entry) {
    if (!entry.tags) entry.tags = [];
    var box = el('div', 'chips');

    function repaint() {
      box.innerHTML = '';
      entry.tags.forEach(function (t, i) {
        var chip = el('span', 'chip');
        chip.appendChild(document.createTextNode(t));
        var x = el('button', null, '×');
        x.type = 'button';
        x.setAttribute('aria-label', 'remove ' + t);
        x.addEventListener('click', function () {
          entry.tags.splice(i, 1);
          repaint();
          touched();
          paintSuggest();
        });
        chip.appendChild(x);
        box.appendChild(chip);
      });
      box.appendChild(input);
    }

    var input = el('input');
    input.placeholder = entry.tags.length ? 'add…' : 'type a tag, press enter';
    input.spellcheck = false;

    function commit(raw) {
      var t = String(raw || '').trim().toLowerCase();
      if (!t || entry.tags.indexOf(t) !== -1) return;
      entry.tags.push(t);
      input.value = '';
      repaint();
      input.focus();
      touched();
      paintSuggest();
    }

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(input.value); }
      else if (e.key === 'Backspace' && !input.value && entry.tags.length) {
        entry.tags.pop();
        repaint();
        touched();
        paintSuggest();
      }
    });
    input.addEventListener('blur', function () { if (input.value) commit(input.value); });

    var suggest = el('div', 'suggest');
    function paintSuggest() {
      suggest.innerHTML = '';
      allTags()
        .filter(function (t) { return entry.tags.indexOf(t) === -1; })
        .slice(0, 18)
        .forEach(function (t) {
          var b = el('button', null, t);
          b.type = 'button';
          b.addEventListener('click', function () { commit(t); });
          suggest.appendChild(b);
        });
    }

    repaint();
    paintSuggest();

    var wrap = el('div', 'field');
    wrap.appendChild(el('span', 'u-label', 'tags'));
    wrap.appendChild(box);
    wrap.appendChild(suggest);
    return wrap;
  }

  /* ---------- media ---------- */

  function mediaField(entry) {
    var wrap = el('div', 'field');
    wrap.appendChild(el('span', 'u-label', 'image'));

    var drop = el('div', 'drop');
    var note = el('p', 'drop__note',
      state.client
        ? 'Drop an image here, or pick one already in /uploads.'
        : 'Offline: type a path by hand. Uploading needs a connection.');
    var row = el('div', 'drop__row');

    var pick = el('button', 'btn btn--sm', 'choose a file');
    pick.type = 'button';
    var file = el('input');
    file.type = 'file';
    file.accept = 'image/*';
    file.hidden = true;
    pick.addEventListener('click', function () { file.click(); });
    file.addEventListener('change', function () {
      if (file.files && file.files[0]) stageUpload(file.files[0], entry);
      file.value = '';
    });
    pick.disabled = !state.client;

    row.append(pick, file);
    drop.append(note, row);

    ['dragenter', 'dragover'].forEach(function (evt) {
      drop.addEventListener(evt, function (e) {
        e.preventDefault();
        drop.classList.add('is-over');
      });
    });
    ['dragleave', 'drop'].forEach(function (evt) {
      drop.addEventListener(evt, function (e) {
        e.preventDefault();
        drop.classList.remove('is-over');
      });
    });
    drop.addEventListener('drop', function (e) {
      var f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) stageUpload(f, entry);
    });

    wrap.appendChild(drop);

    /* existing uploads */
    if (state.uploads.length) {
      var grid = el('div', 'uploads');
      state.uploads.forEach(function (name) {
        var path = '/' + MEDIA_DIR + '/' + name;
        var b = el('button', entry.src === path ? 'is-on' : '');
        b.type = 'button';
        b.title = name;
        var img = el('img');
        img.src = '../' + MEDIA_DIR + '/' + encodeURIComponent(name);
        img.alt = '';
        img.loading = 'lazy';
        b.appendChild(img);
        b.addEventListener('click', function () {
          entry.src = path;
          renderEditor();
          touched();
        });
        grid.appendChild(b);
      });
      wrap.appendChild(grid);
    }

    var path = el('input', 'input--mono');
    path.value = entry.src || '';
    path.spellcheck = false;
    path.placeholder = '/uploads/name.jpg';
    path.addEventListener('input', function () { entry.src = path.value.trim(); touched(); });
    wrap.appendChild(path);

    if (state.pending.has(entry.src)) {
      wrap.appendChild(el('p', 'hint', 'Staged — this file is committed when you publish.'));
    }
    return wrap;
  }

  function stageUpload(fileObj, entry) {
    if (!state.client) return toast('Connect to GitHub before uploading.', 'bad');
    if (!/^image\//.test(fileObj.type)) return toast('That is not an image.', 'bad');
    if (fileObj.size > 8 * 1024 * 1024) {
      return toast('That file is over 8 MB. Shrink it first.', 'bad', 6000);
    }

    var dot = fileObj.name.lastIndexOf('.');
    var ext = (dot > -1 ? fileObj.name.slice(dot + 1) : 'jpg').toLowerCase();
    var stem = Card.slugify(dot > -1 ? fileObj.name.slice(0, dot) : fileObj.name) || 'image';
    var name = stem + '.' + ext;
    var n = 2;
    while (state.uploads.indexOf(name) !== -1 || state.pending.has('/' + MEDIA_DIR + '/' + name)) {
      name = stem + '-' + n++ + '.' + ext;
    }
    var path = '/' + MEDIA_DIR + '/' + name;

    var reader = new FileReader();
    reader.onload = function () {
      var dataUrl = String(reader.result);
      state.pending.set(path, {
        base64: dataUrl.slice(dataUrl.indexOf(',') + 1),
        dataUrl: dataUrl,
        size: fileObj.size
      });
      entry.src = path;
      renderEditor();
      touched();
      toast('staged ' + name, 'ok');
    };
    reader.onerror = function () { toast('Could not read that file.', 'bad'); };
    reader.readAsDataURL(fileObj);
  }

  function youtubeField(entry) {
    var input = el('input', 'input--mono');
    input.value = entry.youtubeId || '';
    input.spellcheck = false;
    input.placeholder = 'paste any youtube link';
    input.addEventListener('input', function () {
      entry.youtubeId = Card.parseYouTubeId(input.value);
      if (entry.youtubeId !== input.value) input.value = entry.youtubeId;
      touched();
    });
    return labelled('youtube', input,
      'A full watch, share, shorts or embed URL all work — the id is pulled out for you.');
  }

  /* ==============================================================
     preview
     ============================================================== */

  function renderPreview() {
    var host = $('preview');
    var entry = current();
    host.innerHTML = '';

    if (!entry) {
      host.appendChild(el('div', 'preview__blank', 'nothing selected'));
      $('jsonOut').textContent = '';
      return;
    }

    var card = Card.createCard(entry, {
      index: state.entries.indexOf(entry) + 1,
      lazyVideo: true
    });

    /* Staged uploads live only in this tab — point the preview at the
       local data URL so you can see what you just dropped. */
    var staged = state.pending.get(entry.src);
    if (staged) {
      var img = card.querySelector('.card__img');
      if (img) img.src = staged.dataUrl;
    }

    host.appendChild(card);
    $('jsonOut').textContent = JSON.stringify(clean(entry), null, 2);
  }

  /* ==============================================================
     diff
     ============================================================== */

  function changedFields(a, b) {
    var ca = clean(a), cb = clean(b);
    var keys = new Set(Object.keys(ca).concat(Object.keys(cb)));
    var out = [];
    keys.forEach(function (k) {
      if (JSON.stringify(ca[k]) !== JSON.stringify(cb[k])) out.push(k);
    });
    return out;
  }

  function computeDiff() {
    var baseByKey = new Map(state.baseline.map(function (b) { return [b.__key, b]; }));
    var curByKey = new Map(state.entries.map(function (c) { return [c.__key, c]; }));
    var out = [];

    state.baseline.forEach(function (b) {
      if (!curByKey.has(b.__key)) out.push({ kind: 'removed', entry: b });
    });

    state.entries.forEach(function (c) {
      var b = baseByKey.get(c.__key);
      if (!b) { out.push({ kind: 'added', entry: c }); return; }
      var fields = changedFields(b, c);
      if (fields.length) out.push({ kind: 'changed', entry: c, fields: fields });
    });

    var beforeOrder = state.baseline
      .filter(function (b) { return curByKey.has(b.__key); })
      .map(function (b) { return b.__key; }).join(',');
    var afterOrder = state.entries
      .filter(function (c) { return baseByKey.has(c.__key); })
      .map(function (c) { return c.__key; }).join(',');
    if (beforeOrder !== afterOrder) out.push({ kind: 'moved', entry: null });

    state.pending.forEach(function (v, path) {
      out.push({ kind: 'added', entry: null, file: path, size: v.size });
    });

    return out;
  }

  function renderDiff() {
    var host = $('diff');
    var items = computeDiff();
    host.innerHTML = '';

    if (!items.length) {
      host.appendChild(el('p', 'diff__none', 'Nothing has changed yet.'));
      return;
    }

    items.forEach(function (d) {
      var box = el('div', 'diff__item');
      box.dataset.kind = d.kind;
      box.appendChild(el('span', 'diff__kind', d.kind));

      if (d.file) {
        box.appendChild(el('span', 'diff__title', d.file));
        box.appendChild(el('span', 'diff__fields', Math.round(d.size / 1024) + ' KB · new file'));
      } else if (d.kind === 'moved') {
        box.appendChild(el('span', 'diff__title', 'the order of entries'));
      } else {
        box.appendChild(el('span', 'diff__title', Card.entryTitle(d.entry)));
        if (d.fields) box.appendChild(el('span', 'diff__fields', d.fields.join(' · ')));
      }
      host.appendChild(box);
    });
  }

  /* ==============================================================
     publish
     ============================================================== */

  function openModal(id) {
    $('scrim').hidden = false;
    $(id).hidden = false;
  }

  function closeModals() {
    $('scrim').hidden = true;
    $('publishModal').hidden = true;
    $('settingsModal').hidden = true;
  }

  function paintMode() {
    document.querySelectorAll('#modeSeg button').forEach(function (b) {
      b.classList.toggle('is-on', b.dataset.mode === state.mode);
    });
    $('prBranchField').hidden = state.mode !== 'pr';
  }

  function openPublish() {
    if (!isDirty()) return toast('Nothing to publish.');

    /* Offline the sheet is still worth opening — you get to see what
       you changed before exporting the file. */
    var online = !!state.client;
    $('commitField').hidden = !online;
    $('modeField').hidden = !online;
    $('confirmPublish').textContent = online ? 'publish' : 'download entries.json';

    renderDiff();
    var n = computeDiff().length;
    $('commitMsg').value = 'closet: ' + (n === 1 ? '1 change' : n + ' changes') +
      ' via the console';
    $('prBranch').value = 'closet/' + new Date().toISOString().slice(0, 10) + '-' +
      Math.random().toString(36).slice(2, 6);
    $('publishLog').hidden = true;
    $('publishLog').innerHTML = '';
    $('confirmPublish').disabled = false;
    if (online) paintMode();
    else $('prBranchField').hidden = true;
    openModal('publishModal');
  }

  function logLine(text, kind) {
    var box = $('publishLog');
    box.hidden = false;
    var line = el('div', 'log__line' + (kind ? ' is-' + kind : ''));
    if (text instanceof Node) line.appendChild(text);
    else line.textContent = text;
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
    return line;
  }

  async function doPublish() {
    if (!state.client) { downloadJson(); closeModals(); return; }

    var btn = $('confirmPublish');
    btn.disabled = true;
    $('publishLog').innerHTML = '';

    var client = state.client;
    var message = $('commitMsg').value.trim() || 'closet: update entries';
    var toPr = state.mode === 'pr';
    var branch = client.branch;

    try {
      /* Give every entry a stable id before it leaves the browser. */
      state.entries.forEach(function (e) {
        if (!e.id) e.id = uniqueId(Card.entryTitle(e), e.__key);
      });

      /* Someone else may have pushed since we loaded. */
      logLine('checking ' + FILE + ' is unchanged…');
      var live = await client.readFile(FILE);
      if (live && state.sha && live.sha !== state.sha) {
        throw new Error(
          FILE + ' changed on ' + client.branch + ' since you loaded it. ' +
          'Reload and re-apply your edits.'
        );
      }
      logLine('up to date', 'ok');

      if (toPr) {
        branch = $('prBranch').value.trim();
        if (!/^[\w./-]+$/.test(branch)) throw new Error('That branch name has characters git will not accept.');
        logLine('creating branch ' + branch + '…');
        await client.createBranch(branch, client.branch);
        logLine('branch created', 'ok');
      }

      /* Images first, so entries.json never points at a file that is
         not there yet. */
      var uploads = Array.from(state.pending.entries());
      for (var i = 0; i < uploads.length; i++) {
        var path = uploads[i][0];
        var blob = uploads[i][1];
        var repoPath = path.replace(/^\//, '');
        logLine('uploading ' + repoPath + '…');
        await client.writeFile({
          path: repoPath,
          base64: blob.base64,
          message: 'closet: add ' + repoPath,
          branch: branch
        });
        logLine(repoPath, 'ok');
      }

      logLine('writing ' + FILE + '…');
      var written = await client.writeFile({
        path: FILE,
        text: serialize(state.entries),
        sha: live ? live.sha : undefined,
        message: message,
        branch: branch
      });
      logLine(FILE + ' written', 'ok');

      var doneLink = null;
      if (toPr) {
        logLine('opening the pull request…');
        var pr = await client.openPullRequest({
          title: message,
          head: branch,
          base: client.branch,
          body: 'Opened from the closet console.'
        });
        doneLink = { url: pr.html_url, label: 'pull request #' + pr.number };
      } else if (written && written.commit) {
        doneLink = { url: written.commit.html_url, label: 'commit ' + written.commit.sha.slice(0, 7) };
      }

      if (doneLink) {
        var a = el('a', null, doneLink.label);
        a.href = doneLink.url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        logLine(a, 'ok');
      }

      /* Only a direct commit to the branch we are reading makes the
         working copy clean; a PR leaves us still ahead of the branch. */
      state.pending.clear();
      if (!toPr) {
        state.baseline = deepClone(state.entries);
        state.baseText = serialize(state.entries);
        state.sha = written && written.content ? written.content.sha : state.sha;
        clearDraft();
        await loadUploads();
      }

      renderList();
      paintDirty();
      toast(toPr ? 'pull request opened' : 'published', 'ok', 5000);
    } catch (err) {
      logLine(err.message, 'bad');
      btn.disabled = false;
      return;
    }

    btn.disabled = false;
  }

  /* ==============================================================
     settings / export
     ============================================================== */

  function openSettings() {
    var dl = $('facts');
    dl.innerHTML = '';
    var rows = state.client
      ? [
          ['repository', state.client.slug()],
          ['branch', state.client.branch],
          ['signed in', (state.access && state.access.login) || 'token (no user scope)'],
          ['can write', state.access && state.access.canPush ? 'yes' : 'no'],
          ['entries', String(state.entries.length)],
          ['token kept', localStorage.getItem(LS_TOKEN) ? 'in this browser' : 'until the tab closes']
        ]
      : [['mode', 'offline'], ['entries', String(state.entries.length)]];

    rows.forEach(function (r) {
      var d = el('div');
      d.appendChild(el('dt', null, r[0]));
      d.appendChild(el('dd', null, r[1]));
      dl.appendChild(d);
    });
    $('forgetBtn').hidden = !state.client;
    openModal('settingsModal');
  }

  function downloadJson() {
    var blob = new Blob([serialize(state.entries)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = FILE;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    if (state.pending.size) {
      toast('Downloaded. Staged images are not in this file — upload them separately.', null, 7000);
    }
  }

  async function copyJson() {
    try {
      await navigator.clipboard.writeText(serialize(state.entries));
      toast('entries.json copied', 'ok');
    } catch (e) {
      toast('Clipboard blocked — use download instead.', 'bad');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
