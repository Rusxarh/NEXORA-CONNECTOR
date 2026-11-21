/**
 * ventana_bounds.js
 *
 * Prompt 8c punto 0 (URGENTE): chrome.windows.create con bounds fuera de
 * pantalla (left/top: -32000, Prompt 8b) revienta con "Invalid value for
 * bounds. Bounds must be at least 50% within visible screen space." --
 * Chrome exige que una ventana con bounds explicitos quede al menos 50%
 * dentro del area visible. Estas funciones son PURAS (sin chrome.*) para
 * poder probarlas con pantallas simuladas.
 */

/** Porcentaje (0 a 1) del area de `bounds` que cae dentro de `pantalla`. */
function calcularPorcentajeVisible(bounds, pantalla) {
  const pantallaDerecha = pantalla.left + pantalla.width;
  const pantallaAbajo = pantalla.top + pantalla.height;
  const vLeft = Math.max(bounds.left, pantalla.left);
  const vTop = Math.max(bounds.top, pantalla.top);
  const vRight = Math.min(bounds.left + bounds.width, pantallaDerecha);
  const vBottom = Math.min(bounds.top + bounds.height, pantallaAbajo);
  const areaVisible = Math.max(0, vRight - vLeft) * Math.max(0, vBottom - vTop);
  const areaTotal = bounds.width * bounds.height;
  return areaTotal > 0 ? areaVisible / areaTotal : 0;
}

/** true si `bounds` queda al menos 50% dentro de `pantalla` (la regla real de Chrome). */
function boundsValidosParaChrome(bounds, pantalla) {
  return calcularPorcentajeVisible(bounds, pantalla) >= 0.5;
}

/**
 * Bounds de una ventana pequeña (hasta 480x360, recortada si la pantalla
 * es mas chica) en la esquina superior izquierda del area de trabajo de
 * `pantalla` -- 100% dentro de pantalla por construccion, nunca necesita
 * validarse con boundsValidosParaChrome (siempre pasa).
 */
function construirBoundsEnEsquina(pantalla, ancho = 480, alto = 360) {
  return {
    left: pantalla.left,
    top: pantalla.top,
    width: Math.max(1, Math.min(ancho, pantalla.width)),
    height: Math.max(1, Math.min(alto, pantalla.height)),
  };
}

// Pantalla de respaldo si chrome.system.display no esta disponible o falla
// (ver background.js): un area de trabajo conservadora, nunca negativa.
const PANTALLA_DE_RESPALDO = { left: 0, top: 0, width: 1024, height: 768 };

if (typeof module !== "undefined") {
  module.exports = {
    calcularPorcentajeVisible, boundsValidosParaChrome, construirBoundsEnEsquina, PANTALLA_DE_RESPALDO,
  };
}
