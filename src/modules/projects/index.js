// modules/projects/index.js — contexto (CLAUDE.md) y memorias editables de
// los proyectos con los que trabaja Claude Code desde acá: el proyecto
// trackeado (Tolkien) Y esta propia consola. Alimenta la pestaña "Proyectos"
// del menú Sistema.
//
// PROJECTS es la única lista de proyectos soportados — agregar uno nuevo es
// sumar una entrada acá (clave estable, no expone rutas crudas del cliente).
//
// HTTP (patrón admin-gating igual al contexto editable de bugfixes: GET
// abierto a cualquier autenticado, POST admin):
//   GET  /api/projects                                -> [{key, name, dir}]
//   GET  /api/projects/:key/context                   -> { content } (CLAUDE.md real)
//   POST /api/projects/:key/context {content}         -> guarda (admin)
//   GET  /api/projects/:key/memory                     -> { indexExists, index, files[] }
//   GET  /api/projects/:key/memory/index               -> { content } (MEMORY.md crudo)
//   POST /api/projects/:key/memory/index {content}      -> guarda el índice (admin)
//   GET  /api/projects/:key/memory/note/:file           -> { file, content }
//   POST /api/projects/:key/memory/note/:file {content} -> guarda la nota (admin)
//
// Nota (regla 4 de CLAUDE.md): esto SÍ toca archivos fuera del propio módulo
// (CLAUDE.md y las memorias de Tolkien Y de esta consola) — es el propósito
// explícito de esta pantalla, no un efecto colateral. Ver excepción
// documentada en CLAUDE.md.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../../core/config.js';
import { isAdmin } from '../../core/auth.js';
import {
  readContext, writeContext, listMemory, readNote, writeNote, readIndex, writeIndex,
  listContextSections, readContextSection, writeContextSection,
} from './memory.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONSOLE_DIR = path.resolve(__dirname, '..', '..', '..'); // raíz de este mismo repo

const displayName = (n) => (n ? n[0].toUpperCase() + n.slice(1) : 'Tolkien');

const PROJECTS = {
  tolkien: { name: displayName(config.projectName), dir: config.projectDir },
  console: { name: 'Consola (este proyecto)', dir: CONSOLE_DIR },
};

function project(req, res) {
  const p = PROJECTS[req.params.key];
  if (!p) { res.status(404).json({ error: `Proyecto desconocido: ${req.params.key}` }); return null; }
  return p;
}

// ===== Análisis con IA de un cambio de contexto (guardián del CLAUDE.md) =====
// Compara la sección ANTERIOR vs la NUEVA con una corrida corta del SDK
// (haiku, 1 turno, CERO herramientas: las dos capas de la regla 6 acá
// directamente deniegan TODO — el análisis solo necesita el prompt) y
// devuelve un veredicto estructurado: qué se elimina / agrega / modifica y
// el nivel de riesgo. La UI lo muestra en un modal de confirmación FORZADA
// antes de escribir el archivo. Si esta corrida falla, la UI cae a un diff
// local igualmente forzado (esto nunca bloquea el guardado consciente).
const ANALYZE_TIMEOUT_MS = 60 * 1000;

function analyzePrompt(before, after) {
  return [
    'Sos el guardián de un CLAUDE.md: la guía operativa que una IA lee antes de',
    'trabajar en un proyecto (reglas duras, prohibiciones, invariantes, mapa).',
    'Compará la versión ANTERIOR y la NUEVA de UNA sección y respondé ÚNICAMENTE',
    'con un bloque ```json así:',
    '{',
    '  "removed":  ["cada regla/prohibición/dato operativo que DESAPARECE"],',
    '  "added":    ["qué se agrega"],',
    '  "modified": ["qué cambia de sentido o se debilita"],',
    '  "risk":     "ok" | "atencion" | "critico",',
    '  "riskWhy":  "1-2 líneas: por qué ese nivel",',
    '  "summary":  "1-2 líneas en criollo: qué hace este cambio"',
    '}',
    'Criterio de risk: "critico" = borra o debilita reglas duras, guardas de',
    'seguridad o invariantes (aunque sea de forma sutil); "atencion" = elimina',
    'contenido operativo o cambia semántica; "ok" = agrega/mejora/reformula sin',
    'pérdida. Arrays vacíos si no aplica. Sé específico y breve.',
    '',
    '=== SECCIÓN ANTERIOR ===',
    before || '(sección nueva: no había contenido)',
    '',
    '=== SECCIÓN NUEVA ===',
    after || '(la sección queda VACÍA: se elimina todo su contenido)',
  ].join('\n');
}

function parseAnalysis(text) {
  const fences = [...String(text || '').matchAll(/```json\s*([\s\S]*?)```/gi)];
  const raw = fences.length ? fences[fences.length - 1][1] : (String(text || '').match(/\{[\s\S]*\}/) || [])[0];
  if (!raw) return null;
  let o;
  try { o = JSON.parse(raw); } catch { return null; }
  const arr = (x) => (Array.isArray(x) ? x.map((s) => String(s).slice(0, 300)).slice(0, 20) : []);
  return {
    removed: arr(o.removed),
    added: arr(o.added),
    modified: arr(o.modified),
    risk: ['ok', 'atencion', 'critico'].includes(o.risk) ? o.risk : 'atencion',
    riskWhy: String(o.riskWhy || '').slice(0, 500),
    summary: String(o.summary || '').slice(0, 500),
  };
}

