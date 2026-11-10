// @ts-check
/**
 * Formulaires protégés côté client : validation native, honeypot, délai minimal.
 * ⚠ Ces contrôles ne remplacent pas la validation serveur (honeypot, `_elapsed`, rate limiting,
 *   captcha type Turnstile/hCaptcha si le volume de spam l'exige).
 */
const DEFAULT_MIN_FILL_MS = 3000;
const REQUEST_TIMEOUT_MS = 10_000;

const MESSAGES = {
  success: 'Merci, votre message a bien été envoyé.',
  tooFast: 'Envoi trop rapide. Merci de patienter quelques secondes puis de réessayer.',
  network: "Une erreur réseau est survenue. Merci de réessayer ou de nous écrire directement par e-mail.",
  server: "L'envoi a échoué. Merci de réessayer plus tard.",
  rateLimited: 'Trop de tentatives. Merci de réessayer dans quelques minutes.',
  notConfigured: "Ce formulaire n'est pas configuré (site.config.json > form.endpoint).",
};

/** @param {HTMLFormElement} form */
function guard(form) {
  const status = form.querySelector('[data-form-status]');
  const submit = /** @type {HTMLButtonElement | null} */ (form.querySelector('[type="submit"]'));
  const honeypot = /** @type {HTMLInputElement | null} */ (form.querySelector('[data-honeypot]'));
  const minFillMs = Number(form.dataset.minFillMs) || DEFAULT_MIN_FILL_MS;
  const renderedAt = Date.now();

  /** @param {'success' | 'error' | ''} state @param {string} message */
  const report = (state, message) => {
    if (!status) return;
    status.setAttribute('data-state', state);
    status.textContent = message;
  };

  /** @param {boolean} busy */
  const setBusy = (busy) => {
    if (!submit) return;
    submit.disabled = busy;
    submit.setAttribute('aria-busy', String(busy));
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;

    // Bot : on simule un succès pour ne pas lui donner de signal exploitable.
    if (honeypot?.value) {
      report('success', MESSAGES.success);
      form.reset();
      return;
    }

    const elapsed = Date.now() - renderedAt;
    if (elapsed < minFillMs) {
      report('error', MESSAGES.tooFast);
      return;
    }

    const endpoint = form.getAttribute('action');
    if (!endpoint) {
      report('error', MESSAGES.notConfigured);
      return;
    }

    /** @type {Record<string, string | number>} */
    const payload = { _elapsed: elapsed };
    for (const [key, value] of new FormData(form)) {
      if (typeof value === 'string' && key !== honeypot?.name) payload[key] = value.trim();
    }

    setBusy(true);
    report('', '');
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) {
        report('success', MESSAGES.success);
        form.reset();
      } else {
        report('error', response.status === 429 ? MESSAGES.rateLimited : MESSAGES.server);
      }
    } catch {
      report('error', MESSAGES.network); // réseau coupé ou timeout
    } finally {
      setBusy(false);
    }
  });
}

export function initFormGuard() {
  document.querySelectorAll('form[data-form-guard]').forEach((form) => {
    if (form instanceof HTMLFormElement) guard(form);
  });
}
