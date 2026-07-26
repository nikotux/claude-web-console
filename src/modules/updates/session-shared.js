// modules/updates/session-shared.js — genera el prompt de arranque de la
// SESIÓN DE ACTUALIZACIÓN: el chat que conduce el update con Bash y reemplaza
// al runner ciego en el camino supervisado. Es determinístico y consume 0
// tokens: solo formatea el censo y el plan ya calculados por shared.js y
// orchestrate-shared.js.
import { riskKey } from './analyze-shared.js';
import { planActionCount } from './orchestrate-shared.js';

function cell(value) {
  return String(value ?? '—')
    .replace(/\r?\n/g, '<br>')
    .replace(/\|/g, '\\|');
}

function table(headers, rows) {
  if (!rows.length) return '';
  return [
    `| ${headers.map(cell).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ].join('\n');
}

function itemName(item) {
  if (typeof item === 'string') return item;
  return item?.name || item?.id || item?.model || item?.key || JSON.stringify(item);
}

function manageableLabel(value) {
  if (value === true) return 'sí';
  if (value === false) return 'no';
  return 'no determinado';
}

function cliRows(cli) {
  if (!cli || typeof cli !== 'object' || Array.isArray(cli) || !Object.keys(cli).length) return [];
  return [[
    cli.current,
    cli.latest,
    cli.resolvedPath || cli.path,
    manageableLabel(cli.manageable),
  ]];
}

function missingModelsRows(models) {
  const rows = [];
  for (const [cli, source, codeFile] of [
    ['Codex', models?.codex?.missing, 'src/modules/chat/codex-models.js'],
    ['Claude', models?.claude?.missing, 'src/core/claude-model.js'],
  ]) {
    for (const model of Array.isArray(source) ? source : []) {
      rows.push([cli, itemName(model), codeFile]);
    }
  }
  return rows;
}

function mcpRows(mcps) {
  if (Array.isArray(mcps)) {
    return mcps.map((mcp) => [
      itemName(mcp),
      typeof mcp === 'object' ? (mcp.status ?? mcp.state ?? mcp.enabled ?? '—') : '—',
    ]);
  }
  if (!mcps || typeof mcps !== 'object') return [];
  return Object.entries(mcps).map(([name, value]) => [
    name,
    typeof value === 'object' && value !== null
      ? (value.status ?? value.state ?? value.enabled ?? '—')
      : value,
  ]);
}

function serviceRows(services) {
  if (!Array.isArray(services)) return [];
  return services.map((service) => [
    itemName(service),
    service?.current,
    service?.latest,
    service?.upToDate === true
      ? 'al día'
      : service?.upToDate === false
        ? 'hay actualización'
        : (service?.status ?? service?.state ?? service?.note),
  ]);
}

function riskVerdicts(risk) {
  if (!risk || typeof risk !== 'object') return {};
  return risk.verdicts && typeof risk.verdicts === 'object' ? risk.verdicts : risk;
}

function planLines(plan) {
  const inRange = Array.isArray(plan?.inRange) ? plan.inRange : [];
  const majorsToApply = Array.isArray(plan?.majorsToApply) ? plan.majorsToApply : [];
  const aptNames = Array.isArray(plan?.apt?.pkgs) ? plan.apt.pkgs : [];

  return [
    plan?.vulnFix
      ? '1. Ejecutar `npm audit fix` (sin `--force`).'
      : '1. Vulnerabilidades: no hay un `npm audit fix` seguro pendiente.',
    inRange.length
      ? `2. Actualizar librerías dentro del rango declarado:\n${inRange.map((lib) => `   - \`npm install ${lib?.name}@${lib?.to}\` (${lib?.from ?? '—'} → ${lib?.to ?? '—'})`).join('\n')}`
      : '2. Librerías in-range: no hay acciones pendientes.',
    majorsToApply.length
      ? `3. Aplicar los saltos mayores que Niko tildó:\n${majorsToApply.map((lib) => `   - \`npm install ${lib?.name}@${lib?.to}\` (${lib?.from ?? '—'} → ${lib?.to ?? '—'})`).join('\n')}`
      : '3. Saltos mayores elegidos para aplicar: ninguno.',
    plan?.claudeCli
      ? `4. Ejecutar \`claude update\` (${plan.claudeCli?.from ?? '—'} → ${plan.claudeCli?.to ?? '—'}).`
      : '4. Claude CLI: no hay una acción manejable pendiente.',
    plan?.apt
      ? `5. Ejecutar \`sudo -n apt-get update && sudo -n apt-get -y upgrade\` (${plan.apt?.count ?? aptNames.length} paquetes: ${aptNames.join(', ') || 'sin nombres en el censo'}).`
      : '5. Sistema operativo: no hay paquetes apt pendientes en el plan.',
  ];
}

