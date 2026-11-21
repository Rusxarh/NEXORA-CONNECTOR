/**
 * NEXORA CONNECTOR - RGM v0.1
 * background.js (service worker, Manifest V3)
 *
 * AJUSTE: flujo directo por URL (mecanismo principal), en vez de abrir el
 * home del RGM y rellenar el formulario. La URL se construye con
 * URL/URLSearchParams (nunca concatenando texto a mano), a partir de una
 * placa normalizada y validada aqui mismo.
 *
 * Prototipo aislado: no hay conexion con NEXORA API todavia.
 */

const BASE_RGM_CONSULTA = "https://www.garantiasmobiliarias.com.co/rgm/Garantias/ConsultaGarantia.aspx";
const REGEX_PLACA_AUTO = /^[A-Z]{3}[0-9]{3}$/;

// Prompt 8b punto 1 (NEXCAM-PROMPTS-Y-PRUEBAS.md): "plan A" seria consultar
// el RGM con un fetch() del service worker, sin tocar ninguna pestana. No
// se implementa en esta version: la pagina de resultados de
// ConsultaGarantia.aspx depende de un postback ASP.NET (__VIEWSTATE/
// __EVENTVALIDATION, tabla cargada por un UpdatePanel -- ver
// content.js:manejarAnalizarPaginaRGM, que espera la tabla con
// MutationObserver en vez de leerla del HTML inicial) que no se puede
// automatizar de forma confiable sin probarlo contra el portal real, y
// CLAUDE.md prohibe que las pruebas automaticas (o este cambio sin
// supervision) le peguen al servicio real. Mientras tanto, TODA consulta
// usa "plan B" (pestana real) y queda anotado el motivo exacto en
// /consulta/diagnostico -- ver MOTIVO_SIN_PLAN_A y consultaPublica().
const MOTIVO_SIN_PLAN_A =
  "no existe un plan A (fetch sin pestaña) implementado todavía: " +
  "ConsultaGarantia.aspx carga la tabla de resultados con un postback " +
  "ASP.NET (__VIEWSTATE) que no se puede automatizar sin probarlo contra " +
  "el portal real (prohibido en pruebas automáticas, CLAUDE.md)";

// Pestana Judicial actualmente abierta por este Connector (si hay una),
// para poder cerrarla automaticamente al terminar. NO afecta ni comparte
// nada con el flujo de RGM: RGM nunca asigna esta variable, y su pestana
// nunca se cierra automaticamente (sigue igual que siempre).
let tabJudicialActual = null;

// FASE 2A.1: pestana RGM actualmente abierta por este Connector (si hay
// una). Antes de esta correccion, iniciarConsulta() creaba la pestana en
// una variable LOCAL (tab) que se perdia al terminar la funcion -- no
// existia ninguna forma de volver a encontrar esa pestana despues. Esta
// variable es la unica fuente de verdad para "que pestana RGM abrio el
// Connector", necesaria para que FINALIZAR_CONSULTA pueda cerrarla.
let tabRgmActual = null;

// --- Orquestacion RGM -> JUDICIAL (nueva, esta correccion) --------------
// resolverEsperaRgm: si esta definido, el PROXIMO RESULTADO_FINAL que
// llegue se le entrega a el en vez de solo guardarse (ver mas abajo). Es
// el mecanismo para que ejecutarFlujoRgmJudicial() pueda "esperar" a que
// RGM termine antes de decidir si lanza Judicial. No cambia en nada el uso
// normal de RGM o Judicial por separado: si nadie arma esta espera,
// resolverEsperaRgm es null y el codigo se comporta exactamente igual que
// antes de esta correccion.
let resolverEsperaRgm = null;
// placa_origen pendiente de asociarse al proximo resultado de Judicial que
// provenga especificamente del flujo encadenado (no de un uso aislado de
// Judicial desde el popup).
let placaOrigenPendiente = null;

// Diagnostico de la prueba real (NEXORA, rama alcance-rgm): una consulta
// PEDIDA DESDE /consulta con alcance "RGM" abria el portal pero el
// NEXORA DEBUG de la pestana se quedaba en "RGM_DOCUMENTO_LISTO" (content.js
// recien cargado) sin avanzar nunca a "RGM_INICIO" -- es decir,
// ANALIZAR_PAGINA_RGM nunca llego a procesarse en esa pestana, aunque
// iniciarConsulta() es la MISMA funcion que usa el popup (que si funciona).
// Causa real encontrada: iniciarConsulta() mandaba chrome.tabs.sendMessage
// SIN CALLBACK y sin verificar chrome.runtime.lastError -- si el mensaje
// se perdia (pestana todavia navegando/redirigiendo en el instante exacto
// del envio, algo mas facil de que pase en una pestana en SEGUNDO PLANO,
// donde Chrome puede demorar mas el pintado/montaje inicial de la pagina
// que en una pestana activa), nadie se enteraba ni reintentaba: la
// consulta se quedaba colgada para siempre en RGM_EN_PROCESO.
// Arreglo (ver iniciarConsulta): reintentos con ack real, y la pestana se
// activa SOLO durante la extraccion de una consulta EXTERNA (nunca para
// el popup, que ya funcionaba con la pestana en segundo plano).
let tabActivaAntesDeConsultaExterna = null;

/**
 * Espejo, del lado del Service Worker, de registrarTraceRgm() (content.js):
 * misma clave de storage (CLAVE_TRACE_RGM mas abajo en content.js,
 * "nexoraRgmTrace"), para que el camino EXTERNO (background.js) quede en
 * la MISMA linea de tiempo que las trazas de la pagina -- antes, un
 * problema como el de arriba solo se podia diagnosticar mirando la
 * pestana por fuera (estado RGM_EN_PROCESO colgado en /consulta) sin
 * ninguna pista de que paso (o no paso) del lado del Connector.
 */
function registrarTraceRgmExterno(evento, detalle) {
  try {
    const ahora = new Date();
    const dos = (n) => String(n).padStart(2, "0");
    const tres = (n) => String(n).padStart(3, "0");
    const entrada = {
      timestamp: `${dos(ahora.getHours())}:${dos(ahora.getMinutes())}:${dos(ahora.getSeconds())}.${tres(ahora.getMilliseconds())}`,
      perfNow: Math.round(performance.now() * 1000) / 1000,
      modulo: "RGM_EXTERNO",
      evento,
      detalle: detalle || null,
    };
    console.log(`[NEXORA-DIAG-RGM-EXTERNO] ${entrada.timestamp} | ${evento}${detalle ? " | " + detalle : ""}`);
    chrome.storage.local.get("nexoraRgmTrace", (datos) => {
      const previo = (datos && datos.nexoraRgmTrace) || [];
      const combinado = previo.concat([entrada]).slice(-300);
      chrome.storage.local.set({ nexoraRgmTrace: combinado });
    });
  } catch (e) {
    // El diagnostico nunca debe romper el flujo real.
  }
}

