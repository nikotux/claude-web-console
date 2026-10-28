// modules/lab/help.js — ayuda contextual del Laboratorio.
import { t } from '../../ui/i18n.js';

export default function labHelp() {
  return {
    title: t('lab.help.title', 'Laboratorio'),
    icon: 'terminal',
    intro: t('lab.help.intro', 'Laboratorio reúne accesos administrados a omp y al escritorio visual Orca para probar herramientas fuera de proyectos reales. Orca arranca con el host y vuelve a abrirse si cerrás su ventana.'),
    sections: [
      {
        title: t('lab.help.first.title', 'Primeros pasos'),
        blocks: [
          {
            type: 'steps',
            items: [
              t('lab.help.first.step1', 'Desplegá la tarjeta Laboratorio en la barra lateral.'),
              t('lab.help.first.step2', 'Elegí omp para abrir una terminal nueva en la carpeta limpia ~/lab-omp.'),
              t('lab.help.first.step3', 'Elegí Orca para abrir el escritorio visual en otra pestaña. La consola completa la clave VNC automáticamente.'),
            ],
          },
        ],
      },
      {
        title: t('lab.help.legend.title', 'Herramientas'),
        blocks: [
          {
            type: 'legend',
            items: [
              { icon: 'terminal', name: t('lab.help.legend.omp.name', 'omp'), desc: t('lab.help.legend.omp.desc', 'agente interactivo dentro de una sesión de terminal persistente') },
              { icon: 'console', name: t('lab.help.legend.orca.name', 'Orca'), desc: t('lab.help.legend.orca.desc', 'escritorio visual servido por Xvnc, Openbox, Orca IDE y noVNC') },
            ],
          },
        ],
      },
      {
        title: t('lab.help.actions.title', 'Botones y acciones'),
        blocks: [
          {
            type: 'kv',
            items: [
              { k: t('lab.help.actions.omp.k', 'Abrir omp'), v: t('lab.help.actions.omp.v', 'Crea una sesión omp y abre su terminal en una ventana nueva. El uso posterior del agente puede consumir los recursos de su propia cuenta.') },
              { k: t('lab.help.actions.orca.k', 'Abrir Orca'), v: t('lab.help.actions.orca.v', 'Abre noVNC con conexión automática, ajuste de escala y la clave VNC en el fragmento de la URL. Ese fragmento queda en el navegador y no se envía al servidor web.') },
            ],
          },
        ],
      },
      {
        title: t('lab.help.orca.title', 'Cómo funciona Orca'),
        blocks: [
          {
            type: 'steps',
            items: [
              t('lab.help.orca.step1', 'Cuatro servicios de usuario mantienen el escritorio: orca-vnc, orca-openbox, orca-app y orca-novnc.'),
              t('lab.help.orca.step2', 'Si cerrás Orca IDE, orca-app lo abre de nuevo para que el escritorio no quede vacío.'),
              t('lab.help.orca.step3', 'Para reiniciar todo el escritorio, usá systemctl --user restart orca-vnc.'),
            ],
          },
          {
            type: 'note',
            tone: 'info',
            text: t('lab.help.orca.passwords', 'Las claves viven en ~/.config/tigervnc/orca-passwd y ~/.cwc-data/lab/orca-vnc.pass. No las compartas ni cambies sus permisos.'),
          },
        ],
      },
      {
        title: t('lab.help.care.title', 'Ojo con esto'),
        blocks: [
          { type: 'note', tone: 'warn', text: t('lab.help.care.text', 'Laboratorio es solo para administradores. ~/lab-omp es una carpeta de pruebas: no la uses como proyecto real. Si Orca no abre, revisá que el host esté conectado a ZeroTier; la consola no inicia ni reinicia los servicios desde el navegador.') },
        ],
      },
    ],
  };
}
