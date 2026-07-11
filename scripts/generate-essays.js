'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CSV_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vQpHxQybBYNImPQGNJTi4LpWQNzjOI7rmVPyMzerQa6h2NfnK8rs25sOZM9RPK6xt8h8xhdnHWqVYH1/pub?gid=0&single=true&output=csv';

const ROOT = path.join(__dirname, '..');
const ESSAYS_DIR = path.join(ROOT, 'essays');
const TEMPLATE_PATH = path.join(ROOT, 'essay-template.html');
const ESSAYS_HTML_PATH = path.join(ROOT, 'essays.html');

const KNOWN_CATEGORIES = [
  'Skills & Qualifications',
  'Applying to Jobs',
  'Relationships & Outreach',
  'Energy & Mindset',
  'Daily Structure',
];

// ── Utilities ──────────────────────────────────────────────────────────────

function htmlEncode(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// Fetch URL, following redirects (handles both http and https)
function fetchUrl(url, _depth) {
  const depth = _depth || 0;
  return new Promise((resolve, reject) => {
    if (depth > 10) {
      reject(new Error('Too many redirects'));
      return;
    }
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(
      url,
      { headers: { 'User-Agent': 'laid-off-launchpad-build/1.0' } },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          fetchUrl(res.headers.location, depth + 1).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error(`Request timed out for ${url}`)));
  });
}

// Retry fetchUrl up to maxAttempts times with a delay between attempts
async function fetchWithRetry(url, maxAttempts = 3, delayMs = 3000) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fetchUrl(url);
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        console.log(`  Attempt ${attempt} failed (${err.message}); retrying in ${delayMs / 1000}s…`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}

// ── CSV Parser (RFC 4180) ──────────────────────────────────────────────────

function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuote = false;
  const n = text.length;

  for (let i = 0; i < n; i++) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '"') {
        if (i + 1 < n && text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuote = false;
        }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuote = true;
      } else if (ch === ',') {
        row.push(field);
        field = '';
      } else if (ch === '\r' && i + 1 < n && text[i + 1] === '\n') {
        row.push(field);
        field = '';
        rows.push(row);
        row = [];
        i++;
      } else if (ch === '\n') {
        row.push(field);
        field = '';
        rows.push(row);
        row = [];
      } else {
        field += ch;
      }
    }
  }
  if (field || row.length > 0) {
    row.push(field);
    if (row.some((f) => f !== '')) rows.push(row);
  }

  return rows;
}

// ── Markdown → HTML ────────────────────────────────────────────────────────

