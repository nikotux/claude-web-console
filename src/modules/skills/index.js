// modules/skills/index.js — pestaña "Skills" de ⚙ Sistema: censo de las skills
// de Claude Code (SKILL.md) cruzadas con los Playbooks de Pad del principal de
// la request. 0 tokens IA — todo determinístico (fs + HTTP plano ya cacheado
// por el cliente de Pad), mismo espíritu que core/inventory.js.
//
// Fuentes escaneadas: el host conserva Consola (este repo) + Tolkien
// (config.projectDir) + global; cada inquilino ve solo su global y su clon de
// Tolkien. Cada SKILL.md que termina con el pie "Fuente de verdad:
// `PLAYB-<n>`" se vincula al playbook correspondiente del Pad de ese principal
// (convención ya usada por module-scan/codex-verify/rutear/agrupar/orquestar).
// Un playbook `status:active` con `invocation_slug` que NINGÚN SKILL.md
// referencia queda listado aparte como CANDIDATO — coherente con MC-683
// ("solo promover a skill un playbook activo con invocation_slug; los draft
// o sin slug se gradúan antes").
//
// El módulo NO edita el contenido de ninguna skill ni de los playbooks. Sí
// instala/desinstala copias del catálogo de Mi Consola en el espacio global del
// propio principal: escribe solo bajo scope.claudeDir, con whitelist estricta
// del nombre y marcador de origen, sin cruzar datos ni pisar skills del usuario.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../core/config.js';
import { reqPadContext } from '../../core/pad-context.js';
import * as pad from '../../core/pad-service-client.js';
import { systemScopeFor } from '../../core/system-scope.js';
import {
  CATALOG_DIR,
  catalogStateFor,
  installSkill,
  parseFrontmatter,
  uninstallSkill,
} from './catalog.js';

export function skillSourcesFor(scope) {
  const sources = scope.isHost
    ? [
        { world: 'console', label: '🏠 Mi Consola', dir: CATALOG_DIR, scope: 'project' },
        { world: 'tolkien', label: '🌳 Tolkien', dir: path.join(config.projectDir || '', '.claude', 'skills'), scope: 'project' },
        { world: 'global', label: '🌐 Global (usuario)', dir: path.join(scope.claudeDir, 'skills'), scope: 'user' },
      ]
    : [
        { world: 'global', label: '🌐 Global (usuario)', dir: path.join(scope.claudeDir, 'skills'), scope: 'user' },
        { world: 'tolkien', label: '🌳 Tolkien', dir: path.join(scope.workspace, 'tolkien', '.claude', 'skills'), scope: 'project' },
      ];
  return sources.filter((source) => fs.existsSync(source.dir));
}

const PAD_REF_RE = /Fuente de verdad:\s*`(PLAYB-\d+)`/;

function readSkillDir({ world, label, dir, scope }, home) {
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const file = path.join(dir, name, 'SKILL.md');
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const fm = parseFrontmatter(raw);
    const padMatch = raw.match(PAD_REF_RE);
    const allowedTools = Array.isArray(fm['allowed-tools'])
      ? fm['allowed-tools']
      : (fm['allowed-tools'] ? [fm['allowed-tools']] : []);
    out.push({
      key: `${world}:${name}`,
      dirName: name,
      world,
      worldLabel: label,
      scope,
      name: fm.name || name,
      description: fm.description || '',
      argumentHint: fm['argument-hint'] || '',
      allowedTools,
      path: '~/' + path.relative(home, file),
      padRef: padMatch ? padMatch[1] : null,
      pad: null, // se completa abajo si hay match
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function parsePadFields(raw) {
  try { return typeof raw === 'string' ? JSON.parse(raw) : (raw || {}); } catch { return {}; }
}

export default {
  name: 'skills',

  registerHttp(router) {
    router.get('/skills', async (req, res) => {
      try {
        const scope = systemScopeFor(req);
        const skills = skillSourcesFor(scope).flatMap((source) => readSkillDir(source, scope.home));

        let padItems = [];
        let padAvailable = true;
        const r = await pad.listItems('playbooks', { ctx: reqPadContext(req) });
        if (r.ok && Array.isArray(r.data)) {
          padItems = r.data.map((it) => ({ ...it, parsedFields: parsePadFields(it.fields) }));
        } else {
          padAvailable = false;
        }

        const padByRef = new Map(padItems.map((it) => [it.ref, it]));
        for (const sk of skills) {
          const p = sk.padRef ? padByRef.get(sk.padRef) : null;
          sk.pad = p
            ? {
                ref: p.ref,
                status: p.parsedFields.status || null,
                trigger: p.parsedFields.trigger || null,
                scope: p.parsedFields.scope || null,
                invocationSlug: p.parsedFields.invocation_slug || null,
              }
            : null;
        }

        // Candidatos: playbook activo + con invocation_slug que ningún SKILL.md
        // referencia todavía (MC-683: los draft/sin-slug se gradúan antes, no
        // se listan acá como "casi listos").
        const linkedRefs = new Set(skills.map((s) => s.padRef).filter(Boolean));
        const padOnly = padItems
          .filter((it) => it.parsedFields.status === 'active' && it.parsedFields.invocation_slug && !linkedRefs.has(it.ref))
          .map((it) => ({
            ref: it.ref,
            title: it.title,
            invocationSlug: it.parsedFields.invocation_slug,
            trigger: it.parsedFields.trigger || null,
            scope: it.parsedFields.scope || null,
            summary: String(it.content || '').slice(0, 220),
          }));

        res.json({
          skills,
          padOnly,
          padAvailable,
          catalog: catalogStateFor(scope.claudeDir),
        });
      } catch (e) {
        res.status(500).json({ error: String(e.message || e) });
      }
    });

    router.post('/skills/install', (req, res) => {
      try {
        const scope = systemScopeFor(req);
        const result = installSkill(scope.claudeDir, req.body?.dirName);
        if (!result.ok) {
          return res.status(400).json({ error: result.error, code: result.code });
        }
        return res.json(result);
      } catch (e) {
        return res.status(400).json({
          error: 'No se pudo instalar la skill.',
          code: e?.code || 'install_failed',
        });
      }
    });

    router.post('/skills/uninstall', (req, res) => {
      try {
        const scope = systemScopeFor(req);
        const result = uninstallSkill(scope.claudeDir, req.body?.dirName);
        if (!result.ok) {
          return res.status(400).json({ error: result.error, code: result.code });
        }
        return res.json(result);
      } catch (e) {
        return res.status(400).json({
          error: 'No se pudo desinstalar la skill.',
          code: e?.code || 'uninstall_failed',
        });
      }
    });
  },
};
