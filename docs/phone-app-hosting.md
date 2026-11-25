# Hosting the phone approval app

The phone app (`apps/approve`) is plain static files: HTML, JavaScript, CSS, a web manifest, a service worker,
fonts and icons. No server code, no secrets. Any host that serves files over HTTPS, can set response headers and
has one fallback rule can serve it. Nothing here depends on a particular provider.

It lives at **its own address**, never under the dashboard's address (the Authority Server refuses an app
address equal to its dashboard address). The plan's name for it is `https://approve.suveren.ai` (DEC-2); any
address works as long as the Authority Server is told the same one (below).

## The release bundle

Every `v*` tag builds the bundle in CI (`.github/workflows/publish-phone-app.yml`):

- built with `VITE_AS_URL=https://www.suveren.ai` and `VITE_BUILD_COMMIT=<commit>` — the only two build-time
  values; the app talks to that Authority Server and no other;
- the app's unit tests run first; a failing test stops the release;
- the result is one tarball `suveren-approve-<version>.tar.gz` with `suveren-approve-<version>.tar.gz.sha256`
  next to it, attached to the GitHub Release of the tag. Inside the tarball, `FILES.sha256` lists every file's
  SHA-256.

Put the tarball's contents at the web root of the app address, replacing everything that was there.
`workflow_dispatch` builds the same bundle as a workflow artifact only (no release).

## Headers

The single source of these values is `apps/approve/hosting/headers.mjs`; a test keeps this page and that file
identical.

### Cache

| Path | `Cache-Control` | Why |
|---|---|---|
| `/index.html` (and every fallback to it), `/sw.js` | `no-store` | An update must reach the next open. A cached shell or service worker would keep an old build running. |
| `/assets/*` | `public, max-age=31536000, immutable` | The file name carries a content hash; a new build has new names. |
| everything else (`/manifest.webmanifest`, `/icons/*`, `/fonts/*`, `/favicon.svg`) | `no-cache` | Revalidated on every use. |

### Security (on every response)

```
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self' https://www.suveren.ai; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
Strict-Transport-Security: max-age=63072000; includeSubDomains
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
Permissions-Policy: camera=(self), publickey-credentials-create=(self), publickey-credentials-get=(self), clipboard-write=(self), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=(), serial=(), hid=()
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
```

`connect-src` names the Authority Server the bundle was built for. For a self-hosted Authority Server, replace
`https://www.suveren.ai` with its address (and build with that `VITE_AS_URL`).

The camera is for scanning the pairing code, passkeys are the phone's touch, the clipboard is for copying the
recovery code. Nothing else may be asked for.

### Types

`.html` `text/html; charset=utf-8` · `.js` `text/javascript; charset=utf-8` · `.css` `text/css; charset=utf-8` ·
`.webmanifest` `application/manifest+json` · `.woff2` `font/woff2` · `.svg` `image/svg+xml` · `.png` `image/png`

## The fallback rule

- A path **without** a file extension (`/`, `/devices`, `/r/abc`) is the app: answer with `/index.html`
  (and its `no-store`).
- A path **with** an extension that does not exist is a `404`, never `index.html`. A missing script must fail,
  not be answered with HTML.

## Examples

### nginx

`/etc/nginx/snippets/approve-security.conf` (nginx drops inherited `add_header` lines inside a `location` that
sets its own, so every location includes this file):

```nginx
add_header Content-Security-Policy "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self' https://www.suveren.ai; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" always;
add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "DENY" always;
add_header Referrer-Policy "no-referrer" always;
add_header Permissions-Policy "camera=(self), publickey-credentials-create=(self), publickey-credentials-get=(self), clipboard-write=(self), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=(), serial=(), hid=()" always;
add_header Cross-Origin-Opener-Policy "same-origin" always;
add_header Cross-Origin-Resource-Policy "same-origin" always;
```

```nginx
server {
  listen 443 ssl http2;
  server_name approve.suveren.ai;
  root /srv/suveren-approve;
  types { application/manifest+json webmanifest; }

  location = /index.html { include snippets/approve-security.conf; add_header Cache-Control "no-store" always; }
  location = /sw.js      { include snippets/approve-security.conf; add_header Cache-Control "no-store" always; }
  location /assets/      { include snippets/approve-security.conf; add_header Cache-Control "public, max-age=31536000, immutable" always; try_files $uri =404; }
  location ~ \.[a-zA-Z0-9]+$ { include snippets/approve-security.conf; add_header Cache-Control "no-cache" always; try_files $uri =404; }
  location / { try_files $uri /index.html; }
}
```

The last `location /` hands extension-less paths to `/index.html`, which the first location answers with its
`no-store` and the security headers.

### Caddy

```caddy
approve.suveren.ai {
  root * /srv/suveren-approve
  header {
    Content-Security-Policy "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self' https://www.suveren.ai; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    Strict-Transport-Security "max-age=63072000; includeSubDomains"
    X-Content-Type-Options "nosniff"
    X-Frame-Options "DENY"
    Referrer-Policy "no-referrer"
    Permissions-Policy "camera=(self), publickey-credentials-create=(self), publickey-credentials-get=(self), clipboard-write=(self), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=(), serial=(), hid=()"
    Cross-Origin-Opener-Policy "same-origin"
    Cross-Origin-Resource-Policy "same-origin"
    Cache-Control "no-cache"
  }
  @noStore path /index.html /sw.js
  header @noStore Cache-Control "no-store"
  @hashed path /assets/*
  header @hashed Cache-Control "public, max-age=31536000, immutable"
  @noExt not path_regexp \.[a-zA-Z0-9]+$
  handle @noExt {
    rewrite * /index.html
    header Cache-Control "no-store"
  }
  file_server
}
```

### Any other static host

It needs: HTTPS on the app's own address; the header list above on every response; the three cache rules;
the fallback rule (extension-less path → `/index.html`, missing file with an extension → 404). Most static hosts
take a headers file and a rewrite rule; set them from the tables above and check with
`curl -sI https://<app address>/`, `/sw.js` and one `/assets/…` file.

Check a bundle locally before it goes up: `node apps/approve/scripts/serve-release.mjs <bundle dir> 3480 https://www.suveren.ai`
serves it with exactly these headers on `http://127.0.0.1:3480`.

## What the Authority Server needs

- `SUVEREN_APP_ORIGIN` = the app's address, scheme and host only (e.g. `https://approve.suveren.ai`). Without it
  the Authority Server admits no phone.
- The passkey relying-party id is that address's **host**: the phone registers its passkeys at the app's own
  host, and the Authority Server checks registrations against `SUVEREN_APP_ORIGIN`. Moving the app to another
  host later means every phone registers again.
- CORS: the Authority Server allows exactly `SUVEREN_APP_ORIGIN` to send `Authorization` across sites (its
  middleware); nothing to configure on the app's host.
- `SUVEREN_DASHBOARD_ORIGIN` must be a different address than the app's.
- The other switch-on settings (notification keys, cron secret) are in the switch-on checklist.
