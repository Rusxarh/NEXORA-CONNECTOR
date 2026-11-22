/**
 * rgm_plan_a.js
 *
 * Prompt 8c (NEXCAM-PROMPTS-Y-PRUEBAS.md) + RGM-PLAN-A.md: plan A real --
 * consultar el RGM con fetch() desde el service worker, SIN pestana ni
 * ventana. Estructura exacta (campos, cabeceras, formato delta,
 * pageRedirect) sacada de una captura real de Gabriel, sin datos reales.
 *
 * Todas las funciones de PARSEO de aqui son PURAS (reciben texto, devuelven
 * datos; nunca llaman a fetch/chrome) para poder probarlas con respuestas
 * simuladas escritas a mano (ver tests/), nunca contra el portal real
 * (CLAUDE.md). Solo `consultarRgmPlanA` hace fetch() de verdad.
 *
 * Cargado en el service worker via importScripts("rgm_plan_a.js") desde
 * background.js (service worker clasico, sin "type":"module" en el
 * manifest -- importScripts es la forma correcta ahi).
 */

const RGM_PLAN_A_BASE_URL = "https://www.garantiasmobiliarias.com.co/rgm/Garantias/ConsultaGarantia.aspx";
const RGM_PLAN_A_ORIGIN = "https://www.garantiasmobiliarias.com.co";
const RGM_PLAN_A_MIN_MS_ENTRE_CONSULTAS = 3000;

const RGM_PLAN_A_CAMPO_PLACA =
  "ctl00$ctl00$ContentPlaceHolderSeguridad$ContentPlaceHolderContenido$txtNumBien";
const RGM_PLAN_A_NOMBRE_BOTON_BUSCAR =
  "ctl00$ctl00$ContentPlaceHolderSeguridad$ContentPlaceHolderContenido$btnConsultarNumBien";
const RGM_PLAN_A_PREFIJO_FILA_GRID =
  "ctl00$ctl00$ContentPlaceHolderSeguridad$ContentPlaceHolderContenido$gvBusqueda$";

// --------------------------------------------------------------------------
// Utilidades puras
// --------------------------------------------------------------------------

function rgmPlanAEscaparRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extrae value="..." de un <input> por su atributo name, sin importar el
 * orden de los atributos (name antes o despues de value) ni si usa comillas
 * simples o dobles. Devuelve null si no aparece.
 */
function rgmPlanAExtraerCampoOculto(html, nombre) {
  const nombreEscapado = rgmPlanAEscaparRegex(nombre);
  const comoNameValue = new RegExp(`name=["']${nombreEscapado}["'][^>]*value=["']([^"']*)["']`, "i");
  let m = html.match(comoNameValue);
  if (m) return m[1];
  const comoValueName = new RegExp(`value=["']([^"']*)["'][^>]*name=["']${nombreEscapado}["']`, "i");
  m = html.match(comoValueName);
  return m ? m[1] : null;
}

const RGM_PLAN_A_CAMPOS_OCULTOS = [
  "__VIEWSTATE",
  "__VIEWSTATEGENERATOR",
  "__EVENTVALIDATION",
  "__VIEWSTATEENCRYPTED",
  "__SCROLLPOSITIONX",
  "__SCROLLPOSITIONY",
  "ctl00$ctl00$hdnCSFK",
  "ContentPlaceHolderSeguridad_ToolkitScriptManager1_HiddenField",
];

/** Lee los 8 campos ocultos de RGM_PLAN_A_CAMPOS_OCULTOS desde un HTML. */
function rgmPlanAExtraerCamposOcultos(html) {
  const campos = {};
  for (const nombre of RGM_PLAN_A_CAMPOS_OCULTOS) {
    campos[nombre] = rgmPlanAExtraerCampoOculto(html, nombre);
  }
  return campos;
}

