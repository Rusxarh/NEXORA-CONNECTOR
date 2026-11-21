# NEXORA-CONNECTOR (RGM + Judicial) v0.1

Extensión Chrome/Brave (Manifest V3) que hace de puente entre NEXORA
(NEX-CONTROL) y dos sitios externos: el RGM (garantiasmobiliarias.com.co)
y la Consulta Judicial por Nombre o Razón Social
(consultaprocesos.ramajudicial.gov.co). Automatiza la extracción de datos
reales desde el DOM de ambos sitios y los entrega a NEXORA mediante un
contrato de eventos (`chrome.runtime.connect`/`sendMessage`).

Archivos principales: `background.js` (orquestación, correlación de
consultas, plan A/plan B de RGM), `content.js` (extracción RGM en una
pestaña real, plan B), `extractor_detalle_rgm.js` (extractor del detalle
RGM, compartido por `content.js` y `offscreen.js` para no duplicar
lógica), `rgm_plan_a.js` (plan A: RGM por `fetch()`, sin pestaña),
`ventana_bounds.js` (validar que una ventana quede dentro de la pantalla),
`offscreen.html`/`offscreen.js` (documento offscreen que lee el HTML del
plan A con DOMParser, ya que el service worker no tiene DOM),
`judicial.js` (extracción Judicial, ya no es el camino principal desde el
Prompt 8 -- ver v0.3.0 más abajo), `manifest.json`, `popup.html`/`popup.js`
(interfaz manual de prueba).

## Pruebas automáticas

No hay `npm`/`package.json`: son scripts Node sueltos, sin dependencias,
que prueban solo las funciones PURAS (sin `chrome.*`, sin red) con datos
simulados escritos a mano. Nunca contra el portal real (regla de CLAUDE.md
de NEXORA-CONTROL, que aplica igual aquí). Correr cada uno con:

```
node tests/test_ventana_bounds.js
node tests/test_rgm_plan_a.js
```

`extractor_detalle_rgm.js` (lectura del DOM) no tiene prueba automática
propia: no hay `document` en Node sin una librería como jsdom, que no se
agregó para no meter dependencias; su lógica es la misma que ya corría en
`content.js` antes de este cambio (movida tal cual, no reescrita).

## Historial técnico

### DIAG-001 — Instrumentación de timestamps Judicial

**Estado:** EN INVESTIGACIÓN

**Problema observado:**

Judicial falla cuando permanece en segundo plano, mientras que el mismo
flujo funciona cuando Judicial está activa.

**Evidencia inicial:**

- Judicial inactiva → CONSULTA_ERROR.
- Judicial activa → listado Judicial entregado correctamente.

**Objetivo:**

Registrar una línea temporal precisa del flujo Judicial para identificar
el punto exacto de divergencia.

**Cambio realizado:**

Se agregó instrumentación diagnóstica de timestamps (función
`registrarTrace` en `judicial.js`, con panel visual aislado vía Shadow
DOM y persistencia en `chrome.storage.local["nexoraJudicialTrace"]`).

**Lógica funcional modificada:**

NO.

**Próxima prueba:**

Comparación Judicial activa vs. Judicial inactiva.

**Resultado:**

PENDIENTE.

### DIAG-002 — Diagnóstico granular de NOMBRE_NO_VALIDADO

**Estado:** EN INVESTIGACIÓN

**Motivo:**

DIAG-001 identificó la primera divergencia entre Judicial activa e
inactiva en `escribirNombreYVerificar()`.

**Objetivo:**

Determinar cuál condición de validación permanece falsa:

- `valorConservado`
- `sinErrorVisible`

**Cambio:**

Instrumentación por intento dentro de `verificar()`.

**Lógica funcional modificada:**

NO.

**Reparación:**

NO aplicada.

**Próxima prueba:**

Repetir Caso A y analizar cada intento.

### DIAG-003 — Diagnóstico de foco y visibilidad

**Estado:** EN INVESTIGACIÓN

**Objetivo:**

Determinar si la diferencia entre Judicial activa e inactiva está
relacionada con el foco real o el estado de visibilidad del documento.

**Cambio:**

Se agregan al evento VERIFICACION_NOMBRE los valores:

- document.hasFocus()
- document.visibilityState
- document.hidden
- document.activeElement

**Lógica funcional modificada:**

NO.

**Reparación aplicada:**

NO.

**Próximo paso:**

Comparar Caso A y Caso B.

### DIAG-004 — Ampliación del presupuesto de verificación

**Estado:** EN INVESTIGACIÓN

**Objetivo:**

Determinar si el estado de validación de Judicial se resuelve
eventualmente en segundo plano cuando se proporciona suficiente
tiempo real.

**Cambio diagnóstico:**

Máximo de verificaciones aumentado de 10 a 40.

**Lógica de éxito:**

SIN CAMBIOS.