chrome.runtime.onMessage.addListener((mensaje, sender, sendResponse) => {
  if (mensaje.tipo === "INICIAR_CONSULTA_RGM") {
    iniciarConsulta(mensaje.placa);
    sendResponse({ ok: true });
    return true;
  }

  if (mensaje.tipo === "INICIAR_CONSULTA_JUDICIAL") {
    iniciarConsultaJudicial(mensaje.nombre);
    sendResponse({ ok: true });
    return true;
  }

  if (mensaje.tipo === "INICIAR_FLUJO_RGM_JUDICIAL") {
    ejecutarFlujoRgmJudicial(mensaje.placa);
    sendResponse({ ok: true });
    return true;
  }

  // FASE 2A: reenvia la seleccion explicita de un radicado a la pestana
  // Judicial YA ABIERTA (tabJudicialActual) -- nunca decide ni abre una
  // pestana nueva, solo transporta el mensaje. El radicado viaja tal cual
  // llego, sin tocarlo (string, sin conversion).
  if (mensaje.tipo === "SELECCIONAR_RADICADO_JUDICIAL") {
    if (tabJudicialActual !== null) {
      chrome.tabs
        .sendMessage(tabJudicialActual, { tipo: "SELECCIONAR_RADICADO_JUDICIAL", radicado: mensaje.radicado })
        .catch(() => {});
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, motivo: "NO_HAY_PESTANA_JUDICIAL_ACTIVA" });
    }
    return true;
  }

  // FASE 2B.4: reenvia la orden de regresar al listado ya cargado a la
  // misma pestana Judicial -- mismo patron exacto que SELECCIONAR_RADICADO_JUDICIAL,
  // nunca abre pestana nueva ni reinicia nada.
  if (mensaje.tipo === "REGRESAR_LISTADO_JUDICIAL") {
    if (tabJudicialActual !== null) {
      chrome.tabs.sendMessage(tabJudicialActual, { tipo: "REGRESAR_LISTADO_JUDICIAL" }).catch(() => {});
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, motivo: "NO_HAY_PESTANA_JUDICIAL_ACTIVA" });
    }
    return true;
  }

  // FASE 2A.1: el usuario termino completamente la consulta (RGM +
  // Judicial). Centralizado aqui porque background.js es quien realmente
  // mantiene las referencias de pestana (tabRgmActual/tabJudicialActual);
  // ni popup.js ni judicial.js cierran pestanas directamente.
  if (mensaje.tipo === "FINALIZAR_CONSULTA") {
    finalizarConsultaCompleta().then((resultado) => sendResponse(resultado));
    return true;
  }

  // Reenvio/registro de lo que informa el content script (RGM o Judicial,
  // ambos usan los mismos dos tipos de mensaje genericos).
  if (mensaje.tipo === "ESTADO_ACTUALIZADO") {
    chrome.storage.local.set({
      trabajoActual: {
        estado: mensaje.estado,
        detalle: mensaje.detalle,
        timestamp: mensaje.timestamp,
      },
    });

    // PUENTE REAL (aditivo): si esta pestana pertenece a una consulta
    // externa correlacionada, tambien se traduce a un evento del
    // contrato publico. No cambia nada de lo de arriba (que sigue
    // sirviendo igual al popup). Se espera a estadoListo (rehidratacion)
    // antes de leer los mapas de correlacion, para no competir con la
    // reconstruccion del estado tras un reinicio del Service Worker.
    const tabIdOrigenEstado = sender.tab ? sender.tab.id : null;
    estadoListo.then(() => {
      const idConsultaPorEstado =
        tabIdOrigenEstado !== null
          ? consultaIdPorTabRgm.get(tabIdOrigenEstado) || consultaIdPorTabJudicial.get(tabIdOrigenEstado)
          : null;
      if (!idConsultaPorEstado) return;
      if (mensaje.estado === "RADICADO_ABRIENDO") {
        emitirEvento(idConsultaPorEstado, ESTADOS_CONSULTA.RADICADO_ABRIENDO);
      } else if (
        mensaje.estado === "ERROR_RADICADO_NO_ENCONTRADO" ||
        mensaje.estado === "ERROR_RADICADO_AMBIGUO" ||
        mensaje.estado === "ERROR_ACTUACIONES_NO_ENCONTRADAS" ||
        mensaje.estado === "ERROR_ACTUACIONES_TIMEOUT"
      ) {
        const consultaConError = consultasPorId.get(idConsultaPorEstado);
        if (consultaConError) consultaConError.errores.push(`${mensaje.estado}: ${mensaje.detalle || ""}`.trim());
        finalizarConsultaExterna(idConsultaPorEstado, ESTADOS_CONSULTA.CONSULTA_ERROR);
      } else if (
        mensaje.estado === "LISTADO_JUDICIAL_RESTAURADO" ||
        mensaje.estado === "ERROR_REGRESAR_LISTADO" ||
        mensaje.estado === "ERROR_LISTADO_NO_DISPONIBLE"
      ) {
        // CORRECCION (encargo "retorno al listado + CONSULTA_COMPLETADA"):
        // si hay una espera pendiente (registrada DESPUES de actuaciones
        // por esperarRegresoListadoYCompletar), este mensaje la resuelve
        // -- nunca se finge un exito que volverAlListadoJudicial() no
        // reporto realmente.
        const resolverEspera = esperasRegresoListadoPendientes.get(idConsultaPorEstado);
        if (resolverEspera) {
          resolverEspera(
            mensaje.estado === "LISTADO_JUDICIAL_RESTAURADO"
              ? null
              : `${mensaje.estado}: ${mensaje.detalle || ""}`.trim()
          );
        } else if (mensaje.estado !== "LISTADO_JUDICIAL_RESTAURADO") {
          // Mismo motivo, pero SIN una espera pendiente registrada:
          // ocurrio como guardia PREVIA a abrir un radicado (dentro de
          // SELECCIONAR_RADICADO_JUDICIAL en judicial.js), no despues de
          // actuaciones. Se trata igual que los demas errores de
          // seleccion de la rama de arriba.
          const consultaConErrorListado = consultasPorId.get(idConsultaPorEstado);
          if (consultaConErrorListado) consultaConErrorListado.errores.push(`${mensaje.estado}: ${mensaje.detalle || ""}`.trim());
          finalizarConsultaExterna(idConsultaPorEstado, ESTADOS_CONSULTA.CONSULTA_ERROR);
        }
      }
    });
  }
  if (mensaje.tipo === "RESULTADO_FINAL") {
    let resultado = mensaje.resultado;

    // Si este resultado es de Judicial Y viene de un flujo encadenado en
    // curso, se le adjunta la placa de origen (nunca se sustituye nada de
    // RGM: esto solo etiqueta el resultado de Judicial).
    if (placaOrigenPendiente && resultado && resultado.fuente === "RAMA_JUDICIAL") {
      resultado = { ...resultado, placa_origen: placaOrigenPendiente };
      placaOrigenPendiente = null;
    }

    chrome.storage.local.set({ resultadoFinal: resultado });

    // CORRECCION intermitencia RGM (autorizada): se captura ANTES de que
    // el bloque de abajo resuelva/anule resolverEsperaRgm, para saber si
    // el flujo en memoria (procesarConsultaExterna o
    // ejecutarFlujoRgmJudicial del popup) VA a procesar este resultado.
    // Si es asi, la via de respaldo de mas abajo (fuente "RGM") no vuelve
    // a procesarlo -- evita duplicar RGM_COMPLETADO/INCOMPLETO y el
    // avance hacia Judicial.
    const habiaEsperaRgmEnMemoria = !!resolverEsperaRgm;

    // Si alguien esta esperando este resultado (ejecutarFlujoRgmJudicial
    // esperando a que RGM termine), se lo entregamos ademas de guardarlo.
    if (resolverEsperaRgm) {
      const resolver = resolverEsperaRgm;
      resolverEsperaRgm = null;
      resolver(resultado);
    }

    // PUENTE REAL (aditivo): rutear este RESULTADO_FINAL a su consulta
    // externa por tabId, SIN interferir con el comportamiento de arriba.
    // Se espera a estadoListo por el mismo motivo que en ESTADO_ACTUALIZADO.
    const tabIdOrigenResultado = sender.tab ? sender.tab.id : null;
    const resultadoCapturado = resultado;
    estadoListo.then(() => {
      const idConsultaPorResultado =
        tabIdOrigenResultado !== null
          ? consultaIdPorTabRgm.get(tabIdOrigenResultado) || consultaIdPorTabJudicial.get(tabIdOrigenResultado)
          : null;
      if (!idConsultaPorResultado || !resultadoCapturado) return;

      if (resultadoCapturado.fuente === "RAMA_JUDICIAL") {
        const consultaDestino = consultasPorId.get(idConsultaPorResultado);
        if (!consultaDestino) return;
        if (resultadoCapturado.estado_consulta === "LISTADO_DETECTADO") {
          consultaDestino.judicial = {
            estado: "LISTADO_DETECTADO",
            nombreBuscado: resultadoCapturado.nombre_consultado,
            // Contrato ampliado (encargo "sujetos procesales"): se propaga
            // tal cual lo que judicial.js ya extrajo de la fila real
            // (extraerSujetosProcesales), nunca se inventa ni se infiere
            // aqui -- si judicial.js no encontro nada, ya llega como [].
            procesos: (resultadoCapturado.procesos || []).map((p) => ({
              radicado: p.radicado,
              estado: p.estado_proceso,
              sujetosProcesales: Array.isArray(p.sujetosProcesales) ? p.sujetosProcesales : [],
            })),
            procesoSeleccionado: null,
          };
          emitirEvento(idConsultaPorResultado, ESTADOS_CONSULTA.LISTADO_JUDICIAL_ENTREGADO, { judicial: consultaDestino.judicial });
          emitirEvento(idConsultaPorResultado, ESTADOS_CONSULTA.ESPERANDO_SELECCION);
        } else {
          // Cualquier otro estado_consulta de Judicial (error, sin
          // procesos, etc.) termina la consulta externa con error -- no
          // se inventa un exito que el motor no reporto.
          consultaDestino.errores.push(`Judicial estado_consulta=${resultadoCapturado.estado_consulta || "desconocido"}`);
          finalizarConsultaExterna(idConsultaPorResultado, ESTADOS_CONSULTA.CONSULTA_ERROR);
        }
        return;
      }

      // CORRECCION intermitencia RGM (autorizada): via de RESPALDO para
      // fuente:"RGM", correlacionada por tabId via consultaIdPorTabRgm
      // (via ya existente, la misma que ya se usa para Judicial -- no se
      // inventa ninguna correlacion por "ultimo resultado"). Solo actua
      // si NADIE en memoria iba a procesar este resultado (ver
      // habiaEsperaRgmEnMemoria) y la consulta no esta ya en un estado
      // terminal (doble seguro contra procesar el mismo resultado dos
      // veces).
      if (!habiaEsperaRgmEnMemoria && resultadoCapturado.fuente === "RGM") {
        const consultaDestinoRgm = consultasPorId.get(idConsultaPorResultado);
        if (consultaDestinoRgm && !ESTADOS_TERMINALES.has(consultaDestinoRgm.estado)) {
          continuarConsultaExternaTrasRgm(consultaDestinoRgm, resultadoCapturado);
        }
      }
    });

    // Si el resultado vino de la pestana temporal de Judicial, cerrarla
    // automaticamente desde el service worker (nunca window.close()) --
    // EXCEPTO cuando el resultado es LISTADO_DETECTADO: en ese caso el
    // Connector se detuvo deliberadamente a esperar la seleccion del
    // usuario (fase "detener apertura automatica del primer radicado"), y
    // cerrar la pestana dejaria sin pagina donde despues abrir el proceso
    // elegido.
    const esperandoSeleccion = resultado && resultado.estado_consulta === "LISTADO_DETECTADO";
    if (sender.tab && tabJudicialActual !== null && sender.tab.id === tabJudicialActual && !esperandoSeleccion) {
      chrome.tabs.remove(tabJudicialActual).catch(() => {});
      tabJudicialActual = null;
    }
  }
  return true;
});

