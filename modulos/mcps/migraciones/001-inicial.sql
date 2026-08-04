-- mcps · 001 · esquema inicial
--
-- El censo conserva metadata y huellas, nunca valores de variables ni cabeceras.
-- Los timestamps son UTC ISO-8601 en TEXT: se ordenan sin conversion implicita y
-- siguen siendo legibles durante una recuperacion manual.
--
-- El eje `cliente` nace NOT NULL (D7). Aunque el censo describa el taller, dejarlo
-- nullable haria imposible atribuir las filas historicas cuando aparezcan clientes.

CREATE TABLE IF NOT EXISTS servidores (
  id                       TEXT PRIMARY KEY,
  nombre                   TEXT NOT NULL,
  fuente                   TEXT NOT NULL,
  ambito                   TEXT NOT NULL,
  transporte               TEXT NOT NULL,
  comando                  TEXT,
  argumentos               TEXT,
  url                      TEXT,
  claves_env               TEXT,
  huella_config            TEXT NOT NULL,
  huella_cred              TEXT,
  huella_config_al_cargar  TEXT,
  huella_cred_al_cargar    TEXT,
  estado                   TEXT NOT NULL DEFAULT 'desconocido',
  motivo                   TEXT,
  ms                       INTEGER,
  sondeado_en              TEXT,
  visto_en                 TEXT NOT NULL,
  cliente                  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sondeos (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  servidor  TEXT NOT NULL,
  ts        TEXT NOT NULL,
  estado    TEXT NOT NULL,
  ms        INTEGER,
  motivo    TEXT,
  cliente   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_sondeos_servidor_ts ON sondeos (servidor, ts);
