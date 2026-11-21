/**
 * extractor_detalle_rgm.js
 *
 * Prompt 8c (NEXCAM-PROMPTS-Y-PRUEBAS.md): extractor de la pagina de
 * "Detalle de la Garantia" (ResultadoConsultaGarantias.aspx), separado de
 * content.js para poder usarlo en DOS contextos SIN DUPLICAR codigo:
 *   1) content.js, en una pestana real (plan B) -- comportamiento IDENTICO
 *      al de antes, solo que las funciones ahora viven aqui.
 *   2) offscreen.js, en un offscreen document (plan A, sin pestana) -- el
 *      service worker no tiene DOM/DOMParser, asi que el HTML obtenido con
 *      fetch() se carga en la pagina offscreen y esta misma logica lo lee.
 *
 * Todo este archivo es SOLO lectura de DOM (document.getElementById/
 * querySelector/querySelectorAll): ningun fetch, ningun mensaje, ningun
 * efecto secundario. Logica copiada tal cual de content.js (sin cambios de
 * comportamiento), solo que calcularDatosDetalleReal() devuelve el
 * resultado en vez de mandarlo por enviarResultadoFinal/registrarTraceRgm
 * (eso sigue siendo responsabilidad de quien la llama).
 */

const IDS_TABLAS_DETALLE = {
  deudores: "ContentPlaceHolderSeguridad_ContentPlaceHolderContenido_ConsultaGM1_gvDeudores",
  acreedores: "ContentPlaceHolderSeguridad_ContentPlaceHolderContenido_ConsultaGM1_gvAcreedores",
  bienes: "ContentPlaceHolderSeguridad_ContentPlaceHolderContenido_ConsultaGM1_gvBienesSerial",
};