// ============================================================
// PUENTE REAL WEB ↔ CONNECTOR — orquestacion, correlacion y
// PERSISTENCIA de consultas (corrige CONSULTA_ID_DESCONOCIDO)
//
// Reemplaza al stub "PRE-PUENTE WEB → CONNECTOR" (misma ubicacion, misma
// base: externally_connectable + chrome.runtime). Reutiliza TAL CUAL
// (sin modificar su interior) las funciones ya calibradas definidas mas
// abajo: iniciarConsulta, iniciarConsultaJudicial,
// esperarProximoResultadoFinal, normalizarPlaca,
// finalizarConsultaCompleta. content.js y judicial.js NO se tocan.
//
// CORRECCION AUTORIZADA (auditoria previa confirmada con evidencia real:
// consultaId "c3d5276e-3cc3-4545-9458-1c9db1ceb7e9" se perdio tras un
// reinicio del Service Worker MV3 -> CONSULTA_ID_DESCONOCIDO): el estado
// de cada consulta externa ahora se persiste en chrome.storage.local
// (clave CLAVE_ESTADO_PUENTE) y se reconstruye al arrancar el script
// (rehidratarEstado/estadoListo), ANTES de que onMessageExternal/
// onConnectExternal puedan usar los mapas. Los Port NUNCA se persisten
// (no son serializables y deben ser conexiones vivas): tras un reinicio
// puertosPorConsultaId siempre empieza vacio; una Web que reconecte con
// chrome.runtime.connect(extensionId, {name: consultaId}) vuelve a
// registrar su Port contra la consulta ya rehidratada.
//
// LIMITACION DOCUMENTADA (sin cambios respecto a la auditoria):
// iniciarConsulta/iniciarConsultaJudicial guardan la pestana que abren
// en una variable singular (tabRgmActual/tabJudicialActual). Por eso
// las consultas externas se procesan de una en una (colaConsultasExternas),
// nunca en paralelo -- esta correccion NO cambia esa limitacion, solo
// hace que el estado sobreviva al reinicio del Service Worker.
// ============================================================

const ESTADOS_CONSULTA = Object.freeze({
  RECIBIDA: "RECIBIDA",
  RGM_EN_PROCESO: "RGM_EN_PROCESO",
  RGM_COMPLETADO: "RGM_COMPLETADO",
  RGM_INCOMPLETO: "RGM_INCOMPLETO",
  JUDICIAL_EN_PROCESO: "JUDICIAL_EN_PROCESO",
  LISTADO_JUDICIAL_ENTREGADO: "LISTADO_JUDICIAL_ENTREGADO",
  ESPERANDO_SELECCION: "ESPERANDO_SELECCION",
  RADICADO_ABRIENDO: "RADICADO_ABRIENDO",
  PROCESO_PRIVADO: "PROCESO_PRIVADO",
  DETALLE_JUDICIAL_ENTREGADO: "DETALLE_JUDICIAL_ENTREGADO",
  ACTUACIONES_ENTREGADAS: "ACTUACIONES_ENTREGADAS",
  CONSULTA_COMPLETADA: "CONSULTA_COMPLETADA",
  CONSULTA_ERROR: "CONSULTA_ERROR",
  CONSULTA_CANCELADA: "CONSULTA_CANCELADA",
});

// Alcance de una consulta externa (rama alcance-rgm, pedido de NEXORA
// FASE 6/7). Ausente o invalido en el mensaje = "COMPLETO": el
// comportamiento exacto de siempre (RGM y, si entrega un nombre util,
// Judicial a continuacion). Cambio aditivo y compatible: ningun llamador
// que no envie "alcance" nota ninguna diferencia.
const ALCANCES_CONSULTA_EXTERNA = Object.freeze({
  RGM: "RGM",
  JUDICIAL: "JUDICIAL",
  COMPLETO: "COMPLETO",
});

// Estados finales: una consulta en uno de estos ya no cambia mas.
const ESTADOS_TERMINALES = new Set([
  ESTADOS_CONSULTA.CONSULTA_COMPLETADA,
  ESTADOS_CONSULTA.CONSULTA_ERROR,
  ESTADOS_CONSULTA.CONSULTA_CANCELADA,
]);

// Estados "estables" en los que la consulta esta quieta esperando una
// decision humana (ningun callback del motor pendiente) -- los UNICOS
// que se consideran seguros de recuperar TAL CUAL tras un reinicio del
// Service Worker, siempre que la pestana Judicial siga existiendo (ver
// rehidratarEstado). Cualquier otro estado no-terminal representa una
// operacion de navegador a mitad de camino: NO se reanuda, se marca
// como interrumpida (seccion 5 del encargo).
const ESTADOS_RECUPERABLES_SIN_REANUDAR_OPERACION = new Set([
  ESTADOS_CONSULTA.LISTADO_JUDICIAL_ENTREGADO,
  ESTADOS_CONSULTA.ESPERANDO_SELECCION,
]);

// Clave UNICA y claramente identificada de chrome.storage.local para
// todo el estado de consultas externas (seccion 15 del encargo).
const CLAVE_ESTADO_PUENTE = "nexoraPuenteConsultasExternas";
const VERSION_ESTADO_PUENTE = 1;
// Retencion minima de una consulta ya terminada antes de limpiarla de
// memoria/storage -- ni borrado instantaneo ni historico completo
// (seccion 9 del encargo).
const MINUTOS_RETENCION_CONSULTA_TERMINADA = 10;

// consultaId -> ConsultaState. Entidad logica independiente por consulta
// (seccion 4 del encargo): nunca se usa "ultimo mensaje"/"ultimo
// resultado" como mecanismo de correlacion, siempre este mapa explicito.
// Se reconstruye al arrancar el Service Worker (ver rehidratarEstado).
const consultasPorId = new Map();
// tabId -> consultaId: unica forma de correlacionar RESULTADO_FINAL /
// ESTADO_ACTUALIZADO (que nunca llevan consultaId, content.js/judicial.js
// no se modifican) con la consulta dueña de esa pestana. Solo puede
// tener, como maximo, las entradas de la consulta actualmente en curso
// (el motor protegido es singular: una a la vez).
const consultaIdPorTabRgm = new Map();
const consultaIdPorTabJudicial = new Map();
// consultaId -> Port (chrome.runtime.connect del lado Web): el canal real
// de eventos Connector -> Web. NUNCA se persiste (no es serializable,
// seccion 4 del encargo); siempre empieza vacio en cada arranque.
const puertosPorConsultaId = new Map();

const colaConsultasExternas = [];
let procesandoColaExterna = false;
// consultaId que esta usando el motor (tabRgmActual/tabJudicialActual)
// AHORA MISMO -- es la base de la correlacion para guardarUltimoResultadoActuaciones,
// que no pasa por ningun mensaje con sender.tab (ver mas abajo).
let consultaExternaEnCurso = null;

// Se dispara UNA sola vez, al cargar el script (cada arranque/reinicio
// del Service Worker). Todo listener externo espera esta promesa ANTES
// de leer los mapas de arriba, para no competir con la rehidratacion
// (seccion 7 del encargo: "no introducir una carrera").
let estadoRehidratado = false;
const estadoListo = rehidratarEstado();

// Whitelist explicita de lo que se persiste de una consulta: NUNCA
// incluye _resolverFin (funcion) ni ninguna referencia a Port -- ninguno
// de los dos es serializable (seccion 4 del encargo).
function serializarConsultaParaStorage(c) {
  return {
    consultaId: c.consultaId,
    placaOrigen: c.placaOrigen,
    alcance: c.alcance,
    judicialDirecto: c.judicialDirecto,
    estado: c.estado,
    rgm: c.rgm,
    judicial: c.judicial,
    errores: c.errores,
    tabRgm: c.tabRgm,
    tabJudicial: c.tabJudicial,
    creadoEn: c.creadoEn,
    actualizadoEn: c.actualizadoEn,
  };
}

async function existeLaPestana(tabId) {
  if (tabId === null || tabId === undefined) return false;
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch (e) {
    return false;
  }
}

// Limpieza de memoria (y, via guardarEstado() de quien la llama, de
// storage): una consulta terminada hace mas de
// MINUTOS_RETENCION_CONSULTA_TERMINADA se elimina de consultasPorId y de
// cualquier mapa que la referencie. No implementa ningun historico
// (seccion 9 del encargo).
function limpiarConsultasTerminadas() {
  const ahoraMs = Date.now();
  let huboLimpieza = false;
  for (const [id, c] of consultasPorId) {
    if (!ESTADOS_TERMINALES.has(c.estado)) continue;
    const actualizadoMs = new Date(c.actualizadoEn).getTime();
    const edadMin = (ahoraMs - actualizadoMs) / 60000;
    if (edadMin < MINUTOS_RETENCION_CONSULTA_TERMINADA) continue;

    consultasPorId.delete(id);
    if (c.tabRgm !== null) consultaIdPorTabRgm.delete(c.tabRgm);
    if (c.tabJudicial !== null) consultaIdPorTabJudicial.delete(c.tabJudicial);
    puertosPorConsultaId.delete(id);
    huboLimpieza = true;
  }
  return huboLimpieza;
}

