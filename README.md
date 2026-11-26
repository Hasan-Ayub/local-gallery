# My Gallery — local & private

A static, installable gallery website for photos and videos. It runs entirely in
the browser: media is stored in IndexedDB, not on a server. No uploads, no
accounts, no analytics.

## What it does

- Import multiple photos/videos with the native picker. Separate **Photos** and
  **Videos** buttons (instead of one mixed `accept`) plus real in-label file
  inputs preserve multi-select on old iOS (iPhone 6 / iOS 12). The page also
  tells you to choose **Photo Library**, not **Browse**; Browse only allows one
  file on iOS.
- **One-by-one mode** fallback: tick it and tap **Add next** after each pick if
  the phone still refuses multi-select.
- On Chrome/Edge on a computer, choose a **folder** and the gallery reads every
  photo/video inside it directly (files are not copied). The folder handle is
  remembered; you can reconnect after a restart.
- Grid gallery with search, type filters, sorting, captions, video badges.
- Full-screen viewer with keyboard navigation, download and delete.
- Storage usage meter, clear-all, and offline support via a service worker.
- Add to Home Screen (PWA manifest) on iPhone.

## Important browser limits

- A website **cannot** silently read the whole iPhone camera roll. iOS sandboxing
  requires you to pick files from Photos. After picking, the gallery keeps them.
- iPhone Safari does not support `showDirectoryPicker`, so folder mode only
  appears in desktop Chrome/Edge.
- Browser storage has a quota (varies by browser/device). Large libraries are
  better handled with folder mode on a computer.
- The JavaScript avoids newer APIs (`replaceChildren`, `for await...of`,
  `Element.remove`, `aspect-ratio` as the only sizing) so it still runs on
  iOS 12 / iPhone 6 Safari.
- HEIC/HEIF files depend on whether the browser can decode them.

## Deploy

Published at <https://hasan-ayub.github.io/local-gallery/> (GitHub Pages, `main`
branch, root). `.nojekyll` is included.

To update:

```bash
git add .
git commit -m "Update gallery"
git push
```
