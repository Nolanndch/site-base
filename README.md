# site-base

Boilerplate HTML/CSS/JS modulaire, sans framework ni dépendance runtime. Le build (`build.mjs`, Node ≥ 20) assemble layout + partials + pages et génère `dist/`, `sitemap.xml`, `robots.txt` et `site.webmanifest`.

```bash
npm run dev            # http://localhost:3000, rebuild auto
npm run build          # ./dist
npm run build:strict   # échoue sur avertissement (balises légales, meta, URL)
npm run typecheck      # JSDoc + tsc (strict) sur src/assets/js
```

## Nouvelle page
Créer `src/pages/ma-page.html` (→ `/ma-page/`) :

```html
---
title: Titre
description: 50 à 160 caractères.
---
<section class="section">…</section>
```
Clés de front matter : `title`, `description`, `image`, `imageAlt`, `ogType`, `fullTitle`, `noindex`, `legal`, `lastmod`, `bodyClass`. Ajouter la page à `nav` / `footerNav` dans `site.config.json`.

## Checklist livraison client
1. `site.config.json` : nom, url, description, organisation, nav, `form.endpoint`.
2. Remplacer toutes les balises `[…]` des pages légales (`build:strict` les détecte).
3. Remplacer favicons / icônes / `og-default.png` (placeholders unis).
4. Polices : `.woff2` dans `assets/fonts`, `@font-face` dans `tokens.css`, URL dans `fonts.preload`.
5. `vercel.json` : compléter la CSP (`connect-src`/`form-action` pour l'endpoint du formulaire, `script-src` pour chaque script tiers conditionné au consentement).
6. Variables Vercel : `SITE_URL` (domaine final). `VERCEL_ENV=preview` passe automatiquement le site en `noindex`.

## Architecture CSS
`@layer tokens, base, layout, components, utilities` : les surcharges client vont dans `utilities` ou une couche ajoutée en fin d'ordre (`CSS_ORDER` dans `build.mjs`).
