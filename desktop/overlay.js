// Draws the overlay list; touched only when the list really changed (the app sends diffs only).
const list = document.getElementById('list');
const colors = ['#5865F2', '#E5467A', '#25A69A', '#F0A030', '#8C62E8', '#3D8BFD', '#E2574C', '#34A853'];
const hue = name => { let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0; return colors[h % colors.length]; };
// White icons crossed out diagonally: microphone off / sound off (drawn here, no icon files).
const NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  mic: ['M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z', 'M6 11a6 6 0 0 0 12 0', 'M12 17v4'],
  headset: ['M4 15v-3a8 8 0 0 1 16 0v3', 'M4 14h3v6H5a1 1 0 0 1-1-1z', 'M20 14h-3v6h2a1 1 0 0 0 1-1z'],
};
function crossed(kind, label) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', 'icon'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', label);
  for (const d of [...ICONS[kind], 'M4 4L20 20']) {
    const path = document.createElementNS(NS, 'path'); path.setAttribute('d', d); svg.append(path);
  }
  return svg;
}
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
    if (p.deafened) row.append(crossed('headset', 'Звук выключен')); else if (p.muted) row.append(crossed('mic', 'Микрофон выключен'));
    list.append(row);
  }
});
