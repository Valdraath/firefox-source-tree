'use strict';

// DevTools panels only get content-script-level APIs, so downloads and
// cross-origin fetches are proxied through here.
browser.runtime.onMessage.addListener(msg => {
  if (msg.cmd === 'download') return downloadAll(msg.items);
  if (msg.cmd === 'fetchText') {
    return fetch(msg.url, { credentials: 'include' }).then(r => r.text());
  }
  if (msg.cmd === 'ping') return Promise.resolve(true);
});

// download id -> resolve(completed?)
const pending = new Map();

browser.downloads.onChanged.addListener(delta => {
  const resolve = pending.get(delta.id);
  if (!resolve || !delta.state) return;
  if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
    pending.delete(delta.id);
    resolve(delta.state.current === 'complete');
  }
});

function whenFinished(id) {
  return new Promise(resolve => {
    pending.set(id, resolve);
    // It may already have finished before we started listening.
    browser.downloads.search({ id }).then(([d]) => {
      if (d && d.state !== 'in_progress' && pending.has(id)) {
        pending.delete(id);
        resolve(d.state === 'complete');
      }
    });
  });
}

// Starts downloads one by one, then waits for all of them to finish.
// Resolves with the URLs that completed successfully.
async function downloadAll(items) {
  const waits = [];
  for (const it of items) {
    try {
      const id = await browser.downloads.download({
        url: it.url,
        filename: it.filename,
        conflictAction: 'uniquify',
        saveAs: false,
      });
      waits.push(whenFinished(id).then(ok => ok && it.url));
    } catch (e) {
      console.warn('Download failed', it.url, e);
    }
  }
  return (await Promise.all(waits)).filter(Boolean);
}
