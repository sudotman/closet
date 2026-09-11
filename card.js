/* ------------------------------------------------------------------
   closet · card.js
   The shared entry model + renderer. Loaded as a classic script by
   both the canvas (index.html) and the console (admin/index.html) so
   the CMS preview is the real card, not an approximation.
   ------------------------------------------------------------------ */
(function (global) {
  'use strict';

  /* Every entry type, its three-letter sigil, and the fields it uses.
     The console builds its forms straight off this table. */
  var TYPES = {
    image:     { sigil: 'IMG', label: 'image',       fields: ['title', 'src', 'alt'] },
    text:      { sigil: 'TXT', label: 'text',        fields: ['title', 'text'] },
    link:      { sigil: 'LNK', label: 'link',        fields: ['title', 'url', 'linkText'] },
    text_link: { sigil: 'REF', label: 'text + link', fields: ['title', 'text', 'url', 'linkText'] },
    youtube:   { sigil: 'VID', label: 'youtube',     fields: ['title', 'youtubeId'] }
  };

  var TYPE_ORDER = ['text', 'image', 'link', 'text_link', 'youtube'];

  function typeInfo(type) {
    return TYPES[type] || { sigil: '???', label: type || 'unknown', fields: ['title'] };
  }

  /* A human label for an entry, falling back through whatever it has. */
  function entryTitle(entry) {
    if (!entry) return '';
    return (
      entry.title ||
      entry.linkText ||
      entry.alt ||
      (entry.text ? entry.text.split('\n')[0].slice(0, 64) : '') ||
      entry.url ||
      entry.id ||
      'untitled'
    );
  }

  /* Everything searchable about an entry, lowercased once. */
  function searchText(entry) {
    return [
      entry.title, entry.text, entry.alt, entry.linkText, entry.url,
      entry.id, entry.type, (entry.tags || []).join(' ')
    ].filter(Boolean).join(' ').toLowerCase();
  }

  /* Stable slug used when an entry arrives without an id. */
  function slugify(str) {
    return String(str || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);
  }

  /* Pull a YouTube id out of anything a person is likely to paste. */
  function parseYouTubeId(input) {
    var s = String(input || '').trim();
    if (!s) return '';
    if (/^[\w-]{11}$/.test(s)) return s;
    var m =
      s.match(/[?&]v=([\w-]{11})/) ||
      s.match(/youtu\.be\/([\w-]{11})/) ||
      s.match(/\/(?:embed|shorts|live|v)\/([\w-]{11})/);
    return m ? m[1] : s;
  }

  /* Resolve an upload path against wherever the page is served from, so
     /uploads/x.jpg works from both / and /admin/. */
  function resolveSrc(src) {
    var s = String(src || '');
    if (!s) return '';
    if (/^(https?:|data:|blob:)/i.test(s)) return s;
    if (s.charAt(0) === '/') return (global.CLOSET_BASE || '') + s;
    return s;
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /* ---------------- the renderer ----------------
     opts:
       index        number shown in the corner (1-based); omit to hide
       compact      render the single-line catalogue row
       interactive  wire up the lightbox / expand behaviours
       lazyVideo    poster image instead of a live iframe
       onImageClick(entry, imgEl)
       onLoad()     fired when media settles, so layout can re-measure
  */
  function createCard(entry, opts) {
    opts = opts || {};
    var info = typeInfo(entry.type);

    var card = el('article', 'card card--' + (entry.type || 'unknown'));
    card.dataset.type = entry.type || '';
    if (entry.id) card.dataset.id = entry.id;
    if (opts.compact) card.classList.add('card--compact');

    /* head: index · sigil · title */
    var head = el('header', 'card__head');
    var meta = el('div', 'card__meta');
    if (opts.index != null) {
      meta.appendChild(el('span', 'card__idx', String(opts.index).padStart(3, '0')));
    }
    meta.appendChild(el('span', 'card__sigil', info.sigil));
    head.appendChild(meta);

    var titleText = entry.title || (opts.compact ? entryTitle(entry) : '');
    if (titleText) head.appendChild(el('h3', 'card__title', titleText));
    card.appendChild(head);

    /* body */
    var body = el('div', 'card__body');
    var content = buildContent(entry, opts);
    if (content) body.appendChild(content);
    card.appendChild(body);

    /* tags */
    if (entry.tags && entry.tags.length) {
      var tags = el('footer', 'card__tags');
      entry.tags.forEach(function (t) { tags.appendChild(el('span', 'card__tag', t)); });
      card.appendChild(tags);
    }

    if (opts.compact && opts.interactive) wireCompact(card, opts);
    return card;
  }

  function buildContent(entry, opts) {
    var onLoad = opts.onLoad || function () {};

    if (entry.type === 'image') {
      var frame = el('div', 'card__frame');
      var img = el('img', 'card__img');
      img.src = resolveSrc(entry.src);
      img.alt = entry.alt || entry.title || '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.draggable = false;
      img.addEventListener('load', onLoad);
      img.addEventListener('error', function () {
        frame.classList.add('is-broken');
        frame.appendChild(el('div', 'card__broken', 'image not found'));
        onLoad();
      });
      if (opts.interactive && opts.onImageClick) {
        frame.classList.add('is-zoomable');
        frame.addEventListener('click', function (ev) {
          ev.stopPropagation();
          opts.onImageClick(entry, img);
        });
      }
      frame.appendChild(img);
      return frame;
    }

    if (entry.type === 'text') {
      return el('div', 'card__text', entry.text || '');
    }

    if (entry.type === 'link') {
      var a = el('a', 'card__link', entry.linkText || entry.title || entry.url || '');
      a.href = entry.url || '#';
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.appendChild(el('span', 'card__link-arrow', '↗'));
      return a;
    }

    if (entry.type === 'text_link') {
      var wrap = el('div', 'card__text');
      if (entry.text) wrap.appendChild(document.createTextNode(entry.text));
      var ref = el('a', 'card__link card__link--inline', entry.linkText || entry.url || '');
      ref.href = entry.url || '#';
      ref.target = '_blank';
      ref.rel = 'noopener noreferrer';
      ref.appendChild(el('span', 'card__link-arrow', '↗'));
      wrap.appendChild(el('span', 'card__text-break'));
      wrap.appendChild(ref);
      return wrap;
    }

    if (entry.type === 'youtube') {
      var id = parseYouTubeId(entry.youtubeId);
      var media = el('div', 'card__frame card__frame--video');
      if (!id) {
        media.classList.add('is-broken');
        media.appendChild(el('div', 'card__broken', 'no video id'));
        return media;
      }
      if (opts.lazyVideo) {
        /* poster-first: the console previews many cards at once and does
           not need that many live iframes. */
        var poster = el('img', 'card__img');
        poster.src = 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg';
        poster.alt = entry.title || 'video thumbnail';
        poster.loading = 'lazy';
        poster.addEventListener('load', onLoad);
        media.appendChild(poster);
        media.appendChild(el('div', 'card__play', '▶'));
        return media;
      }
      var iframe = el('iframe', 'card__video');
      iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
      iframe.allowFullscreen = true;
      iframe.loading = 'lazy';
      iframe.title = entry.title || 'video';
      iframe.src = 'https://www.youtube-nocookie.com/embed/' + id;
      iframe.addEventListener('load', onLoad);
      media.appendChild(iframe);
      return media;
    }

    return el('div', 'card__text card__text--muted', 'unknown type: ' + entry.type);
  }

  /* Compact rows open on click; links inside keep working. */
  function wireCompact(card, opts) {
    card.addEventListener('click', function (ev) {
      if (opts.isDragging && opts.isDragging()) return;
      if (ev.target.closest('a')) return;
      card.classList.toggle('is-open');
      if (opts.onToggle) opts.onToggle(card);
    });
  }

  global.ClosetCard = {
    TYPES: TYPES,
    TYPE_ORDER: TYPE_ORDER,
    typeInfo: typeInfo,
    entryTitle: entryTitle,
    searchText: searchText,
    slugify: slugify,
    parseYouTubeId: parseYouTubeId,
    resolveSrc: resolveSrc,
    createCard: createCard
  };
})(typeof window !== 'undefined' ? window : this);
