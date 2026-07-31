// modules/files-help.js — ayuda contextual del Explorador de archivos.
//
// Es una función para que t() resuelva el idioma recién cuando se abre el tema.
import { t } from '../ui/i18n.js';

export default function filesHelp() {
  return {
    title: t('files.help.title', 'Explorador de archivos'),
    icon: 'folder',
    intro: t('files.help.intro', 'El Explorador sirve para recorrer y ordenar los archivos de tus proyectos sin salir de la consola. Podés abrir una vista previa, descargar, subir y administrar carpetas desde una sola pantalla.'),
    sections: [
      {
        title: t('files.help.first.title', 'Primeros pasos'),
        blocks: [
          {
            type: 'steps',
            items: [
              t('files.help.first.step1', 'Elegí Home, el proyecto principal o la Papelera en la barra lateral.'),
              t('files.help.first.step2', 'Entrá a una carpeta con doble clic; usá las migas de arriba o Atrás para volver.'),
              t('files.help.first.step3', 'Hacé un clic para seleccionar y doble clic para abrir una carpeta o previsualizar un archivo.'),
              t('files.help.first.step4', 'Usá la barra superior para cambiar la vista, subir archivos, crear una carpeta o refrescar.'),
              t('files.help.first.step5', 'Abrí el menú contextual con clic derecho para descargar, renombrar o mandar una selección a la Papelera.'),
            ],
          },
        ],
      },
      {
        title: t('files.help.legend.title', 'Leyenda de colores'),
        wide: true,
        blocks: [
          {
            type: 'legend',
            items: [
              {
                icon: 'folder',
                name: t('files.help.legend.folder.name', 'Carpeta · azul'),
                desc: t('files.help.legend.folder.desc', 'contenedor navegable; las carpetas siempre aparecen antes que los archivos'),
              },
              {
                emoji: t('files.help.legend.image.emoji', '🟢'),
                name: t('files.help.legend.image.name', 'Imágenes · verde'),
                desc: t('files.help.legend.image.desc', 'PNG, JPG, GIF, WebP, SVG y otros formatos de imagen'),
              },
              {
                emoji: t('files.help.legend.video.emoji', '🟣'),
                name: t('files.help.legend.video.name', 'Video · violeta'),
                desc: t('files.help.legend.video.desc', 'MP4, MKV, MOV, WebM y otros formatos de video'),
              },
              {
                emoji: t('files.help.legend.audio.emoji', '🩷'),
                name: t('files.help.legend.audio.name', 'Audio · rosa'),
                desc: t('files.help.legend.audio.desc', 'MP3, WAV, FLAC, OGG y otros formatos de audio'),
              },
              {
                emoji: t('files.help.legend.archive.emoji', '🟠'),
                name: t('files.help.legend.archive.name', 'Comprimidos · naranja'),
                desc: t('files.help.legend.archive.desc', 'ZIP, TAR, GZ, RAR, 7Z y formatos relacionados'),
              },
              {
                emoji: t('files.help.legend.code.emoji', '🔵'),
                name: t('files.help.legend.code.name', 'Código · azul intenso'),
                desc: t('files.help.legend.code.desc', 'archivos de código, configuración y datos como JS, Python, JSON, YAML o CSS'),
              },
              {
                emoji: t('files.help.legend.pdf.emoji', '🔴'),
                name: t('files.help.legend.pdf.name', 'PDF · rojo'),
                desc: t('files.help.legend.pdf.desc', 'documentos PDF que se pueden abrir dentro de la vista previa'),
              },
              {
                emoji: t('files.help.legend.doc.emoji', '⚪'),
                name: t('files.help.legend.doc.name', 'Documentos · gris'),
                desc: t('files.help.legend.doc.desc', 'texto, Markdown, Office, CSV y formatos de documento'),
              },
              {
                emoji: t('files.help.legend.other.emoji', '⚫'),
                name: t('files.help.legend.other.name', 'Otros · gris oscuro'),
                desc: t('files.help.legend.other.desc', 'archivos cuya extensión no pertenece a una categoría conocida'),
              },
            ],
          },
        ],
      },
      {
        title: t('files.help.buttons.title', 'Botones y acciones'),
        wide: true,
        blocks: [
          {
            type: 'kv',
            items: [
              {
                k: t('files.help.buttons.back.k', 'Atrás y migas'),
                v: t('files.help.buttons.back.v', 'Suben a la carpeta anterior o saltan directamente a un nivel de la ruta.'),
              },
              {
                k: t('files.help.buttons.places.k', 'Home / Proyecto / Papelera'),
                v: t('files.help.buttons.places.v', 'Saltan a tus archivos, al proyecto principal o a los ítems eliminados.'),
              },
              {
                k: t('files.help.buttons.claude.k', 'Claude aquí'),
                v: t('files.help.buttons.claude.v', 'Abre una sesión de Claude en la carpeta actual; la sesión consume tokens mientras trabaja.'),
              },
              {
                k: t('files.help.buttons.terminal.k', 'Terminal'),
                v: t('files.help.buttons.terminal.v', 'Abre una terminal en la carpeta actual; por sí sola no consume tokens de IA.'),
              },
              {
                k: t('files.help.buttons.views.k', 'Iconos / Lista'),
                v: t('files.help.buttons.views.v', 'Alterna entre miniaturas y una tabla ordenable por nombre, tipo, tamaño o fecha.'),
              },
              {
                k: t('files.help.buttons.upload.k', 'Subir'),
                v: t('files.help.buttons.upload.v', 'Copia uno o varios archivos a la carpeta actual; si el nombre ya existe, crea uno único en vez de pisarlo.'),
              },
              {
                k: t('files.help.buttons.drop.k', 'Arrastrar y soltar'),
                v: t('files.help.buttons.drop.v', 'Sube los archivos soltados sobre el área principal de la carpeta actual.'),
              },
              {
                k: t('files.help.buttons.mkdir.k', 'Carpeta'),
                v: t('files.help.buttons.mkdir.v', 'Crea una carpeta nueva con el nombre que indiques.'),
              },
              {
                k: t('files.help.buttons.refresh.k', 'Refrescar'),
                v: t('files.help.buttons.refresh.v', 'Vuelve a leer el contenido de la carpeta desde el disco.'),
              },
              {
                k: t('files.help.buttons.home.k', 'Inicio'),
                v: t('files.help.buttons.home.v', 'Vuelve a la consola principal.'),
              },
              {
                k: t('files.help.buttons.help.k', '? Ayuda'),
                v: t('files.help.buttons.help.v', 'Abre esta guía del Explorador.'),
              },
              {
                k: t('files.help.buttons.selection.k', 'Selección'),
                v: t('files.help.buttons.selection.v', 'Un clic elige uno; Ctrl/Cmd alterna ítems y Shift selecciona un rango.'),
              },
              {
                k: t('files.help.buttons.preview.k', 'Previsualizar'),
                v: t('files.help.buttons.preview.v', 'Abre imágenes, audio, video, PDF o texto; los binarios y archivos muy grandes se descargan.'),
              },
              {
                k: t('files.help.buttons.download.k', 'Descargar'),
                v: t('files.help.buttons.download.v', 'Baja un archivo, una carpeta como ZIP o una selección múltiple en un ZIP.'),
              },
              {
                k: t('files.help.buttons.rename.k', 'Renombrar'),
                v: t('files.help.buttons.rename.v', 'Cambia el nombre en disco; puede romper enlaces o procesos que dependan de la ruta anterior.'),
              },
              {
                k: t('files.help.buttons.trash.k', 'Eliminar'),
                v: t('files.help.buttons.trash.v', 'Mueve la selección a la Papelera; se puede restaurar durante 30 días.'),
              },
              {
                k: t('files.help.buttons.restore.k', 'Restaurar'),
                v: t('files.help.buttons.restore.v', 'Devuelve un ítem de la Papelera a su ubicación original.'),
              },
              {
                k: t('files.help.buttons.purge.k', 'Eliminar en Papelera'),
                v: t('files.help.buttons.purge.v', 'Borra el ítem definitivamente. Es destructivo y no se puede deshacer.'),
              },
              {
                k: t('files.help.buttons.keys.k', 'Enter / Delete / Esc'),
                v: t('files.help.buttons.keys.v', 'Enter abre; Delete o Backspace manda la selección a la Papelera; Esc cierra menús y vistas previas.'),
              },
            ],
          },
        ],
      },
      {
        title: t('files.help.warning.title', 'Ojo con esto'),
        blocks: [
          {
            type: 'note',
            tone: 'danger',
            text: t('files.help.warning.text', 'La Papelera es recuperable: guarda los ítems en ~/.cwc-trash/ durante 30 días y después los purga. “Eliminar” dentro de la Papelera es inmediato e irreversible; renombrar también cambia la ruta real que usan enlaces, scripts y sesiones.'),
          },
        ],
      },
    ],
  };
}