/**
 * Parsea el formato "delta" de ASP.NET AJAX: segmentos
 * <longitud>|<tipo>|<id>|<contenido>| seguidos. `longitud` es el largo
 * exacto de `contenido` (que puede contener "|" sin que eso rompa el
 * parseo, por eso no se puede usar split simple). Segmentos malformados
 * detienen el parseo en ese punto (se devuelve lo que se alcanzo a leer
 * bien); nunca lanza.
 */
function rgmPlanAParsearDelta(texto) {
  const segmentos = [];
  let pos = 0;
  const longitudTotal = texto.length;
  while (pos < longitudTotal) {
    const finLongitud = texto.indexOf("|", pos);
    if (finLongitud === -1) break;
    const longitud = parseInt(texto.slice(pos, finLongitud), 10);
    if (!Number.isFinite(longitud) || longitud < 0) break;
    pos = finLongitud + 1;

    const finTipo = texto.indexOf("|", pos);
    if (finTipo === -1) break;
    const tipo = texto.slice(pos, finTipo);
    pos = finTipo + 1;

    const finId = texto.indexOf("|", pos);
    if (finId === -1) break;
    const id = texto.slice(pos, finId);
    pos = finId + 1;

    if (pos + longitud > longitudTotal) break; // contenido anunciado mas largo de lo que queda
    const contenido = texto.slice(pos, pos + longitud);
    pos += longitud;

    if (texto[pos] !== "|") break; // separador final del segmento ausente: formato inesperado
    pos += 1;

    segmentos.push({ tipo, id, contenido });
  }
  return segmentos;
}

/** Busca entre los segmentos del delta un hiddenField por nombre. */
function rgmPlanABuscarHiddenFieldEnDelta(segmentos, nombre) {
  const seg = segmentos.find((s) => s.tipo === "hiddenField" && s.id === nombre);
  return seg ? seg.contenido : null;
}

/** El segmento updatePanel cuyo id termina en el sufijo dado (p. ej. "upBusqueda"). */
function rgmPlanABuscarUpdatePanelEnDelta(segmentos, sufijoId) {
  const seg = segmentos.find((s) => s.tipo === "updatePanel" && s.id.endsWith(sufijoId));
  return seg ? seg.contenido : null;
}

function rgmPlanAExtraerPageRedirect(segmentos) {
  const seg = segmentos.find((s) => s.tipo === "pageRedirect");
  if (!seg) return null;
  try {
    return decodeURIComponent(seg.contenido);
  } catch (e) {
    return seg.contenido;
  }
}

/**
 * Filas de la grilla de resultados: una por cada boton "Consultar detalle
 * garantia" (nombre ctl00$...$gvBusqueda$ctlNN$lnkBtnConsultar). 0 filas =
 * "sin datos" para esa placa (resultado RGM legitimo, no un fallo de
 * parseo). Para cada fila, intenta sacar (mejor esfuerzo, el detalle real
 * se confirma en el paso 4) la primera fecha dd/mm/aaaa y el primer numero
 * de 17 digitos (folio electronico) que aparezcan en su fragmento de HTML,
 * para poder elegir la mas reciente sin tener que abrir cada detalle.
 */
function rgmPlanAExtraerFilasGrid(htmlGrid) {
  const regex = new RegExp(
    `name=["']${rgmPlanAEscaparRegex(RGM_PLAN_A_PREFIJO_FILA_GRID)}(ctl\\d+)\\$lnkBtnConsultar["']`,
    "g"
  );
  const posiciones = [];
  let m;
  while ((m = regex.exec(htmlGrid)) !== null) {
    posiciones.push({ ctl: m[1], inicio: m.index, fin: m.index + m[0].length });
  }
  // El fragmento de la fila i va desde el FINAL del boton de la fila
  // anterior (o el inicio de la grilla, para la primera) hasta el INICIO
  // del boton de la fila siguiente -- no desde su propio boton hacia
  // adelante: el boton "Consultar detalle" va al final de cada fila, con
  // sus datos (folio, fecha...) ANTES; usar inicio->siguiente.inicio
  // capturaba por error los datos de la fila SIGUIENTE.
  return posiciones.map((p, i) => {
    const desde = i === 0 ? 0 : posiciones[i - 1].fin;
    const hasta = i + 1 < posiciones.length ? posiciones[i + 1].inicio : htmlGrid.length;
    const fragmento = htmlGrid.slice(desde, hasta);
    const fechaMatch = fragmento.match(/\b(\d{1,2}\/\d{1,2}\/\d{4})\b/);
    const folioMatch = fragmento.match(/\b(\d{17})\b/);
    return { ctl: p.ctl, fecha: fechaMatch ? fechaMatch[1] : null, folio: folioMatch ? folioMatch[1] : null };
  });
}