**Validación:**

SIN CAMBIOS.

**Reparación:**

NO aplicada.

**Hipótesis:**

Distinguir entre un estado simplemente ralentizado por throttling
y un estado que no se resuelve mientras la pestaña está oculta.

### DIAG-005 — NEXORA DEBUG GLOBAL

**Estado:** EN INVESTIGACIÓN

**Objetivo:**

Instrumentar temporalmente RGM y Judicial para observar el
comportamiento en primer y segundo plano.

**Motivación:**

Se observó una diferencia reproducible en Judicial según
visibilidad y un comportamiento intermitente en RGM donde la
página puede mostrar datos antes de que la extracción finalice.

**Cambio:**

- `content.js` (RGM): nueva función `registrarTraceRgm(evento, detalle)`
  + panel Shadow DOM "NEXORA DEBUG — RGM TIMELINE", persistencia en
  `chrome.storage.local["nexoraRgmTrace"]` (máx. 300 eventos). Eventos:
  RGM_INICIO, RGM_DOCUMENTO_LISTO, RGM_FORMULARIO_DETECTADO (flujo de
  respaldo), RGM_PLACA_ESCRITA (flujo de respaldo), RGM_CONSULTA_ENVIADA
  (flujo de respaldo), RGM_ESPERANDO_RESULTADOS, RGM_RESULTADOS_DETECTADOS,
  RGM_CONTROL_DETALLE_DETECTADO, RGM_ESPERANDO_DETALLE, RGM_DETALLE_ABIERTO,
  RGM_TABLAS_DETALLE_DETECTADAS, RGM_EXTRACCION_INICIADA,
  RGM_EXTRACCION_COMPLETADA, RGM_EXTRACCION_INCOMPLETA, RGM_TIMEOUT,
  RGM_ERROR, RGM_FINALIZACION, más TIMER_PROGRAMADO/EJECUTADO y
  OBSERVER_INICIADO/DETECTO_OBJETIVO/TIMEOUT en los 3 timers/observers
  críticos (tabla de resultados, llegada en el mismo documento, tablas de
  detalle), y NAVEGACION_INICIO/COMPLETADA.
- `judicial.js`: se agregaron eventos adicionales (reutilizando
  `registrarTrace` existente, sin tocarla) para cubrir Selección de
  radicado/Detalle/Actuaciones/Retorno al listado, puntos que DIAG-001
  no cubría todavía: RADICADO_VALIDADO, RADICADO_ABRIENDO,
  DETALLE_DETECTADO, ACTUACIONES_ABRIENDO, ACTUACIONES_DETECTADAS,
  ACTUACIONES_EXTRAYENDO, ACTUACIONES_EXTRAIDAS,
  RETORNO_AL_LISTADO_POST_ACTUACIONES, LISTADO_JUDICIAL_RESTAURADO, ERROR,
  FINALIZACION.

**Alcance:** Solo diagnóstico.

**Lógica funcional modificada:** NO.

**Extractores modificados:** NO.

**Timers funcionales modificados:** NO.

**Reparación aplicada:** NO.

# REPARACIÓN-001 — Sincronización del input Judicial

**Problema:**

El DOM conserva correctamente el nombre, pero cuando la pestaña está
oculta el estado de validación no se sincroniza.

**Evidencia:**

DIAG-004 registró 41 verificaciones sin que `sinErrorVisible` pasara a
`true`.

**Causa técnica:**

No confirmada con certeza (Vuetify/Vue remoto no es observable desde este
código). Lo único demostrable: dos puntos del mecanismo de disparo de
eventos eran menos "reales" que lo que un navegador genera ante tecleo
humano — (1) el evento `input` se construía como `Event` genérico, sin
`inputType`/`data`; (2) `.blur()` depende de que el elemento esté
realmente enfocado, algo no garantizado en el documento de una pestaña en
segundo plano (`document.hasFocus()=false` confirmado en Caso A, AUDITORÍA-003).

**Solución:**

En `escribirNombreYVerificar`: el valor se asigna vía el setter nativo
de `HTMLInputElement.prototype` en vez de asignación directa; el evento
`input` se reconstruye como `InputEvent` real (`inputType:"insertText"`,
`data`); `.blur()` se sustituye por el despacho explícito de `blur` y
`focusout`. `change`, `focus()`, `valorConservado`, `sinErrorVisible`, la
condición de éxito y los timers/número de intentos NO se modificaron.

**Archivos:** `judicial.js` únicamente (`escribirNombreYVerificar`).

**Riesgos:** si la causa real es un mecanismo de renderizado/transición de
Vuetify suspendido mientras la pestaña está oculta (hipótesis más
probable según AUDITORÍA-003/004, no confirmada), este cambio no la
resolvería — no hay ningún evento que este script pueda despachar para
forzar un repintado que el navegador decide no hacer en una pestaña
oculta.