// Unica funcion que escribe el estado del puente en chrome.storage.local.
// Un fallo de escritura se registra claramente (console.error) y NUNCA
// se finge como exito (seccion 16 del encargo): el estado en memoria
// sigue siendo la fuente de verdad de esta ejecucion del Service Worker,
// solo queda sin sincronizar hasta la siguiente escritura exitosa.
async function guardarEstado() {
  const consultas = {};
  for (const [id, c] of consultasPorId) consultas[id] = serializarConsultaParaStorage(c);

  const tabRgmAConsulta = {};
  for (const [tabId, id] of consultaIdPorTabRgm) tabRgmAConsulta[tabId] = id;
  const tabJudicialAConsulta = {};
  for (const [tabId, id] of consultaIdPorTabJudicial) tabJudicialAConsulta[tabId] = id;

  const estado = {
    version: VERSION_ESTADO_PUENTE,
    consultas,
    tabRgmAConsulta,
    tabJudicialAConsulta,
    consultaExternaEnCurso,
    colaConsultasExternas: colaConsultasExternas.slice(),
  };

  try {
    await chrome.storage.local.set({ [CLAVE_ESTADO_PUENTE]: estado });
  } catch (e) {
    console.error("[PUENTE_REAL] No se pudo persistir el estado de consultas:", e);
  }
}

// Reconstruye consultasPorId/consultaExternaEnCurso/colaConsultasExternas
// al arrancar el Service Worker, ANTES de que cualquier evento externo
// pueda depender de ellos (estadoListo). NUNCA reanuda automaticamente
// una operacion de navegador que haya quedado a mitad de camino (seccion
// 5 del encargo): solo se considera "recuperable tal cual" una consulta
// que estuviera en un estado ESTABLE (ver ESTADOS_RECUPERABLES_SIN_REANUDAR_OPERACION)
// y cuya pestana Judicial siga realmente abierta (seccion 6: se valida,
// nunca se asume). Cualquier otro caso se marca explicitamente como
// interrumpida -- nunca se finge que sigue "en proceso".
async function rehidratarEstado() {
  try {
    const datosGuardados = await chrome.storage.local.get(CLAVE_ESTADO_PUENTE);
    const guardado = datosGuardados && datosGuardados[CLAVE_ESTADO_PUENTE];

    if (!guardado || guardado.version !== VERSION_ESTADO_PUENTE) {
      estadoRehidratado = true;
      return;
    }

    for (const [id, c] of Object.entries(guardado.consultas || {})) {
      consultasPorId.set(id, { ...c, _resolverFin: null });
    }

    const idEnCurso = guardado.consultaExternaEnCurso || null;
    if (idEnCurso) {
      const consulta = consultasPorId.get(idEnCurso);
      if (consulta && !ESTADOS_TERMINALES.has(consulta.estado)) {
        const esEstadoEstable = ESTADOS_RECUPERABLES_SIN_REANUDAR_OPERACION.has(consulta.estado);
        const tabJudicialViva = esEstadoEstable && (await existeLaPestana(consulta.tabJudicial));

        if (esEstadoEstable && tabJudicialViva) {
          // Recuperable TAL CUAL: la pestana Judicial sigue mostrando el
          // listado, nada del motor estaba a mitad de camino. Se
          // restauran tambien las variables singulares protegidas
          // (tabRgmActual/tabJudicialActual, definidas mas abajo) a los
          // valores de ESTA consulta -- son solo numeros/null (nunca
          // funciones ni Port), indispensable para que SELECCIONAR_RADICADO
          // vuelva a apuntar a la pestana correcta.
          consultaExternaEnCurso = idEnCurso;
          tabJudicialActual = consulta.tabJudicial;
          if (consulta.tabRgm !== null) tabRgmActual = consulta.tabRgm;
          consultaIdPorTabJudicial.set(consulta.tabJudicial, idEnCurso);
          if (consulta.tabRgm !== null) consultaIdPorTabRgm.set(consulta.tabRgm, idEnCurso);
        } else {
          const motivo = esEstadoEstable
            ? "la pestana Judicial ya no existe"
            : "operacion de navegador intermedia no reanudable de forma segura";
          consulta.errores.push(
            `INTERRUMPIDA_POR_REINICIO_DEL_SERVICE_WORKER (estado previo: ${consulta.estado}; ${motivo})`
          );
          consulta.estado = ESTADOS_CONSULTA.CONSULTA_ERROR;
          consulta.tabRgm = null;
          consulta.tabJudicial = null;
        }
      }
    }

    // La cola de consultas que NUNCA llegaron a usar el motor si es
    // segura de restaurar tal cual: no tenian ninguna pestana abierta.
    const colaRestaurada = (guardado.colaConsultasExternas || []).filter(
      (id) => consultasPorId.has(id) && id !== idEnCurso
    );
    colaConsultasExternas.push(...colaRestaurada);

    limpiarConsultasTerminadas();
    estadoRehidratado = true;
    await guardarEstado();

    if (colaConsultasExternas.length > 0 && !procesandoColaExterna) {
      procesarColaExternaSiLibre();
    }
  } catch (e) {
    console.error("[PUENTE_REAL] Error al rehidratar el estado de consultas:", e);
    estadoRehidratado = true; // se continua con mapas vacios antes que bloquear el Connector indefinidamente
  }
}

async function emitirEvento(consultaId, tipo, datosExtra) {
  const consulta = consultasPorId.get(consultaId);
  if (!consulta) return;
  consulta.estado = tipo;
  consulta.actualizadoEn = new Date().toISOString();
  if (datosExtra) Object.assign(consulta, datosExtra);

  await guardarEstado();

  const puerto = puertosPorConsultaId.get(consultaId);
  if (!puerto) return;
  try {
    puerto.postMessage({ tipo, consultaId, placaOrigen: consulta.placaOrigen, consulta: consultaPublica(consulta) });
  } catch (e) {
    // El puerto pudo haberse desconectado (pagina Web cerrada/recargada);
    // la consulta sigue viva (en memoria y en storage), no es un error fatal.
  }
}

// Expone SOLO el contrato publico (seccion 5 del encargo); nunca expone
// tabRgm/tabJudicial (detalle interno del Connector).
function consultaPublica(consulta) {
  return {
    consultaId: consulta.consultaId,
    placaOrigen: consulta.placaOrigen,
    alcance: consulta.alcance,
    estado: consulta.estado,
    rgm: consulta.rgm,
    judicial: consulta.judicial,
    errores: consulta.errores,
    // Prompt 8b punto 1: que plan se uso para RGM ("A" sin pestana, "B"
    // con pestana/ventana invisible) y, si fue "B", por que -- consulta.html
    // lo reenvia tal cual a /rgm/trabajador/resultado.
    plan: consulta.plan || null,
    planMotivo: consulta.planMotivo || null,
  };
}

async function crearConsultaExterna(placaOrigen, alcance, judicialDirecto) {
  limpiarConsultasTerminadas();

  const consultaId = crypto.randomUUID();
  const consulta = {
    consultaId,
    placaOrigen,
    alcance: alcance || ALCANCES_CONSULTA_EXTERNA.COMPLETO,
    judicialDirecto: judicialDirecto || null,
    estado: ESTADOS_CONSULTA.RECIBIDA,
    plan: null,
    planMotivo: null,
    rgm: null,
    judicial: null,
    tabRgm: null,
    tabJudicial: null,
    errores: [],
    _resolverFin: null,
    creadoEn: new Date().toISOString(),
    actualizadoEn: new Date().toISOString(),
  };
  consultasPorId.set(consultaId, consulta);
  await guardarEstado();
  return consulta;
}

// Marca el fin (exito o error) de una consulta externa: emite el estado
// final, cierra UNICAMENTE las pestanas de ESA consulta (reutilizando
// finalizarConsultaCompleta, protegida, que ya usa exclusivamente
// tabRgmActual/tabJudicialActual y nunca chrome.tabs.query({})), y libera
// la cola para la siguiente consulta pendiente.
async function finalizarConsultaExterna(consultaId, estadoFinal) {
  const consulta = consultasPorId.get(consultaId);
  if (!consulta) return;

  if (consulta.tabRgm !== null) consultaIdPorTabRgm.delete(consulta.tabRgm);
  if (consulta.tabJudicial !== null) consultaIdPorTabJudicial.delete(consulta.tabJudicial);

  if (consultaId === consultaExternaEnCurso) {
    await finalizarConsultaCompleta(); // protegida, sin modificar
  }

  // Devuelve el foco a la pestana que el usuario tenia activa antes de
  // esta consulta externa (solo se activo la pestana RGM para esta
  // consulta -- ver iniciarConsulta/opciones.activarMientrasExtrae).
  // chrome.tabs.update falla en silencio (try/catch) si esa pestana ya
  // no existe (el usuario la cerro mientras tanto): no es un error fatal.
  if (tabActivaAntesDeConsultaExterna !== null) {
    const tabARestaurar = tabActivaAntesDeConsultaExterna;
    tabActivaAntesDeConsultaExterna = null;
    try {
      await chrome.tabs.update(tabARestaurar, { active: true });
    } catch (e) {
      // La pestana original ya no existe; no hay nada que restaurar.
    }
  }

  await emitirEvento(consultaId, estadoFinal);

  if (consulta._resolverFin) {
    const resolver = consulta._resolverFin;
    consulta._resolverFin = null;
    resolver();
  }
}

// Esperas pendientes de confirmacion de volverAlListadoJudicial() tras
// actuaciones, antes de declarar CONSULTA_COMPLETADA (encargo "retorno
// al listado + CONSULTA_COMPLETADA", seccion 9). consultaId -> funcion
// resolver (ver esperarRegresoListadoYCompletar).
const esperasRegresoListadoPendientes = new Map();
const TIMEOUT_ESPERA_REGRESO_LISTADO_MS = 12000;