function rgmPlanAParsearFechaDDMMYYYY(s) {
  if (!s) return null;
  const partes = s.split("/").map(Number);
  if (partes.length !== 3) return null;
  const [d, m, y] = partes;
  if (!d || !m || !y) return null;
  const fecha = new Date(y, m - 1, d);
  return Number.isNaN(fecha.getTime()) ? null : fecha.getTime();
}

/**
 * De varias filas, elige la de fecha de inscripcion mas reciente (best
 * effort: si ninguna trae fecha reconocible, se queda con la primera tal
 * cual la devuelve el portal). Las demas se devuelven en "otras" para que
 * NEXORA las guarde como "otras_garantias".
 */
function rgmPlanAElegirFilaMasReciente(filas) {
  if (!filas.length) return { elegida: null, otras: [] };
  let indiceElegido = 0;
  let mejorFecha = rgmPlanAParsearFechaDDMMYYYY(filas[0].fecha);
  for (let i = 1; i < filas.length; i++) {
    const fecha = rgmPlanAParsearFechaDDMMYYYY(filas[i].fecha);
    if (fecha !== null && (mejorFecha === null || fecha > mejorFecha)) {
      indiceElegido = i;
      mejorFecha = fecha;
    }
  }
  const elegida = filas[indiceElegido];
  const otras = filas.filter((_, i) => i !== indiceElegido);
  return { elegida, otras };
}

// --------------------------------------------------------------------------
// Construccion de los cuerpos POST (orden tal cual RGM-PLAN-A.md; el
// orden no le importa a application/x-www-form-urlencoded, se respeta
// solo para que el cuerpo sea facil de comparar con la captura real)
// --------------------------------------------------------------------------

function rgmPlanAConstruirCuerpoBusqueda(campos, placa) {
  const datos = new URLSearchParams();
  datos.set(
    "ctl00$ctl00$ContentPlaceHolderSeguridad$ToolkitScriptManager1",
    `ctl00$ctl00$ContentPlaceHolderSeguridad$ToolkitScriptManager1|${RGM_PLAN_A_NOMBRE_BOTON_BUSCAR}`
  );
  datos.set(
    "ContentPlaceHolderSeguridad_ToolkitScriptManager1_HiddenField",
    campos["ContentPlaceHolderSeguridad_ToolkitScriptManager1_HiddenField"] || ""
  );
  datos.set("__EVENTTARGET", "");
  datos.set("__EVENTARGUMENT", "");
  datos.set("__VIEWSTATE", campos["__VIEWSTATE"] || "");
  datos.set("__VIEWSTATEGENERATOR", campos["__VIEWSTATEGENERATOR"] || "");
  datos.set("__SCROLLPOSITIONX", "0");
  datos.set("__SCROLLPOSITIONY", "0");
  datos.set("__VIEWSTATEENCRYPTED", campos["__VIEWSTATEENCRYPTED"] || "");
  datos.set("__EVENTVALIDATION", campos["__EVENTVALIDATION"] || "");
  datos.set("ctl00$ctl00$hdnCSFK", campos["ctl00$ctl00$hdnCSFK"] || "");
  datos.set("ctl00$ctl00$ContentPlaceHolderSeguridad$ContentPlaceHolderContenido$txtNumeroIdentificacion", "");
  datos.set("ctl00$ctl00$ContentPlaceHolderSeguridad$ContentPlaceHolderContenido$txtNombre", "");
  datos.set(RGM_PLAN_A_CAMPO_PLACA, placa);
  datos.set("ctl00$ctl00$ContentPlaceHolderSeguridad$ContentPlaceHolderContenido$hfHoraConsulta", "");
  datos.set(
    "ctl00$ctl00$ContentPlaceHolderSeguridad$ContentPlaceHolderContenido$rblTiposConsulta",
    "Consultas no oficiales"
  );
  datos.set("ctl00$ctl00$ContentPlaceHolderSeguridad$ContentPlaceHolderContenido$recaptchaResponse", "");
  datos.set("ctl00$ctl00$ContentPlaceHolderSeguridad$ContentPlaceHolderContenido$hfFolioElectronico", "");
  datos.set("ctl00$ctl00$ContentPlaceHolderSeguridad$ContentPlaceHolderContenido$hfCopias", "false");
  datos.set("ctl00$ctl00$hfAuth", "");
  datos.set("__ASYNCPOST", "true");
  datos.set(RGM_PLAN_A_NOMBRE_BOTON_BUSCAR, "Consultar");
  return datos.toString();
}

