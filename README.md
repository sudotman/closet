# closet

A subtle, draggable canvas of things. Built for GitHub Pages.

Local preview:

```bash
# from repo root
python -m http.server 4000
# then open http://localhost:4000
```

Deploy:
- Push to `main` on the GitHub repo with Pages enabled for the `root`.
- Custom domain is configured via `CNAME`.

Content:
- Edit `entries.json` to add or arrange items. Fields:
  - `id`: stable identifier
  - `type`: `image` | `text` | `link` | `text_link` | `youtube`
  - `title`: small label shown above content (optional)
  - positioning: `x`, `y` in pixels relative to canvas origin
  - per-type fields:
    - image: `src`, `alt`
    - text: `text`
    - link: `url`, `linkText`
    - text_link: `text`, `url`, `linkText`
    - youtube: `youtubeId`

Interactions:
- Drag empty space to pan.
- Click a card or search result to center it.
- Type to search; press Enter to jump to the top result.

Design:
- Monotone, glassy cards over a subtle grid; space-grotesque accents.