**Estado:** REPARACIÓN IMPLEMENTADA — PENDIENTE DE VALIDACIÓN

# v0.2.0 — Prompt 8b punto 1: RGM externo ya no roba el foco

**Problema (prueba real, Fase 18):** cada consulta RGM automática
(cámara/Telegram/estudio/panel, atendida mientras `/consulta` está
abierta) activaba una pestaña (`active: true`) en la ventana ACTUAL del
usuario — "la pestaña del portal" que Gabriel veía abrirse y le robaba el
foco, aunque esa pestaña fuera inactiva para el popup manual.

**Causa real:** `iniciarConsulta()` solo tenía un camino: abrir la
pestaña en la ventana actual, activa o no (`active: !!opciones.activarMientrasExtrae`).
No existe ningún "plan A" (consultar sin pestaña, con `fetch()` desde el
service worker) — ver `MOTIVO_SIN_PLAN_A` en `background.js`: la página
de resultados de `ConsultaGarantia.aspx` depende de un postback ASP.NET
(`__VIEWSTATE`) que `content.js` espera con `MutationObserver` (no llega
en el HTML inicial de una sola petición GET/POST), y automatizarlo sin
poder probarlo contra el portal real es justo lo que CLAUDE.md prohíbe.

**Decisión (anotada):** mientras no haya plan A, toda consulta externa
queda marcada `plan: "B"` con el motivo exacto, visible en
`/consulta/diagnostico` (NEXORA-CONTROL). Para que el plan B no robe el
foco: la pestaña de trabajo se abre en una **ventana aparte**
(`chrome.windows.create`), `focused: false` y posicionada fuera del área
visible (`left/top: -32000`), en vez de minimizada. Se prefirió "fuera de
pantalla" sobre "minimizada" porque una ventana minimizada pone sus
pestañas en `visibilityState: 'hidden'` (el navegador limita sus
temporizadores, el mismo mecanismo que causaba el "mensaje perdido" que
`active: true` evitaba, y el mismo riesgo que REPARACIÓN-001 ya documentó
para páginas que dependen de que la pestaña esté "visible"/enfocada).
Fuera de pantalla pero no minimizada, la pestaña sigue siendo la pestaña
activa de su propia ventana (no debería entrar en el modo "oculto").

**No se implementó (y por qué):** un verdadero "plan A" por `fetch()`
sin pestaña, porque exige reproducir el postback ASP.NET real
(`__VIEWSTATE`/`__EVENTVALIDATION`) y el servicio worker ni siquiera
tiene `DOMParser` disponible para leer la respuesta -- no se puede
construir ni validar sin probarlo contra `garantiasmobiliarias.com.co`
de verdad, algo que este cambio no hizo (regla de CLAUDE.md). Si Gabriel
quiere avanzar en esto, el siguiente paso es capturar con las DevTools
(pestaña Red) una consulta manual real y pasar esa captura (sin datos
reales) para construir el postback a partir de un caso conocido, no de
una suposición.

**Archivos:** `manifest.json` (versión 0.1.0 → 0.2.0), `background.js`
(`iniciarConsulta`, `procesarConsultaExterna`, `consultaPublica`, PING).

**Riesgos:** no se pudo probar contra Brave/Windows real que una ventana
`focused:false` posicionada fuera de pantalla se comporte como se espera
en todas las versiones (podría recolocarse en pantalla, o el sistema
operativo podría tratarla distinto). Prueba manual pendiente (ver reporte
de Claude Code a Gabriel).

**Estado:** IMPLEMENTADO — PENDIENTE DE VALIDACIÓN MANUAL (fase 18.1)

# v0.3.0 — Prompt 8c: plan A real (sin pestaña) + arreglo urgente del crash de v0.2.0

**Problema urgente (prueba del 21/11/2026, 3:11 a. m.):** la v0.2.0 (ventana
aparte `focused:false` posicionada en `left/top: -32000`, fuera de
pantalla) hacía que `chrome.windows.create` reventara SIEMPRE con
`Invalid value for bounds. Bounds must be at least 50% within visible
screen space.` -- Chrome exige que una ventana con bounds explícitos quede
al menos 50% dentro del área visible. Ningún RGM terminaba (LRY517,
KPQ749 confirmados en el diagnóstico de NEXORA-CONTROL).

