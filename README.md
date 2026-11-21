# NEXORA-CONNECTOR (RGM + Judicial) v0.1

Extensión Chrome/Brave (Manifest V3) que hace de puente entre NEXORA
(NEX-CONTROL) y dos sitios externos: el RGM (garantiasmobiliarias.com.co)
y la Consulta Judicial por Nombre o Razón Social
(consultaprocesos.ramajudicial.gov.co). Automatiza la extracción de datos
reales desde el DOM de ambos sitios y los entrega a NEXORA mediante un
contrato de eventos (`chrome.runtime.connect`/`sendMessage`).

Archivos principales: `background.js` (orquestación, correlación de
consultas), `content.js` (extracción RGM), `judicial.js` (extracción
Judicial), `manifest.json`, `popup.html`/`popup.js` (interfaz manual de
prueba).

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
