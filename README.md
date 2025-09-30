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

CMS (Decap):
- Visit `/admin` to log in and edit entries.
- Configure GitHub auth via Netlify Identity or your own OAuth app:
  1) Create a Netlify site (any), enable Identity, enable Git Gateway.
  2) In `admin/config.yml`, keep `base_url` and `auth_endpoint` as provided.
  3) Alternatively, set up a GitHub OAuth proxy and update `backend` accordingly.
- Media uploads go to `/uploads`.
- Manually navigate to admin/#/collections/entries post succesful login - this is a weird bug that needs to be fixed.
