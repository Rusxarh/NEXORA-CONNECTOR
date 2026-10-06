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
