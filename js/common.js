// Shared helpers for historical ranking templates.
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slug = x => String(x ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
const ord = n => n + ((n % 100 >= 11 && n % 100 <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'));
// Placement colour class: 1st gold, 2nd silver, 3rd bronze, the rest sky.
const pcls = n => n <= 3 ? 'p' + n : 'pn';
const md = d => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
// "Jun 1 – Oct 31, 2026", or with both years when the period crosses a year.
const period = (s, e) => s.slice(0, 4) === e.slice(0, 4)
  ? `${md(s)} – ${md(e)}, ${e.slice(0, 4)}`
  : `${md(s)}, ${s.slice(0, 4)} – ${md(e)}, ${e.slice(0, 4)}`;
