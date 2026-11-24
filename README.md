# Source Tree (Firefox DevTools)

Adds a **Source Tree** tab to Firefox DevTools that works like Chrome's Sources → Page tree:

- Resources grouped by host and folder
- Previews for images (with size and dimensions), video, audio, and JS/CSS/HTML/JSON
- Filter by URL text or file type; step through files with ↑/↓
- **⬇** on a folder downloads everything in it to `Downloads/SourceTree/<host>/<path>`

## Install (temporary, until Firefox restarts)

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…** and choose `manifest.json` in this folder
3. Open DevTools (F12) and go to the **Source Tree** tab (it may be behind the `»` overflow)

This is a Manifest V3 extension. If text previews show "Could not load", open
**about:addons → Source Tree → Permissions** and turn on **Access your data for all websites**.

## Install permanently

- **Firefox Developer Edition / Nightly:** set `xpinstall.signatures.required` to `false` in `about:config`,
  zip the folder's contents into a `.xpi`, and drag it into Firefox.
- **Regular Firefox:** sign it as an unlisted add-on: `npx web-ext sign --channel=unlisted`
  (needs free AMO API keys), then install the `.xpi` it produces.

## Notes

- Resources loaded *before* DevTools opened come from the page's Resource Timing list and DOM, so
  they have no size and are previewed by loading the URL again. Reload the page with DevTools open
  to capture exact bytes for everything.
- Scans again every 3 s, so lazy-loaded images appear as you scroll.

## License

MIT. See [LICENSE](LICENSE).
