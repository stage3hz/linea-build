// Draws the overlay list; touched only when the list really changed (the app sends diffs only).
const list = document.getElementById('list');
const colors = ['#5865F2', '#E5467A', '#25A69A', '#F0A030', '#8C62E8', '#3D8BFD', '#E2574C', '#34A853'];
const hue = name => { let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0; return colors[h % colors.length]; };
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
window.overlay.onView((view, opacity) => {
  document.body.style.opacity = String(opacity || 0.9);
  list.replaceChildren();
  if (!view) return;
  list.append(el('div', 'ch', view.channel));
  for (const p of view.people) {
    const row = el('div', 'row ' + (p.speaking ? 'speak' : 'quiet'));
    const av = el('div', 'av', (p.name || '?').trim().charAt(0).toUpperCase()); av.style.background = hue(p.name || '?');
    row.append(av, el('div', 'name', p.name + (p.me ? ' (ты)' : '')));
    if (p.deafened) row.append(el('div', 'state', 'звук выкл.')); else if (p.muted) row.append(el('div', 'state', 'микр. выкл.'));
    list.append(row);
  }
});
