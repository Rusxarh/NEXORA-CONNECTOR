/**
 * offscreen.js
 * Prompt 8c: recibe de background.js el HTML de la pagina de detalle del
 * RGM (ya descargado con fetch(), credentials:"include") y la placa
 * consultada; lo monta en el DOM de ESTE documento (vacio salvo por este
 * script) y llama a calcularDatosDetalleReal (extractor_detalle_rgm.js,
 * cargado antes que este archivo) -- la MISMA funcion que usa content.js
 * en una pestana real, sin duplicar logica.
 *
 * DOMParser SI existe aqui (es un documento normal, no un service worker):
 * se usa para parsear el HTML completo de forma robusta y luego se
 * remonta solo el <body> dentro de #contenedorDetalleRgm, para que
 * document.getElementById/querySelector (que usan las funciones del
 * extractor, sin modificar) encuentren los elementos como si estuvieran
 * en la pagina real.
 *
 * Una sola extraccion a la vez: background.js nunca manda dos mensajes
 * EXTRAER_DETALLE_RGM_OFFSCREEN sin esperar la respuesta del anterior
 * (misma regla de "una consulta a la vez" del plan A).
 */

chrome.runtime.onMessage.addListener((mensaje, sender, sendResponse) => {
  if (!mensaje || mensaje.accion !== "EXTRAER_DETALLE_RGM_OFFSCREEN") return false;

  try {
    const contenedor = document.getElementById("contenedorDetalleRgm");
    const parseado = new DOMParser().parseFromString(mensaje.html || "", "text/html");
    contenedor.innerHTML = parseado.body ? parseado.body.innerHTML : "";

    const { resultado, camposFaltantes, tipoServicioOrigen } = calcularDatosDetalleReal(mensaje.placa);
    sendResponse({ ok: true, resultado, camposFaltantes, tipoServicioOrigen });
  } catch (e) {
    sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
  } finally {
    // Nunca deja el HTML de una placa consultada en memoria mas de lo
    // necesario para esta extraccion puntual.
    const contenedor = document.getElementById("contenedorDetalleRgm");
    if (contenedor) contenedor.innerHTML = "";
  }
  return false; // respuesta sincrona (sendResponse ya se llamo arriba)
});