function applyInline(text) {
  return text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

function bodyToHtml(body) {
  const text = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const blocks = text.split(/\n{2,}/);
  let html = '';

  for (const rawBlock of blocks) {
    const block = rawBlock.trim();
    if (!block) continue;

    const lines = block.split('\n').map((l) => l.trim());

    if (lines[0].startsWith('## ')) {
      html += `        <h2>${applyInline(lines[0].slice(3).trim())}</h2>\n`;
    } else if (lines.every((l) => l.startsWith('> '))) {
      const content = lines.map((l) => l.slice(2)).join(' ');
      html += `        <blockquote><p>${applyInline(content)}</p></blockquote>\n`;
    } else if (lines.every((l) => l.startsWith('- '))) {
      const items = lines.map((l) => `          <li>${applyInline(l.slice(2).trim())}</li>`).join('\n');
      html += `        <ul>\n${items}\n        </ul>\n`;
    } else {
      const content = lines.join(' ');
      html += `        <p>${applyInline(content)}</p>\n`;
    }
  }

  return html;
}

// ── Slug ───────────────────────────────────────────────────────────────────

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// ── Path Adjustment (root-relative → essays/ subdirectory) ─────────────────

function adjustPaths(html) {
  return html
    .replace(/href="_ds\//g, 'href="../_ds/')
    .replace(/src="\.\/images\//g, 'src="../images/')
    .replace(/href="\.\/images\//g, 'href="../images/')
    .replace(/href="index\.html"/g, 'href="../index.html"')
    .replace(/href="about\.html"/g, 'href="../about.html"')
    .replace(/href="essays\.html"/g, 'href="../essays.html"')
    .replace(/href="essay-template\.html"/g, 'href="../essay-template.html"')
    .replace(/href="\.\/accelerator\.html"/g, 'href="../accelerator.html"')
    .replace(/href="\.\/privacy\.html"/g, 'href="../privacy.html"');
}

// ── Extra CSS for list and blockquote (not in template) ───────────────────

const EXTRA_CSS = `
    .essay-body ul { margin: 0 0 1.45em 1.4em; padding: 0; }
    .essay-body li { font-family: var(--font-sans); font-weight: 400; font-size: clamp(1.05rem, 1.18vw, 1.15rem); line-height: 1.72; color: var(--fg-body); margin: 0 0 0.5em; text-wrap: pretty; }
    .essay-body blockquote { border-left: 3px solid var(--c-sinopia); margin: 0 0 1.45em 0; padding: 0.2em 0 0.2em 1.2em; }
    .essay-body blockquote p { margin: 0; font-style: italic; color: var(--c-warm-500); }`;

// ── Generate one essay HTML file ───────────────────────────────────────────

function generateEssayHtml(template, { title, category, bodyHtml }) {
  let html = template;

  html = adjustPaths(html);

  // Inject list/blockquote CSS
  html = html.replace('</style>', EXTRA_CSS + '\n  </style>');

  // <title>
  html = html.replace(
    '<title>Laid Off Launchpad — Essay</title>',
    `<title>${htmlEncode(title)} — Laid Off Launchpad</title>`
  );

  // category tag
  html = html.replace(
    /<p class="essay-tag">[\s\S]*?<\/p>/,
    `<p class="essay-tag">${htmlEncode(category)}</p>`
  );

  // essay title
  html = html.replace(
    /<h1 class="essay-title">[\s\S]*?<\/h1>/,
    `<h1 class="essay-title">${htmlEncode(title)}</h1>`
  );

  // essay body content
  html = html.replace(
    /(<div class="essay-body">)[\s\S]*?(<\/div>\s*\n\s*<!-- End-of-essay)/,
    `$1\n${bodyHtml}      $2`
  );

  return html;
}

// ── essays.html update ─────────────────────────────────────────────────────

function buildListItem(title, slug) {
  return `          <li><a class="essay-link" href="essays/${slug}.html"><span>${htmlEncode(title)}</span><span class="chev"><i data-lucide="chevron-right"></i></span></a></li>`;
}

function updateEssaysHtml(essaysHtml, essaysByCat) {
  return essaysHtml.replace(
    /(<article class="cat-card(?:\s+is-wide)?">[\s\S]*?<p class="cat-label">([\s\S]*?)<\/p>[\s\S]*?<ul class="essay-list">)[\s\S]*?(<\/ul>)/g,
    (match, before, rawLabel, closing) => {
      const label = decodeHtmlEntities(rawLabel.trim());
      const essays = essaysByCat[label];
      if (!essays || essays.length === 0) return match;
      const items = essays.map((e) => buildListItem(e.title, e.slug)).join('\n');
      return `${before}\n${items}\n        ${closing}`;
    }
  );
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('Fetching CSV…');
  let csvText;
  try {
    csvText = await fetchWithRetry(CSV_URL);
  } catch (err) {
    console.warn(`\n⚠  CSV fetch failed after 3 attempts: ${err.message}`);
    console.warn('   Previously generated essay files are unchanged.');
    console.warn('   Fix the network issue or sheet permissions and redeploy.\n');
    return;
  }

  const rows = parseCSV(csvText);
  if (rows.length < 2) {
    console.log('CSV has no data rows — nothing to generate.');
    return;
  }

  const header = rows[0].map((h) => h.trim());
  const titleIdx = header.findIndex((h) => h === 'Title');
  const catIdx = header.findIndex((h) => h === 'Category');
  const bodyIdx = header.findIndex((h) => h === 'Body');

  if (titleIdx === -1 || catIdx === -1 || bodyIdx === -1) {
    throw new Error(`Expected columns Title, Category, Body. Got: ${header.join(', ')}`);
  }

  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  fs.mkdirSync(ESSAYS_DIR, { recursive: true });

  const slugCount = {};
  const generated = [];
  const warnings = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const title = (row[titleIdx] || '').trim();
    const category = (row[catIdx] || '').trim();
    const body = (row[bodyIdx] || '').trim();

    if (!title) {
      console.log(`  Row ${i + 1}: blank title — skipped.`);
      continue;
    }

    if (!KNOWN_CATEGORIES.includes(category)) {
      warnings.push(`Row ${i + 1} "${title}": unrecognised category "${category}" — essay generated but will not appear in any card.`);
    }

    const base = slugify(title);
    slugCount[base] = (slugCount[base] || 0) + 1;
    const slug = slugCount[base] === 1 ? base : `${base}-${slugCount[base]}`;
    if (slugCount[base] > 1) {
      warnings.push(`Slug collision on "${base}" — duplicate renamed to "${slug}".`);
    }

    const bodyHtml = bodyToHtml(body);
    const essayHtml = generateEssayHtml(template, { title, category, bodyHtml });
    const outPath = path.join(ESSAYS_DIR, `${slug}.html`);
    fs.writeFileSync(outPath, essayHtml, 'utf8');

    generated.push({ title, category, slug });
    console.log(`  ✓ essays/${slug}.html  [${category}]`);
  }

  // Group by category preserving CSV row order
  const essaysByCat = {};
  for (const e of generated) {
    if (!essaysByCat[e.category]) essaysByCat[e.category] = [];
    essaysByCat[e.category].push(e);
  }

  const essaysHtml = fs.readFileSync(ESSAYS_HTML_PATH, 'utf8');
  const updated = updateEssaysHtml(essaysHtml, essaysByCat);
  fs.writeFileSync(ESSAYS_HTML_PATH, updated, 'utf8');
  console.log('  ✓ essays.html updated');

  console.log('\n══ Build Report ══════════════════════════════════');
  console.log(`Generated ${generated.length} essay page(s):`);
  for (const e of generated) {
    console.log(`  [${e.category}]  ${e.title}  →  essays/${e.slug}.html`);
  }
  if (warnings.length) {
    console.log('\nWarnings:');
    for (const w of warnings) console.log(`  ⚠  ${w}`);
  } else {
    console.log('\nNo warnings.');
  }
  console.log('══════════════════════════════════════════════════');
}

main().catch((err) => {
  console.error('\nBuild failed:', err.message);
  process.exit(1);
});
