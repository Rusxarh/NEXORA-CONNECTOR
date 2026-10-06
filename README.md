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