// Espera (con limite de tiempo PROPIO, independiente del timeout interno
// de volverAlListadoJudicial, protegida, sin modificar) la confirmacion
// real de que la pestana Judicial volvio a mostrar el listado, antes de
// declarar CONSULTA_COMPLETADA -- nunca antes de comprobarlo.
//
// Razon documentada (seccion 9 del encargo: "si existe una razon tecnica
// fuerte para no hacerlo bloqueante, documentarla") de por que NO es
// bloqueante INDEFINIDAMENTE: el dato que el usuario pidio (las
// actuaciones) ya quedo entregado -- emitirEvento(ACTUACIONES_ENTREGADAS)
// se llama ANTES de invocar esta funcion, nunca despues. Que la pestana
// Judicial vuelva o no a mostrar el listado es una operacion de
// navegacion secundaria; bloquear la senal de "consulta completa" sin
// limite por ella dejaria una consulta con datos ya correctos
// pareciendo "colgada" por un motivo ajeno a esos datos. Por eso esta
// funcion SIEMPRE termina en CONSULTA_COMPLETADA, anotando un error
// informativo en consulta.errores si el regreso fallo o no se confirmo
// a tiempo, en vez de dejar la consulta sin terminar nunca.
function esperarRegresoListadoYCompletar(consultaId) {
  let resuelto = false;

  const finalizar = async (motivoSiFallo) => {
    if (resuelto) return;
    resuelto = true;
    esperasRegresoListadoPendientes.delete(consultaId);
    if (motivoSiFallo) {
      const consulta = consultasPorId.get(consultaId);
      if (consulta) consulta.errores.push(motivoSiFallo);
    }
    await finalizarConsultaExterna(consultaId, ESTADOS_CONSULTA.CONSULTA_COMPLETADA);
  };

  esperasRegresoListadoPendientes.set(consultaId, finalizar);

  setTimeout(() => {
    finalizar("TIMEOUT_ESPERANDO_CONFIRMACION_DE_RETORNO_AL_LISTADO (las actuaciones ya habian sido entregadas correctamente)");
  }, TIMEOUT_ESPERA_REGRESO_LISTADO_MS);
}

async function encolarConsultaExterna(consultaId) {
  colaConsultasExternas.push(consultaId);
  await guardarEstado();
  procesarColaExternaSiLibre();
}

async function procesarColaExternaSiLibre() {
  if (procesandoColaExterna) return;
  procesandoColaExterna = true;

  while (colaConsultasExternas.length > 0) {
    const consultaId = colaConsultasExternas.shift();
    const consulta = consultasPorId.get(consultaId);
    if (!consulta) {
      await guardarEstado();
      continue;
    }

    consultaExternaEnCurso = consultaId;
    await guardarEstado();

    const finDeConsulta = new Promise((resolve) => {
      consulta._resolverFin = resolve;
    });

    try {
      await procesarConsultaExterna(consulta);
    } catch (e) {
      consulta.errores.push(String(e && e.message ? e.message : e));
      await finalizarConsultaExterna(consultaId, ESTADOS_CONSULTA.CONSULTA_ERROR);
    }

    // Espera hasta que la consulta llegue a un estado terminal (lo
    // dispara finalizarConsultaExterna desde el listado/actuaciones/error
    // que llegue despues, de forma asincrona) antes de atender la
    // siguiente de la cola.
    await finDeConsulta;
    consultaExternaEnCurso = null;
    await guardarEstado();
  }

  procesandoColaExterna = false;
}

// Orquestacion RGM -> JUDICIAL de UNA consulta externa correlacionada.
// Funcion HERMANA de ejecutarFlujoRgmJudicial (esa sigue intacta para el
// popup, no se reemplaza): se necesita una version propia porque
// ejecutarFlujoRgmJudicial no devuelve el resultado RGM a su caller --lo
// deja en chrome.storage.local, que iniciarConsultaJudicial limpia de
// inmediato (seccion 12 del encargo: "el resultado RGM puede perderse
// cuando inicia Judicial", corregido aqui capturando resultadoRgm en una
// variable propia de ESTA consulta, nunca en el storage compartido) y
// tampoco expone el tabId de cada pestana. Llama EXCLUSIVAMENTE a
// iniciarConsulta/iniciarConsultaJudicial/esperarProximoResultadoFinal
// (protegidas, sin modificar su interior).
// Continua el flujo RGM -> JUDICIAL para una consulta externa que YA
// tiene su resultado RGM resuelto. COMPARTIDA (correccion intermitencia
// RGM, autorizada) por dos caminos que NUNCA se ejecutan a la vez para
// la misma consulta (ver habiaEsperaRgmEnMemoria en el listener
// RESULTADO_FINAL):
//   1. El camino normal: procesarConsultaExterna, cuando
//      esperaResultadoRgm se resuelve en la misma ejecucion del Service
//      Worker que la inicio (resolverEsperaRgm sigue vivo en memoria).
//   2. La via de respaldo: el listener RESULTADO_FINAL, correlacionando
//      por consultaIdPorTabRgm, cuando resolverEsperaRgm ya no existia
//      (ej. se limpio por otra via) pero la pestana RGM de esta consulta
//      sigue correlacionada.
// Una sola implementacion evita que ambos caminos produzcan resultados
// distintos o dupliquen RGM_COMPLETADO/INCOMPLETO.
async function continuarConsultaExternaTrasRgm(consulta, resultadoRgm) {
  const consultaId = consulta.consultaId;
  consulta.rgm = resultadoRgm || null;

  const rgmOk = resultadoRgm && resultadoRgm.estado === "OK";
  const nombreCrudo = resultadoRgm && resultadoRgm.deudor_garante ? resultadoRgm.deudor_garante.nombre : null;
  const nombre = (nombreCrudo || "").replace(/\s+/g, " ").trim();

  await emitirEvento(consultaId, rgmOk ? ESTADOS_CONSULTA.RGM_COMPLETADO : ESTADOS_CONSULTA.RGM_INCOMPLETO, { rgm: consulta.rgm });

  // Alcance "RGM" (rama alcance-rgm): termina AQUI siempre, nunca
  // encadena Judicial -- a diferencia de "COMPLETO" (el bloque de abajo,
  // comportamiento original exacto, sin cambios).
  if (consulta.alcance === ALCANCES_CONSULTA_EXTERNA.RGM) {
    await finalizarConsultaExterna(consultaId, ESTADOS_CONSULTA.CONSULTA_COMPLETADA);
    return;
  }

  // Regla funcional aprobada (seccion 6, encargo anterior): si RGM
  // obtuvo el NOMBRE, Judicial continua aunque algun otro campo de RGM
  // este incompleto -- NO se exige rgmOk === true, solo nombre utilizable.
  if (!nombre) {
    consulta.errores.push("RGM no devolvio un nombre de deudor/garante utilizable. Judicial no se inicia.");
    await finalizarConsultaExterna(consultaId, ESTADOS_CONSULTA.CONSULTA_ERROR);
    return;
  }

  await emitirEvento(consultaId, ESTADOS_CONSULTA.JUDICIAL_EN_PROCESO, {
    judicial: { estado: "EN_PROCESO", nombreBuscado: nombre, procesos: [], procesoSeleccionado: null },
  });

  await iniciarConsultaJudicial(nombre); // protegida

  consulta.tabJudicial = tabJudicialActual;
  consultaIdPorTabJudicial.set(tabJudicialActual, consultaId);
  await guardarEstado();

  // La funcion termina aqui: el listado llega async por RESULTADO_FINAL
  // (listener onMessage de arriba, ya extendido para rutear por tabId).
  // finalizarConsultaExterna() la cerrara cuando corresponda.
}

// Prueba real: sin este limite, una consulta externa que se quedara
// colgada en el portal (ver nota de iniciarConsulta/EXTERNO_RGM_TIMEOUT)
// se quedaba en RGM_EN_PROCESO para siempre -- nunca CONSULTA_ERROR, y la
// cola nunca quedaba libre para atender la siguiente. A los 2 min sin
// resultado, termina con un motivo claro (visible en "Ultimas 20" de
// /consulta vía consulta.errores).
const TIMEOUT_CONSULTA_EXTERNA_RGM_MS = 2 * 60 * 1000;

async function procesarConsultaExterna(consulta) {
  const consultaId = consulta.consultaId;

  // Alcance "JUDICIAL" (rama alcance-rgm): sin pasar por RGM en absoluto,
  // usando el nombre que ya llego en el mensaje externo.
  if (consulta.alcance === ALCANCES_CONSULTA_EXTERNA.JUDICIAL) {
    return procesarConsultaExternaJudicialDirecta(consulta);
  }

  await emitirEvento(consultaId, ESTADOS_CONSULTA.RGM_EN_PROCESO);
  registrarTraceRgmExterno("EXTERNO_CONSULTA_RGM_EN_PROCESO", `consultaId=${consultaId} placa="${consulta.placaOrigen}"`);

  // Prompt 8b punto 1: sin plan A todavia (ver MOTIVO_SIN_PLAN_A), asi que
  // toda consulta externa queda anotada como plan B desde ya -- antes de
  // llamar a iniciarConsulta, para que quede registrado aunque la
  // consulta termine en error.
  consulta.plan = "B";
  consulta.planMotivo = MOTIVO_SIN_PLAN_A;

  const esperaResultadoRgm = esperarProximoResultadoFinal(); // protegida
  // activarMientrasExtrae=true: causa real de la prueba real (ver nota en
  // iniciarConsulta) -- SOLO para consultas externas, el popup no cambia.
  // Prompt 8b punto 1: ya NO activa una pestana en la ventana de NEXORA
  // (eso era "la pestana del portal" que Gabriel veia abrirse) -- ver
  // iniciarConsulta, que ahora abre una ventana aparte sin foco.
  await iniciarConsulta(consulta.placaOrigen, { activarMientrasExtrae: true });

  // Seguro: las consultas externas se procesan una a la vez, asi que
  // tabRgmActual contiene aqui exactamente la pestana que esta llamada
  // acaba de abrir.
  consulta.tabRgm = tabRgmActual;
  consultaIdPorTabRgm.set(tabRgmActual, consultaId);
  await guardarEstado();

  let yaResuelta = false;
  const idTimeout = setTimeout(async () => {
    if (yaResuelta) return;
    yaResuelta = true;
    const motivo = `TIMEOUT_RGM_2MIN (se quedo colgada sin resultado final -- revisa el NEXORA DEBUG de la pestana; placa="${consulta.placaOrigen}")`;
    registrarTraceRgmExterno("EXTERNO_RGM_TIMEOUT", `consultaId=${consultaId} ${motivo}`);
    consulta.errores.push(motivo);
    await finalizarConsultaExterna(consultaId, ESTADOS_CONSULTA.CONSULTA_ERROR);
    if (resolverEsperaRgm) {
      const resolver = resolverEsperaRgm;
      resolverEsperaRgm = null;
      resolver(null);
    }
  }, TIMEOUT_CONSULTA_EXTERNA_RGM_MS);

  const resultadoRgm = await esperaResultadoRgm;
  if (yaResuelta) return; // el timeout ya cerro esta consulta: no procesar un resultado tardio
  yaResuelta = true;
  clearTimeout(idTimeout);
  await continuarConsultaExternaTrasRgm(consulta, resultadoRgm);
}

