#!/usr/bin/env node
// Puente mínimo entre Mi Consola y los runners internos de Tolkien.
// Los imports pesados son dinámicos: el guard de DB/Redis corre ANTES de
// cargar Prisma, Redis o cualquier runner que pueda abrir conexiones.

const DB_MODULE = '/home/nmosquera/tolkien/packages/db/dist/index.js';
const SHARED_MODULE = '/home/nmosquera/tolkien/packages/shared/dist/index.js';
const ZOHO_MODULE = '/home/nmosquera/tolkien/packages/zoho/dist/index.js';
const DESK_RUNNER = '/home/nmosquera/tolkien/apps/worker/src/runners/desk-sync.ts';
const DESK_SOURCE_RUNNER = '/home/nmosquera/tolkien/apps/worker/src/runners/desk-source-sync.ts';
const FORBIDDEN_ENV = [
  'REDIS_URL',
  'WATCHDOG_REDIS_URL',
  'TOLKIEN_WORKER_DATABASE_URL',
  'TOLKIEN_CONSOLE_DATABASE_URL',
  'TOLKIEN_API_DATABASE_URL',
  'TOLKIEN_MIGRATION_DATABASE_URL',
];

type FinalResult = {
  ok: boolean;
  step: string;
  summary: Record<string, unknown>;
};

function guardEnvironment(): string | null {
  const raw = process.env.DATABASE_URL?.trim();
  if (!raw) return 'DATABASE_URL no está definida.';
  let url: URL;
  try { url = new URL(raw); }
  catch { return 'DATABASE_URL no es una URL válida.'; }
  const dbName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!['localhost', '127.0.0.1'].includes(url.hostname)) {
    return 'DATABASE_URL debe apuntar a localhost o 127.0.0.1.';
  }
  if (url.port !== '5435') return 'DATABASE_URL debe usar el puerto local 5435.';
  if (!/^tolkien_[a-z0-9_]+$/.test(dbName)) {
    return 'DATABASE_URL debe apuntar a una DB local con nombre tolkien_*.';
  }
  const present = FORBIDDEN_ENV.filter((name) => process.env[name] !== undefined);
  if (present.length > 0) return `Variables prohibidas presentes: ${present.join(', ')}.`;
  return null;
}

function printFinal(result: FinalResult): void {
  console.log(JSON.stringify(result));
}

function safeError(value: unknown): string {
  let message = value instanceof Error ? value.message : String(value);
  const secrets = [
    process.env.DATABASE_URL,
    process.env.ZOHO_CLIENT_ID,
    process.env.ZOHO_CLIENT_SECRET,
    process.env.ZOHO_REFRESH_TOKEN,
  ].filter(Boolean) as string[];
  try {
    const dbUrl = new URL(process.env.DATABASE_URL || '');
    if (dbUrl.password) secrets.push(dbUrl.password);
  } catch { /* el guard ya reporta la URL inválida sin imprimirla */ }
  for (const secret of secrets) message = message.replaceAll(secret, '***');
  return message.replace(/\s+/g, ' ').trim().slice(0, 300);
}