// Función pura: no lee archivos, no ejecuta comandos y tolera censos viejos.
export function buildUpdateBriefing({ census = {}, plan = {}, risk = {} } = {}) {
  const actions = planActionCount(plan);
  const rawTitle = actions === 0
    ? '🧑‍✈️ Revisar actualizaciones'
    : `🧑‍✈️ Actualizar (${actions} acciones)`;
  const title = rawTitle.slice(0, 40);
  const parts = [
    '# 🧑‍✈️ Sesión de actualización de Mi Consola',
    '',
    '## Tu rol',
    '',
    'Sos la sesión que ACTUALIZA esta consola. Ejecutás vos, con Bash (`npm`, `apt`, `systemctl`, `claude`, `codex`). No hay runner haciéndolo por vos. Antes de tocar nada, explicale a Niko en una tabla qué vas a hacer y esperá su OK (él ya apretó el botón, pero el plan concreto se confirma acá). Después ejecutá de corrido.',
    '',
    '## 📋 Estado actual (censo determinístico, generado por la consola)',
    '',
  ];

  const libs = Array.isArray(census?.npm?.libs) ? census.npm.libs : [];
  if (libs.length) {
    parts.push(
      '### Librerías npm desactualizadas',
      '',
      table(
        ['Nombre', 'Instalada', 'Wanted (in-range)', 'Latest', 'Riesgo'],
        libs.map((lib) => [lib?.name, lib?.current, lib?.wanted, lib?.latest, lib?.risk]),
      ),
      '',
    );
  }

  const vulns = Array.isArray(census?.npm?.vulns) ? census.npm.vulns : [];
  if (vulns.length) {
    parts.push(
      '### Vulnerabilidades',
      '',
      table(
        ['Nombre', 'Severidad', 'Tiene fix'],
        vulns.map((vuln) => [vuln?.name, vuln?.severity, vuln?.fixAvailable ? 'sí' : 'no']),
      ),
      '',
    );
  }

  const vulnCounts = census?.npm?.vulnCounts;
  if (vulnCounts && typeof vulnCounts === 'object' && !Array.isArray(vulnCounts) && Object.keys(vulnCounts).length) {
    parts.push(
      '### Conteos de vulnerabilidades',
      '',
      table(
        ['Severidad', 'Cantidad'],
        Object.entries(vulnCounts).map(([severity, count]) => [severity, count]),
      ),
      '',
    );
  }

  const claudeRows = cliRows(census?.claudeCli);
  if (claudeRows.length) {
    parts.push(
      '### Claude CLI',
      '',
      table(['Actual', 'Latest', 'Path', 'Manejable'], claudeRows),
      '',
    );
    if (census.claudeCli.manageable === false) {
      parts.push('Claude CLI es una instalación root en `/usr/lib` y `claude update` NO puede con ella sin sudo.', '');
    }
  }

  const codexRows = cliRows(census?.codexCli);
  if (codexRows.length) {
    parts.push(
      '### Codex CLI',
      '',
      table(['Actual', 'Latest', 'Path', 'Manejable'], codexRows),
      '',
    );
  }

  const modelRows = missingModelsRows(census?.models);
  if (modelRows.length) {
    parts.push(
      '### Modelos ofrecidos por el CLI que faltan en la whitelist',
      '',
      table(['CLI', 'Modelo faltante', 'Whitelist de la consola'], modelRows),
      '',
      'Agregarlos es EDITAR CÓDIGO (`src/modules/chat/codex-models.js` para Codex, `src/core/claude-model.js` para Claude), no un `npm install`.',
      '',
    );
  }

  const mcps = mcpRows(census?.mcps);
  if (mcps.length) {
    parts.push('### MCPs', '', table(['Nombre', 'Estado'], mcps), '');
  }

  const aptPkgs = Array.isArray(census?.apt?.pkgs) ? census.apt.pkgs : [];
  if ((census?.apt?.count || 0) > 0 || aptPkgs.length) {
    parts.push(
      '### Sistema operativo',
      '',
      table(['Cantidad', 'Nombres'], [[
        census?.apt?.count ?? aptPkgs.length,
        aptPkgs.map(itemName).join(', ') || '—',
      ]]),
      '',
    );
  }

  const services = serviceRows(census?.services);
  if (services.length) {
    parts.push(
      '### Servicios',
      '',
      table(['Nombre', 'Actual', 'Latest', 'Estado'], services),
      '',
    );
  }

  parts.push(
    '## 🎯 Plan sugerido (calculado por la consola)',
    '',
    ...planLines(plan),
    '',
    'Esto es una SUGERENCIA: podés reordenar o saltear con criterio, explicando por qué.',
    '',
    '## ⚠️ Saltos mayores (requieren criterio)',
    '',
  );

  const majors = Array.isArray(plan?.majors) ? plan.majors : [];
  const verdicts = riskVerdicts(risk);
  if (majors.length) {
    parts.push(
      table(
        ['Paquete', 'Salto', 'Nivel IA', 'Confianza', 'Por qué', 'Breaking changes'],
        majors.map((major) => {
          const verdict = verdicts[riskKey(major?.name, major?.current, major?.latest)];
          return [
            major?.name,
            `${major?.current ?? '—'} → ${major?.latest ?? '—'}`,
            verdict?.level || 'sin veredicto',
            verdict?.confidence || '—',
            verdict?.why || '—',
            Array.isArray(verdict?.breakingChanges) && verdict.breakingChanges.length
              ? verdict.breakingChanges.join('<br>')
              : '—',
          ];
        }),
      ),
      '',
    );
  }

  const blocked = Array.isArray(plan?.majorsBlocked) ? plan.majorsBlocked : [];
  if (blocked.length) {
    parts.push(
      '### Saltos mayores bloqueados',
      '',
      ...blocked.map((major) => `- ${major?.name ?? '—'} (${major?.from ?? '—'} → ${major?.to ?? '—'}): ${major?.reason ?? 'sin motivo informado'}`),
      '',
    );
  }

  parts.push(
    'Un veredicto IA favorable INFORMA pero NO DECIDE: el 2026-07-24 `archiver@8` entró como 🟢 seguro/confianza alta y tumbó el server. Ningún salto mayor se aplica sin que Niko lo pida explícitamente en este chat.',
    '',
    '## 🔴 Reglas innegociables',
    '',
    '- JAMÁS `sudo reboot` / `shutdown` / reiniciar la MÁQUINA. Reiniciar el SERVICIO (`systemctl --user restart claude-web-console`) sí. Si `/var/run/reboot-required` existe, mencionalo como dato neutro y seguí.',
    '- `node --check` NO alcanza: parsea sintaxis pero no evalúa imports. Dos veces dejó pasar un crash-loop (`cookie` v2 renombró su export `parse`; `archiver` v8 pasó a ESM puro y perdió el default export). ANTES de reiniciar el servicio corré SIEMPRE la verificación de runtime real: `node -e "import(\'./src/core/registry.js\').then(()=>process.exit(0)).catch(e=>{console.error(e?.message||String(e));process.exit(1)})"` desde la raíz del repo. Si falla, NO reinicies.',
    '- Antes de reiniciar, avisá por interfono a las otras sesiones: `node bin/cwc-bus.js` (mirá su `--help`) o el canal que corresponda; y al terminar, avisá que pueden seguir.',
    '- El reinicio del servicio corta la interfaz web de Niko unos 10 segundos. Es ESPERADO: vos sos un chat-runner desacoplado y sobrevivís al reinicio (la unidad tiene `KillMode=process`). Seguí trabajando; el navegador se reengancha solo.',
    '- Si algo rompe: revert QUIRÚRGICO primero (`npm install paquete@versión-anterior` SOLO del que rompe), nunca `git checkout -- package.json` de entrada — el revert total se lleva puesto los updates que sí funcionaron.',
    '- Preferí ARREGLAR antes que revertir: si un paquete cambió su API (renombró un export, pasó a ESM), adaptá el import en el código de la consola y verificá. Así se resolvió `cookie` v2 (commit 10e5b7d) y `archiver` v8.',
    '- Tras aplicar updates, borrá la caché del censo: `rm -f ~/.cwc-data/updates-census.json` (si no, el panel sigue mostrando como pendiente lo ya aplicado).',
    '- No toques `.env`, `users.json`, `sessions.json`, `certs/`.',
    '',
    '## ✅ Al terminar',
    '',
    'Mostrá un resumen visual en una tabla de qué se aplicó, qué se saltó y qué quedó pendiente; informá el estado de `GET /api/health/checks`; y cerrá con la línea:',
    '',
    '🎾 Pelota: ...',
  );

  return { prompt: parts.join('\n'), title };
}
