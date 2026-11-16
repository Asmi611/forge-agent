// Replaces ONLY the "contributes" block of package.json (Developer 2 may edit that block).
// Everything else in the file is left exactly as it is. Run from the forge-agent folder:
//   node apply-contributes.js
const fs = require('fs');
const file = 'package.json';
const text = fs.readFileSync(file, 'utf8');

const contributes = {
  commands: [
    { command: 'forge.showDemoDiff', title: 'Show Demo Diff (mock)', category: 'Forge' },
    { command: 'forge.acceptHunk', title: '✓ Accept', category: 'Forge' },
    { command: 'forge.rejectHunk', title: '✗ Reject', category: 'Forge' },
    { command: 'forge.acceptHunkAtCursor', title: 'Accept Change Under Cursor', category: 'Forge' },
    { command: 'forge.rejectHunkAtCursor', title: 'Reject Change Under Cursor', category: 'Forge' },
    { command: 'forge.acceptAllHunks', title: 'Accept All Changes in This Diff', category: 'Forge' },
    { command: 'forge.rejectAllHunks', title: 'Reject All Changes in This Diff', category: 'Forge' },
    { command: 'forge.applyAccepted', title: 'Apply Accepted Changes', category: 'Forge' },
    { command: 'forge.undoLastApply', title: 'Undo Last Apply', category: 'Forge' },
  ],
  menus: {
    'comments/comment/title': [
      { command: 'forge.acceptHunk', group: 'inline@1', when: 'commentController == forge-review' },
      { command: 'forge.rejectHunk', group: 'inline@2', when: 'commentController == forge-review' },
    ],
    commandPalette: [
      { command: 'forge.acceptHunk', when: 'false' },
      { command: 'forge.rejectHunk', when: 'false' },
    ],
  },
};

const key = '"contributes"';
const keyAt = text.indexOf(key);
if (keyAt < 0) { console.error('Could not find "contributes" in package.json. Nothing changed.'); process.exit(1); }
const open = text.indexOf('{', keyAt);
let depth = 0, end = -1;
for (let i = open; i < text.length; i++) {
  if (text[i] === '{') depth++;
  else if (text[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
}
if (end < 0) { console.error('The "contributes" block is not closed. Nothing changed.'); process.exit(1); }

const block = JSON.stringify(contributes, null, 2).split('\n').map((l, i) => (i === 0 ? l : '  ' + l)).join('\n');
const next = text.slice(0, open) + block + text.slice(end + 1);
JSON.parse(next); // throws if we would break the file
fs.writeFileSync(file, next);
console.log('Done: "contributes" updated. Everything else in package.json is unchanged.');