function requestedEmails(): string[] {
  return [...new Set(String(process.env.CWC_IT_EMAILS || '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean))];
}

async function ensureDevTeam(): Promise<Record<string, unknown>> {
  const { getDb, listTeams, createTeam, addTeamMember } = await import(DB_MODULE);
  const db = getDb('worker');
  const emails = requestedEmails();
  if (emails.length === 0) throw new Error('CWC_IT_EMAILS no contiene emails.');
  const ctx = { actor: 'cwc:tolkien-sources', source: 'console' };
  const teams = await listTeams(db);
  let team = teams.find((candidate: { slug: string }) => candidate.slug === 'dev');
  let created = false;
  if (!team) {
    const result = await createTeam(db, { slug: 'dev', name: 'Dev team' }, ctx);
    if (!result.ok) throw new Error(`no se pudo crear el equipo dev: ${result.error}`);
    team = { ...result.value, updatedAt: '', members: [] };
    created = true;
  }

  const employees = await db.employee.findMany({
    where: { isActive: true, email: { in: emails, mode: 'insensitive' } },
    select: { id: true, email: true },
  });
  const byEmail = new Map(employees.map((employee: { id: string; email: string }) => [
    employee.email.trim().toLowerCase(), employee,
  ]));
  const members = new Set((team.members || []).map((member: { email: string }) => member.email.trim().toLowerCase()));
  const skippedEmails = emails.filter((email) => !byEmail.has(email));
  let added = 0;
  for (const email of emails) {
    const employee = byEmail.get(email);
    if (!employee || members.has(email)) continue;
    const result = await addTeamMember(db, { teamId: team.id, employeeId: employee.id }, ctx);
    if (!result.ok && result.code !== 'conflict') {
      throw new Error(`no se pudo agregar ${email} al equipo dev: ${result.error}`);
    }
    if (result.ok) added += 1;
    members.add(email);
  }
  return {
    slug: 'dev',
    name: team.name,
    created,
    added,
    members: members.size,
    skippedEmails,
  };
}

async function deskRuntime() {
  const [{ getDb }, { createLogger }, { createZohoClient }] = await Promise.all([
    import(DB_MODULE),
    import(SHARED_MODULE),
    import(ZOHO_MODULE),
  ]);
  const db = getDb('worker');
  const logger = createLogger({
    service: 'cwc-tolkien-glue',
    env: process.env.NODE_ENV || 'development',
    level: process.env.LOG_LEVEL || 'info',
  });
  const zoho = createZohoClient({
    env: {
      ZOHO_CLIENT_ID: process.env.ZOHO_CLIENT_ID,
      ZOHO_CLIENT_SECRET: process.env.ZOHO_CLIENT_SECRET,
      ZOHO_REFRESH_TOKEN: process.env.ZOHO_REFRESH_TOKEN,
      ZOHO_ACCOUNTS_HOST: process.env.ZOHO_ACCOUNTS_HOST || 'https://accounts.zoho.com',
    },
    logger,
  });
  return { db, logger, zoho };
}

async function syncDeskCatalogue(): Promise<Record<string, unknown>> {
  const [{ runDeskSync }, { db, logger, zoho }] = await Promise.all([
    import(DESK_RUNNER),
    deskRuntime(),
  ]);
  const catalogue = await runDeskSync({
    db,
    zoho,
    logger,
    dryRun: false,
    tolkienDepartmentId: process.env.ZOHO_DESK_TOLKIEN_DEPARTMENT_ID || undefined,
    mordorDepartmentId: process.env.ZOHO_DESK_MORDOR_DEPARTMENT_ID || undefined,
  });
  return {
    listed: catalogue.listed,
    upserts: catalogue.upserts,
    open: catalogue.open,
    sourceComplete: catalogue.sourceComplete,
  };
}

async function syncDeskSource(): Promise<Record<string, unknown>> {
  const [{ runDeskSourceSync }, { db, logger, zoho }] = await Promise.all([
    import(DESK_SOURCE_RUNNER),
    deskRuntime(),
  ]);
  const source = await runDeskSourceSync({ db, zoho, logger, dryRun: false });
  return {
    eligible: source.eligible,
    selected: source.selected,
    skipped: source.skipped,
    synced: source.synced,
    failed: source.failed,
    importedUpdates: source.importedUpdates,
    importedAttachments: source.importedAttachments,
  };
}

async function syncDesk(): Promise<Record<string, unknown>> {
  const catalogue = await syncDeskCatalogue();
  const source = await syncDeskSource();
  return { catalogue, source };
}

async function main(): Promise<void> {
  const guardError = guardEnvironment();
  if (guardError) {
    console.error(`[guard] ${guardError}`);
    printFinal({ ok: false, step: 'guard', summary: { error: guardError } });
    process.exitCode = 2;
    return;
  }

  const step = process.argv[2] || '';
  const runners: Record<string, () => Promise<Record<string, unknown>>> = {
    team: ensureDevTeam,
    'desk-catalogue': syncDeskCatalogue,
    'desk-source': syncDeskSource,
    desk: syncDesk,
  };
  const runner = runners[step];
  if (!runner) {
    printFinal({ ok: false, step: 'usage', summary: { error: 'Uso: cwc-tolkien-glue.mts team|desk-catalogue|desk-source|desk' } });
    process.exitCode = 1;
    return;
  }

  let disconnectDb: (() => Promise<void>) | null = null;
  let finalResult: FinalResult;
  try {
    ({ disconnectDb } = await import(DB_MODULE));
    const summary = await runner();
    finalResult = { ok: true, step, summary };
  } catch (error) {
    finalResult = { ok: false, step, summary: { error: safeError(error) } };
    process.exitCode = 1;
  } finally {
    if (disconnectDb) {
      try { await disconnectDb(); }
      catch (error) {
        finalResult = { ok: false, step, summary: { error: `no se pudo desconectar la DB: ${safeError(error)}` } };
        process.exitCode = 1;
      }
    }
  }
  printFinal(finalResult!);
}

await main();
