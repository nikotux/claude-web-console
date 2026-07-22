import dotenv from 'dotenv';
dotenv.config({ path: '/home/nmosquera/claude-web-console/.env', quiet: true });
const { deskCtx } = await import('/home/nmosquera/claude-web-console/src/core/zoho-desk-client.js');
const { hostUser } = await import('/home/nmosquera/claude-web-console/src/core/user-space.js');
const ctx = await deskCtx(hostUser());
const base = `https://desk.zoho.${ctx.dc}/api/v1`;
const strip = s => String(s||'').replace(/<[^>]+>/g,' ').replace(/&quot;/g,'"').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();
let errs=0;
for (const pair of process.argv.slice(2)) {
  const [num,id] = pair.split(':');
  const tr = await fetch(`${base}/tickets/${id}`, { headers: ctx.headers });
  if(!tr.ok){ console.log(`### TICKET #${num} — ERROR HTTP ${tr.status}`); errs++; continue; }
  const t = await tr.json();
  console.log('='.repeat(70));
  console.log(`### TICKET #${num} | ${t.subject}`);
  console.log(`ESTADO: ${t.status} | VENCE: ${(t.dueDate||'sin fecha').slice(0,10)} | PRIORIDAD: ${t.priority}`);
  console.log(`DESCRIPCION: ${strip(t.description)}`);
  const cr = await fetch(`${base}/tickets/${id}/comments?limit=30&sortBy=commentedTime`, { headers: ctx.headers });
  if(!cr.ok){ console.log(`COMENTARIOS: ERROR HTTP ${cr.status}`); errs++; continue; }
  const cj = await cr.json();
  const cs = cj.data||[];
  console.log(`COMENTARIOS (${cs.length}):`);
  for (const c of cs) console.log(`  [${(c.commentedTime||'').slice(0,10)}] ${strip(c.content).slice(0,900)}`);
}
console.error('errores de lectura:', errs);