function limpiarTexto(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function normalizarEspacios(s) {
  return limpiarTexto(s);
}

function normalizarTexto(s) {
  return (s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

function encontrarTablaPorIdReal(idExacto) {
  const exacta = document.getElementById(idExacto);
  if (exacta) return exacta;
  const sufijo = idExacto.split("_").pop();
  return document.querySelector(`[id$="_${sufijo}"], [id="${sufijo}"]`);
}

/**
 * Dentro de un contenedor (una tabla especifica, incluyendo lo que haya en
 * tablas anidadas dentro de ella, ya que querySelectorAll recorre todos
 * los descendientes), busca la celda cuyo texto sea exactamente la
 * etiqueta buscada (con o sin ":" final) y devuelve el texto de la celda
 * INMEDIATAMENTE siguiente en la misma fila (el valor asociado real, no
 * una posicion fija global).
 */
function buscarValorPorEtiqueta(contenedor, etiquetaBuscada) {
  if (!contenedor) return null;
  const normalizado = normalizarTexto(etiquetaBuscada).replace(/:$/, "");
  const celdas = Array.from(contenedor.querySelectorAll("td, th"));

  for (const celda of celdas) {
    const textoCelda = normalizarTexto(celda.textContent).replace(/:$/, "");
    if (textoCelda === normalizado) {
      const siguienteCelda = celda.nextElementSibling;
      return siguienteCelda ? limpiarTexto(siguienteCelda.textContent) || null : null;
    }
  }
  return null;
}

/**
 * Dentro de la tabla dada, localiza la fila que tiene un <td> (nunca la de
 * solo <th>) y devuelve el texto de esa unica celda, con espacios
 * normalizados.
 */
function obtenerTextoUnicaCeldaDeDatos(tabla) {
  const filaConDatos = Array.from(tabla.querySelectorAll("tr")).find((fila) => fila.querySelector("td"));
  const celda = filaConDatos ? filaConDatos.querySelector("td") : null;
  return celda ? normalizarEspacios(celda.textContent) : null;
}

/**
 * Extrae el texto entre dos etiquetas literales dentro de un texto ya
 * normalizado en espacios, usando limites por indexOf.
 */
function extraerCampoEntreEtiquetas(texto, etiquetaInicio, etiquetaFin) {
  const idxInicio = texto.indexOf(etiquetaInicio);
  if (idxInicio === -1) return null;
  const desde = idxInicio + etiquetaInicio.length;
  const idxFin = etiquetaFin ? texto.indexOf(etiquetaFin, desde) : -1;
  const hasta = idxFin === -1 ? texto.length : idxFin;
  const valor = texto.slice(desde, hasta).trim();
  return valor || null;
}

function extraerDeudorGaranteReal() {
  const tabla = encontrarTablaPorIdReal(IDS_TABLAS_DETALLE.deudores);
  if (!tabla) return { encontrada: false, valor: null };

  const texto = obtenerTextoUnicaCeldaDeDatos(tabla);
  if (!texto) {
    return {
      encontrada: true,
      valor: { nombre: null, tipo_identificacion: null, numero_identificacion: null, ciudad: null },
    };
  }

  return {
    encontrada: true,
    valor: {
      nombre: extraerCampoEntreEtiquetas(texto, "Razón Social o Nombre", "Tipo Identificación"),
      tipo_identificacion: extraerCampoEntreEtiquetas(texto, "Tipo Identificación", "Número de Identificación"),
      numero_identificacion: extraerCampoEntreEtiquetas(
        texto,
        "Número de Identificación",
        "Dígito De Verificación"
      ),
      ciudad: extraerCampoEntreEtiquetas(texto, "Ciudad", "Dirección"),
    },
  };
}

function extraerAcreedorReal() {
  const tabla = encontrarTablaPorIdReal(IDS_TABLAS_DETALLE.acreedores);
  if (!tabla) return { encontrada: false, valor: null };

  return {
    encontrada: true,
    valor: {
      razon_social: buscarValorPorEtiqueta(tabla, "Razón Social o Nombre"),
    },
  };
}

/**
 * Extrae "T. Servicio: X" desde el texto de descripcion del bien, SOLO
 * como fallback cuando el campo directo "Tipo de Servicio" viene vacio.
 */
function extraerTipoServicioDeDescripcion(descripcion) {
  if (!descripcion) return null;
  const match = descripcion.match(/T\.\s*Servicio:\s*([^:]*?)(?=[A-ZÁÉÍÓÚÑ][a-záéíóúñ.]*:|$)/);
  if (match && match[1] && match[1].trim()) return limpiarTexto(match[1]);
  return null;
}

function extraerVehiculoReal() {
  const tabla = encontrarTablaPorIdReal(IDS_TABLAS_DETALLE.bienes);
  if (!tabla) return { encontrada: false, valor: null };

  const descripcionBien = buscarValorPorEtiqueta(tabla, "Descripción del Bien");
  let tipoServicio = buscarValorPorEtiqueta(tabla, "Tipo de Servicio");
  let tipoServicioOrigen = tipoServicio ? "campo_directo" : null;

  if (!tipoServicio) {
    const desdeDescripcion = extraerTipoServicioDeDescripcion(descripcionBien);
    if (desdeDescripcion) {
      tipoServicio = desdeDescripcion;
      tipoServicioOrigen = "fallback_descripcion_bien";
    }
  }

  return {
    encontrada: true,
    tipoServicioOrigen,
    valor: {
      tipo_bien: buscarValorPorEtiqueta(tabla, "Tipo de Bien"),
      marca: buscarValorPorEtiqueta(tabla, "Marca"),
      fabricante: buscarValorPorEtiqueta(tabla, "Fabricante"),
      modelo: buscarValorPorEtiqueta(tabla, "Año Correspondiente al Modelo"),
      placa: buscarValorPorEtiqueta(tabla, "Placa"),
      numero_serial: buscarValorPorEtiqueta(tabla, "Número de Serial"),
      tipo_servicio: tipoServicio || null,
      descripcion_bien: descripcionBien,
    },
  };
}

/**
 * Nucleo PURO (sin logging ni mensajes) de extraerDatosDetalleReal() de
 * content.js: lee los 3 bloques del `document` actual (la pestana real en
 * content.js, o el offscreen document ya cargado con el HTML fetcheado en
 * offscreen.js) y decide el estado igual que siempre. Quien llama decide
 * que hacer con el resultado (enviarResultadoFinal en content.js,
 * sendMessage de vuelta a background.js en offscreen.js).
 */
function calcularDatosDetalleReal(placaConsultada) {
  const deudor = extraerDeudorGaranteReal();
  const acreedor = extraerAcreedorReal();
  const vehiculo = extraerVehiculoReal();

  const camposFaltantes = [];

  if (!deudor.encontrada) {
    camposFaltantes.push("deudor_garante (tabla no encontrada)");
  } else {
    if (!deudor.valor.nombre) camposFaltantes.push("deudor_garante.nombre");
    if (!deudor.valor.tipo_identificacion) camposFaltantes.push("deudor_garante.tipo_identificacion");
    if (!deudor.valor.numero_identificacion) camposFaltantes.push("deudor_garante.numero_identificacion");
    if (!deudor.valor.ciudad) camposFaltantes.push("deudor_garante.ciudad");
  }

  if (!acreedor.encontrada || !acreedor.valor.razon_social) {
    camposFaltantes.push("acreedor.razon_social");
  }

  if (!vehiculo.encontrada) {
    camposFaltantes.push("vehiculo (tabla no encontrada)");
  } else {
    if (!vehiculo.valor.tipo_bien) camposFaltantes.push("vehiculo.tipo_bien");
    if (!vehiculo.valor.marca) camposFaltantes.push("vehiculo.marca");
    if (!vehiculo.valor.fabricante) camposFaltantes.push("vehiculo.fabricante");
    if (!vehiculo.valor.modelo) camposFaltantes.push("vehiculo.modelo");
    if (!vehiculo.valor.placa) camposFaltantes.push("vehiculo.placa");
    if (!vehiculo.valor.numero_serial) camposFaltantes.push("vehiculo.numero_serial");
    if (!vehiculo.valor.descripcion_bien) camposFaltantes.push("vehiculo.descripcion_bien");
  }

  const placaExtraidaCruda = vehiculo.valor ? vehiculo.valor.placa : null;
  const placaCoincide =
    !!placaExtraidaCruda && limpiarTexto(placaExtraidaCruda).toUpperCase() === limpiarTexto(placaConsultada).toUpperCase();

  if (placaExtraidaCruda && !placaCoincide) {
    camposFaltantes.push(`placa_coincide (consultada="${placaConsultada}", extraida="${placaExtraidaCruda}")`);
  }

  const estado = camposFaltantes.length === 0 && placaCoincide ? "OK" : "EXTRACCION_INCOMPLETA";

  const resultado = {
    fuente: "RGM",
    placa_consultada: placaConsultada,
    estado,
    deudor_garante: deudor.valor,
    acreedor: acreedor.valor,
    vehiculo: vehiculo.valor,
  };
  if (camposFaltantes.length > 0) resultado.campos_faltantes = camposFaltantes;

  return { resultado, camposFaltantes, tipoServicioOrigen: vehiculo.tipoServicioOrigen || null };
}

// Node (pruebas, nunca en el navegador: typeof module es undefined ahi).
if (typeof module !== "undefined") {
  module.exports = {
    limpiarTexto, normalizarEspacios, normalizarTexto, encontrarTablaPorIdReal,
    buscarValorPorEtiqueta, obtenerTextoUnicaCeldaDeDatos, extraerCampoEntreEtiquetas,
    extraerDeudorGaranteReal, extraerAcreedorReal, extraerTipoServicioDeDescripcion,
    extraerVehiculoReal, calcularDatosDetalleReal, IDS_TABLAS_DETALLE,
  };
}