**Arreglo (punto 0, primero y urgente):** nunca más bounds fuera de
pantalla. `iniciarConsulta()` ahora intenta primero una ventana
**minimizada** (`state:"minimized"`, sin bounds explícitos -- minimizar
nunca choca con la regla del 50%). Si en 20 s no se confirma que el
mensaje `ANALIZAR_PAGINA_RGM` llegó (podría ser que, minimizada, el
navegador limite demasiado sus temporizadores), se cierra esa ventana y se
reintenta con una ventana normal pequeña **en una esquina, 100% dentro de
la pantalla** (`chrome.system.display.getInfo()` +
`construirBoundsEnEsquina`, con `PANTALLA_DE_RESPALDO` si la API de
pantallas no responde). Si el sistema le pasa el foco a esa ventana de
todos modos, se devuelve el foco a la ventana que lo tenía antes. Prueba
automática (`tests/test_ventana_bounds.js`) que valida que los bounds
pedidos quedan ≥ 50% (de hecho, 100%) dentro de la pantalla, en varios
tamaños de pantalla simulados, incluida la reproducción exacta del bug
real (`left/top: -32000` → 0% visible → inválido).

**Plan A real (punto 1):** `rgm_plan_a.js` implementa de punta a punta la
especificación sacada de una captura real de Gabriel
(`RGM-PLAN-A.md`, sin datos reales): GET del formulario → extraer los 8
campos ocultos (`__VIEWSTATE` y compañía) → POST asíncrono de búsqueda →
parsear el delta de ASP.NET AJAX (formato `longitud|tipo|id|contenido|`,
por longitudes, nunca `split("|")`) → elegir la fila más reciente de la
grilla (0 filas = "sin datos", resultado legítimo, no un fallo) → POST
asíncrono del detalle de esa fila → `pageRedirect` → GET del detalle →
`extractor_detalle_rgm.js` (el MISMO extractor que ya usaba `content.js`,
movido a un archivo compartido, cero cambios de lógica) corriendo en un
**offscreen document** (`offscreen.html`/`offscreen.js`, `DOMParser`
disponible ahí porque es una página normal, no el service worker). Una
consulta a la vez, mínimo 3 s entre consultas (`RGM_PLAN_A_MIN_MS_ENTRE_CONSULTAS`).

**Plan B automático (punto 2):** si el plan A falla por cualquier motivo
estructural (sin `__VIEWSTATE`, HTML que parece captcha/desafío, HTTP
distinto de 200/2xx, el delta no trae la grilla esperada, el extractor del
detalle no pudo leer nada), se cae al plan B (la ventana aparte del punto
0) con el motivo exacto. `procesarConsultaExterna` manda `plan`/`plan_motivo`
a NEXORA-CONTROL junto con el resultado; `/consulta/diagnostico` muestra
"plan A OK" o "plan B porque: `<motivo exacto>`" (texto literal pedido).

**Pruebas automáticas (punto 3):** `tests/test_rgm_plan_a.js`, HTML/delta
simulados escritos a mano según la especificación: formulario con los 8
campos, grilla de 0/1/2 filas (elige la de fecha más reciente), delta con
`pageRedirect`, un extractor de detalle simulado inyectable. Cubre también
captcha, HTTP 500, delta sin la grilla esperada y un extractor que falla
-- todos caen a plan B con un motivo legible, nunca lanzan. Un bug real
apareció escribiendo estas pruebas: `rgmPlanAExtraerFilasGrid` leía la
fecha/folio de la fila SIGUIENTE en vez de la propia (el botón "Consultar
detalle" va al final de cada fila, con sus datos antes) -- corregido antes
de este commit, confirmado por la prueba de 2 filas.

**No se probó contra el portal real** (regla de CLAUDE.md): ni el plan A
de punta a punta, ni la ventana minimizada/en la esquina en Brave/Windows
real. Pendiente la prueba manual de Gabriel (fase 18, ver reporte de
Claude Code).

**Judicial/`judicial.js` (confirmado con NEXORA-CONTROL):** desde el
Prompt 8, Judicial ya no depende de este Connector -- lo atiende un hilo
propio de NEXORA-CONTROL contra la API real (`judicial_directo.py`), que
reserva los ítems `alcance="JUDICIAL"` casi al instante. El camino de
`judicial.js` vía una pestaña real (`procesarConsultaExternaJudicialDirecta`/
`iniciarConsultaJudicial`) queda como "plan B" documentado para el caso
raro de que ese hilo esté caído -- no se borra, pero en la práctica no
debería dispararse nunca. El bug de Prompt 8 punto 2
(`extraerSujetosProcesales` con roles en minúscula o con "/") ya no se
corrige: no vale la pena arreglar un camino que ya no es el principal.

**Archivos:** `manifest.json` (versión 0.2.0 → 0.3.0; permisos nuevos
`system.display` y `offscreen`), `background.js`, `content.js` (ya no
tiene su propia copia del extractor de detalle), `rgm_plan_a.js` (nuevo),
`ventana_bounds.js` (nuevo), `extractor_detalle_rgm.js` (nuevo),
`offscreen.html`/`offscreen.js` (nuevos), `tests/` (nuevo).

**Estado:** IMPLEMENTADO — PENDIENTE DE VALIDACIÓN MANUAL (fase 18, punto 0 es lo más urgente de probar)
