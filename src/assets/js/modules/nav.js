// @ts-check
const DESKTOP_QUERY = '(min-width: 48em)';

/** Amélioration progressive : sans JS, le menu reste entièrement visible. */
export function initNav() {
  const toggle = document.querySelector('[data-nav-toggle]');
  const header = toggle?.closest('.site-header');
  const nav = document.getElementById(toggle?.getAttribute('aria-controls') ?? '');
  if (!toggle || !header || !nav) return;

  header.setAttribute('data-enhanced', '');

  /** @param {boolean} open */
  const setOpen = (open) => {
    toggle.setAttribute('aria-expanded', String(open));
    nav.toggleAttribute('data-open', open);
  };
  const isOpen = () => toggle.getAttribute('aria-expanded') === 'true';

  toggle.addEventListener('click', () => setOpen(!isOpen()));
  nav.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest('a')) setOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isOpen()) {
      setOpen(false);
      /** @type {HTMLElement} */ (toggle).focus();
    }
  });
  window.matchMedia(DESKTOP_QUERY).addEventListener('change', (event) => {
    if (event.matches) setOpen(false);
  });
}