function rgmPlanAConstruirCuerpoDetalle(campos, ctl) {
  const nombreBoton = `${RGM_PLAN_A_PREFIJO_FILA_GRID}${ctl}$lnkBtnConsultar`;
  const datos = new URLSearchParams();
  datos.set(
    "ctl00$ctl00$ContentPlaceHolderSeguridad$ToolkitScriptManager1",
    `ctl00$ctl00$ContentPlaceHolderSeguridad$ContentPlaceHolderContenido$upBusqueda|${nombreBoton}`
  );
  datos.set(
    "ContentPlaceHolderSeguridad_ToolkitScriptManager1_HiddenField",
    campos["ContentPlaceHolderSeguridad_ToolkitScriptManager1_HiddenField"] || ""
  );
  datos.set("__EVENTTARGET", "");
  datos.set("__EVENTARGUMENT", "");
  datos.set("__VIEWSTATE", campos["__VIEWSTATE"] || "");
  datos.set("__VIEWSTATEGENERATOR", campos["__VIEWSTATEGENERATOR"] || "");
  datos.set("__SCROLLPOSITIONX", "0");
  datos.set("__SCROLLPOSITIONY", "0");
  datos.set("__VIEWSTATEENCRYPTED", campos["__VIEWSTATEENCRYPTED"] || "");
  datos.set("__EVENTVALIDATION", campos["__EVENTVALIDATION"] || "");
  datos.set("ctl00$ctl00$hdnCSFK", campos["ctl00$ctl00$hdnCSFK"] || "");
  datos.set("ctl00$ctl00$ContentPlaceHolderSeguridad$ContentPlaceHolderContenido$txtNumeroIdentificacion", "");
  datos.set("ctl00$ctl00$ContentPlaceHolderSeguridad$ContentPlaceHolderContenido$txtNombre", "");
  datos.set(RGM_PLAN_A_CAMPO_PLACA, "");
  datos.set("ctl00$ctl00$ContentPlaceHolderSeguridad$ContentPlaceHolderContenido$hfHoraConsulta", "");
  datos.set(
    "ctl00$ctl00$ContentPlaceHolderSeguridad$ContentPlaceHolderContenido$rblTiposConsulta",
    "Consultas no oficiales"
  );
  datos.set("ctl00$ctl00$ContentPlaceHolderSeguridad$ContentPlaceHolderContenido$recaptchaResponse", "");
  datos.set("ctl00$ctl00$ContentPlaceHolderSeguridad$ContentPlaceHolderContenido$hfFolioElectronico", "");
  datos.set("ctl00$ctl00$ContentPlaceHolderSeguridad$ContentPlaceHolderContenido$hfCopias", "false");
  datos.set("ctl00$ctl00$hfAuth", "");
  datos.set("__ASYNCPOST", "true");
  datos.set(`${nombreBoton}.x`, "18");
  datos.set(`${nombreBoton}.y`, "10");
  return datos.toString();
}

