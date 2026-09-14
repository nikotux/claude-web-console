import { icon } from '../ui/icons.js';

const SECTION_ICONS = {
  what: 'help',
  steps: 'checklist',
  examples: 'play',
  legend: 'eye',
  actions: 'gear',
  warning: 'lifebuoy',
};

const TEMAS = {
  conversaciones: {
    title: 'Conversaciones',
    icon: 'room',
    what: [
      'Si ayer le pediste algo a la IA, hoy podés volver a esa charla y seguir desde donde quedaron.',
      'Cada conversación guarda lo que se dijeron. Las carpetas funcionan como cajones: juntan conversaciones del mismo lugar para que sea más fácil encontrarlas.',
    ],
    steps: [
      { icon: 'search', text: 'Buscá una conversación por su nombre. También podés mirar dentro de las carpetas.' },
      { icon: 'eye', text: 'Mirá el cartel de estado. Te dice si la IA está trabajando, te espera o está en reposo.' },
      { icon: 'edit', text: 'Tocá la conversación. Escribí lo que necesitás en el cuadro de abajo.' },
      { icon: 'sparkle', text: 'Tocá Enviar. Recién ahí la IA recibe tu mensaje y se pone a trabajar.' },
    ],
    examples: [
      {
        title: 'Ejemplo: retomar un trabajo de ayer',
        text: 'Ayer le pediste a la IA que preparara una propuesta. Hoy buscás esa conversación por su nombre, la abrís y escribís “cambiá la fecha”. Al tocar Enviar, la IA continúa el mismo trabajo.',
      },
      {
        title: 'Ejemplo: encontrar una parte de una charla larga',
        text: 'La conversación tiene muchos mensajes y querés volver a una decisión anterior. Tocás Índice para ver una lista de las partes importantes. Abrir esa lista no le pide trabajo nuevo a la IA.',
      },
    ],
    legend: [
      { icon: 'folder', label: 'Carpeta', text: 'Es como un cajón. Guarda juntas varias conversaciones del mismo lugar.' },
      { icon: 'search', label: 'Lupa', text: 'Te ayuda a encontrar una conversación escribiendo parte de su nombre.' },
      { icon: 'more', label: 'Tres puntos', text: 'Muestran opciones para cambiar el nombre, mover o archivar.' },
      { icon: 'archive', label: 'Caja de archivo', text: 'Señala una conversación guardada aparte de las que usás ahora.' },
    ],
    actions: [
      { icon: 'plus', label: 'Nueva carpeta', text: 'Crea un cajón nuevo en el lugar que elijas. No le pide trabajo a la IA.' },
      { icon: 'search', label: 'Buscar y abrir', text: 'Te ayuda a encontrar una conversación y entrar en ella. No le pide trabajo a la IA.' },
      { icon: 'more', label: 'Tres puntos', text: 'Te deja cambiar el nombre, mover la conversación a una carpeta o archivarla. No le pide trabajo a la IA.' },
      { icon: 'sparkle', label: 'Enviar', text: 'Entrega tu mensaje a la IA para que continúe el trabajo.', cost: true },
      { icon: 'list', label: 'Índice', text: 'Muestra una lista de las partes de la conversación para que puedas saltar a una. Abrirla no le pide trabajo nuevo a la IA.' },
      { icon: 'folder', label: 'Artefactos', text: 'Muestra los materiales que quedaron guardados durante la conversación. Abrirlos no le pide trabajo nuevo a la IA.' },
      { icon: 'refresh', label: 'Actualizar, dentro de Índice', text: 'Prepara de nuevo la lista con los mensajes más recientes.', cost: true },
      { icon: 'chevronDown', label: 'Ir al último', text: 'Te lleva al mensaje más reciente y borra el aviso de mensajes nuevos. No le pide trabajo a la IA.' },
    ],
    warn: '“Trabajando” quiere decir que la IA está ocupada. “Te espera” quiere decir que está lista para vos o que necesita que aceptes o rechaces un permiso. “En reposo” quiere decir que no hay un trabajo en marcha. Si una conversación dice “Archivada” o “Modo Terminal”, podés leerla acá, pero no continuarla desde este cuadro. Si eliminás una carpeta, las conversaciones que estaban adentro no se borran.',
  },
  salas: {
    title: 'Salas compartidas',
    icon: 'room',
    what: [
      'Imaginá una mesa donde varias personas escriben para ponerse de acuerdo. La IA de la sala, llamada Cucho, no lee esa charla mientras ustedes conversan.',
      'Cucho recién recibe lo escrito cuando alguien toca ✦ Enviar a la IA. Hablar entre personas no le cuesta nada.',
    ],
    steps: [
      { icon: 'plus', text: 'Abrí una sala que ya existe. Si necesitás otra, creala y ponele un nombre claro.' },
      { icon: 'room', text: 'Escribí y tocá Enviar a la sala. Las otras personas lo ven, y no le cuesta nada.' },
      { icon: 'edit', text: 'Escribí @cucho al comenzar una pregunta si querés señalarla para la IA. Eso todavía no la envía.' },
      { icon: 'sparkle', text: 'Cuando el grupo esté listo, tocá ✦ Enviar a la IA. Recién ahí Cucho lee lo que corresponda y responde.' },
    ],
    examples: [
      {
        title: 'Ejemplo: ponerse de acuerdo antes de pedir ayuda',
        text: 'Están tres personas viendo un presupuesto. Escriben entre ellas un rato para ponerse de acuerdo. Cuando ya saben qué quieren pedir, una toca ✦ Enviar a la IA y recién ahí Cucho lee todo junto y responde.',
      },
      {
        title: 'Ejemplo: mandar solo una pregunta marcada',
        text: 'El grupo viene hablando de varios temas. Alguien escribe “@cucho ¿cuánto suman estos gastos?” y después toca ✦ Enviar a la IA. Cucho recibe esa pregunta marcada; lo demás queda esperando para otro envío.',
      },
    ],
    legend: [
      { icon: 'room', label: 'Dos globos de charla', text: 'Señalan una sala donde participan varias personas.' },
      { icon: 'sparkle', label: 'Destello', text: 'Acompaña el botón que entrega lo escrito a Cucho.' },
    ],
    actions: [
      { icon: 'plus', label: 'Abrir o crear una sala', text: 'Te deja entrar al espacio del grupo o preparar uno nuevo. No le pide trabajo a la IA.' },
      { icon: 'room', label: 'Enviar a la sala', text: 'Muestra tu mensaje a las otras personas. No le cuesta nada y queda esperando hasta que alguien se lo entregue a Cucho.' },
      { icon: 'check', label: '👍 ❓ 🔴', text: 'Sirven para que las personas marquen acuerdo, duda o bloqueo. No le cuestan nada y Cucho no las recibe.' },
      { icon: 'edit', label: 'Responder', text: 'Repite arriba una parte del mensaje al que contestás para que el grupo se ubique. No le pide trabajo a la IA.' },
      { icon: 'sparkle', label: '✦ Enviar a la IA', text: 'Entrega a Cucho lo que está esperando desde la vez anterior.', cost: true },
      { icon: 'refresh', label: 'Actualizar, dentro de Índice', text: 'Prepara de nuevo la lista de partes con los mensajes más recientes.', cost: true },
      { icon: 'close', label: 'Detener', text: 'Le pide a Cucho que frene el trabajo actual. Solo aparece mientras está trabajando.' },
      { icon: 'clipboard', label: 'Acta', text: 'Muestra los acuerdos que quedaron anotados. Abrirla no le pide trabajo nuevo a la IA.' },
      { icon: 'list', label: 'Índice', text: 'Muestra una lista de las partes importantes de la charla. Abrirla no le pide trabajo nuevo a la IA.' },
      { icon: 'folder', label: 'Artefactos', text: 'Muestra los materiales guardados en la sala. Abrirlos no le pide trabajo nuevo a la IA.' },
      { icon: 'chevronDown', label: 'Ir al último', text: 'Te lleva al mensaje más reciente. No le pide trabajo a la IA.' },
      { icon: 'logout', label: 'Invitar o salir', text: 'La persona dueña puede invitar. Las demás pueden salir de la sala. No le pide trabajo a la IA.' },
    ],
    warn: 'Escribir @cucho solo marca una pregunta; no se la entrega. Si hay preguntas marcadas cuando tocás ✦ Enviar a la IA, Cucho recibe solo esas preguntas y el resto queda esperando. Si no hay ninguna marcada, recibe todo lo escrito desde el envío anterior. Si Cucho ya está ocupado, el nuevo pedido espera su turno.',
  },
  archivos: {
    title: 'La Forja · tus archivos',
    icon: 'folder',
    what: [
      'Si guardaste una foto, un texto o un PDF, acá podés encontrarlo, verlo y ordenarlo.',
      'La Forja muestra tus archivos, que son cosas guardadas, y tus carpetas, que funcionan como cajones para agruparlas.',
    ],
    steps: [
      { icon: 'folder', text: 'Para entrar en una carpeta, tocala dos veces seguidas o seleccionala y tocá Abrir.' },
      { icon: 'eye', text: 'Tocá una cosa guardada. A un lado vas a ver su nombre, tamaño y, cuando sea posible, su contenido.' },
      { icon: 'upload', text: 'Tocá Subir archivos para elegir algo de tu equipo y guardarlo en la carpeta que estás viendo.' },
      { icon: 'more', text: 'Tocá los tres puntos si querés descargar, cambiar el nombre o mover algo a la papelera.' },
    ],
    examples: [
      {
        title: 'Ejemplo: guardar una factura en el lugar correcto',
        text: 'Entrás en la carpeta “Facturas 2026” y tocás Subir archivos. Elegís la factura de tu equipo. Como abriste primero la carpeta correcta, queda guardada ahí.',
      },
      {
        title: 'Ejemplo: mirar antes de descargar',
        text: 'Encontrás un PDF y no recordás qué contiene. Lo seleccionás y tocás Vista previa para mirarlo sin bajarlo a tu equipo. Esto no le pide trabajo a la IA.',
      },
    ],
    legend: [
      { icon: 'folder', label: 'Carpeta', text: 'Es como un cajón. Tocarla abre otro grupo de cosas guardadas.' },
      { icon: 'fileGeneric', label: 'Hoja', text: 'Representa una cosa guardada. Su color ayuda a reconocer de qué tipo es.' },
      { icon: 'upload', label: 'Flecha hacia arriba', text: 'Guarda en esta pantalla algo que está en tu equipo.' },
      { icon: 'eye', label: 'Ojo', text: 'Muestra el contenido sin descargarlo, cuando se puede.' },
      { icon: 'download', label: 'Flecha hacia abajo', text: 'Baja algo desde esta pantalla hasta tu equipo.' },
      { icon: 'more', label: 'Tres puntos', text: 'Muestran más cosas que podés hacer.' },
      { icon: 'trash', label: 'Papelera', text: 'Saca lo elegido de la carpeta y lo manda a la papelera.' },
    ],
    actions: [
      { icon: 'folder', label: 'Nueva carpeta', text: 'Crea un cajón nuevo para ordenar tus cosas. No le pide trabajo a la IA.' },
      { icon: 'upload', label: 'Subir archivos', text: 'Guarda acá cosas que elegís desde tu equipo. No le pide trabajo a la IA.' },
      { icon: 'grid', label: 'Ordenar y cambiar vista', text: 'Ordena por nombre, tamaño o fecha. También cambia entre filas y cuadros. No le pide trabajo a la IA.' },
      { icon: 'eye', label: 'Abrir y Vista previa', text: 'Entran en una carpeta o muestran imágenes, PDF y textos que esta pantalla puede leer. No le piden trabajo a la IA.' },
      { icon: 'download', label: 'Descargar', text: 'Baja una cosa a tu equipo. Si elegís una carpeta, junta todo en un solo paquete comprimido. No le pide trabajo a la IA.' },
      { icon: 'edit', label: 'Cambiar el nombre', text: 'Le pone un nombre nuevo a lo que elegiste. No le pide trabajo a la IA.' },
      { icon: 'trash', label: 'Mover a la papelera', text: 'Saca lo elegido de la carpeta actual y lo manda a la papelera. No le pide trabajo a la IA.' },
    ],
    warn: 'Hay cosas guardadas que esta pantalla no puede mostrar por dentro. Si son muy grandes o tienen un formato que no reconoce, te ofrece descargarlas. Si algo dice “Enlace”, es un acceso que lleva a otro lugar. Antes de subir o arrastrar algo, mirá el nombre de la carpeta abierta para no guardarlo donde no querías.',
  },
  conexiones: {
    title: 'Conexiones · tus cuentas',
    icon: 'externalLink',
    what: [
      'Por ejemplo, podés conectar tu cuenta de Microsoft 365 para que la IA te ayude con el correo o el calendario.',
      'También podés conectar Zoho o Freshservice. Antes de hacerlo, cada tarjeta te cuenta con palabras claras qué podrá hacer la IA y qué no podrá hacer.',
    ],
    steps: [
      { icon: 'eye', text: 'Elegí la cuenta que querés conectar. Leé qué podrá hacer la IA con ella.' },
      { icon: 'externalLink', text: 'Tocá Conectar cuenta. Microsoft y Zoho abren su propia página. Freshservice te pide los datos en esta misma pantalla.' },
      { icon: 'refresh', text: 'Cuando termines esos pasos, volvé a Conexiones. Esperá hasta ver la palabra Conectada.' },
      { icon: 'logout', text: 'Si ya no querés que la IA use esa cuenta, tocá Desconectar.' },
    ],
    examples: [
      {
        title: 'Ejemplo: conectar Microsoft 365',
        text: 'Querés que la IA te ayude a ordenar reuniones. Tocás Conectar cuenta en Microsoft 365 y seguís los pasos que muestra Microsoft. Al volver, esperás la marca Conectada antes de pedir ayuda con el calendario.',
      },
      {
        title: 'Ejemplo: dejar de usar una cuenta',
        text: 'Ya no querés que la IA trabaje con tu cuenta de Zoho. Tocás Desconectar en su tarjeta. Desde ese momento, la IA deja de tener ese acceso.',
      },
    ],
    legend: [
      { icon: 'check', label: 'Marca de verificación', text: 'Confirma que la cuenta quedó conectada.' },
      { icon: 'externalLink', label: 'Flecha que sale de un cuadro', text: 'Te lleva a la página del servicio para seguir la conexión.' },
      { icon: 'clipboard', label: 'Portapapeles', text: 'Copia un código o la lista de accesos que hacen falta.' },
      { icon: 'refresh', label: 'Flechas en círculo', text: 'Vuelve a intentar una conexión que se cortó o tuvo un error.' },
    ],
    actions: [
      { icon: 'externalLink', label: 'Conectar cuenta', text: 'Empieza los pasos para dar acceso a esa cuenta. No le pide trabajo a la IA.' },
      { icon: 'clipboard', label: 'Copiar código o permisos', text: 'Copia la información que vas a necesitar en el paso siguiente. No le pide trabajo a la IA.' },
      { icon: 'externalLink', label: 'Abrir Microsoft o Zoho', text: 'Abre la página segura de ese servicio. No le pide trabajo a la IA.' },
      { icon: 'check', label: 'Verificar y conectar', text: 'Comprueba tu cuenta de Freshservice con los datos que escribiste. No le pide trabajo a la IA.' },
      { icon: 'refresh', label: 'Reintentar', text: 'Vuelve a empezar una conexión que no terminó. No le pide trabajo a la IA.' },
      { icon: 'close', label: 'Cancelar o desconectar', text: 'Frena el intento o quita el acceso de una cuenta conectada. No le pide trabajo a la IA.' },
    ],
    warn: 'La IA no recibe tu contraseña. Solo obtiene los accesos que muestra cada tarjeta. En Freshservice, puede trabajar únicamente con lo que tu propia cuenta ya puede ver y cambiar. Los códigos de Microsoft y Zoho duran poco y se usan una sola vez. La clave de Freshservice se comprueba y después deja de verse en esta pantalla.',
  },
  'como-trabajo': {
    title: 'Cómo trabajo · tus preferencias',
    icon: 'gear',
    what: [
      'Por ejemplo, podés escribir que preferís respuestas cortas. La IA tendrá en cuenta esa indicación en las próximas conversaciones.',
      'Esta pantalla reúne tus indicaciones de trabajo. También muestra los datos disponibles para que la IA sepa cómo presentarte.',
    ],
    steps: [
      { icon: 'grid', text: 'En Comportamiento, tocá uno de los cuadros. Cada cuadro guarda una parte de tus indicaciones.' },
      { icon: 'edit', text: 'Leé el texto. Si aparece Abrir y ajustar, podés cambiarlo. Si aparece Ver, solo podés leerlo.' },
      { icon: 'eye', text: 'Tocá Revisar antes de guardar. Vas a ver con claridad qué parte sale y qué parte queda.' },
      { icon: 'check', text: 'Si está bien, tocá Sí, aplicar este cambio. Si no, tocá Seguir editando y corregilo.' },
    ],
    examples: [
      {
        title: 'Ejemplo: pedir respuestas más simples',
        text: 'Abrís un cuadro que podés ajustar y agregás “Usá frases cortas y explicá las palabras difíciles”. Tocás Revisar antes de guardar para comparar. Si el resultado dice lo que querías, aplicás el cambio.',
      },
      {
        title: 'Ejemplo: mirar sin cambiar',
        text: 'Un cuadro dice “Se mantiene automáticamente”. Tocás Ver para leerlo. No aparece una opción para cambiarlo desde esta pantalla.',
      },
    ],
    legend: [],
    legendNote: 'En esta pantalla, los controles principales están escritos con palabras. Los carteles como “Abrir y ajustar”, “Ver” y “Se mantiene automáticamente” te dicen qué podés hacer con cada cuadro.',
    actions: [
      { icon: 'refresh', label: 'Actualizar', text: 'Vuelve a mostrar tus indicaciones y tus datos más recientes. No le pide trabajo a la IA.' },
      { icon: 'edit', label: 'Abrir y ajustar', text: 'Abre un cuadro que sí podés cambiar. Ver abre uno que solo podés leer. No le piden trabajo a la IA.' },
      { icon: 'eye', label: 'Revisar antes de guardar', text: 'Le pide a la IA que compare el texto anterior con el nuevo y te explique el cambio.', cost: true },
      { icon: 'chevronLeft', label: 'Seguir editando', text: 'Vuelve al texto sin guardar nada. No le pide trabajo a la IA.' },
      { icon: 'check', label: 'Sí, aplicar este cambio', text: 'Guarda la indicación revisada para las próximas conversaciones. No inicia otra revisión de la IA.' },
    ],
    warn: 'Solo se cambia un cuadro por vez. Los demás quedan como estaban. Los cuadros que dicen “Se mantiene automáticamente” se pueden leer, pero no cambiar desde acá. Si la explicación automática falla, igual vas a ver el texto anterior y el nuevo, uno junto al otro, para que decidas.',
  },
  lecciones: {
    title: 'Lecciones · lo que aprendió',
    icon: 'brain',
    what: [
      'Por ejemplo, si varias veces pedís títulos cortos, la IA puede proponerte recordar esa preferencia.',
      'Acá aparecen las cosas que la IA notó porque se repitieron en tu forma de trabajar. Nada se conserva sin que vos lo decidas.',
    ],
    steps: [
      { icon: 'clock', text: 'Empezá por el grupo Por decidir. Ahí están las propuestas que esperan tu respuesta.' },
      { icon: 'eye', text: 'Tocá una propuesta. Leé Lo que observé y La lección general.' },
      { icon: 'checklist', text: 'Mirá cuántas veces pasó y qué tan segura está la IA de haberlo entendido bien.' },
      { icon: 'check', text: 'Elegí conservarla o descartarla. Después seguirá visible en el grupo que corresponda.' },
    ],
    examples: [
      {
        title: 'Ejemplo: conservar una preferencia útil',
        text: 'La IA notó varias veces que pedís fechas escritas con el mes en palabras. Abrís la propuesta y confirmás que está bien entendida. Tocás Sí, conservar esta lección para mantenerla.',
      },
      {
        title: 'Ejemplo: descartar una conclusión equivocada',
        text: 'Una propuesta dice que siempre querés respuestas formales, pero eso solo pasó una vez. Tocás No, descartarla y confirmás. La propuesta pasa al grupo Descartadas para que sepas qué decidiste.',
      },
    ],
    legend: [],
    legendNote: 'Las marcas ⛔, 📏, 🧭, 📋, 🔧 y 📝 separan las lecciones por tipo: regla, forma habitual, manera de trabajar, pasos, herramienta y nota. Los carteles también muestran si falta decidir y cuántas veces se repitió.',
    actions: [
      { icon: 'refresh', label: 'Actualizar', text: 'Vuelve a mostrar la lista más reciente. No le pide trabajo nuevo a la IA.' },
      { icon: 'eye', label: 'Abrir una lección', text: 'Muestra qué observó la IA, qué propone recordar, cuántas veces pasó y qué tan segura está. No le pide trabajo a la IA.' },
      { icon: 'check', label: 'Sí, conservar esta lección', text: 'Guarda la propuesta entre las aprobadas. No le pide trabajo nuevo a la IA.' },
      { icon: 'trash', label: 'No, descartarla', text: 'Te pide confirmar y después la mueve a Descartadas. No le pide trabajo a la IA.' },
    ],
    warn: 'Que algo se repita muchas veces no lo aprueba por sí solo. Las propuestas esperan tu decisión. Una lección descartada sigue visible en Descartadas. Una que ya se usa aparece junto a las aprobadas.',
  },
};