async function analyzeChange(before, after) {
  const deny = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'El análisis de cambios no usa herramientas.',
    },
  };
  const q = query({
    prompt: analyzePrompt(before, after),
    options: {
      cwd: CONSOLE_DIR,
      settingSources: [], // nada de settings/skills: análisis puro de texto
      model: 'haiku',     // rápido y barato; el criterio viene entero en el prompt
      maxTurns: 1,
      permissionMode: 'default',
      hooks: { PreToolUse: [{ hooks: [async () => deny] }] },
      canUseTool: async () => ({ behavior: 'deny', message: 'Sin herramientas.' }),
    },
  });
  let text = '';
  let timer = null;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('El análisis tardó demasiado.')), ANALYZE_TIMEOUT_MS); });
  const pump = (async () => {
    for await (const m of q) {
      if (m.type === 'assistant') {
        for (const b of m.message?.content || []) if (b.type === 'text' && b.text) text += `${b.text}\n`;
      } else if (m.type === 'result') break;
    }
  })();
  try {
    await Promise.race([pump, timeout]);
  } finally {
    clearTimeout(timer);
    try { Promise.resolve(q.close?.()).catch(() => {}); } catch { /* noop */ }
  }
  const analysis = parseAnalysis(text);
  if (!analysis) throw new Error('No se pudo interpretar el análisis.');
  return analysis;
}

export default {
  name: 'projects',

  registerHttp(router) {
    const r = express.Router();

    r.get('/', (req, res) => {
      res.json(Object.entries(PROJECTS).map(([key, p]) => ({ key, name: p.name, dir: p.dir })));
    });

    // ===== Contexto (CLAUDE.md) =====
    r.get('/:key/context', (req, res) => {
      const p = project(req, res); if (!p) return;
      try { res.json({ content: readContext(p.dir) }); }
      catch { res.status(500).json({ error: 'No se pudo leer el contexto.' }); }
    });

    r.post('/:key/context', (req, res) => {
      const p = project(req, res); if (!p) return;
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      try {
        writeContext(p.dir, String(req.body?.content ?? ''));
        res.json({ ok: true });
      } catch {
        res.status(500).json({ error: 'No se pudo guardar el contexto.' });
      }
    });

    // ===== Contexto por SECCIONES (la UI edita fragmentos, nunca el archivo
    // entero — integridad: un descuido arruina UNA sección como mucho) =====
    r.get('/:key/context/sections', (req, res) => {
      const p = project(req, res); if (!p) return;
      try { res.json(listContextSections(p.dir)); }
      catch { res.status(500).json({ error: 'No se pudo leer el contexto.' }); }
    });

    r.get('/:key/context/section/:i', (req, res) => {
      const p = project(req, res); if (!p) return;
      try { res.json(readContextSection(p.dir, req.params.i)); }
      catch (e) { res.status(400).json({ error: e.message || 'No se pudo leer la sección.' }); }
    });

    r.post('/:key/context/section/:i', (req, res) => {
      const p = project(req, res); if (!p) return;
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      try {
        writeContextSection(p.dir, req.params.i, req.body?.hash, String(req.body?.content ?? ''));
        res.json({ ok: true });
      } catch (e) {
        res.status(e.conflict ? 409 : 500).json({ error: e.message || 'No se pudo guardar la sección.' });
      }
    });

    // Analiza con IA el cambio propuesto sobre una sección ANTES de guardar
    // (admin: consume tokens). Valida el hash primero: si la sección ya
    // cambió, 409 sin gastar tokens. NO escribe nada.
    r.post('/:key/context/section/:i/analyze', async (req, res) => {
      const p = project(req, res); if (!p) return;
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      try {
        const sec = readContextSection(p.dir, req.params.i);
        if (sec.hash !== String(req.body?.hash || '')) {
          return res.status(409).json({ error: 'El contexto cambió desde que abriste esta sección. Recargá y reintentá.' });
        }
        const analysis = await analyzeChange(sec.text, String(req.body?.content ?? ''));
        res.json({ ok: true, analysis });
      } catch (e) {
        res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
      }
    });

    // ===== Memorias (MEMORY.md + notas individuales) =====
    r.get('/:key/memory', (req, res) => {
      const p = project(req, res); if (!p) return;
      try { res.json(listMemory(p.dir)); }
      catch { res.status(500).json({ error: 'No se pudo leer la memoria.' }); }
    });

    r.get('/:key/memory/index', (req, res) => {
      const p = project(req, res); if (!p) return;
      try { res.json({ content: readIndex(p.dir) }); }
      catch { res.status(500).json({ error: 'No se pudo leer el índice.' }); }
    });

    r.post('/:key/memory/index', (req, res) => {
      const p = project(req, res); if (!p) return;
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      try {
        writeIndex(p.dir, String(req.body?.content ?? ''));
        res.json({ ok: true });
      } catch {
        res.status(500).json({ error: 'No se pudo guardar el índice.' });
      }
    });

    r.get('/:key/memory/note/:file', (req, res) => {
      const p = project(req, res); if (!p) return;
      try { res.json({ file: req.params.file, content: readNote(p.dir, req.params.file) }); }
      catch (e) { res.status(400).json({ error: e.message || 'No se pudo leer la nota.' }); }
    });

    r.post('/:key/memory/note/:file', (req, res) => {
      const p = project(req, res); if (!p) return;
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      try {
        writeNote(p.dir, req.params.file, String(req.body?.content ?? ''));
        res.json({ ok: true });
      } catch (e) {
        res.status(400).json({ error: e.message || 'No se pudo guardar la nota.' });
      }
    });

    router.use('/projects', r);
  },
};