const RGM_PLAN_A_CABECERAS_POST = {
  "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
  "X-MicrosoftAjax": "Delta=true",
  "X-Requested-With": "XMLHttpRequest",
  "Cache-Control": "no-cache",
};

// --------------------------------------------------------------------------
// Validez del formulario (Prompt 8d, punto 1): el formulario real del RGM
// trae un campo oculto "recaptchaResponse" (vacio) y scripts que mencionan
// la palabra "captcha" aunque no haya ningun desafio -- decidir por esa
// palabra sola daba una falsa alarma SIEMPRE. El formulario es valido si
// trae los campos de ASP.NET/CSFK y el campo de la placa, sin importar que
// contenga la palabra "captcha" en algun lado.
// --------------------------------------------------------------------------

function rgmPlanAFormularioValido(html) {
  const htmlStr = html || "";
  return (
    !!rgmPlanAExtraerCampoOculto(htmlStr, "__VIEWSTATE") &&
    !!rgmPlanAExtraerCampoOculto(htmlStr, "__EVENTVALIDATION") &&
    !!rgmPlanAExtraerCampoOculto(htmlStr, "ctl00$ctl00$hdnCSFK") &&
    htmlStr.includes(RGM_PLAN_A_CAMPO_PLACA)
  );
}

// --------------------------------------------------------------------------
// Deteccion de desafio/captcha REAL (heuristica, mejor esfuerzo): solo se usa
// cuando el formulario ya resulto invalido (le faltan los campos de arriba).
// Si trae __VIEWSTATE nunca es un desafio (es la pagina real de ASP.NET,
// aunque mencione la palabra "captcha" en un campo vacio o un script). Se
// considera un desafio real cuando aparece un widget de reCAPTCHA visible
// (con data-sitekey) o una pagina de verificacion conocida y corta.
// --------------------------------------------------------------------------

function rgmPlanAPareceDesafioOCaptcha(html) {
  const htmlStr = html || "";
  if (rgmPlanAExtraerCampoOculto(htmlStr, "__VIEWSTATE")) return false;
  const texto = htmlStr.toLowerCase();
  const tieneRecaptchaVisible = /g-recaptcha[^>]*data-sitekey/i.test(htmlStr);
  const esPaginaDeVerificacionConocidaYCorta =
    htmlStr.length < 1000 &&
    (texto.includes("verificación adicional") ||
      texto.includes("verificacion adicional") ||
      texto.includes("verifying you are human") ||
      texto.includes("checking your browser") ||
      texto.includes("acceso denegado") ||
      texto.includes("cloudflare") ||
      texto.includes("attention required"));
  return tieneRecaptchaVisible || esPaginaDeVerificacionConocidaYCorta;
}

// --------------------------------------------------------------------------
// Orquestacion real (fetch) -- NUNCA se ejecuta en las pruebas automaticas.
// --------------------------------------------------------------------------

/**
 * Resultado: { ok: true, resultado, camposFaltantes, otrasGarantias } o
 * { ok: false, motivo, httpStatus, cuerpoInicio } (motivo SIEMPRE legible,
 * sin ViewState/cookies/hdnCSFK -- ver regla de RGM-PLAN-A.md "Sesion y
 * proteccion"). `fetchFn`/`crearOffscreenYExtraer` son inyectables para
 * poder probar la orquestacion con un fetch simulado sin tocar la red.
 */
