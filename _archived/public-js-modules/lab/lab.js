// modules/lab/lab.js — accesos admin a herramientas experimentales del equipo.
import { helpBtn } from '../../ui/help.js';
import { t } from '../../ui/i18n.js';

const OPEN_KEY = 'cwc.lab.open';

function readOpen() {
  try { return localStorage.getItem(OPEN_KEY) === '1'; }
  catch { return false; }
}

export default {
  name: 'lab',

  mount(el, ctx) {
    const { icon, dialog, bus, whoami } = ctx;
    el.hidden = true;

    Promise.resolve(whoami).then((me) => {
      if (me?.admin !== true) return;

      el.innerHTML = `
        <header class="sec-head" data-ref="header" role="button" tabindex="0" aria-expanded="false">
          <button class="btn-ghost btn--sm btn--icon" data-ref="toggle" type="button" title="${t('lab.toggle', 'Mostrar u ocultar Laboratorio')}">${icon('chevronRight', { size: 13 })}</button>
          <span class="sec-title">${t('lab.title', '🧪 Laboratorio')}</span>
          ${helpBtn('lab')}
        </header>
        <div class="tk-card" data-ref="body" hidden>
          <div class="tk-actions">
            <button class="btn-ghost btn--sm btn--block" data-ref="omp" type="button">
              ${icon('terminal', { size: 14 })}
              <span><b>${t('lab.omp', 'Abrir omp')}</b><br><span class="bf-sub">${t('lab.ompHint', 'Agente de terminal · carpeta limpia ~/lab-omp')}</span></span>
            </button>
            <button class="btn-ghost btn--sm btn--block" data-ref="orca" type="button">
              ${icon('console', { size: 14 })}
              <span><b>${t('lab.orca', 'Abrir Orca')}</b><br><span class="bf-sub">${t('lab.orcaHint', 'Escritorio visual en una ventana nueva')}</span></span>
            </button>
          </div>
        </div>`;

      const refs = {};
      for (const ref of el.querySelectorAll('[data-ref]')) refs[ref.dataset.ref] = ref;
      let open = readOpen();

      const setOpen = (nextOpen, persist = true) => {
        open = nextOpen;
        refs.body.hidden = !open;
        refs.header.setAttribute('aria-expanded', String(open));
        refs.toggle.innerHTML = icon(open ? 'chevronDown' : 'chevronRight', { size: 13 });
        if (persist) {
          try { localStorage.setItem(OPEN_KEY, open ? '1' : '0'); } catch { /* localStorage puede estar bloqueado. */ }
        }
      };

      refs.header.addEventListener('click', (event) => {
        if (event.target.closest?.('[data-help]')) return;
        setOpen(!open);
      });
      refs.header.addEventListener('keydown', (event) => {
        if (event.target !== refs.header) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        setOpen(!open);
      });

      refs.omp.addEventListener('click', async () => {
        refs.omp.disabled = true;
        try {
          const response = await fetch('/api/terminal/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cwd: 'lab-omp', agent: 'omp', title: 'omp:lab-omp' }),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error || t('lab.ompError', 'No se pudo abrir omp.'));
          if (!data.session?.id) throw new Error(t('lab.ompError', 'No se pudo abrir omp.'));
          window.open(`/?focus=${encodeURIComponent(data.session.id)}`, '_blank', 'noopener');
          bus?.dispatchEvent?.(new Event('sessions-changed'));
        } catch (error) {
          void dialog.alertDialog({
            title: t('lab.errorTitle', 'Laboratorio'),
            message: error?.message || t('lab.ompError', 'No se pudo abrir omp.'),
          });
        } finally {
          refs.omp.disabled = false;
        }
      });

      refs.orca.addEventListener('click', async () => {
        const w = window.open('', '_blank');
        try {
          if (!w) throw new Error(t('lab.orcaPopupError', 'El navegador bloqueó la ventana de Orca. Permití ventanas emergentes e intentá de nuevo.'));
          const response = await fetch('/api/lab/orca');
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error || t('lab.orcaError', 'No se pudo abrir Orca.'));
          const password = typeof data.password === 'string' ? data.password : '';
          if (!password) throw new Error(t('lab.orcaError', 'No se pudo abrir Orca.'));
          w.opener = null;
          w.location.href = `http://${location.hostname}:6080/vnc.html?autoconnect=true&resize=scale#password=${encodeURIComponent(password)}`;
        } catch (error) {
          if (w && !w.closed) w.close();
          void dialog.alertDialog({
            title: t('lab.errorTitle', 'Laboratorio'),
            message: error?.message || t('lab.orcaError', 'No se pudo abrir Orca.'),
          });
        }
      });

      setOpen(open, false);
      el.hidden = false;
    }).catch(() => {
      el.hidden = true;
    });
  },
};
