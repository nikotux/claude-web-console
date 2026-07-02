// modules/tolkien/tolkien.js — panel del proyecto principal (git).
//   - Sección del sidebar: estado (SHA + al día/N detrás) + acciones rápidas
//     (terminal / Claude Code / explorar en el Gestor de Archivos).
//   - Pie fijo: versión (SHA), si está actualizada, y botón actualizar.

let els = {};
let current = null;      // último status
let busy = false;

function upToDate(st) { return !!st && st.behind === 0; }

function stateText(st) {
  if (!st) return '…';
  let s;
  if (st.behind > 0) s = `${st.behind} detrás`;
  else if (st.ahead > 0) s = `${st.ahead} adelante`;
  else s = 'al día';
  if (st.dirty) s += ` · ${st.dirtyCount} cambios`;
  return s;
}

function render() {
  const st = current;
  const head = st ? `#${st.head}` : '#—';
  const cls = upToDate(st) ? 'ok' : 'behind';

  if (els.chip) {
    els.chip.className = `tk-chip ${cls}`;
    els.chip.textContent = st ? (upToDate(st) ? '✓' : `↓${st.behind}`) : '';
  }

  if (els.footer) {
    els.footer.innerHTML = `
      <div class="tk-foot-row">
        <span class="tk-name">${st?.name || 'tolkien'}</span>
        <span class="tk-head">${head}</span>
      </div>
      <div class="tk-foot-row">
        <span class="tk-state ${cls}">${stateText(st)}</span>
        <button class="tk-update" id="tk-foot-update"${busy ? ' disabled' : ''}>${busy ? '…' : 'Actualizar'}</button>
      </div>`;
    els.footer.querySelector('#tk-foot-update')?.addEventListener('click', doUpdate);
  }

  // Botones de la sección
  for (const b of document.querySelectorAll('#tk-update, #tk-refresh')) b.disabled = busy;
}

async function loadStatus() {
  try { current = await (await fetch('/api/tolkien/status')).json(); render(); }
  catch { /* noop */ }
}

export async function refreshTolkien() {
  if (busy) return;
  busy = true; render();
  try {
    const data = await (await fetch('/api/tolkien/fetch', { method: 'POST' })).json();
    if (data.status) current = data.status;
    if (data.error) console.warn('[tolkien] fetch:', data.error);
  } catch { /* noop */ } finally { busy = false; render(); }
}

async function doUpdate() {
  if (busy) return;
  if (!confirm('¿Actualizar tolkien desde GitHub?\n\nstash → pull (ff-only) → stash pop.\nTus cambios locales quedan a salvo en el stash si algo falla.')) return;
  busy = true; render();
  try {
    const data = await (await fetch('/api/tolkien/update', { method: 'POST' })).json();
    if (data.status) current = data.status;
    if (data.error) {
      alert('No se pudo actualizar:\n' + data.error + '\n\n' + fmtLog(data.log));
    } else if (data.popConflict) {
      alert('Se actualizó, pero hubo CONFLICTO al reaplicar tus cambios.\nQuedaron guardados en el stash (git stash list) para que los resuelvas a mano.\n\n' + fmtLog(data.log));
    } else {
      alert('Repositorio actualizado.' + (data.stashed ? '\nTus cambios locales fueron reaplicados.' : '') + '\n\n' + fmtLog(data.log));
    }
  } catch {
    alert('No se pudo actualizar (error de red o del servidor).');
  } finally {
    busy = false; render();
  }
}

function fmtLog(log) {
  if (!Array.isArray(log)) return '';
  return log.map((s) => `• ${s.step}: ${(s.out || '').split('\n')[0] || '(ok)'}`).join('\n');
}

export async function initTolkien({ openTerminal }) {
  els.chip = document.getElementById('tk-status');
  els.footer = document.getElementById('tolkien-mini');

  document.getElementById('tk-update')?.addEventListener('click', (e) => { e.stopPropagation(); doUpdate(); });
  document.getElementById('tk-refresh')?.addEventListener('click', (e) => { e.stopPropagation(); refreshTolkien(); });

  await loadStatus(); // versión local inmediata (para el pie)
  const rel = current?.rel || 'tolkien';

  // Acciones rápidas del proyecto: terminal / Claude Code / explorar archivos.
  document.getElementById('tk-term')?.addEventListener('click', () => openTerminal?.({ cwd: rel }));
  document.getElementById('tk-claude')?.addEventListener('click', () => openTerminal?.({ cwd: rel, runClaude: true }));
  const explore = document.getElementById('tk-explore');
  if (explore) explore.href = `/archivos?path=${encodeURIComponent(rel)}`;

  refreshTolkien(); // compara con remoto (para saber si está actualizada)

  // Chequeo periódico cada 5 min (pausado con la pestaña en segundo plano).
  const CHECK_MS = 5 * 60 * 1000;
  setInterval(() => { if (!document.hidden) refreshTolkien(); }, CHECK_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshTolkien(); });
}