// Alcance "JUDICIAL" (rama alcance-rgm, pedido de NEXORA FASE 6/7): arranca
// Judicial directo con el nombre recibido, SIN tocar judicial.js -- reusa
// exactamente la misma forma de abrir Judicial que
// continuarConsultaExternaTrasRgm (iniciarConsultaJudicial, protegida),
// solo que entrando directo en vez de despues de RGM. "documento" (si
// vino en el mensaje) se guarda en consulta.judicialDirecto para
// referencia, pero el buscador real de Consulta Judicial solo busca por
// nombre/razon social -- no se modifico judicial.js para aceptar un
// numero de documento, no existe ese campo en el formulario real.
async function procesarConsultaExternaJudicialDirecta(consulta) {
  const consultaId = consulta.consultaId;
  const nombre = (consulta.judicialDirecto && consulta.judicialDirecto.nombre) || "";

  await emitirEvento(consultaId, ESTADOS_CONSULTA.JUDICIAL_EN_PROCESO, {
    judicial: { estado: "EN_PROCESO", nombreBuscado: nombre, procesos: [], procesoSeleccionado: null },
  });

  await iniciarConsultaJudicial(nombre); // protegida

  consulta.tabJudicial = tabJudicialActual;
  consultaIdPorTabJudicial.set(tabJudicialActual, consultaId);
  await guardarEstado();

  // Termina aqui: el listado llega async por RESULTADO_FINAL (mismo
  // listener de siempre, sin cambios); finalizarConsultaExterna() la
  // cerrara cuando corresponda, igual que en el flujo COMPLETO.
}

chrome.runtime.onMessageExternal.addListener((mensaje, sender, sendResponse) => {
  // "PING": chequeo de disponibilidad para la Web (pedido tras una prueba
  // real donde Consulta mandaba el latido de trabajador -- y el servidor
  // creia que si habia alguien atendiendo la cola -- sin comprobar nunca
  // si la extension de verdad respondia). Responde sincrono, sin tocar
  // ningun estado de consulta ni esperar estadoListo.
  if (mensaje && mensaje.accion === "PING") {
    // Prompt 8b punto 1: version del manifest en la respuesta, para que
    // Consulta pueda mostrar "Connector vX.Y.Z conectado" y avisar si
    // esta vieja (ver VERSION_CONNECTOR_ESPERADA en consulta.html).
    sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
    return false;
  }
  if (!mensaje || mensaje.accion !== "CONSULTAR_PLACA") {
    return false; // no es para este listener; no se responde nada.
  }
  manejarConsultarPlacaExterna(mensaje, sendResponse);
  return true; // mantiene el canal abierto: la respuesta llega async, tras estadoListo.
});

async function manejarConsultarPlacaExterna(mensaje, sendResponse) {
  await estadoListo; // nunca crear una consulta antes de rehidratar el estado previo

  // Alcance (rama alcance-rgm): ausente o invalido => "COMPLETO", el
  // comportamiento de siempre. Cambio aditivo: un llamador que nunca
  // manda "alcance" (por ejemplo el Puente de Prueba) no nota nada distinto.
  const alcanceCrudo = typeof mensaje.alcance === "string" ? mensaje.alcance.trim().toUpperCase() : "";
  const alcance = Object.values(ALCANCES_CONSULTA_EXTERNA).includes(alcanceCrudo)
    ? alcanceCrudo
    : ALCANCES_CONSULTA_EXTERNA.COMPLETO;

  if (alcance === ALCANCES_CONSULTA_EXTERNA.JUDICIAL) {
    const nombre = typeof mensaje.nombre === "string" ? mensaje.nombre.trim() : "";
    if (!nombre) {
      sendResponse({ ok: false, motivo: "NOMBRE_REQUERIDO_PARA_JUDICIAL" });
      return;
    }
    const documento = typeof mensaje.documento === "string" && mensaje.documento.trim() ? mensaje.documento.trim() : null;
    const consulta = await crearConsultaExterna(null, alcance, { nombre, documento });
    sendResponse({ ok: true, consultaId: consulta.consultaId, estado: ESTADOS_CONSULTA.RECIBIDA, alcance });
    await encolarConsultaExterna(consulta.consultaId);
    return;
  }

  const placaCruda = mensaje.placa;
  if (!placaCruda || typeof placaCruda !== "string" || !placaCruda.trim()) {
    sendResponse({ ok: false, motivo: "PLACA_REQUERIDA" });
    return;
  }

  // Validacion estricta LLLDDD reutilizando normalizarPlaca (protegida,
  // la misma que ya usa iniciarConsulta) -- no se duplica la regex.
  const { placa, valida } = normalizarPlaca(placaCruda);
  if (!valida) {
    sendResponse({ ok: false, motivo: "FORMATO_PLACA_INVALIDO" });
    return;
  }

  const consulta = await crearConsultaExterna(placa, alcance);
  sendResponse({ ok: true, consultaId: consulta.consultaId, estado: ESTADOS_CONSULTA.RECIBIDA, placa, alcance });

  await encolarConsultaExterna(consulta.consultaId);
}

// Canal de eventos Connector -> Web (y seleccion de radicado Web ->
// Connector) para UNA consulta: chrome.runtime.connect(extensionId,
// {name: consultaId}) desde la pagina Web. El nombre del puerto ES el
// consultaId -- no existe una identidad separada sin relacion (seccion
// 16 del encargo). No es tecnologia nueva: es la variante de conexion
// larga de la misma familia chrome.runtime ya usada por sendMessage.
chrome.runtime.onConnectExternal.addListener((puerto) => {
  manejarConexionExterna(puerto);
});

async function manejarConexionExterna(puerto) {
  await estadoListo; // nunca resolver un consultaId antes de rehidratar el estado previo

  const consultaId = puerto.name;
  const consulta = consultasPorId.get(consultaId);
  if (!consulta) {
    try {
      puerto.postMessage({ tipo: "CONSULTA_ERROR", motivo: "CONSULTA_ID_DESCONOCIDO" });
    } catch (e) {}
    puerto.disconnect();
    return;
  }

  puertosPorConsultaId.set(consultaId, puerto);
  // Entrega inmediata del estado actual al conectar, por si la Web se
  // conecto tarde y se perdio algun evento emitido antes (o el estado
  // viene recien rehidratado desde chrome.storage.local).
  puerto.postMessage({ tipo: consulta.estado, consultaId, placaOrigen: consulta.placaOrigen, consulta: consultaPublica(consulta) });

  puerto.onMessage.addListener((mensajeDesdeWeb) => {
    if (!mensajeDesdeWeb) return;

    if (mensajeDesdeWeb.accion === "SELECCIONAR_RADICADO") {
      const radicado = String(mensajeDesdeWeb.radicado || "").trim();
      if (!radicado) {
        puerto.postMessage({ tipo: "CONSULTA_ERROR", consultaId, motivo: "RADICADO_REQUERIDO" });
        return;
      }

      // Validacion obligatoria (seccion 10 del encargo): el radicado debe
      // pertenecer al listado YA entregado de ESTA consulta.
      const procesoEnListado = consulta.judicial && consulta.judicial.procesos.find((p) => p.radicado === radicado);
      if (!procesoEnListado) {
        puerto.postMessage({ tipo: "CONSULTA_ERROR", consultaId, motivo: "RADICADO_NO_PERTENECE_A_ESTA_CONSULTA" });
        return;
      }

      if (procesoEnListado.estado === "PROCESO_PRIVADO") {
        consulta.judicial.procesoSeleccionado = { radicado, estado: "PROCESO_PRIVADO" };
        emitirEvento(consultaId, ESTADOS_CONSULTA.PROCESO_PRIVADO, { judicial: consulta.judicial });
        return;
      }

      // Solo se abre el radicado si ESTA consulta es, en este instante,
      // la que realmente tiene el motor/la pestana Judicial (evita abrir
      // un radicado de una consulta distinta a la activa). tabJudicialActual
      // puede venir de esta misma sesion o de una rehidratacion reciente.
      if (consultaId !== consultaExternaEnCurso || tabJudicialActual !== consulta.tabJudicial) {
        puerto.postMessage({ tipo: "CONSULTA_ERROR", consultaId, motivo: "CONSULTA_NO_ACTIVA_EN_EL_MOTOR" });
        return;
      }

      chrome.tabs.sendMessage(tabJudicialActual, { tipo: "SELECCIONAR_RADICADO_JUDICIAL", radicado }).catch(() => {});
      return;
    }

    if (mensajeDesdeWeb.accion === "CANCELAR_CONSULTA") {
      finalizarConsultaExterna(consultaId, ESTADOS_CONSULTA.CONSULTA_CANCELADA);
      return;
    }
  });

  puerto.onDisconnect.addListener(() => {
    puertosPorConsultaId.delete(consultaId);
  });
}