let cerrarActual = null;

function element(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function section(title, iconName) {
  const wrapper = element('section', 'cab-ayuda-section');
  const heading = element('h3', 'cab-ayuda-section-title');
  const mark = element('span', 'cab-ayuda-section-icon');
  mark.setAttribute('aria-hidden', 'true');
  mark.innerHTML = icon(iconName, { size: 22 });
  heading.append(mark, title);
  wrapper.appendChild(heading);
  return wrapper;
}

function appendIconItem(list, item) {
  const row = element('li');
  const mark = element('span', 'cab-ayuda-legend-icon');
  const copy = element('span');
  mark.setAttribute('aria-hidden', 'true');
  mark.innerHTML = icon(item.icon, { size: 20 });
  copy.appendChild(element('strong', '', item.label));
  copy.appendChild(element('span', '', item.text));
  if (item.cost) copy.appendChild(element('span', 'cab-ayuda-cost', 'Esto sí le pide trabajo a la IA'));
  row.append(mark, copy);
  list.appendChild(row);
}

function renderTopic(body, title, topic) {
  title.textContent = topic.title;
  body.replaceChildren();

  const back = element('button', 'cab-btn cab-btn--cold cab-ayuda-back', 'Volver al índice');
  back.type = 'button';
  back.dataset.ayudaIndex = '';
  body.appendChild(back);

  const what = section('Qué es', SECTION_ICONS.what);
  topic.what.forEach((text) => what.appendChild(element('p', '', text)));
  body.appendChild(what);

  const firstSteps = section('Primeros pasos', SECTION_ICONS.steps);
  const steps = element('div', 'cab-ayuda-steps-grid');
  topic.steps.forEach((step, index) => {
    const card = element('div', 'cab-ayuda-step');
    const number = element('span', 'cab-ayuda-step-num', String(index + 1));
    const mark = element('span', 'cab-ayuda-step-icon');
    mark.setAttribute('aria-hidden', 'true');
    mark.innerHTML = icon(step.icon, { size: 22 });
    card.append(number, mark, element('p', '', step.text));
    steps.appendChild(card);
  });
  firstSteps.appendChild(steps);
  body.appendChild(firstSteps);

  const examplesSection = section('Ejemplos de la vida real', SECTION_ICONS.examples);
  topic.examples.forEach((example) => {
    const details = element('details', 'cab-ayuda-example');
    const summary = element('summary', 'cab-ayuda-example-head', example.title);
    details.append(summary, element('p', '', example.text));
    examplesSection.appendChild(details);
  });
  body.appendChild(examplesSection);

  const legendSection = section('Leyenda de íconos', SECTION_ICONS.legend);
  if (topic.legend.length) {
    const legend = element('ul', 'cab-ayuda-grid cab-ayuda-legend');
    topic.legend.forEach((item) => appendIconItem(legend, item));
    legendSection.appendChild(legend);
  } else {
    legendSection.appendChild(element('p', '', topic.legendNote));
  }
  body.appendChild(legendSection);

  const actionsSection = section('Botones y acciones', SECTION_ICONS.actions);
  const actions = element('ul', 'cab-ayuda-grid cab-ayuda-actions');
  topic.actions.forEach((action) => appendIconItem(actions, action));
  actionsSection.appendChild(actions);
  body.appendChild(actionsSection);

  const warningSection = section('Ojo con esto', SECTION_ICONS.warning);
  warningSection.appendChild(element('div', 'cab-ayuda-warn', topic.warn));
  body.appendChild(warningSection);
  body.scrollTop = 0;
}

function renderIndex(body, title) {
  title.textContent = 'Ayuda de Modo Cabina';
  body.replaceChildren();
  body.appendChild(element('p', '', '¿No sabés por dónde empezar? Elegí la pantalla que estás mirando. Vas a encontrar pasos cortos y ejemplos para probar con tranquilidad.'));
  const index = element('div', 'cab-ayuda-index');
  Object.entries(TEMAS).forEach(([name, topic]) => {
    const button = element('button', 'cab-btn cab-btn--cold cab-ayuda-index-item');
    const mark = element('span', 'cab-ayuda-index-icon');
    button.type = 'button';
    button.dataset.ayudaTopic = name;
    mark.setAttribute('aria-hidden', 'true');
    mark.innerHTML = icon(topic.icon, { size: 22 });
    button.append(mark, topic.title);
    index.appendChild(button);
  });
  body.appendChild(index);
  body.scrollTop = 0;
}

export async function abrirAyuda(ctx, viewName) {
  cerrarActual?.(false);
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const overlay = element('div', 'cab-ayuda-overlay');
  const panel = element('section', 'cab-ayuda-panel');
  const head = element('header', 'cab-ayuda-head');
  const title = element('h2', 'cab-ayuda-title');
  const close = element('button', 'cab-btn cab-btn--cold cab-ayuda-close');
  const body = element('div', 'cab-ayuda-body');
  const titleId = `cabina-help-title-${Date.now()}`;

  void ctx;
  title.id = titleId;
  close.type = 'button';
  close.setAttribute('aria-label', 'Cerrar ayuda');
  close.title = 'Cerrar ayuda';
  close.innerHTML = icon('close', { size: 20 });
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', titleId);
  panel.tabIndex = -1;
  head.append(title, close);
  panel.append(head, body);
  overlay.appendChild(panel);

  const showIndex = () => {
    renderIndex(body, title);
    body.querySelector('.cab-ayuda-index-item')?.focus({ preventScroll: true });
  };
  const showTopic = (name) => {
    const topic = TEMAS[name];
    if (!topic) return showIndex();
    renderTopic(body, title, topic);
    body.querySelector('.cab-ayuda-back')?.focus({ preventScroll: true });
  };
  const cleanup = (restoreFocus = true) => {
    if (!overlay.isConnected) return;
    document.removeEventListener('pointerdown', onDocumentPointerDown, true);
    document.removeEventListener('keydown', onDocumentKeydown, true);
    panel.removeEventListener('click', onPanelClick);
    overlay.remove();
    if (cerrarActual === cleanup) cerrarActual = null;
    if (restoreFocus && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  };
  function onDocumentPointerDown(event) {
    if (!panel.contains(event.target)) cleanup();
  }
  function onDocumentKeydown(event) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    cleanup();
  }
  function onPanelClick(event) {
    if (event.target.closest('.cab-ayuda-close')) {
      cleanup();
      return;
    }
    if (event.target.closest('[data-ayuda-index]')) {
      showIndex();
      return;
    }
    const topicButton = event.target.closest('[data-ayuda-topic]');
    if (topicButton) showTopic(topicButton.dataset.ayudaTopic);
  }

  cerrarActual = cleanup;
  panel.addEventListener('click', onPanelClick);
  document.body.appendChild(overlay);
  if (Object.hasOwn(TEMAS, viewName)) renderTopic(body, title, TEMAS[viewName]);
  else renderIndex(body, title);
  document.addEventListener('pointerdown', onDocumentPointerDown, true);
  document.addEventListener('keydown', onDocumentKeydown, true);
  close.focus({ preventScroll: true });
}
