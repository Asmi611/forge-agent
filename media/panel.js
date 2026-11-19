/* Forge agent panel. Plain JavaScript. SAFETY RULE: text is only ever put on screen with textContent. */
(function () {
  'use strict';
  var vscode = acquireVsCodeApi();
  var $ = function (id) { return document.getElementById(id); };
  var view = null, suggestSeq = 0, suggestItems = [], suggestIndex = -1, mentionStart = -1;

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function post(m) { vscode.postMessage(m); }

  /* Keyed list: keeps existing nodes, creates only new ones, updates only changed ones (so 500 rows stay fast). */
  function syncList(container, items, key, create, update) {
    var existing = container.__map || (container.__map = new Map());
    var seen = new Set(), prev = null;
    for (var i = 0; i < items.length; i++) {
      var it = items[i], k = key(it), node = existing.get(k);
      seen.add(k);
      var sig = JSON.stringify(it);
      if (!node) { node = create(it); node.__sig = sig; existing.set(k, node); }
      else if (node.__sig !== sig) { update(node, it); node.__sig = sig; }
      var want = prev ? prev.nextSibling : container.firstChild;
      if (want !== node) container.insertBefore(node, want);
      prev = node;
    }
    existing.forEach(function (node, k) { if (!seen.has(k)) { node.remove(); existing.delete(k); } });
  }

  function atBottom(c) { return c.scrollHeight - c.scrollTop - c.clientHeight < 40; }

  function renderMessages(v) {
    var main = $('main'), stick = atBottom(main) && v.proposals.length === 0; // never scroll the review buttons out of sight
    syncList($('messages'), v.messages, function (m) { return m.id; },
      function (m) { var d = el('div', 'msg ' + m.role + (m.tone ? ' ' + m.tone : ''), m.text); return d; },
      function (d, m) { d.textContent = m.text; });
    if (stick) main.scrollTop = main.scrollHeight;
  }

  function iconFor(state) { return state === 'ok' ? '✓' : state === 'failed' ? '✗' : state === 'info' ? '•' : ''; }
  function fillRow(li, r) {
    li.className = 'row ' + r.state + (r.helper ? ' helper' : '');
    li.children[0].textContent = iconFor(r.state);
    li.children[1].children[0].textContent = r.label;
    li.children[1].children[1].textContent = (r.detail ? ' ' + r.detail : '') + (r.result ? ' — ' + r.result : '');
  }
  function renderRows(v) {
    var box = $('activity'), stick = atBottom(box);
    syncList(box, v.rows, function (r) { return r.id; },
      function (r) { var li = el('li'); li.appendChild(el('span', 'icon')); var b = el('span'); b.appendChild(el('span')); b.appendChild(el('span', 'detail')); li.appendChild(b); fillRow(li, r); return li; }, fillRow);
    if (stick) box.scrollTop = box.scrollHeight;
    $('activity-count').textContent = v.rows.length ? '(' + v.rows.length + (v.hiddenRows ? '+' : '') + ')' : '';
    var h = $('activity-hidden'); h.hidden = !v.hiddenRows; h.textContent = v.hiddenRows ? v.hiddenRows + ' older steps are hidden to keep things fast.' : '';
  }

  function renderFiles(v) {
    syncList($('files'), v.files, function (f) { return f.source + '|' + f.path; },
      function (f) { var li = el('li', 'file'); fillFile(li, f); return li; }, fillFile);
    $('files-empty').hidden = v.files.length > 0;
    $('files-count').textContent = v.files.length ? '(' + v.files.length + ')' : '';
  }
  function fillFile(li, f) {
    while (li.firstChild) li.removeChild(li.firstChild);
    var p = el('div', 'path', f.path);
    p.appendChild(el('span', 'badge ' + (f.source === 'mention' ? 'mention' : ''), f.badge));
    li.appendChild(p);
    li.appendChild(el('div', 'reason', f.reason + (f.range ? ' (' + f.range + ')' : '') + ' · about ' + f.tokens + ' tokens'));
  }

  function renderMeter(v) {
    var m = $('meter'), b = v.budget;
    m.hidden = !b;
    if (!b) return;
    m.className = 'meter ' + b.level;
    $('meter-text').textContent = b.used.toLocaleString() + ' of ' + b.limit.toLocaleString() + ' (' + b.percent + '%)';
    $('bar-fill').style.width = b.percent + '%';
    m.querySelector('.bar').setAttribute('aria-valuenow', String(b.percent));
    var ul = $('breakdown-list'); while (ul.firstChild) ul.removeChild(ul.firstChild);
    b.breakdown.forEach(function (p) { ul.appendChild(el('li', '', p.label + ': ' + p.tokens.toLocaleString())); });
  }

  function statusLabel(s) { return s === 'accepted' ? '✓ Accepted' : s === 'rejected' ? '✗ Rejected' : 'Not decided'; }
  function fillProposal(div, p) {
    while (div.firstChild) div.removeChild(div.firstChild);
    div.appendChild(el('div', 'path', p.path + (p.isNewFile ? ' (new file)' : '')));
    if (p.rationale) div.appendChild(el('div', 'why', p.rationale));
    var rv = el('button', 'secondary small', 'Look at the changes'); rv.addEventListener('click', function () { post({ type: 'review', proposalId: p.id }); });
    div.appendChild(rv);
    p.hunks.forEach(function (h) {
      var row = el('div', 'hunk ' + h.status);
      row.appendChild(el('span', 'lbl', h.label));
      row.appendChild(el('span', 'st', statusLabel(h.status)));
      var a = el('button', 'secondary small', 'Accept'); a.setAttribute('aria-pressed', String(h.status === 'accepted')); a.setAttribute('aria-label', 'Accept ' + h.label + ' in ' + p.path);
      var r = el('button', 'secondary small', 'Reject'); r.setAttribute('aria-pressed', String(h.status === 'rejected')); r.setAttribute('aria-label', 'Reject ' + h.label + ' in ' + p.path);
      a.addEventListener('click', function () { post({ type: 'hunk', proposalId: p.id, hunkId: h.id, status: 'accepted' }); });
      r.addEventListener('click', function () { post({ type: 'hunk', proposalId: p.id, hunkId: h.id, status: 'rejected' }); });
      row.appendChild(a); row.appendChild(r); div.appendChild(row);
    });
  }
  function renderChanges(v) {
    $('changes').hidden = v.proposals.length === 0;
    syncList($('changes-list'), v.proposals, function (p) { return p.id; }, function (p) { var d = el('div', 'proposal'); fillProposal(d, p); return d; }, fillProposal);
    var undecided = 0, accepted = 0;
    v.proposals.forEach(function (p) { undecided += p.pending; accepted += p.accepted; });
    $('apply').textContent = accepted > 0 ? 'Save accepted changes (' + accepted + ')' : 'Finish review';
  }

  function render(v) {
    view = v;
    $('model').textContent = v.model ? v.model : '';
    var s = $('status'); s.textContent = v.statusText; s.className = 'pill' + (v.running ? ' working' : '');
    $('stop').hidden = !v.running; $('send').disabled = v.running;
    $('undo').disabled = !v.canUndo;
    renderMeter(v); renderChanges(v); renderMessages(v); renderRows(v); renderFiles(v);
  }

  /* ---- input, @mentions ---- */
  var input = $('input');
  function send() {
    var t = input.value.trim();
    if (!t) return;
    post({ type: 'send', text: t });
    input.value = ''; closeSuggest(); renderChips();
  }
  function renderChips() {
    var box = $('chips'); while (box.firstChild) box.removeChild(box.firstChild);
    var seen = {}; var re = /(^|[\s([{,;:])@([A-Za-z0-9_][A-Za-z0-9_.\/\\-]*)/g, m;
    while ((m = re.exec(input.value)) !== null) {
      var name = m[2].replace(/[.,;:)\]}]+$/, '');
      if (!name || seen[name]) continue; seen[name] = true;
      (function (nm) {
        var c = el('span', 'chip', '@' + nm);
        var x = el('button', '', '×'); x.setAttribute('aria-label', 'Remove mention ' + nm);
        x.addEventListener('click', function () { input.value = input.value.split('@' + nm).join('').replace(/ {2,}/g, ' '); renderChips(); input.focus(); });
        c.appendChild(x); box.appendChild(c);
      })(name);
    }
  }
  function currentMention() {
    var pos = input.selectionStart, before = input.value.slice(0, pos), m = /(^|[\s([{,;:])@([A-Za-z0-9_.\/\\-]*)$/.exec(before);
    return m ? { start: pos - m[2].length - 1, q: m[2] } : null;
  }
  function closeSuggest() { $('suggest').hidden = true; suggestItems = []; suggestIndex = -1; mentionStart = -1; }
  function showSuggest(items) {
    var ul = $('suggest'); while (ul.firstChild) ul.removeChild(ul.firstChild);
    suggestItems = items; suggestIndex = items.length ? 0 : -1;
    if (!items.length) { ul.hidden = true; return; }
    items.forEach(function (it, i) {
      var li = el('li'); li.setAttribute('role', 'option'); li.id = 'sg' + i; li.setAttribute('aria-selected', String(i === 0));
      li.appendChild(document.createTextNode(it.label)); li.appendChild(el('span', 'd', it.detail));
      li.addEventListener('mousedown', function (ev) { ev.preventDefault(); pick(i); });
      ul.appendChild(li);
    });
    ul.hidden = false;
  }
  function moveSuggest(d) {
    var n = suggestItems.length; if (!n) return;
    suggestIndex = (suggestIndex + d + n) % n;
    Array.prototype.forEach.call($('suggest').children, function (li, i) { li.setAttribute('aria-selected', String(i === suggestIndex)); if (i === suggestIndex) li.scrollIntoView({ block: 'nearest' }); });
  }
  function pick(i) {
    var it = suggestItems[i], cur = currentMention(); if (!it || !cur) return closeSuggest();
    input.value = input.value.slice(0, cur.start) + it.insert + ' ' + input.value.slice(input.selectionStart);
    var pos = cur.start + it.insert.length + 1; input.setSelectionRange(pos, pos);
    closeSuggest(); renderChips(); input.focus();
  }
  input.addEventListener('input', function () {
    renderChips();
    var cur = currentMention();
    if (!cur) return closeSuggest();
    mentionStart = cur.start; post({ type: 'suggest', q: cur.q, seq: ++suggestSeq });
  });
  input.addEventListener('keydown', function (ev) {
    var open = !$('suggest').hidden;
    if (open && ev.key === 'ArrowDown') { ev.preventDefault(); moveSuggest(1); }
    else if (open && ev.key === 'ArrowUp') { ev.preventDefault(); moveSuggest(-1); }
    else if (open && (ev.key === 'Enter' || ev.key === 'Tab')) { ev.preventDefault(); pick(suggestIndex); }
    else if (open && ev.key === 'Escape') { ev.preventDefault(); closeSuggest(); }
    else if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); send(); }
  });
  input.addEventListener('blur', function () { setTimeout(closeSuggest, 150); });

  $('send').addEventListener('click', send);
  $('stop').addEventListener('click', function () { post({ type: 'stop' }); });
  $('apply').addEventListener('click', function () { post({ type: 'applyAccepted' }); });
  $('undo').addEventListener('click', function () { post({ type: 'undo' }); });
  $('accept-all').addEventListener('click', function () { post({ type: 'all', status: 'accepted' }); });
  $('reject-all').addEventListener('click', function () { post({ type: 'all', status: 'rejected' }); });

  window.addEventListener('message', function (ev) {
    var m = ev.data; if (!m || typeof m !== 'object') return;
    if (m.type === 'state') render(m.state);
    else if (m.type === 'suggestions' && m.seq === suggestSeq && mentionStart >= 0) showSuggest(m.items || []);
    else if (m.type === 'focusInput') input.focus();
  });
  post({ type: 'ready' });
})();
