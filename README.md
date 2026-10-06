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
