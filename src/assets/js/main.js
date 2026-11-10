// @ts-check
import { initCookieConsent } from './modules/cookie-consent.js';
import { initFormGuard } from './modules/form-guard.js';
import { initNav } from './modules/nav.js';

initNav();
initFormGuard();
initCookieConsent();
