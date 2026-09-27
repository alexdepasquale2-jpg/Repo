/* Essence Protocol: play the content editor's draft. The editor's ▶ Play opens index.html?draft
   after leaving its draft here: the content (all of data/) in localStorage, and when the draft
   changes merges, their re-baked records in IndexedDB (db.js reads them instead of db/).
   Runs before essences.js so every module builds from the draft. */
(function () {
  'use strict';
  if (typeof location === 'undefined' || !/[?&]draft\b/.test(location.search)) return;
  try {
    const d = JSON.parse(localStorage.getItem('ep-play-draft'));
    if (!d || !d.data || !d.data.world) return;
    self.EP_DATA_SHIPPED = self.EP_DATA;
    self.EP_DATA = d.data;
    self.EP_DRAFT = { at: d.at, rows: !!d.rows };
  } catch (e) { /* no draft: play the game as shipped */ }
})();