// LIMITACION DOCUMENTADA (hallazgo Regla 13): guardarUltimoResultadoActuaciones()
// en judicial.js escribe DIRECTAMENTE en chrome.storage.local bajo esta
// clave, por diseno explicito de esa funcion (su propio comentario
// explica por que: evita que background.js cierre tabJudicialActual) --
// nunca pasa por enviarResultadoFinal ni por ningun mensaje con
// sender.tab. chrome.storage.onChanged NO entrega informacion de que
// pestana escribio el cambio, asi que la UNICA correlacion posible SIN
// modificar judicial.js es atribuirlo a consultaExternaEnCurso (la unica
// consulta externa usando el motor en este momento), mas una verificacion
// de que el radicado pertenezca a su listado. Paralelismo real en este
// punto especifico requeriria que judicial.js empezara a identificar la
// consulta -- cambio que SI tocaria el archivo protegido y que esta
// tarea NO autoriza.
chrome.storage.onChanged.addListener(async (cambios) => {
  if (!cambios.ultimoResultadoActuaciones) return;
  const resultado = cambios.ultimoResultadoActuaciones.newValue;
  if (!resultado) return;

  // CORRECCION (auditoria previa, hallazgo confirmado): este era el UNICO
  // punto de entrada del puente real que leia consultaExternaEnCurso/
  // consultasPorId sin esperar estadoListo primero -- asimetrico respecto
  // de onMessageExternal/onConnectExternal. Si el Service Worker se
  // reinicio justo antes de que judicial.js escribiera este resultado,
  // consultaExternaEnCurso podia seguir en null (valor inicial del script
  // recien reiniciado) aunque la rehidratacion lo fuera a restaurar
  // microsegundos despues -- causa probable de que ACTUACIONES_ENTREGADAS
  // se perdiera. Cambio minimo: esperar la misma promesa que ya esperan
  // los demas puntos de entrada, sin tocar la estructura de persistencia.
  await estadoListo;

  if (!consultaExternaEnCurso) return;
  const consultaIdActual = consultaExternaEnCurso;
  const consulta = consultasPorId.get(consultaIdActual);
  if (!consulta || !consulta.judicial) return;

  const perteneceAlListado = consulta.judicial.procesos.some((p) => p.radicado === resultado.radicado);
  if (!perteneceAlListado) return;

  consulta.judicial.procesoSeleccionado = {
    radicado: resultado.radicado,
    estado: resultado.estado === "OK" ? "OK" : "ERROR",
    actuaciones: resultado.actuaciones || [],
    motivo: resultado.motivo || null,
  };

  if (resultado.estado === "OK") {
    await emitirEvento(consultaIdActual, ESTADOS_CONSULTA.DETALLE_JUDICIAL_ENTREGADO, { judicial: consulta.judicial });
    await emitirEvento(consultaIdActual, ESTADOS_CONSULTA.ACTUACIONES_ENTREGADAS, { judicial: consulta.judicial });
    // CORRECCION (encargo "retorno al listado + CONSULTA_COMPLETADA",
    // seccion 9): ya no se declara CONSULTA_COMPLETADA inmediatamente
    // aqui. Se espera la confirmacion real de volverAlListadoJudicial()
    // (LISTADO_JUDICIAL_RESTAURADO, via ESTADO_ACTUALIZADO) -- ver
    // esperarRegresoListadoYCompletar, que de todas formas SIEMPRE
    // termina en CONSULTA_COMPLETADA (razon documentada ahi mismo).
    esperarRegresoListadoYCompletar(consultaIdActual);
  } else {
    consulta.errores.push(resultado.motivo || "Error desconocido al extraer actuaciones.");
    await finalizarConsultaExterna(consultaIdActual, ESTADOS_CONSULTA.CONSULTA_ERROR);
  }
});

/**
 * Normaliza una placa de entrada: mayusculas, sin espacios, sin caracteres
 * no alfanumericos. Valida formato de automovil colombiano LLLDDD.
 * No altera el contenido en si (no "corrige" letras/numeros), solo limpia
 * formato.
 */
