#!/usr/bin/env node
/**
 * Générateur statique sans dépendance (Node >= 20).
 *
 *   node build.mjs             build dans ./dist
 *   node build.mjs --strict    échoue si un avertissement est levé (CI / prod)
 *   node build.mjs --watch --serve   dev local sur http://localhost:3000
 *
 * Variables d'environnement :
 *   SITE_URL   surcharge site.config.json > url
 *   SITE_ENV   "staging" => noindex global + robots.txt Disallow
 *
 * Syntaxe des templates :
 *   {{ chemin.var }}       valeur échappée HTML
 *   {{{ chemin.var }}}     valeur brute (HTML de confiance uniquement)
 *   {{> nom }}             inclusion de src/partials/nom.html
 *   {{#if chemin}}…{{/if}} bloc conditionnel (non imbricable)
 * Toute variable inconnue fait échouer le build (pas de "undefined" silencieux).
 */
import { createHash } from 'node:crypto';
import { createReadStream, watch } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, dirname, extname, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');
const CSS_DIR = join(SRC, 'assets', 'css');
const CSS_ORDER = ['tokens', 'base', 'layout', 'components', 'utilities'];
const MAX_PARTIAL_DEPTH = 5;

const PLACEHOLDER = /\[[A-ZÀ-Ý][^\]\n<>]{1,80}\]/g;
const IF_RE = /\{\{#if\s+([\w.]+)\s*\}\}([\s\S]*?)\{\{\/if\}\}/g;
const VAR_RE = /\{\{\{\s*([\w.]+)\s*\}\}\}|\{\{\s*([\w.]+)\s*\}\}/g;

const argv = new Set(process.argv.slice(2));
const isWatch = argv.has('--watch');

/* ---------- Utilitaires ---------- */

const normalizeEol = (text) => text.replace(/\r\n/g, '\n');
const stripComments = (html) => html.replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n');

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])),
  );
  return nested.flat().sort();
}

/* ---------- Moteur de templates ---------- */

function lookup(ctx, path, origin, lenient = false) {
  let value = ctx;
  for (const key of path.split('.')) {
    if (value === null || typeof value !== 'object' || !(key in value)) {
      if (lenient) return undefined;
      throw new Error(`Variable inconnue "${path}" (${origin})`);
    }
    value = value[key];
  }
  return value;
}

const isTruthy = (v) => Boolean(v) && !(Array.isArray(v) && v.length === 0);

function expandPartials(template, partials, origin, depth = 0) {
  if (depth > MAX_PARTIAL_DEPTH) throw new Error(`Partials imbriqués trop profondément (${origin})`);
  return template.replace(/\{\{>\s*([\w-]+)\s*\}\}/g, (_, name) => {
    const partial = partials.get(name);
    if (partial === undefined) throw new Error(`Partial inconnu "${name}" (${origin})`);
    return expandPartials(partial, partials, `partial:${name}`, depth + 1);
  });
}

function interpolate(template, ctx, origin) {
  const out = template
    .replace(IF_RE, (_, path, inner) => (isTruthy(lookup(ctx, path, origin, true)) ? inner : ''))
    .replace(VAR_RE, (_, raw, escaped) => {
      const value = lookup(ctx, raw ?? escaped, origin) ?? '';
      return raw ? String(value) : escapeHtml(value);
    });
  if (/\{\{[#/]/.test(out)) throw new Error(`Bloc {{#if}} mal formé ou imbriqué (${origin})`);
  return out;
}

function parseFrontMatter(source, origin) {
  const match = source.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { data: {}, body: source };
  const data = {};
  for (const line of match[1].split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx < 1) throw new Error(`Front matter invalide "${line}" (${origin})`);
    const raw = line.slice(idx + 1).trim();
    data[line.slice(0, idx).trim()] = raw === 'true' ? true : raw === 'false' ? false : raw;
  }
  return { data, body: source.slice(match[0].length) };
}

/* ---------- Routage & données dérivées ---------- */

function toRoute(relPath) {
  const slug = relPath.split(sep).join('/').replace(/\.html$/, '');
  if (slug === '404') return { url: '/404.html', out: '404.html' };
  if (slug === 'index') return { url: '/', out: 'index.html' };
  const dir = slug.replace(/\/index$/, '');
  return { url: `/${dir}/`, out: `${dir}/index.html` };
}

const renderNav = (items, current) =>
  `<ul>${items
    .map(
      (i) =>
        `<li><a href="${escapeHtml(i.href)}"${i.href === current ? ' aria-current="page"' : ''}>${escapeHtml(i.label)}</a></li>`,
    )
    .join('')}</ul>`;

const renderFontPreloads = (fonts) =>
  fonts
    .map((href) => `<link rel="preload" href="${escapeHtml(href)}" as="font" type="font/woff2" crossorigin>`)
    .join('\n');

function buildJsonLd(site, absolute) {
  const org = site.organization ?? {};
  const orgId = `${site.url}/#organization`;
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': orgId,
        name: org.name || site.name,
        url: `${site.url}/`,
        logo: org.logo ? absolute(org.logo) : undefined,
        email: org.email || undefined,
        sameAs: org.sameAs?.length ? org.sameAs : undefined,
      },
      {
        '@type': 'WebSite',
        '@id': `${site.url}/#website`,
        url: `${site.url}/`,
        name: site.name,
        inLanguage: site.lang,
        publisher: { '@id': orgId },
      },
    ],
  }).replace(/</g, '\\u003c'); // empêche toute sortie de la balise <script>
}

