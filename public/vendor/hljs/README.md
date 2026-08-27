# highlight.js vendorizado

Esta carpeta es la única copia estática que se conserva a propósito. Las demás dependencias vendorizadas se migraron a mounts desde `node_modules` como parte de BUG-2816, pero highlight.js no publica en npm un bundle para navegador: solo distribuye `lib/` en CommonJS, `es/` y `styles/*.css`.

Los archivos actuales corresponden a highlight.js 11.12.0 y al tema **github-dark**:

- `hljs.min.js`: https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.12.0/highlight.min.js
- `theme.css`: https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.12.0/styles/github-dark.min.css

El check `vendor-drift` de Salud avisa cuando esta copia queda atrasada respecto de `node_modules/highlight.js`.