function normalizarPlaca(entrada) {
  const limpia = (entrada || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return { placa: limpia, valida: REGEX_PLACA_AUTO.test(limpia) };
}

/**
 * Construye la URL de consulta mediante URL + URLSearchParams (codificacion
 * segura de parametros, nunca concatenacion manual de texto).
 */
function construirUrlConsultaGarantia(placa) {
  const url = new URL(BASE_RGM_CONSULTA);
  url.searchParams.set("NumeroBien", placa);
  url.searchParams.set("ConsultaOficial", "false");
  return url.toString();
}

async function publicarEstado(estado, detalle) {
  await chrome.storage.local.set({
    trabajoActual: { estado, detalle: detalle || null, timestamp: new Date().toISOString() },
  });
}

// Reintentos de ANALIZAR_PAGINA_RGM con ack real (chrome.runtime.lastError):
// antes, iniciarConsulta() mandaba el mensaje una sola vez, sin callback,
// asi que si se perdia (pestana todavia navegando/montando en ese instante)
// nadie se enteraba y la consulta se quedaba colgada para siempre en
// RGM_EN_PROCESO (ver nota junto a tabActivaAntesDeConsultaExterna). Solo
// se usa en el camino EXTERNO (ver iniciarConsulta): el popup sigue
// mandando el mensaje tal cual lo hacia antes, sin tocar su comportamiento
// ya validado.
const INTENTOS_ENVIO_ANALIZAR_RGM = 4;
const ESPERA_ENTRE_INTENTOS_ANALIZAR_RGM_MS = 700;

function enviarAnalizarPaginaRgmConReintentos(tabId, placa, intento) {
  intento = intento || 1;
  chrome.tabs.sendMessage(tabId, { tipo: "ANALIZAR_PAGINA_RGM", placa }, (respuesta) => {
    const error = chrome.runtime.lastError;
    if (error) {
      registrarTraceRgmExterno(
        "EXTERNO_ENVIO_FALLIDO",
        `intento=${intento}/${INTENTOS_ENVIO_ANALIZAR_RGM} tabId=${tabId} placa="${placa}" error="${error.message}"`
      );
      if (intento < INTENTOS_ENVIO_ANALIZAR_RGM) {
        setTimeout(
          () => enviarAnalizarPaginaRgmConReintentos(tabId, placa, intento + 1),
          ESPERA_ENTRE_INTENTOS_ANALIZAR_RGM_MS
        );
      } else {
        registrarTraceRgmExterno(
          "EXTERNO_ENVIO_AGOTADO",
          `tabId=${tabId} placa="${placa}" tras ${INTENTOS_ENVIO_ANALIZAR_RGM} intentos sin ack`
        );
      }
      return;
    }
    registrarTraceRgmExterno(
      "EXTERNO_ENVIO_CONFIRMADO",
      `intento=${intento} tabId=${tabId} placa="${placa}" respuesta=${JSON.stringify(respuesta || null)}`
    );
  });
}

async function iniciarConsulta(placaCruda, opciones) {
  opciones = opciones || {};
  await chrome.storage.local.set({ resultadoFinal: null });
  await publicarEstado("VALIDANDO_PLACA", `Validando "${placaCruda}"...`);

  const { placa, valida } = normalizarPlaca(placaCruda);
  if (!valida) {
    await publicarEstado(
      "ERROR",
      `Formato de placa invalido: "${placaCruda}" (se espera LLLDDD, ej. GCT953).`
    );
    return;
  }

  const url = construirUrlConsultaGarantia(placa);
  await publicarEstado("ABRIENDO_RGM", `Abriendo ${url}`);

  if (opciones.activarMientrasExtrae) {
    try {
      const [actual] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      tabActivaAntesDeConsultaExterna = actual ? actual.id : null;
    } catch (e) {
      tabActivaAntesDeConsultaExterna = null;
    }
    registrarTraceRgmExterno("EXTERNO_RGM_INICIO", `placa="${placa}" pestana_previa=${tabActivaAntesDeConsultaExterna}`);
  }

  // UX (autorizado): la pestana de trabajo RGM se crea INACTIVA para el
  // popup -- NEXORA nunca pierde el foco por esto, SIN CAMBIOS.
  //
  // Prompt 8b punto 1: para una consulta EXTERNA (opciones.activarMientrasExtrae,
  // camara/Telegram/estudio/panel atendidas mientras Consulta esta abierta)
  // la version anterior hacia `active: true` en la ventana ACTUAL -- eso
  // es literalmente "la pestana del portal" que le robaba el foco a
  // Gabriel en cada consulta automatica (reportado en la prueba de la
  // Fase 18). La necesidad real (ver EXTERNO_PESTANA_COMPLETA/retries de
  // ANALIZAR_PAGINA_RGM mas abajo) era que la pestana fuera la pestana
  // ACTIVA de SU PROPIA ventana -- una pestana de fondo puede perder el
  // mensaje si el navegador la limita.
  //
  // Decision (anotada, ver CLAUDE.md "decide tu"): ventana aparte PERO
  // fuera de pantalla, NO minimizada. El encargo ofrecia las dos
  // ("focused:false y state:'minimized' (o fuera de pantalla)"); se elige
  // "fuera de pantalla" porque una ventana minimizada pasa sus pestanas a
  // visibilityState:'hidden' (el navegador limita sus temporizadores,
  // igual que una pestana de fondo real -- podria reproducir el mismo
  // bug de mensaje perdido que `active:true` evitaba). Posicionada fuera
  // del area visible pero SIN minimizar, la pestana sigue "visible" para
  // el navegador (sin limitacion de temporizadores) y por fuera de la
  // pantalla para Gabriel. Si en la prueba real la ventana aparece visible
  // en algun monitor/sistema, Gabriel lo anota en el reporte y se cambia a
  // `state: 'minimized'` (ver PRUEBA_MANUAL mas abajo).
  //
  // Se cierra sola al terminar: chrome.tabs.remove en
  // finalizarConsultaCompleta cierra tambien la ventana, al quedar sin
  // pestanas (comportamiento documentado de chrome.tabs.remove).
  let tab;
  if (opciones.activarMientrasExtrae) {
    const ventana = await chrome.windows.create({
      url, focused: false, type: "normal",
      left: -32000, top: -32000, width: 1024, height: 768,
    });
    tab = ventana.tabs[0];
    registrarTraceRgmExterno("EXTERNO_VENTANA_APARTE", `ventanaId=${ventana.id} tabId=${tab.id} url="${url}"`);
  } else {
    tab = await chrome.tabs.create({ url, active: false });
  }
  tabRgmActual = tab.id;

  const listener = (tabId, changeInfo, tabInfo) => {
    if (tabId === tab.id && changeInfo.status === "complete") {
      chrome.tabs.onUpdated.removeListener(listener);
      if (opciones.activarMientrasExtrae) {
        registrarTraceRgmExterno("EXTERNO_PESTANA_COMPLETA", `tabId=${tabId} url="${(tabInfo && tabInfo.url) || ""}"`);
      }
      // Pequena espera adicional por si la pagina sigue cargando contenido
      // via JS/AJAX tras el evento "complete".
      setTimeout(() => {
        if (opciones.activarMientrasExtrae) {
          enviarAnalizarPaginaRgmConReintentos(tab.id, placa, 1);
        } else {
          chrome.tabs.sendMessage(tab.id, { tipo: "ANALIZAR_PAGINA_RGM", placa });
        }
      }, 500);
    }
  };
  chrome.tabs.onUpdated.addListener(listener);
}

// =========================================================================
// JUDICIAL v0.1 - independiente de RGM (funciones separadas, sin tocar
// nada de lo anterior). Abre una pestana temporal, la cierra automatica-
// mente al terminar (ver el listener de RESULTADO_FINAL mas arriba).
// =========================================================================

const URL_CONSULTA_JUDICIAL = "https://consultaprocesos.ramajudicial.gov.co/Procesos/NombreRazonSocial";

async function iniciarConsultaJudicial(nombreCrudo) {
  const nombre = (nombreCrudo || "").trim();

  await chrome.storage.local.set({ resultadoFinal: null });

  if (!nombre) {
    await chrome.storage.local.set({
      trabajoActual: {
        estado: "ERROR",
        detalle: "Nombre vacio: se requiere un nombre o razon social para consultar.",
        timestamp: new Date().toISOString(),
      },
    });
    return;
  }

  await chrome.storage.local.set({
    trabajoActual: {
      estado: "ABRIENDO_JUDICIAL",
      detalle: `Abriendo Consulta Judicial para "${nombre}"...`,
      timestamp: new Date().toISOString(),
    },
  });

  // UX (autorizado): misma correccion que en RGM -- pestana Judicial
  // INACTIVA, sin cambiar URL ni el resto del flujo.
  const tab = await chrome.tabs.create({ url: URL_CONSULTA_JUDICIAL, active: false });
  tabJudicialActual = tab.id;

  const listener = (tabId, changeInfo) => {
    if (tabId === tab.id && changeInfo.status === "complete") {
      chrome.tabs.onUpdated.removeListener(listener);
      // Espera mayor que RGM: esta pagina es una SPA de Vue que sigue
      // montando componentes despues del evento "complete" del documento
      // base (que solo tiene el shell vacio, ver informe de diagnostico).
      setTimeout(() => {
        chrome.tabs.sendMessage(tab.id, { tipo: "EJECUTAR_CONSULTA_JUDICIAL", nombre });
      }, 1200);
    }
  };
  chrome.tabs.onUpdated.addListener(listener);
}

// =========================================================================
// FASE 2A.1: FINALIZAR_CONSULTA -- cierre centralizado de RGM + Judicial
//
// Usa EXCLUSIVAMENTE las referencias que el propio Connector ya mantiene
// (tabRgmActual/tabJudicialActual) -- nunca chrome.tabs.query({}) ni
// ningun otro mecanismo que pudiera afectar pestanas ajenas a esta
// consulta. Segura ante doble llamada: si una pestana ya no existe (el
// usuario la cerro a mano, o ya se habia finalizado antes),
// chrome.tabs.remove() rechaza la promesa y el catch simplemente lo
// ignora -- nunca se propaga como error fatal.
// =========================================================================

async function finalizarConsultaCompleta() {
  const cerrados = { judicial: false, rgm: false };

  if (tabJudicialActual !== null) {
    try {
      await chrome.tabs.remove(tabJudicialActual);
      cerrados.judicial = true;
    } catch (e) {
      // La pestana ya no existia (cerrada a mano, o ya finalizada antes).
      // No es un error fatal: se continua igual con RGM.
    }
    tabJudicialActual = null;
  }

  if (tabRgmActual !== null) {
    try {
      await chrome.tabs.remove(tabRgmActual);
      cerrados.rgm = true;
    } catch (e) {
      // idem
    }
    tabRgmActual = null;
  }

  // Limpia SOLO el estado temporal de navegacion activo (radicado en
  // curso, persona/listado actual) -- nunca logs, auditoria ni ningun
  // dato historico: esta extension todavia no persiste ninguno de esos,
  // asi que no hay nada de eso que limpiar por error.
  resolverEsperaRgm = null;
  placaOrigenPendiente = null;

  await chrome.storage.local.set({
    trabajoActual: {
      estado: "ESPERANDO",
      detalle: "Consulta finalizada. Connector disponible para una nueva consulta.",
      timestamp: new Date().toISOString(),
    },
    resultadoFinal: null,
  });

  return { ok: true, cerrados };
}

// =========================================================================
// ORQUESTACION RGM -> JUDICIAL (correccion de esta tarea)
//
// Esta es la unica pieza nueva: coordina, llamando a iniciarConsulta() y
// iniciarConsultaJudicial() TAL CUAL existen (cero cambios en su interior,
// cero cambios en content.js ni judicial.js), el paso:
//
//   rgm.deudor_garante.nombre  ->  nombre_consulta  ->  campo Judicial
//
// Nunca usa la placa como texto de busqueda judicial. La placa se
// conserva unicamente como placa_origen para asociarla al resultado final.
// =========================================================================

function esperarProximoResultadoFinal() {
  return new Promise((resolve) => {
    resolverEsperaRgm = resolve;
  });
}

async function ejecutarFlujoRgmJudicial(placaCruda) {
  await chrome.storage.local.set({
    trabajoActual: { estado: "RGM_INICIANDO", detalle: `Ejecutando RGM para "${placaCruda}"...`, timestamp: new Date().toISOString() },
    resultadoFinal: null,
  });

  const esperaResultadoRgm = esperarProximoResultadoFinal();
  await iniciarConsulta(placaCruda); // funcion RGM EXISTENTE, sin modificar
  const resultadoRgm = await esperaResultadoRgm;

  const placaOrigen = resultadoRgm ? resultadoRgm.placa_consultada : placaCruda;
  const nombreCrudo = resultadoRgm && resultadoRgm.deudor_garante ? resultadoRgm.deudor_garante.nombre : null;
  // Normalizacion minima (espacios), NUNCA alteracion del contenido.
  const nombre = (nombreCrudo || "").replace(/\s+/g, " ").trim();

  console.log("[NEXORA-RGM]");
  console.log(`placa_consultada=${placaOrigen}`);
  console.log(`deudor_nombre=${nombreCrudo || "(vacio)"}`);

  const rgmOk = resultadoRgm && resultadoRgm.estado === "OK";

  if (!rgmOk || !nombre) {
    await chrome.storage.local.set({
      trabajoActual: {
        estado: "RGM_SIN_DEUDOR",
        detalle: !rgmOk
          ? `RGM no devolvio estado OK (estado real: ${resultadoRgm ? resultadoRgm.estado : "desconocido"}). Judicial NO se inicia.`
          : "RGM no devolvio un nombre de deudor/garante utilizable. Judicial NO se inicia.",
        timestamp: new Date().toISOString(),
      },
      resultadoFinal: resultadoRgm,
    });
    console.log("[NEXORA-JUDICIAL] no iniciado (RGM_SIN_DEUDOR)");
    return;
  }

  console.log("[NEXORA-JUDICIAL]");
  console.log(`placa_origen=${placaOrigen}`);
  console.log(`nombre_consulta=${nombre}`);

  await chrome.storage.local.set({
    trabajoActual: {
      estado: "JUDICIAL_INICIANDO",
      detalle: `Nombre obtenido de RGM: "${nombre}" (placa_origen=${placaOrigen})`,
      timestamp: new Date().toISOString(),
    },
  });

  placaOrigenPendiente = placaOrigen;
  await iniciarConsultaJudicial(nombre); // funcion Judicial EXISTENTE, sin modificar
}
