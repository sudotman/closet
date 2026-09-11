/* ------------------------------------------------------------------
   closet · admin/github.js
   A minimal GitHub client: read a file, write a file, open a pull
   request. No build step, no backend, no third-party SDK — the token
   goes straight from the browser to api.github.com and nowhere else.
   ------------------------------------------------------------------ */
(function (global) {
  'use strict';

  var API = 'https://api.github.com';

  /* ---------- base64 that survives non-ASCII ---------- */

  function encodeText(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function decodeText(b64) {
    var clean = String(b64 || '').replace(/\s/g, '');
    var bin = atob(clean);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  /* ---------- errors people can act on ---------- */

  function ApiError(status, message, body) {
    var e = new Error(message);
    e.name = 'ApiError';
    e.status = status;
    e.body = body;
    return e;
  }

  function explain(status, body) {
    var msg = (body && body.message) || 'Request failed';
    if (status === 401) return 'GitHub rejected the token. It may be expired or mistyped.';
    if (status === 403 && /rate limit/i.test(msg)) return 'GitHub rate limit reached. Wait a few minutes.';
    if (status === 403) return 'The token lacks permission for this repository. It needs Contents: read and write.';
    if (status === 404) return 'Not found. Check the owner/repo and that the token can see this repository.';
    if (status === 409) return 'The branch moved since this was loaded. Reload before publishing.';
    if (status === 422) return msg + ' (GitHub rejected the request as invalid.)';
    return msg;
  }

  function Client(config) {
    this.owner = config.owner;
    this.repo = config.repo;
    this.branch = config.branch || 'main';
    this.token = config.token || '';
  }

  Client.prototype.slug = function () {
    return this.owner + '/' + this.repo;
  };

  Client.prototype.request = async function (path, options) {
    options = options || {};
    var headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
    if (this.token) headers.Authorization = 'Bearer ' + this.token;
    if (options.body) headers['Content-Type'] = 'application/json';

    var res = await fetch(API + path, {
      method: options.method || 'GET',
      headers: headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    });

    var text = await res.text();
    var data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }

    if (!res.ok) throw ApiError(res.status, explain(res.status, data), data);
    return data;
  };

  /* Confirm the token works and report what it may do. */
  Client.prototype.verify = async function () {
    var repo = await this.request('/repos/' + this.owner + '/' + this.repo);
    var me = null;
    try { me = await this.request('/user'); } catch (e) { /* fine-grained tokens may not expose /user */ }
    return {
      login: me && me.login,
      canPush: !!(repo.permissions && repo.permissions.push),
      defaultBranch: repo.default_branch,
      private: repo.private
    };
  };

  var contentsPath = function (self, path, ref) {
    return '/repos/' + self.owner + '/' + self.repo + '/contents/' +
      path.split('/').map(encodeURIComponent).join('/') +
      '?ref=' + encodeURIComponent(ref || self.branch) +
      '&t=' + Date.now();   /* GitHub caches raw content aggressively */
  };

  /* Returns { text, sha } — or null when the file does not exist yet. */
  Client.prototype.readFile = async function (path, ref) {
    try {
      var data = await this.request(contentsPath(this, path, ref));
      return { text: decodeText(data.content), sha: data.sha, path: data.path };
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  };

  Client.prototype.listDir = async function (path, ref) {
    try {
      var data = await this.request(contentsPath(this, path, ref));
      return Array.isArray(data) ? data : [];
    } catch (e) {
      if (e.status === 404) return [];
      throw e;
    }
  };

  /* Create or update one file. `sha` must be the blob's current sha
     when replacing, omitted when creating. */
  Client.prototype.writeFile = async function (opts) {
    var body = {
      message: opts.message,
      content: opts.base64 != null ? opts.base64 : encodeText(opts.text),
      branch: opts.branch || this.branch
    };
    if (opts.sha) body.sha = opts.sha;
    return this.request(
      '/repos/' + this.owner + '/' + this.repo + '/contents/' +
        opts.path.split('/').map(encodeURIComponent).join('/'),
      { method: 'PUT', body: body }
    );
  };

  Client.prototype.headSha = async function (branch) {
    var ref = await this.request(
      '/repos/' + this.owner + '/' + this.repo +
      '/git/ref/heads/' + encodeURIComponent(branch || this.branch)
    );
    return ref.object.sha;
  };

  Client.prototype.createBranch = async function (name, fromBranch) {
    var sha = await this.headSha(fromBranch || this.branch);
    return this.request('/repos/' + this.owner + '/' + this.repo + '/git/refs', {
      method: 'POST',
      body: { ref: 'refs/heads/' + name, sha: sha }
    });
  };

  Client.prototype.openPullRequest = async function (opts) {
    return this.request('/repos/' + this.owner + '/' + this.repo + '/pulls', {
      method: 'POST',
      body: {
        title: opts.title,
        head: opts.head,
        base: opts.base || this.branch,
        body: opts.body || ''
      }
    });
  };

  global.ClosetGitHub = {
    Client: Client,
    encodeText: encodeText,
    decodeText: decodeText
  };
})(window);
