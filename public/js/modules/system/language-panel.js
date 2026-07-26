// modules/system/language-panel.js — panel "🌐 Idioma" del menú Sistema.
// Preferencia PERSONAL, self-service (NO admin-gated): cada usuario elige su
// propio idioma de interfaz. Guarda en su perfil (POST /api/account/lang) y
// recarga la página para aplicarlo (ver ui/i18n.js). Primer consumidor real
// del núcleo i18n — demo end-to-end del mecanismo que Fase 2 va a replicar
// módulo por módulo (PLAN i18n, 2026-07-19).
import { icon } from '../../ui/icons.js';
import { helpBtn } from '../../ui/help.js';
import { t, getLang, setLang } from '../../ui/i18n.js';

export function mountLanguagePanel(el, ctx) {
  const current = getLang();

  const optHtml = (lang, flag, label) => `
    <button class="lg-opt${current === lang ? ' lg-opt--active' : ''}" data-lang="${lang}">
      <span class="lg-opt-flag">${flag}</span>
      <span class="lg-opt-lb">${label}</span>
      ${current === lang ? `<span class="lg-opt-cur">${icon('check', { size: 13 })}</span>` : ''}
    </button>`;

  el.innerHTML = `
    <div class="hp-head">
      <span class="hp-title">${t('system.help.language.title', 'Idioma')}</span>
      ${helpBtn('sys-lang')}
    </div>
    <p class="ev-hint">${t('system.lang.hint', 'Elegí el idioma de la interfaz para TU cuenta. Aplica solo a vos — es una preferencia personal, no una configuración del sistema.')}</p>
    <div class="lg-opts">
      ${optHtml('es', '🇪🇸', t('system.lang.es', 'Español'))}
      ${optHtml('en', '🇬🇧', t('system.lang.en', 'English'))}
    </div>
    <p class="ev-msg" data-ref="msg" hidden></p>
    <p class="ev-hint lg-note">${t('system.lang.note', 'Toda la interfaz principal está traducida. Si encontrás algún texto que quedó en español, avisá para sumarlo.')}</p>
  `;

  el.querySelectorAll('[data-lang]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const lang = btn.dataset.lang;
      if (lang === current) return;
      const ok = await ctx.dialog.confirmDialog({
        title: t('system.lang.title', 'Idioma'),
        message: t('system.lang.confirm', 'La página se va a recargar en el idioma elegido.'),
      });
      if (!ok) return;
      const msg = el.querySelector('[data-ref="msg"]');
      msg.hidden = false;
      msg.textContent = t('system.lang.saving', 'Guardando…');
      try {
        await setLang(lang); // recarga la página al terminar
      } catch (e) {
        msg.textContent = e.message || t('system.lang.error', 'No se pudo guardar el idioma.');
      }
    });
  });
}