async function loadConfig() {
  const site = JSON.parse(await readFile(join(ROOT, 'site.config.json'), 'utf8'));
  site.url = new URL(process.env.SITE_URL || site.url).origin;
  site.fonts = { preload: [], ...site.fonts };
  const indexable = process.env.SITE_ENV !== 'staging' && process.env.VERCEL_ENV !== 'preview';
  return { site, indexable };
}

/* ---------- Assets ---------- */

async function buildCss(minify) {
  const parts = await Promise.all(CSS_ORDER.map((name) => readFile(join(CSS_DIR, `${name}.css`), 'utf8')));
  const css = parts.join('\n');
  if (!minify) return css;
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{};,])\s*/g, '$1')
    .trim();
}

async function assetVersion(css) {
  const hash = createHash('sha1').update(css);
  for (const file of (await walk(join(SRC, 'assets', 'js'))).filter((f) => f.endsWith('.js'))) {
    hash.update(await readFile(file));
  }
  return hash.digest('hex').slice(0, 8);
}

/* ---------- Build ---------- */

async function build() {
  const t0 = performance.now();
  const { site, indexable } = await loadConfig();
  const warnings = [];
  const absolute = (path) => (/^https?:\/\//.test(path) ? path : `${site.url}${path}`);

  if (site.url.includes('example.com')) warnings.push('site.config.json : "url" vaut encore example.com');
  if ([site.name, site.description].some((v) => v.match(PLACEHOLDER))) {
    warnings.push('site.config.json : balises [à remplacer] restantes (name / description)');
  }

  const partials = new Map();
  for (const file of await walk(join(SRC, 'partials'))) {
    partials.set(basename(file, '.html'), normalizeEol(await readFile(file, 'utf8')));
  }
  const layout = expandPartials(
    normalizeEol(await readFile(join(SRC, 'layouts', 'base.html'), 'utf8')),
    partials,
    'layouts/base.html',
  );

  const css = await buildCss(!isWatch);
  const version = await assetVersion(css);

  await rm(DIST, { recursive: true, force: true });
  await mkdir(join(DIST, 'assets', 'css'), { recursive: true });
  await cp(join(SRC, 'assets'), join(DIST, 'assets'), { recursive: true, filter: (p) => !p.startsWith(CSS_DIR) });
  await cp(join(SRC, 'public'), DIST, { recursive: true }).catch((err) => {
    if (err.code !== 'ENOENT') throw err;
  });
  await writeFile(join(DIST, 'assets', 'css', 'main.css'), css);

  const pagesDir = join(SRC, 'pages');
  const pageFiles = (await walk(pagesDir)).filter((f) => f.endsWith('.html'));
  if (pageFiles.length === 0) throw new Error('Aucune page dans src/pages');

  const sitemap = [];
  for (const file of pageFiles) {
    const rel = relative(pagesDir, file);
    const { data, body } = parseFrontMatter(normalizeEol(await readFile(file, 'utf8')), rel);
    const route = toRoute(rel);
    const page = {
      title: '', description: '', image: '', imageAlt: '', bodyClass: '', ogType: 'website',
      fullTitle: false, noindex: route.url === '/404.html', legal: false, lastmod: '',
      ...data,
    };

    const title = page.fullTitle || !page.title ? page.title || site.name : `${page.title} — ${site.name}`;
    const description = page.description || site.description;
    const meta = {
      title,
      description,
      canonical: route.url === '/404.html' ? '' : absolute(route.url),
      image: absolute(page.image || site.ogImage),
      imageAlt: page.imageAlt || site.name,
      robots: !indexable || page.noindex ? 'noindex, nofollow' : 'index, follow, max-image-preview:large',
      ogType: page.ogType,
      jsonld: route.url === '/' ? buildJsonLd(site, absolute) : '',
    };
    if (title.length > 60) warnings.push(`${route.url} : title > 60 caractères (${title.length})`);
    if (description.length > 160 || description.length < 50) {
      warnings.push(`${route.url} : description hors 50–160 caractères (${description.length})`);
    }

    const ctx = {
      site,
      page,
      meta,
      build: { version, year: new Date().getFullYear() },
      nav: renderNav(site.nav, route.url),
      footerNav: renderNav(site.footerNav, route.url),
      fontPreloads: renderFontPreloads(site.fonts.preload),
    };

    const content = stripComments(interpolate(expandPartials(body, partials, rel), ctx, rel));
    if (page.legal) {
      const left = new Set(content.match(PLACEHOLDER) ?? []);
      if (left.size > 0) warnings.push(`${route.url} : ${left.size} balise(s) [à remplacer] restante(s)`);
    }
    const html = stripComments(interpolate(layout, { ...ctx, content }, `layout:${rel}`));

    const outPath = join(DIST, route.out);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, html);

    if (indexable && !page.noindex) {
      const lastmod = page.lastmod || (await stat(file)).mtime.toISOString().slice(0, 10);
      sitemap.push(`  <url><loc>${escapeHtml(meta.canonical)}</loc><lastmod>${escapeHtml(lastmod)}</lastmod></url>`);
    }
  }

  await writeFile(
    join(DIST, 'robots.txt'),
    indexable
      ? `User-agent: *\nAllow: /\n\nSitemap: ${site.url}/sitemap.xml\n`
      : 'User-agent: *\nDisallow: /\n',
  );
  if (indexable) {
    await writeFile(
      join(DIST, 'sitemap.xml'),
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemap.join('\n')}\n</urlset>\n`,
    );
  }
  await writeFile(
    join(DIST, 'site.webmanifest'),
    JSON.stringify(
      {
        name: site.name,
        short_name: site.shortName || site.name,
        lang: site.lang,
        start_url: '/',
        display: 'standalone',
        background_color: site.backgroundColor,
        theme_color: site.themeColor,
        icons: [
          { src: '/assets/img/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/assets/img/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
      null,
      2,
    ),
  );

  console.log(`✓ ${pageFiles.length} pages — ${Math.round(performance.now() - t0)} ms${indexable ? '' : ' [noindex]'}`);
  for (const w of warnings) console.warn(`⚠ ${w}`);
  if (argv.has('--strict') && warnings.length > 0 && !isWatch) {
    console.error(`✗ ${warnings.length} avertissement(s) — build strict refusé`);
    process.exitCode = 1;
  }
}

/* ---------- Dev : serveur statique + watch ---------- */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
};

function serve(port = 3000) {
  createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url ?? '/', 'http://localhost');
      let target = normalize(join(DIST, decodeURIComponent(pathname)));
      if (target !== DIST && !target.startsWith(DIST + sep)) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      let info = await stat(target).catch(() => null);
      if (info?.isDirectory()) {
        target = join(target, 'index.html');
        info = await stat(target).catch(() => null);
      }
      const status = info ? 200 : 404;
      if (!info) target = join(DIST, '404.html');
      res.writeHead(status, { 'Content-Type': MIME[extname(target)] ?? 'application/octet-stream' });
      createReadStream(target).on('error', () => res.end()).pipe(res);
    } catch {
      res.writeHead(400).end('Bad request');
    }
  }).listen(port, '127.0.0.1', () => console.log(`→ http://localhost:${port}`));
}

function watchSources() {
  let timer;
  const rebuild = () => {
    clearTimeout(timer);
    timer = setTimeout(() => build().catch((err) => console.error(`✗ ${err.message}`)), 80);
  };
  watch(SRC, { recursive: true }, rebuild);
  watch(join(ROOT, 'site.config.json'), rebuild);
}

/* ---------- Entrée ---------- */

try {
  await build();
  if (argv.has('--serve')) serve();
  if (isWatch) watchSources();
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exit(1);
}
