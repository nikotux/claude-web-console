#!/usr/bin/env node
// bin/cwc-forbidden-override.js — CAMINO DE OVERRIDE CONSCIENTE del gate de
// acciones prohibidas por lección (M5, PLAN-1934). Un gate ciego se vuelve un
// obstáculo: acá se registra POR QUÉ se saltea una lección, para UNA sola tool
// call y por unos minutos. Determinístico, 0 tokens. Config-free a propósito (no
// importa core/config.js: tiene que correr desde cualquier cwd y sin .env).
//
// Uso:
//   cwc-forbidden-override.js <reglaId> "<motivo>" [--minutes N] [--chat <chatId>] [--by <quien>]
//   cwc-forbidden-override.js --list
// Exit: 0 ok · 1 error de uso/escritura · 2 regla desconocida.
import {
  listForbiddenActions, listForbiddenOverrides, grantForbiddenOverride, OVERRIDE_DEFAULT_MINUTES,
} from '../src/core/forbidden-actions.js';

const argv = process.argv.slice(2);
function flag(name) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return null;
  const v = argv[i + 1];
  return (typeof v === 'string' && !v.startsWith('--')) ? v : null;
}
const positional = [];
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a.startsWith('--')) { if (['minutes', 'chat', 'by'].includes(a.slice(2))) i += 1; continue; }
  positional.push(a);
}

if (argv.includes('--list') || argv.includes('-l') || !positional.length) {
  console.log('🔒 Reglas prohibitivas activas (hook PreToolUse, inmune a bypassPermissions):\n');
  for (const r of listForbiddenActions()) {
    console.log(`  ${r.id}  [${r.origin}]  ${r.title}`);
    if (r.lesson) console.log(`      origen: ${r.lesson}`);
    if (r.hint) console.log(`      en vez de eso: ${r.hint}`);
  }
  const ovs = listForbiddenOverrides(10);
  console.log(`\n📝 Últimos overrides registrados (${ovs.length}):`);
  for (const g of ovs) {
    const est = g.consumedAt ? 'usado' : (g.expiresAt > Date.now() ? 'vigente' : 'vencido');
    console.log(`  ${g.id}  ${g.ruleId}  [${est}]  ${new Date(g.at).toLocaleString('es-CO')}  — ${g.motivo}`);
  }
  if (!positional.length && !argv.includes('--list') && !argv.includes('-l')) {
    console.log('\nUso: cwc-forbidden-override.js <reglaId> "<motivo>" [--minutes N] [--chat <chatId>] [--by <quien>]');
  }
  process.exit(0);
}

const [ruleId, ...motivoParts] = positional;
const motivo = motivoParts.join(' ');
try {
  const grant = grantForbiddenOverride({
    ruleId,
    motivo,
    by: flag('by'),
    chatId: flag('chat'),
    minutes: flag('minutes') ? Number(flag('minutes')) : OVERRIDE_DEFAULT_MINUTES,
  });
  const mins = Math.round((grant.expiresAt - grant.at) / 60000);
  console.log(`✅ Override registrado: ${grant.id} para la regla "${grant.ruleId}".`);
  console.log(`   Vale UNA sola tool call y vence en ${mins} min (${new Date(grant.expiresAt).toLocaleString('es-CO')}).`);
  console.log(`   Motivo: ${grant.motivo}`);
  process.exit(0);
} catch (e) {
  console.error(`❌ ${e?.message || e}`);
  if (e?.code === 'unknown_rule') {
    console.error('   Reglas disponibles:', listForbiddenActions().map((r) => r.id).join(', '));
    process.exit(2);
  }
  process.exit(1);
}