async function consultarRgmPlanA(placa, { fetchFn, crearOffscreenYExtraer, log } = {}) {
  const hacerFetch = fetchFn || ((...args) => fetch(...args));
  const registrar = log || (() => {});

  // 1) GET del formulario
  let respuestaForm;
  try {
    respuestaForm = await hacerFetch(RGM_PLAN_A_BASE_URL, { method: "GET", credentials: "include" });
  } catch (e) {
    return { ok: false, motivo: `paso 1 (GET formulario) sin respuesta: ${e && e.message ? e.message : e}` };
  }
  if (!respuestaForm.ok) {
    return { ok: false, motivo: "paso 1 (GET formulario) respondió con error", httpStatus: respuestaForm.status };
  }
  const htmlForm = await respuestaForm.text();
  if (!rgmPlanAFormularioValido(htmlForm)) {
    if (rgmPlanAPareceDesafioOCaptcha(htmlForm)) {
      return { ok: false, motivo: "paso 1: la respuesta parece un captcha/desafío, no el formulario", httpStatus: respuestaForm.status, cuerpoInicio: htmlForm.slice(0, 200) };
    }
    return { ok: false, motivo: "paso 1: no trajo los campos esperados del formulario (__VIEWSTATE, __EVENTVALIDATION, hdnCSFK o txtNumBien)", httpStatus: respuestaForm.status, cuerpoInicio: htmlForm.slice(0, 200) };
  }
  let campos = rgmPlanAExtraerCamposOcultos(htmlForm);

  // 2) POST asincrono: buscar la placa
  let respuestaBusqueda;
  try {
    respuestaBusqueda = await hacerFetch(RGM_PLAN_A_BASE_URL, {
      method: "POST", credentials: "include", headers: RGM_PLAN_A_CABECERAS_POST,
      body: rgmPlanAConstruirCuerpoBusqueda(campos, placa),
    });
  } catch (e) {
    return { ok: false, motivo: `paso 2 (POST búsqueda) sin respuesta: ${e && e.message ? e.message : e}` };
  }
  if (!respuestaBusqueda.ok) {
    return { ok: false, motivo: "paso 2 (POST búsqueda) respondió con error", httpStatus: respuestaBusqueda.status };
  }
  const textoBusqueda = await respuestaBusqueda.text();
  const segmentosBusqueda = rgmPlanAParsearDelta(textoBusqueda);
  if (!segmentosBusqueda.length) {
    return { ok: false, motivo: "paso 2: la respuesta no tiene formato delta reconocible", httpStatus: respuestaBusqueda.status, cuerpoInicio: textoBusqueda.slice(0, 200) };
  }
  const htmlGrid = rgmPlanABuscarUpdatePanelEnDelta(segmentosBusqueda, "upBusqueda");
  if (htmlGrid === null) {
    return { ok: false, motivo: "paso 2: el delta no trae la grilla de resultados (upBusqueda)", httpStatus: respuestaBusqueda.status, cuerpoInicio: textoBusqueda.slice(0, 200) };
  }
  // Campos ocultos nuevos del delta (hay que USARLOS en el paso 3) --
  // conserva el valor anterior si el delta no trajo ese campo en particular.
  for (const nombre of RGM_PLAN_A_CAMPOS_OCULTOS) {
    const nuevo = rgmPlanABuscarHiddenFieldEnDelta(segmentosBusqueda, nombre);
    if (nuevo !== null) campos[nombre] = nuevo;
  }

  const filas = rgmPlanAExtraerFilasGrid(htmlGrid);
  if (!filas.length) {
    // Sin filas = "sin datos" (resultado RGM legitimo, Prompt 8c): plan A
    // funciono, simplemente no hay garantias para esta placa.
    return {
      ok: true,
      resultado: { fuente: "RGM", placa_consultada: placa, estado: "SIN_DATOS", deudor_garante: null, acreedor: null, vehiculo: null },
      camposFaltantes: [],
      otrasGarantias: [],
    };
  }
  const { elegida, otras } = rgmPlanAElegirFilaMasReciente(filas);

  // 3) POST asincrono: abrir el detalle de la fila elegida
  let respuestaDetalle;
  try {
    respuestaDetalle = await hacerFetch(RGM_PLAN_A_BASE_URL, {
      method: "POST", credentials: "include", headers: RGM_PLAN_A_CABECERAS_POST,
      body: rgmPlanAConstruirCuerpoDetalle(campos, elegida.ctl),
    });
  } catch (e) {
    return { ok: false, motivo: `paso 3 (POST detalle) sin respuesta: ${e && e.message ? e.message : e}` };
  }
  if (!respuestaDetalle.ok) {
    return { ok: false, motivo: "paso 3 (POST detalle) respondió con error", httpStatus: respuestaDetalle.status };
  }
  const textoDetalle = await respuestaDetalle.text();
  const segmentosDetalle = rgmPlanAParsearDelta(textoDetalle);
  const pageRedirect = rgmPlanAExtraerPageRedirect(segmentosDetalle);
  if (!pageRedirect) {
    return { ok: false, motivo: "paso 3: el delta no trae pageRedirect al detalle", httpStatus: respuestaDetalle.status, cuerpoInicio: textoDetalle.slice(0, 200) };
  }

  // 4) GET del detalle
  const urlDetalle = pageRedirect.startsWith("http") ? pageRedirect : RGM_PLAN_A_ORIGIN + pageRedirect;
  let respuestaFinal;
  try {
    respuestaFinal = await hacerFetch(urlDetalle, { method: "GET", credentials: "include" });
  } catch (e) {
    return { ok: false, motivo: `paso 4 (GET detalle) sin respuesta: ${e && e.message ? e.message : e}` };
  }
  if (!respuestaFinal.ok) {
    return { ok: false, motivo: "paso 4 (GET detalle) respondió con error", httpStatus: respuestaFinal.status };
  }
  const htmlDetalle = await respuestaFinal.text();
  if (rgmPlanAPareceDesafioOCaptcha(htmlDetalle)) {
    return { ok: false, motivo: "paso 4: la respuesta parece un captcha/desafío, no el detalle", httpStatus: respuestaFinal.status, cuerpoInicio: htmlDetalle.slice(0, 200) };
  }

  const extraer = crearOffscreenYExtraer || extraerDetalleRgmConOffscreen;
  let extraido;
  try {
    extraido = await extraer(htmlDetalle, placa);
  } catch (e) {
    return { ok: false, motivo: `paso 4: no se pudo leer el detalle (${e && e.message ? e.message : e})` };
  }
  if (!extraido || !extraido.ok) {
    return { ok: false, motivo: `paso 4: el extractor no pudo leer el detalle (${extraido && extraido.error})` };
  }

  return {
    ok: true,
    resultado: extraido.resultado,
    camposFaltantes: extraido.camposFaltantes || [],
    otrasGarantias: otras.map((o) => ({ folio: o.folio, fecha: o.fecha })),
  };
}

// Node (pruebas); nunca en el navegador.
if (typeof module !== "undefined") {
  module.exports = {
    rgmPlanAExtraerCampoOculto, rgmPlanAExtraerCamposOcultos, rgmPlanAParsearDelta,
    rgmPlanABuscarHiddenFieldEnDelta, rgmPlanABuscarUpdatePanelEnDelta, rgmPlanAExtraerPageRedirect,
    rgmPlanAExtraerFilasGrid, rgmPlanAParsearFechaDDMMYYYY, rgmPlanAElegirFilaMasReciente,
    rgmPlanAConstruirCuerpoBusqueda, rgmPlanAConstruirCuerpoDetalle, rgmPlanAPareceDesafioOCaptcha,
    rgmPlanAFormularioValido, consultarRgmPlanA, RGM_PLAN_A_CAMPOS_OCULTOS, RGM_PLAN_A_BASE_URL,
  };
}
