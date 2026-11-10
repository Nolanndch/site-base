// @ts-check
/**
 * Gestion du consentement (RGPD / CNIL).
 * - Aucun traceur non essentiel avant consentement explicite.
 * - "Tout refuser" aussi accessible que "Tout accepter".
 * - Choix conservé 6 mois maximum, retirable à tout moment (lien "Gérer les cookies").
 *
 * Pour conditionner un script tiers :
 *   <script type="text/plain" data-consent="analytics" src="…"></script>
 * (autoriser son domaine dans la CSP de vercel.json).
 */

/** @typedef {'analytics' | 'marketing'} ConsentCategory */
/** @typedef {Record<ConsentCategory, boolean>} ConsentChoices */

const STORAGE_KEY = 'consent';
const SCHEMA_VERSION = 1;
const TTL_MS = 182 * 24 * 60 * 60 * 1000;
/** @type {readonly ConsentCategory[]} */
const CATEGORIES = ['analytics', 'marketing'];

/** @param {unknown} input @returns {ConsentChoices} */
function sanitize(input) {
  const source = /** @type {Record<string, unknown>} */ (input && typeof input === 'object' ? input : {});
  return { analytics: source.analytics === true, marketing: source.marketing === true };
}

/** @returns {ConsentChoices | null} */
function readStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.v !== SCHEMA_VERSION || typeof parsed.exp !== 'number' || parsed.exp < Date.now()) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return sanitize(parsed.choices);
  } catch {
    return null; // stockage indisponible ou corrompu : on redemande
  }
}

/** @param {ConsentChoices} choices */
function writeStored(choices) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: SCHEMA_VERSION, exp: Date.now() + TTL_MS, choices }));
  } catch {
    /* mode privé / quota : le choix vaut pour la page courante uniquement */
  }
}

/** @param {ConsentCategory} category */
function activateScripts(category) {
  document.querySelectorAll(`script[type="text/plain"][data-consent="${category}"]`).forEach((placeholder) => {
    const script = document.createElement('script');
    for (const { name, value } of Array.from(placeholder.attributes)) {
      if (name !== 'type' && name !== 'data-consent') script.setAttribute(name, value);
    }
    script.text = placeholder.textContent ?? '';
    placeholder.replaceWith(script);
  });
}

/** @type {ConsentChoices | null} */
let current = null;

/** @param {ConsentCategory} category */
export const hasConsent = (category) => current?.[category] === true;

export function initCookieConsent() {
  const banner = /** @type {HTMLElement | null} */ (document.querySelector('[data-cookie-banner]'));
  if (!banner) return;
  const title = /** @type {HTMLElement | null} */ (banner.querySelector('#cookie-title'));
  const prefs = /** @type {HTMLFormElement | null} */ (banner.querySelector('[data-cookie-prefs]'));
  const customizeBtn = banner.querySelector('[data-cookie-action="customize"]');

  /** @param {ConsentChoices} choices */
  const save = (choices) => {
    const revoked = CATEGORIES.some((c) => current?.[c] && !choices[c]);
    current = choices;
    writeStored(choices);
    banner.hidden = true;
    for (const category of CATEGORIES) if (choices[category]) activateScripts(category);
    document.dispatchEvent(new CustomEvent('consent:change', { detail: choices }));
    // Un script déjà chargé ne peut pas être déchargé : on recharge pour appliquer le retrait.
    if (revoked) location.reload();
  };

  const syncPrefs = () => {
    if (!prefs) return;
    for (const category of CATEGORIES) {
      const input = /** @type {HTMLInputElement | null} */ (prefs.elements.namedItem(category));
      if (input) input.checked = hasConsent(category);
    }
  };

  banner.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('[data-cookie-action]') : null;
    switch (button?.getAttribute('data-cookie-action')) {
      case 'accept':
        save({ analytics: true, marketing: true });
        break;
      case 'reject':
        save({ analytics: false, marketing: false });
        break;
      case 'customize':
        if (prefs) {
          prefs.hidden = !prefs.hidden;
          customizeBtn?.setAttribute('aria-expanded', String(!prefs.hidden));
        }
        break;
    }
  });

  prefs?.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(prefs);
    save({ analytics: data.has('analytics'), marketing: data.has('marketing') });
  });

  document.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest('[data-cookie-settings]')) {
      syncPrefs();
      banner.hidden = false;
      title?.focus();
    }
  });

  current = readStored();
  if (current) {
    for (const category of CATEGORIES) if (current[category]) activateScripts(category);
  } else {
    banner.hidden = false;
  }
}
