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

const charSlugAliases = {
  'simon-belmont': 'simon',
  'shovel-knight': 'shovelknight',
  'sheik-zelda': 'sheik',
  'la-reina': 'reina'
};

const charStockSlug = name => {
  const s = slug(name);
  return charSlugAliases[s] || s;
};

// Safe Markdown renderer with XSS protection
function renderMarkdown(text) {
  if (!text) return '';

  // 1. First escape all raw HTML to prevent XSS
  let s = esc(String(text));

  // Store fenced code blocks temporarily to prevent inner replacements
  const codeBlocks = [];
  s = s.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre><code${lang ? ` class="language-${lang}"` : ''}>${code}</code></pre>`);
    return `@@CODEBLOCK_${idx}@@`;
  });

  // Store inline code
  const inlineCodes = [];
  s = s.replace(/`([^`\n]+)`/g, (_, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code>${code}</code>`);
    return `@@INLINECODE_${idx}@@`;
  });

  // Split into block paragraphs separated by two or more newlines
  const blocks = s.split(/\n{2,}/);

  const formatInline = str => {
    let out = str;

    // Links: [text](url) - only allow safe http / https protocols
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s\)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

    // Bold + Italic: ***text*** or ___text___
    out = out.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    out = out.replace(/___([^_]+)___/g, '<strong><em>$1</em></strong>');

    // Bold: **text** or __text__
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');

    // Italic: *text* or _text_
    out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    out = out.replace(/_([^_]+)_/g, '<em>$1</em>');

    // Single line break
    out = out.replace(/\n/g, '<br>');

    return out;
  };

  const renderedBlocks = blocks.map(block => {
    block = block.trim();
    if (!block) return '';

    // Check placeholder
    if (/^@@CODEBLOCK_\d+@@$/.test(block)) {
      return block;
    }

    // Headings
    if (/^###\s+/.test(block)) {
      return `<h3>${formatInline(block.replace(/^###\s+/, ''))}</h3>`;
    }
    if (/^##\s+/.test(block)) {
      return `<h2>${formatInline(block.replace(/^##\s+/, ''))}</h2>`;
    }
    if (/^#\s+/.test(block)) {
      return `<h1>${formatInline(block.replace(/^#\s+/, ''))}</h1>`;
    }

    // Blockquote
    if (/^>\s?/.test(block)) {
      const bqContent = block.split('\n').map(l => l.replace(/^>\s?/, '')).join('\n');
      return `<blockquote>${formatInline(bqContent)}</blockquote>`;
    }

    // Unordered list
    if (/^[-*]\s+/.test(block)) {
      const items = block.split('\n').filter(l => /^[-*]\s+/.test(l)).map(l => `<li>${formatInline(l.replace(/^[-*]\s+/, ''))}</li>`).join('');
      return `<ul>${items}</ul>`;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(block)) {
      const items = block.split('\n').filter(l => /^\d+\.\s+/.test(l)).map(l => `<li>${formatInline(l.replace(/^\d+\.\s+/, ''))}</li>`).join('');
      return `<ol>${items}</ol>`;
    }

    // Regular paragraph
    return `<p>${formatInline(block)}</p>`;
  });

  let result = renderedBlocks.filter(Boolean).join('');

  // Restore inline codes
  result = result.replace(/@@INLINECODE_(\d+)@@/g, (_, idx) => inlineCodes[+idx] || '');

  // Restore code blocks
  result = result.replace(/@@CODEBLOCK_(\d+)@@/g, (_, idx) => codeBlocks[+idx] || '');

  return result;
}
