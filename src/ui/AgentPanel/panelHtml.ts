/** panelHtml.ts -- the panel's HTML shell. Strict CSP: nothing is allowed except our own script (by nonce) and stylesheet. */
export interface HtmlParts { cspSource: string; nonce: string; cssUri: string; jsUri: string }

export function makeNonce(random: () => number = Math.random): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(random() * chars.length));
  return s;
}

export function buildPanelHtml(p: HtmlParts): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${p.cspSource}; script-src 'nonce-${p.nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${p.cssUri}"><title>Forge</title></head>
<body>
<header id="top">
  <div class="titlebar"><h1>Forge</h1><span id="model" class="model" title="The AI model in use"></span><span id="status" class="pill" role="status" aria-live="polite">Ready</span></div>
  <div id="meter" class="meter" hidden>
    <div class="meter-line"><span class="meter-title">AI budget used</span><span id="meter-text"></span></div>
    <div class="bar" role="progressbar" aria-label="AI budget used" aria-valuemin="0" aria-valuemax="100"><div id="bar-fill"></div></div>
    <details id="breakdown"><summary>What used it?</summary><ul id="breakdown-list"></ul></details>
  </div>
</header>
<main id="main">
  <section id="changes" hidden aria-labelledby="changes-h">
    <h2 id="changes-h">Changes to review</h2>
    <p class="hint">Nothing is saved until you press <b>Save accepted changes</b>.</p>
    <div id="changes-list"></div>
    <div class="actions">
      <button id="accept-all" class="secondary">Accept all</button>
      <button id="reject-all" class="secondary">Reject all</button>
      <button id="apply" class="primary">Save accepted changes</button>
    </div>
  </section>
  <section aria-labelledby="chat-h"><h2 id="chat-h" class="sr">Conversation</h2><div id="messages" aria-live="polite"></div></section>
  <details id="activity-box" open><summary>What Forge is doing <span id="activity-count" class="count"></span></summary><div id="activity-hidden" class="hint" hidden></div><ol id="activity" class="rows"></ol></details>
  <details id="files-box" open><summary>Files chosen and why <span id="files-count" class="count"></span></summary><ul id="files" class="files"></ul><p id="files-empty" class="hint">Forge has not chosen any files yet. Ask for something and they will appear here.</p></details>
  <div class="undo-row"><button id="undo" class="secondary" disabled title="Put your files back the way they were before the last save">Undo last save</button></div>
</main>
<footer>
  <div id="chips" class="chips" aria-label="Files you mentioned"></div>
  <div class="inputwrap">
    <ul id="suggest" role="listbox" aria-label="Files and functions you can mention" hidden></ul>
    <textarea id="input" rows="3" aria-label="Tell Forge what to do" placeholder="What should Forge do? Type @ to point at a file. (Enter = send, Shift+Enter = new line)"></textarea>
  </div>
  <div class="actions"><button id="send" class="primary">Send</button><button id="stop" class="danger" hidden>Stop</button></div>
</footer>
<script nonce="${p.nonce}" src="${p.jsUri}"></script>
</body></html>`;
}
