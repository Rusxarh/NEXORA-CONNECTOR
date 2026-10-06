/**
 * NEXORA CONNECTOR - JUDICIAL v0.1
 * judicial.js
 *
 * Content script INDEPENDIENTE de content.js (RGM). Cero codigo
 * compartido a proposito (seccion 26 de la especificacion: "Judicial NO
 * debe quedar acoplado innecesariamente al extractor RGM"). Matched
 * unicamente contra consultaprocesos.ramajudicial.gov.co (ver manifest.json).
 *
 * NIVEL DE CONFIANZA POR SECCION (para que quede explicito en el propio
 * codigo, no solo en el informe):
 *
 *   ALTA  - confirmado por diagnostico DOM real:
 *           - campo de nombre (label real + fallback documentado a
 *             "input-78"); verificado tras escribir que el valor persiste
 *             y que su .v-input no muestra mensaje de error asociado
 *           - boton "Consultar por nombre o razon social" (aria-label real)
 *           - tabla de Actuaciones (columnas reales confirmadas)
 *           - seleccion de "Natural" en "Tipo de Persona": confirmado por
 *             diagnostico DOM v1/v2/v3 como v-select de Vuetify (input
 *             readonly + [role=button][aria-haspopup=listbox][aria-owns] +
 *             lista que solo existe abierta); verificado via
 *             aria-activedescendant del input, nunca input.value
 *           - seleccion de "Todos los Procesos": CORRECCION tras evidencia
 *             real repetida en dos sesiones distintas (ids input-65/67 una
 *             vez, input-57/59 otra -- confirma que Vuetify los regenera).
 *             Se localiza por relacion estructural real (contenedor
 *             "processFilterBox" -> label con texto exacto -> input via
 *             label.htmlFor) y se verifica via aria-checked="true" +
 *             clase real "v-item--active", nunca via input.checked (que la
 *             evidencia real demostro que puede dar falso negativo)
 *
 *   MEDIA - deteccion semantica razonada, sin selector fijo confirmado:
 *           - deteccion de radicados en el listado (por patron numerico de
 *             20-25 digitos, formato real de radicado colombiano
 *             confirmado en dos casos reales de esta conversacion)
 *           - control de "siguiente pagina" de actuaciones (por
 *             aria-label/texto "siguiente", cerca de la tabla, validando
 *             que el contenido realmente cambio)
 *
 *   BAJA  - mejor esfuerzo sin ninguna confirmacion DOM:
 *           - "Datos del Proceso" (etiquetas buscadas por texto, sin tabla
 *             ni contenedor confirmado)
 *           - mecanismo de apertura de un proceso individual (se asume
 *             navegacion en la MISMA pestana + history.back() para volver;
 *             si el sitio real abre pestana nueva por proceso, esto
 *             necesitara ajuste en una siguiente iteracion, igual que paso
 *             con RGM)
 *
 * No se hacen peticiones HTTP propias. No se intenta evadir CAPTCHA ni
 * ningun control de seguridad: si aparece, el flujo se detiene y reporta
 * INFORMACION_NO_DISPONIBLE o ERROR_CONSULTA, nunca intenta continuar.
 */

const NEXORA_LOG = (msg) => console.log(`[NEXORA-JUDICIAL] ${msg}`);

function enviarEstado(estado, detalle) {
  NEXORA_LOG(`Estado: ${estado}${detalle ? " - " + detalle : ""}`);
  chrome.runtime
    .sendMessage({ tipo: "ESTADO_ACTUALIZADO", estado, detalle: detalle || null, timestamp: new Date().toISOString() })
    .catch(() => {});
}

function enviarResultadoFinal(resultado) {
  chrome.runtime.sendMessage({ tipo: "RESULTADO_FINAL", resultado }).catch(() => {});
}

// =========================================================================
// DIAG-001 — INSTRUMENTACION DIAGNOSTICA DE TIMELINE (NO funcional)
//
// Autorizada explicitamente para investigar por que Judicial falla cuando
// la pestana permanece inactiva (ver README, "Historial tecnico"). Esta
// seccion SOLO OBSERVA: no decide nada, no cambia ningun timer, timeout,
// MutationObserver, selector, navegacion ni contrato de mensajes
// existente. Cada llamada a registrarTrace() es una linea ADICIONAL junto
// al codigo real, nunca un reemplazo de el.
//
// Persistencia: chrome.storage.local (permiso "storage" ya declarado en
// manifest.json, sin cambios) bajo CLAVE_TRACE_JUDICIAL, con un limite de
// LIMITE_TRACE_JUDICIAL entradas (recorte FIFO) para no crecer sin
// control. No guarda contraseñas/cookies/tokens: el unico dato personal
// que puede aparecer en "detalle" es el nombre que el flujo real YA
// recibe (ejecutarConsultaJudicial), nunca un dato nuevo agregado solo
// para debug.
// =========================================================================

const CLAVE_TRACE_JUDICIAL = "nexoraJudicialTrace";
const LIMITE_TRACE_JUDICIAL = 300;
let nexoraTracelineMemoria = [];
let nexoraPanelDebugShadow = null;

function _formatearHoraTrace(fecha) {
  const dos = (n) => String(n).padStart(2, "0");
  const tres = (n) => String(n).padStart(3, "0");
  return `${dos(fecha.getHours())}:${dos(fecha.getMinutes())}:${dos(fecha.getSeconds())}.${tres(fecha.getMilliseconds())}`;
}

/**
 * Registra UN evento de la timeline diagnostica. NO decide nada sobre el
 * flujo real: solo observa y deja constancia (consola + memoria +
 * chrome.storage.local + panel visual). Llamarla nunca debe cambiar el
 * resultado de ninguna funcion existente.
 */
function registrarTrace(evento, detalle) {
  const ahora = new Date();
  const entrada = {
    timestamp: _formatearHoraTrace(ahora),
    perfNow: Math.round(performance.now() * 1000) / 1000,
    evento,
    detalle: detalle || null,
  };

  console.log(`[NEXORA-DIAG] ${entrada.timestamp} | ${evento}${detalle ? " | " + detalle : ""}`);

  nexoraTracelineMemoria.push(entrada);
  if (nexoraTracelineMemoria.length > LIMITE_TRACE_JUDICIAL) {
    nexoraTracelineMemoria = nexoraTracelineMemoria.slice(-LIMITE_TRACE_JUDICIAL);
  }

  try {
    chrome.storage.local.get(CLAVE_TRACE_JUDICIAL, (datos) => {
      const previo = (datos && datos[CLAVE_TRACE_JUDICIAL]) || [];
      const combinado = previo.concat([entrada]).slice(-LIMITE_TRACE_JUDICIAL);
      chrome.storage.local.set({ [CLAVE_TRACE_JUDICIAL]: combinado });
    });
  } catch (e) {
    // Si storage no esta disponible por alguna razon, el diagnostico no
    // debe romper el flujo real: se ignora silenciosamente, el log de
    // consola y la memoria ya quedaron registrados igual.
  }

  _actualizarPanelDebugJudicial();
}

/**
 * Panel visual MINIMO, aislado via Shadow DOM (para no heredar ni filtrar
 * estilos hacia/desde la pagina real de Rama Judicial), fijo en una
 * esquina, con pointer-events:none para garantizar que NUNCA intercepta
 * un click destinado al sitio real. Puramente informativo.
 */
function _crearPanelDebugJudicial() {
  if (nexoraPanelDebugShadow || !document.body) return;
  const host = document.createElement("div");
  host.id = "nexora-debug-judicial-host";
  host.style.cssText = "position:fixed;bottom:8px;right:8px;z-index:2147483647;pointer-events:none;";
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: "open" });
  const estilo = document.createElement("style");
  estilo.textContent = `
    .panel { font-family: monospace; font-size: 10px; line-height: 1.4; background: rgba(0,0,0,0.85);
      color: #0f0; border: 1px solid #0f0; border-radius: 4px; padding: 6px 8px; max-width: 480px;
      max-height: 220px; overflow: hidden; white-space: pre; }
    .titulo { color: #ff0; font-weight: bold; margin-bottom: 4px; }
    .estado { color: #fff; margin-bottom: 4px; }
  `;
  const contenedor = document.createElement("div");
  contenedor.className = "panel";
  contenedor.innerHTML =
    '<div class="titulo">NEXORA DEBUG — JUDICIAL TIMELINE</div>' +
    '<div class="estado" id="estadoActual">Esperando...</div>' +
    '<div id="lineas"></div>';

  shadow.appendChild(estilo);
  shadow.appendChild(contenedor);
  nexoraPanelDebugShadow = shadow;
}

function _actualizarPanelDebugJudicial() {
  try {
    _crearPanelDebugJudicial();
    if (!nexoraPanelDebugShadow) return;
    const lineas = nexoraPanelDebugShadow.getElementById("lineas");
    const estadoActual = nexoraPanelDebugShadow.getElementById("estadoActual");
    if (!lineas) return;
    const ultimas = nexoraTracelineMemoria.slice(-12);
    lineas.textContent = ultimas.map((e) => `${e.timestamp} ${e.evento}${e.detalle ? " " + e.detalle : ""}`).join("\n");
    if (estadoActual && nexoraTracelineMemoria.length > 0) {
      estadoActual.textContent = "Estado actual: " + nexoraTracelineMemoria[nexoraTracelineMemoria.length - 1].evento;
    }
  } catch (e) {
    // Puramente visual: cualquier fallo aqui nunca debe propagarse al flujo real.
  }
}

function normalizarTexto(s) {
  return (s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function limpiarTexto(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function buscarTextoAproximado(frasesPosibles) {
  const texto = normalizarTexto(document.body.innerText);
  return frasesPosibles.some((f) => texto.includes(normalizarTexto(f)));
}

// =========================================================================
// FORMULARIO (confianza ALTA: campo/boton confirmados; MEDIA: selectores
// de tipo persona/tipo de proceso, por texto exacto confirmado sin
// selector de control confirmado)
// =========================================================================

function encontrarBotonPorAriaLabel(ariaLabel) {
  return document.querySelector(`[aria-label="${ariaLabel}"]`);
}

/**
 * Preferido: localizar por el LABEL real "Nombre(s) Apellido o Razón
 * Social" (semantico, resistente a que Vuetify regenere ids). Respaldo
 * documentado: el id "input-78" observado en el diagnostico -- fragil
 * porque Vuetify genera esos ids secuencialmente y pueden cambiar.
 */
function encontrarCampoNombre() {
  const TEXTO_LABEL = "Nombre(s) Apellido o Razón Social";
  const labels = Array.from(document.querySelectorAll("label"));
  const labelEncontrado = labels.find((l) => normalizarTexto(l.textContent).includes(normalizarTexto(TEXTO_LABEL)));

  if (labelEncontrado) {
    if (labelEncontrado.htmlFor) {
      const porFor = document.getElementById(labelEncontrado.htmlFor);
      if (porFor) return porFor;
    }
    const contenedor = labelEncontrado.closest(".v-input, .v-text-field, div");
    const inputCercano = contenedor ? contenedor.querySelector("input") : null;
    if (inputCercano) return inputCercano;
  }

  return document.getElementById("input-78");
}

/**
 * Localiza el radio real de "Todos los Procesos" por su relacion
 * ESTRUCTURAL, no por un id fijo. Evidencia real (dos sesiones distintas,
 * mismo dia): los ids de Vuetify cambian (input-65/67 una vez, input-57/59
 * otra) pero la relacion label[for] -> input, y el contenedor semantico
 * "processFilterBox" (clase real confirmada en el DOM), se mantienen
 * estables. Por eso se usa esa relacion, nunca un id.
 */
function localizarRadioTodosLosProcesos() {
  const TEXTO = "Todos los Procesos (consulta completa, menos rápida)";
  const contenedor = document.querySelector(".processFilterBox") || document;
  const labels = Array.from(contenedor.querySelectorAll("label"));
  const labelEncontrado = labels.find((l) => normalizarTexto(l.textContent) === normalizarTexto(TEXTO));
  if (!labelEncontrado || !labelEncontrado.htmlFor) return null;

  const input = document.getElementById(labelEncontrado.htmlFor);
  if (!input) return null;

  return { input, radioContenedor: input.closest(".v-radio") };
}

/**
 * CORRECCION del falso negativo INPUT_NO_QUEDO_CHECKED: la verificacion
 * anterior usaba input.checked (propiedad nativa del DOM), pero la
 * evidencia real demostro que ese valor puede no reflejar el estado
 * reactivo real de Vuetify. La verificacion correcta -- confirmada en
 * TODAS las capturas DOM reales disponibles -- es aria-checked="true" en
 * el input, reforzada por la clase real "v-item--active" en su .v-radio
 * contenedor inmediato.
 */
function estaTodosLosProcesosActivo(radio) {
  if (!radio) return false;
  const ariaOk = radio.input.getAttribute("aria-checked") === "true";
  const claseOk = !!(radio.radioContenedor && radio.radioContenedor.classList.contains("v-item--active"));
  return ariaOk || claseOk;
}

/**
 * Selecciona "Todos los Procesos" y espera -- polling corto, maximo 1.5s,
 * nunca una espera fija larga -- a que Vuetify refleje el cambio de forma
 * reactiva antes de dar por buena la seleccion. Si ya estaba activo (es la
 * opcion por defecto segun evidencia real), no hace click.
 */
function seleccionarTodosLosProcesos(callback) {
  const radio = localizarRadioTodosLosProcesos();
  if (!radio) {
    callback({ exito: false, motivo: "ERROR_TODOS_LOS_PROCESOS_NO_ENCONTRADO" });
    return;
  }

  if (!estaTodosLosProcesosActivo(radio)) {
    radio.input.click();
  }

  let verificaciones = 0;
  const verificar = () => {
    verificaciones++;
    if (estaTodosLosProcesosActivo(radio)) {
      callback({ exito: true, motivo: null });
      return;
    }
    if (verificaciones > 10) {
      callback({ exito: false, motivo: "TODOS_LOS_PROCESOS_NO_QUEDO_ACTIVO" });
      return;
    }
    setTimeout(verificar, 150);
  };
  setTimeout(verificar, 150);
}

/**
 * "Tipo de Persona" NO es un radio (correccion tras diagnostico DOM real
 * v1/v2/v3): es un v-select de Vuetify. Evidencia confirmada:
 *   - input#input-72 (readonly=true) -- su .value NUNCA cambia a "Natural",
 *     por eso NO se usa input.value como criterio de exito.
 *   - contenedor real: [role="button"][aria-haspopup="listbox"] con
 *     aria-owns apuntando a una lista que SOLO existe en el DOM mientras el
 *     desplegable esta abierto (las opciones "Natural"/"Juridica" no
 *     existen antes de abrirlo).
 *   - tras seleccionar una opcion, Vuetify marca en el INPUT el atributo
 *     aria-activedescendant con el id de la opcion elegida (observado real:
 *     list-item-121-0) -- ese es el indicador real de exito. El id exacto
 *     no se asume fijo entre sesiones: se lee dinamicamente de la opcion
 *     encontrada en ESTA sesion, nunca hardcodeado.
 */
function localizarComponenteTipoPersona() {
  let input = null;
  const labels = Array.from(document.querySelectorAll("label"));
  const labelEncontrado = labels.find((l) =>
    normalizarTexto(l.textContent).includes(normalizarTexto("Tipo de Persona"))
  );
  if (labelEncontrado && labelEncontrado.htmlFor) {
    input = document.getElementById(labelEncontrado.htmlFor);
  }
  if (!input) input = document.getElementById("input-72"); // respaldo observado, no fijo
  if (!input) return null;

  const contenedorSelect = input.closest(".v-select") || input.closest(".v-input");
  const boton =
    (contenedorSelect && contenedorSelect.querySelector("[role='button'][aria-haspopup='listbox']")) ||
    input.closest("[role='button']") ||
    (input.parentElement ? input.parentElement.querySelector("[role='button']") : null);

  if (!boton) return null;
  return { input, boton };
}

/**
 * Abre el v-select (click sobre su contenedor real [role=button]) y espera
 * -- via MutationObserver + polling, maximo 5s -- a que el elemento
 * referenciado por aria-owns exista con contenido. Si ya estaba abierto
 * (aria-owns ya resuelve a una lista con hijos), no vuelve a hacer click.
 */
function abrirYObtenerOpcionesTipoPersona(boton, callback) {
  const TIMEOUT_MS = 5000;
  const ariaOwns = boton.getAttribute("aria-owns");
  if (!ariaOwns) {
    callback(null);
    return;
  }

  const listaConContenido = () => {
    const lista = document.getElementById(ariaOwns);
    return lista && lista.children.length > 0 ? lista : null;
  };

  const yaAbierta = listaConContenido();
  if (yaAbierta) {
    callback(yaAbierta);
    return;
  }

  boton.click();

  let resuelto = false;
  const intentar = () => {
    if (resuelto) return true;
    const lista = listaConContenido();
    if (lista) {
      resuelto = true;
      callback(lista);
      return true;
    }
    return false;
  };

  if (intentar()) return;

  const observer = new MutationObserver(() => {
    if (intentar()) {
      observer.disconnect();
      clearInterval(intervalo);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  const intervalo = setInterval(() => {
    if (intentar()) {
      observer.disconnect();
      clearInterval(intervalo);
    }
  }, 200);

  setTimeout(() => {
    if (resuelto) return;
    resuelto = true;
    observer.disconnect();
    clearInterval(intervalo);
    callback(null);
  }, TIMEOUT_MS);
}

function encontrarOpcionDeListaPorTexto(lista, textoExacto) {
  const normalizado = normalizarTexto(textoExacto);
  const opciones = Array.from(lista.querySelectorAll("[role='option']"));
  const candidatas =
    opciones.length > 0 ? opciones : Array.from(lista.querySelectorAll("li, div")).filter((el) => el.textContent.trim());
  return candidatas.find((el) => normalizarTexto(el.textContent) === normalizado) || null;
}

/**
 * Selecciona "Natural" en el v-select "Tipo de Persona" y VERIFICA el
 * resultado real (aria-activedescendant del input apuntando al id de la
 * opcion elegida, o aria-selected="true" en la propia opcion como
 * respaldo) -- nunca input.value, que permanece vacio segun evidencia real.
 */
function seleccionarTipoPersonaNatural(callback) {
  const componente = localizarComponenteTipoPersona();
  if (!componente) {
    callback({ exito: false, motivo: "ERROR_TIPO_PERSONA_NO_ENCONTRADO" });
    return;
  }

  abrirYObtenerOpcionesTipoPersona(componente.boton, (lista) => {
    if (!lista) {
      callback({ exito: false, motivo: "ERROR_TIPO_PERSONA_NO_ABIERTO" });
      return;
    }

    const opcionNatural = encontrarOpcionDeListaPorTexto(lista, "Natural");
    if (!opcionNatural) {
      callback({ exito: false, motivo: "ERROR_OPCION_NATURAL_NO_ENCONTRADA" });
      return;
    }

    const idOpcion = opcionNatural.id || null;
    opcionNatural.click();

    let verificaciones = 0;
    const verificar = () => {
      verificaciones++;
      const activo = componente.input.getAttribute("aria-activedescendant");
      const confirmado = (idOpcion && activo === idOpcion) || opcionNatural.getAttribute("aria-selected") === "true";

      if (confirmado) {
        callback({ exito: true, motivo: null });
        return;
      }
      if (verificaciones > 10) {
        callback({ exito: false, motivo: "TIPO_PERSONA_NO_SELECCIONADO" });
        return;
      }
      setTimeout(verificar, 200);
    };
    setTimeout(verificar, 200);
  });
}

/**
 * Vuelve a localizar el boton "Consultar por nombre o razon social" JUSTO
 * ANTES del click, en vez de reutilizar la referencia capturada al inicio
 * de ejecutarConsultaJudicial (que puede quedar obsoleta -stale- si Vue
 * re-renderiza el boton, o seguir con disabled/aria-disabled="true" si la
 * validacion reactiva del v-form aun no proceso el nombre recien escrito).
 * Usa polling corto (150ms), con timeout de 5s -- nunca esperas fijas
 * largas -- hasta confirmar que el boton esta: presente, isConnected,
 * disabled !== true y aria-disabled !== "true".
 */
function esperarBotonConsultarInteractuable(callback) {
  const TIMEOUT_MS = 5000;
  const INTERVALO_MS = 150;
  let resuelto = false;
  let intentos = 0;

  const revisar = () => {
    if (resuelto) return;
    intentos++;

    const boton = encontrarBotonPorAriaLabel("Consultar por nombre o razón social");
    const diagnostico = boton
      ? {
          encontrado: true,
          isConnected: boton.isConnected,
          disabled: boton.disabled === true,
          ariaDisabled: boton.getAttribute("aria-disabled"),
          className: boton.className,
          ariaLabel: boton.getAttribute("aria-label"),
        }
      : { encontrado: false };

    const interactuable =
      !!boton && boton.isConnected === true && boton.disabled !== true && boton.getAttribute("aria-disabled") !== "true";

    if (interactuable) {
      resuelto = true;
      NEXORA_LOG(`boton_consultar diagnostico: ${JSON.stringify(diagnostico)}`);
      callback(boton, null);
      return;
    }

    if (intentos * INTERVALO_MS >= TIMEOUT_MS) {
      resuelto = true;
      NEXORA_LOG(`boton_consultar diagnostico (timeout): ${JSON.stringify(diagnostico)}`);
      callback(null, "ERROR_BOTON_CONSULTAR_NO_INTERACTUABLE");
      return;
    }

    setTimeout(revisar, INTERVALO_MS);
  };

  revisar();
}

/**
 * Escribe el nombre y verifica -- sin acceder a estado interno de Vue,
 * solo DOM publico -- que Vuetify realmente lo registro: el valor
 * persiste en el input (no fue descartado/reseteado), y su .v-input
 * contenedor ya no muestra un mensaje de validacion propio (buscado SOLO
 * dentro de ESE contenedor, nunca en toda la pagina, para no confundirlo
 * con un mensaje de error de otro campo). Incluye un blur() -- evento real
 * que un usuario dispara al pasar al siguiente control -- porque Vuetify
 * suele finalizar su validacion en ese momento.
 */
function escribirNombreYVerificar(campoNombre, nombre, callback) {
  const valor = nombre.toUpperCase().trim();
  campoNombre.focus();
  campoNombre.value = valor;
  campoNombre.dispatchEvent(new Event("input", { bubbles: true }));
  campoNombre.dispatchEvent(new Event("change", { bubbles: true }));
  campoNombre.blur();

  const contenedorCampo = campoNombre.closest(".v-input") || campoNombre.parentElement;

  let verificaciones = 0;
  const verificar = () => {
    verificaciones++;
    const valorConservado = campoNombre.value === valor;
    const mensajeError = contenedorCampo ? contenedorCampo.querySelector(".v-messages__message") : null;
    const sinErrorVisible = !mensajeError || !limpiarTexto(mensajeError.textContent);

    // DIAG-002 (diagnostico, NO decide nada): registra el detalle exacto de
    // ESTE intento antes de evaluar exito/fracaso, para poder reconstruir
    // despues cual condicion (valorConservado o sinErrorVisible) fue la
    // que impidio NOMBRE_ESCRITO en segundo plano.
    // DIAG-003 (diagnostico, NO decide nada): foco/visibilidad del documento
    // en ESTE instante, para contrastar la hipotesis de que la revalidacion
    // de Vuetify dependa de un blur/foco real (document.hasFocus()) o de
    // que la pestaña este visible (document.visibilityState/hidden).
    const activeEl = document.activeElement;
    registrarTrace(
      "VERIFICACION_NOMBRE",
      JSON.stringify({
        intento: verificaciones,
        valorConservado,
        valorActual: campoNombre.value,
        valorEsperado: valor,
        sinErrorVisible,
        mensajeErrorPresente: !!mensajeError,
        mensajeErrorTexto: mensajeError ? limpiarTexto(mensajeError.textContent) : null,
        documentHasFocus: document.hasFocus(),
        visibilityState: document.visibilityState,
        documentHidden: document.hidden,
        activeElementTag: activeEl ? activeEl.tagName : null,
        activeElementType: activeEl ? activeEl.getAttribute("type") : null,
        activeElementName: activeEl ? activeEl.getAttribute("name") : null,
        activeElementId: activeEl ? activeEl.id : null,
      })
    );

    if (valorConservado && sinErrorVisible) {
      callback({ exito: true, motivo: null, valor });
      return;
    }
    if (verificaciones > 40) {
      // DIAG-004 (diagnostico, autorizado): presupuesto ampliado de 10 a 40
      // intentos UNICAMENTE para determinar si el estado de validacion
      // eventualmente se resuelve con mas tiempo real en segundo plano.
      // Ningun otro valor de esta funcion cambia.
      callback({
        exito: false,
        motivo: "NOMBRE_NO_VALIDADO",
        valor,
        valorConservado,
        mensajeError: mensajeError ? limpiarTexto(mensajeError.textContent) : null,
      });
      return;
    }
    setTimeout(verificar, 150);
  };
  setTimeout(verificar, 150);
}

/**
 * "Varios registros": modal intermedio real confirmado en Brave que a
 * veces aparece DESPUES de pulsar CONSULTAR y ANTES del listado (cuando
 * hay varios procesos con el mismo nombre). Si no se cierra, el listado
 * nunca aparece en el DOM y el flujo termina en LISTADO_TIMEOUT aunque el
 * click y la consulta funcionaron correctamente. Deteccion 100% por texto
 * (nunca por id: es un dialogo Vuetify con ids generados en runtime), y
 * tolera que aun no exista en el DOM en el instante del click.
 */
const TEXTO_MODAL_VARIOS_REGISTROS = "Se han encontrado varios registros con el mismo nombre o razón social";

function encontrarElementoModalVariosRegistros() {
  const normalizadoBuscado = normalizarTexto(TEXTO_MODAL_VARIOS_REGISTROS);
  const candidatos = Array.from(document.querySelectorAll("div, section, p, span"));
  let mejor = null;
  for (const el of candidatos) {
    if (normalizarTexto(el.textContent).includes(normalizadoBuscado)) {
      if (!mejor || el.textContent.length < mejor.textContent.length) mejor = el;
    }
  }
  return mejor;
}

/**
 * Busca "VOLVER" subiendo desde el mensaje del modal hacia sus ancestros
 * (hasta 6 niveles, cubre el contenedor real del dialogo sin asumir su
 * estructura exacta) y, como respaldo, en todo el documento.
 */
function encontrarBotonVolverEnModal(elementoModal) {
  let raiz = elementoModal;
  for (let nivel = 0; nivel < 6 && raiz && raiz.parentElement; nivel++) {
    raiz = raiz.parentElement;
    const candidatos = Array.from(raiz.querySelectorAll("button, [role='button']"));
    const boton = candidatos.find((b) => normalizarTexto(b.textContent) === normalizarTexto("VOLVER"));
    if (boton) return boton;
  }
  const todos = Array.from(document.querySelectorAll("button, [role='button']"));
  return todos.find((b) => normalizarTexto(b.textContent) === normalizarTexto("VOLVER")) || null;
}

/**
 * Espera (polling corto, maximo 4s) a que aparezca el modal. Si aparece,
 * hace click en VOLVER y espera (maximo 3s adicionales) a que el mensaje
 * desaparezca del DOM antes de continuar. Si nunca aparece dentro del
 * limite, invoca el callback de inmediato para no bloquear el flujo
 * normal -- exactamente como ya se comportaba antes de este cambio.
 */
function manejarModalVariosRegistrosSiAparece(callback) {
  const TIMEOUT_DETECCION_MS = 4000;
  const INTERVALO_MS = 200;
  let intentos = 0;
  let resuelto = false;

  const buscar = () => {
    if (resuelto) return;
    intentos++;

    const elementoModal = encontrarElementoModalVariosRegistros();
    if (elementoModal) {
      resuelto = true;
      NEXORA_LOG("modal varios registros: detectado");

      const botonVolver = encontrarBotonVolverEnModal(elementoModal);
      if (!botonVolver) {
        callback({ detectado: true, cerrado: false, motivo: "ERROR_BOTON_VOLVER_NO_ENCONTRADO" });
        return;
      }

      botonVolver.click();
      NEXORA_LOG("modal varios registros: click VOLVER");

      let verificacionesCierre = 0;
      const verificarCierre = () => {
        verificacionesCierre++;
        if (!encontrarElementoModalVariosRegistros()) {
          NEXORA_LOG("modal varios registros: cerrado");
          callback({ detectado: true, cerrado: true, motivo: null });
          return;
        }
        if (verificacionesCierre > 15) {
          callback({ detectado: true, cerrado: false, motivo: "ERROR_MODAL_NO_CERRO" });
          return;
        }
        setTimeout(verificarCierre, 200);
      };
      setTimeout(verificarCierre, 200);
      return;
    }

    if (intentos * INTERVALO_MS >= TIMEOUT_DETECCION_MS) {
      resuelto = true;
      NEXORA_LOG("modal varios registros: no detectado");
      callback({ detectado: false, cerrado: false, motivo: null });
      return;
    }
    setTimeout(buscar, INTERVALO_MS);
  };

  buscar();
}

function ejecutarConsultaJudicial(nombre) {
  registrarTrace("INICIO_CONSULTA", `nombre="${nombre}"`);
  enviarEstado("VALIDANDO_FORMULARIO", "Localizando formulario de Consulta por Nombre o Razón Social...");

  const campoNombre = encontrarCampoNombre();
  const botonConsultar = encontrarBotonPorAriaLabel("Consultar por nombre o razón social");

  if (!campoNombre || !botonConsultar) {
    capturarSnapshotDesconocido(nombre, "FORMULARIO_NO_ENCONTRADO", {
      campoNombreEncontrado: !!campoNombre,
      botonConsultarEncontrado: !!botonConsultar,
    });
    return;
  }

  registrarTrace("SELECCIONANDO_PERSONA_NATURAL");
  seleccionarTipoPersonaNatural((resultadoNatural) => {
    NEXORA_LOG(`tipo_persona seleccion: exito=${resultadoNatural.exito} motivo=${resultadoNatural.motivo || "ok"}`);

    if (!resultadoNatural.exito) {
      // No se confirma "Natural" realmente seleccionado: detenerse aqui,
      // NO pulsar CONSULTAR (fallaria de todos modos por validacion).
      capturarSnapshotDesconocido(nombre, resultadoNatural.motivo, resultadoNatural);
      return;
    }
    NEXORA_LOG("tipo_persona=NATURAL");
    registrarTrace("PERSONA_NATURAL_OK");

    registrarTrace("SELECCIONANDO_TODOS_PROCESOS");
    seleccionarTodosLosProcesos((resultadoTodosProcesos) => {
      NEXORA_LOG(
        `tipo_consulta seleccion: exito=${resultadoTodosProcesos.exito} motivo=${resultadoTodosProcesos.motivo || "ok"}`
      );

      if (!resultadoTodosProcesos.exito) {
        // CORRECCION: antes se continuaba silenciosamente hacia CONSULTAR
        // incluso si esto fallaba. Ahora, si realmente no queda activo
        // (verificado por aria-checked/v-item--active, no por un id), se
        // detiene el flujo igual que ya se hacia con Natural.
        capturarSnapshotDesconocido(nombre, resultadoTodosProcesos.motivo, resultadoTodosProcesos);
        return;
      }
      registrarTrace("TODOS_PROCESOS_OK");

      registrarTrace("ESCRIBIENDO_NOMBRE");
      escribirNombreYVerificar(campoNombre, nombre, (resultadoNombre) => {
        NEXORA_LOG(
          `nombre preparacion: exito=${resultadoNombre.exito} motivo=${resultadoNombre.motivo || "ok"} valor="${
            resultadoNombre.valor || ""
          }"`
        );

        if (!resultadoNombre.exito) {
          capturarSnapshotDesconocido(nombre, resultadoNombre.motivo, resultadoNombre);
          return;
        }
        registrarTrace("NOMBRE_ESCRITO");

        enviarEstado("CONSULTANDO", `Ejecutando consulta para "${nombre}"...`);

        registrarTrace("ESPERANDO_BOTON_CONSULTAR");
        esperarBotonConsultarInteractuable((botonConsultarActual, motivoError) => {
          if (!botonConsultarActual) {
            capturarSnapshotDesconocido(nombre, motivoError, { paso: "CLICK_CONSULTAR" });
            return;
          }
          registrarTrace("BOTON_CONSULTAR_ENCONTRADO");

          const urlAntesDelClick = location.href;
          NEXORA_LOG(`consultar: click ejecutado. url=${urlAntesDelClick}`);
          botonConsultarActual.click();
          registrarTrace("CONSULTA_ENVIADA");
          setTimeout(() => {
            NEXORA_LOG(
              `consultar: estado 300ms despues del click. url=${location.href} cambioUrl=${
                location.href !== urlAntesDelClick
              }`
            );
          }, 300);

          registrarTrace("ESPERANDO_MODAL");
          manejarModalVariosRegistrosSiAparece((resultadoModal) => {
            registrarTrace(
              resultadoModal.detectado ? "MODAL_DETECTADO" : "MODAL_NO_DETECTADO",
              `detectado=${resultadoModal.detectado} cerrado=${resultadoModal.cerrado} motivo=${resultadoModal.motivo || "ok"}`
            );

            if (resultadoModal.detectado && !resultadoModal.cerrado) {
              // El modal aparecio pero no se pudo cerrar (VOLVER no
              // encontrado, o siguio presente tras el click): no tiene
              // sentido seguir esperando el listado detras de un modal
              // que sigue bloqueando la pantalla.
              capturarSnapshotDesconocido(nombre, resultadoModal.motivo, { paso: "MODAL_VARIOS_REGISTROS" });
              return;
            }

            NEXORA_LOG("listado: esperando resultados");
            registrarTrace("ESPERANDO_LISTADO");
            observarListadoResultados(nombre);
          });
        });
      });
    });
  });
}

// =========================================================================
// LISTADO DE RESULTADOS (confianza MEDIA: deteccion por patron de
// radicado, formato real confirmado: 20-25 digitos)
// =========================================================================

const PATRON_RADICADO = /^\d{20,25}$/;

function encontrarCeldasConRadicado() {
  const elementos = Array.from(document.querySelectorAll("td, span, div, a"));
  const vistos = new Set();
  const resultado = [];
  for (const el of elementos) {
    const textoDirecto = limpiarTexto(
      Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent)
        .join("")
    );
    if (PATRON_RADICADO.test(textoDirecto) && !vistos.has(textoDirecto)) {
      vistos.add(textoDirecto);
      resultado.push({ radicado: textoDirecto, elemento: el });
    }
  }
  return resultado;
}

/**
 * Estructura de columnas del listado (confianza ALTA: confirmada por
 * evidencia DOM real de una consulta EXITOSA para este mismo nombre --
 * ver consulta_judicial_resultados_1_0.txt): "Numero de Radicacion",
 * "Fecha de Radicacion y ultima actuacion" (dos fechas en la misma celda:
 * la primera como texto directo, la segunda dentro de un <button>),
 * "Despacho y Departamento", "Sujetos Procesales".
 */
const ENCABEZADOS_LISTADO_PROCESOS = ["numero de radicacion", "fecha de radicacion", "despacho", "sujetos procesales"];

function encontrarTablaListadoProcesos() {
  const tablas = Array.from(document.querySelectorAll("table"));
  let mejor = null;
  let mejorPuntaje = 0;
  for (const tabla of tablas) {
    const encabezados = Array.from(tabla.querySelectorAll("th, tr:first-child td")).map((c) => normalizarTexto(c.textContent));
    let puntaje = 0;
    for (const esperado of ENCABEZADOS_LISTADO_PROCESOS) {
      if (encabezados.some((t) => t.includes(esperado))) puntaje++;
    }
    if (puntaje > mejorPuntaje) {
      mejorPuntaje = puntaje;
      mejor = tabla;
    }
  }
  return mejorPuntaje >= 3 ? mejor : null;
}

function indiceColumnaListado(tabla, nombres) {
  const encabezados = Array.from(tabla.querySelectorAll("th, tr:first-child td")).map((c) => normalizarTexto(c.textContent));
  for (const nombre of nombres) {
    const idx = encabezados.findIndex((t) => t.includes(normalizarTexto(nombre)));
    if (idx !== -1) return idx;
  }
  return -1;
}

function extraerFechasDeCeldaListado(celda) {
  if (!celda) return { fecha_radicacion: null, fecha_ultima_actuacion: null };
  const contenedor = celda.querySelector("div") || celda;
  const fechaRadicacion =
    limpiarTexto(
      Array.from(contenedor.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent)
        .join(" ")
    ) || null;
  const boton = celda.querySelector("button");
  const fechaUltimaActuacion = boton ? limpiarTexto(boton.textContent) || null : null;
  return { fecha_radicacion: fechaRadicacion, fecha_ultima_actuacion: fechaUltimaActuacion };
}

/**
 * CLASIFICACION DE ESTADO POR FILA (evidencia real confirmada): un
 * proceso real puede no ser abrible aunque tenga radicado valido -- por
 * ejemplo un "PROCESO PRIVADO", cuyo radicado real observado es:
 *   <td class="text-center"><p class="mb-0">05579310300120250021800</p></td>
 * (SIN <button>, a diferencia de una fila normal que SI lo tiene), con el
 * marcador real:
 *   <td class="text-center"><div class="text-left">--- [ PROCESO PRIVADO ] ---</div></td>
 * en OTRA celda de la MISMA fila. La busqueda del marcador se hace sobre
 * el texto de la fila COMPLETA (no una columna fija), porque no hay
 * evidencia de que "PROCESO PRIVADO" viva siempre en la misma columna.
 *
 * Nunca se asume "sin boton = privado": solo se marca PROCESO_PRIVADO si
 * ademas existe el marcador real en la fila; si no existe boton NI
 * marcador, se reporta RESULTADO_NO_IDENTIFICADO (nunca se asume, nunca
 * se descarta la fila).
 */
const TEXTO_PROCESO_PRIVADO = "proceso privado";

function clasificarEstadoProceso(fila, celdaRadicado) {
  const tieneBoton = !!(celdaRadicado && celdaRadicado.querySelector("button"));
  if (tieneBoton) return "PROCESO_ABRIBLE";

  const tieneMarcadorPrivado = normalizarTexto(limpiarTexto(fila.textContent)).includes(TEXTO_PROCESO_PRIVADO);
  if (tieneMarcadorPrivado) return "PROCESO_PRIVADO";

  return "RESULTADO_NO_IDENTIFICADO";
}

/**
 * Convierte el texto crudo de la celda "Sujetos Procesales" (rol:nombre
 * concatenados sin separador fiable, ej. "Demandante: XDemandado: Y") en
 * una lista estructurada [{rol, nombre}]. Mismo criterio ya usado en
 * content.js (extraerTipoServicioDeDescripcion) para "Etiqueta: valor"
 * concatenado: el limite de cada valor es el INICIO de la siguiente
 * etiqueta (palabra con mayuscula inicial seguida de ":"), nunca un
 * separador de espacio/salto de linea que no existe de forma fiable.
 * No inventa ni infiere roles: si el texto no trae ningun "Rol:", o la
 * celda no existe, devuelve [] (nunca fabrica un sujeto).
 */
function extraerSujetosProcesales(textoCrudo) {
  if (!textoCrudo) return [];
  const regexParRolNombre = /([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ ]*?):\s*([^:]*?)(?=[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ ]*?:|$)/g;
  const sujetos = [];
  let coincidencia;
  while ((coincidencia = regexParRolNombre.exec(textoCrudo)) !== null) {
    const rol = limpiarTexto(coincidencia[1]);
    const nombre = limpiarTexto(coincidencia[2]);
    if (rol && nombre) sujetos.push({ rol, nombre });
  }
  return sujetos;
}

function extraerProcesosDeTablaListado(tabla) {
  const idxRadicado = indiceColumnaListado(tabla, ["numero de radicacion"]);
  const idxFechas = indiceColumnaListado(tabla, ["fecha de radicacion"]);
  const idxDespacho = indiceColumnaListado(tabla, ["despacho"]);
  const idxSujetos = indiceColumnaListado(tabla, ["sujetos procesales"]);

  return Array.from(tabla.querySelectorAll("tr"))
    .slice(1)
    .map((fila) => {
      const celdas = fila.children;
      const celdaRadicado = idxRadicado !== -1 ? celdas[idxRadicado] : null;
      const textoRadicado = celdaRadicado ? limpiarTexto(celdaRadicado.textContent) : "";
      const fechas = extraerFechasDeCeldaListado(idxFechas !== -1 ? celdas[idxFechas] : null);
      const celdaSujetos = idxSujetos !== -1 ? celdas[idxSujetos] : null;

      return {
        radicado: textoRadicado || null,
        fecha_radicacion: fechas.fecha_radicacion,
        fecha_ultima_actuacion: fechas.fecha_ultima_actuacion,
        despacho_departamento:
          idxDespacho !== -1 && celdas[idxDespacho] ? limpiarTexto(celdas[idxDespacho].textContent) || null : null,
        // Estructurado (seccion 1/3 del encargo): [{rol, nombre}], nunca
        // string crudo. Se extrae IGUAL para cualquier estado_proceso
        // (abrible/privado/no identificado) -- es la fila real la que
        // decide si hay o no texto que parsear, nunca se fuerza vacio
        // por adelantado solo por ser PROCESO_PRIVADO.
        sujetosProcesales: extraerSujetosProcesales(celdaSujetos ? celdaSujetos.textContent : null),
        estado_proceso: textoRadicado ? clasificarEstadoProceso(fila, celdaRadicado) : null,
      };
    })
    .filter((p) => p.radicado);
}

/**
 * Conserva el ULTIMO listado de procesos ya clasificado (estado_proceso
 * incluido) durante esta sesion Judicial (misma pestana -- este content
 * script no se recarga mientras no haya una navegacion completa de
 * pagina, y ya confirmamos que listado/detalle/Actuaciones/regreso son
 * cambios de vista internos de Vue sin recargar la pagina). Se llena UNA
 * sola vez, cuando se entrega el listado (entregarListadoDeProcesos), y
 * permite decidir si un radicado solicitado es PROCESO_PRIVADO sin volver
 * a tocar el DOM -- reutiliza la clasificacion que ya hizo
 * extraerProcesosDeTablaListado(), nunca la duplica.
 */
let ultimoListadoJudicialProcesos = [];

function buscarProcesoClasificado(radicado) {
  return ultimoListadoJudicialProcesos.find((p) => p.radicado === radicado) || null;
}

/**
 * FASE: separar "detectar listado" de "abrir proceso". El Connector ya NO
 * decide por su cuenta que radicado abrir: entrega la lista completa y se
 * DETIENE. NO llama a iniciarProcesamientoDeProcesos() ni a ninguna
 * funcion que abra un proceso -- esa cola (iniciarProcesamientoDeProcesos,
 * continuarConSiguienteProceso, observarDetalleProceso, etc.) queda
 * intacta y sin usar, lista para la siguiente fase (abrir SOLO el
 * radicado que seleccione el usuario desde NEXORA CORE/Web).
 */
function entregarListadoDeProcesos(nombre, radicados) {
  const tabla = encontrarTablaListadoProcesos();
  let procesos = tabla ? extraerProcesosDeTablaListado(tabla) : [];

  // Respaldo: si la deteccion de columnas no encontro la tabla o no
  // extrajo procesos, no se pierde lo que SI se confirmo (los radicados
  // ya detectados por encontrarCeldasConRadicado, mecanismo sin cambios).
  // estado_proceso se marca RESULTADO_NO_IDENTIFICADO aqui porque este
  // camino de respaldo no tiene la fila real para clasificar de verdad.
  if (procesos.length === 0) {
    procesos = radicados.map((r) => ({
      radicado: r.radicado,
      fecha_radicacion: null,
      fecha_ultima_actuacion: null,
      despacho_departamento: null,
      sujetosProcesales: [], // respaldo sin tabla real identificada: no hay celda que parsear, nunca se inventa
      estado_proceso: "RESULTADO_NO_IDENTIFICADO",
    }));
  }

  ultimoListadoJudicialProcesos = procesos;

  const totalAbribles = procesos.filter((p) => p.estado_proceso === "PROCESO_ABRIBLE").length;
  const totalPrivados = procesos.filter((p) => p.estado_proceso === "PROCESO_PRIVADO").length;
  const totalNoIdentificados = procesos.filter((p) => p.estado_proceso === "RESULTADO_NO_IDENTIFICADO").length;

  NEXORA_LOG(
    `LISTADO_ENTREGADO - ${procesos.length} proceso(s) encontrados (${totalAbribles} PROCESO_ABRIBLE, ${totalPrivados} PROCESO_PRIVADO, ${totalNoIdentificados} RESULTADO_NO_IDENTIFICADO)`
  );
  NEXORA_LOG("ESPERANDO_SELECCION_USUARIO - no se abrirá ningún radicado automáticamente");

  enviarEstado("LISTADO_ENTREGADO", `${procesos.length} proceso(s) entregados. Esperando seleccion del usuario.`);
  enviarResultadoFinal({
    fuente: "RAMA_JUDICIAL",
    nombre_consultado: nombre,
    estado_consulta: "LISTADO_DETECTADO",
    procesos,
  });
  registrarTrace("RESULTADO_ENTREGADO", `${procesos.length} proceso(s) (${totalAbribles} abrible(s))`);
  registrarTrace("FINALIZACION", "estado_final=LISTADO_DETECTADO");
}

function observarListadoResultados(nombre) {
  const TIMEOUT_MS = 20000;
  let resuelto = false;

  const intentar = () => {
    if (resuelto) return true;

    if (buscarTextoAproximado(["no se encontraron", "sin resultados", "no existen procesos", "no hay resultados"])) {
      resuelto = true;
      enviarEstado("SIN_RESULTADOS", "La Rama Judicial no reporto procesos para este nombre.");
      enviarResultadoFinal({ fuente: "RAMA_JUDICIAL", nombre_consultado: nombre, estado_consulta: "SIN_RESULTADOS", procesos: [] });
      registrarTrace("LISTADO_NO_DETECTADO", "SIN_RESULTADOS");
      registrarTrace("RESULTADO_ENTREGADO", "SIN_RESULTADOS (0 procesos)");
      registrarTrace("FINALIZACION", "estado_final=SIN_RESULTADOS");
      return true;
    }

    const radicados = encontrarCeldasConRadicado();
    if (radicados.length > 0) {
      resuelto = true;
      // NOTA: encontrarCeldasConRadicado() solo se usa aqui como DISPARADOR
      // ("¿ya hay resultados?"), nunca como conteo final -- puede
      // sub-contar filas reales (ej. un radicado envuelto en <p>, sin
      // <button>, como un PROCESO_PRIVADO). El conteo real y autoritativo
      // se calcula e informa dentro de entregarListadoDeProcesos()
      // (LISTADO_ENTREGADO), a partir de la tabla real completa.
      enviarEstado("RESULTADO_DETECTADO", "Listado de resultados detectado, extrayendo procesos...");
      NEXORA_LOG("RESULTADO_DETECTADO - listado detectado, extrayendo procesos...");
      registrarTrace("OBSERVER_DETECTO_OBJETIVO", "listado");
      registrarTrace("LISTADO_DETECTADO", `${radicados.length} radicado(s) candidato(s)`);

      entregarListadoDeProcesos(nombre, radicados);
      return true;
    }
    return false;
  };

  if (intentar()) return;

  registrarTrace("OBSERVER_INICIADO", "listado");
  const observer = new MutationObserver(() => {
    if (intentar()) observer.disconnect();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  registrarTrace("TIMER_PROGRAMADO", `listado timeout=${TIMEOUT_MS}ms`);
  const _listadoTimeoutProgramadoEn = performance.now();
  setTimeout(() => {
    if (resuelto) return;
    resuelto = true;
    observer.disconnect();
    const _elapsed = Math.round(performance.now() - _listadoTimeoutProgramadoEn);
    registrarTrace("TIMER_EJECUTADO", `listado timeout programado=${TIMEOUT_MS}ms elapsed=${_elapsed}ms`);
    registrarTrace("OBSERVER_TIMEOUT", "listado");
    registrarTrace("LISTADO_NO_DETECTADO", "LISTADO_TIMEOUT");
    capturarSnapshotDesconocido(nombre, "LISTADO_TIMEOUT");
  }, TIMEOUT_MS);
}

// =========================================================================
// FASE 2A: SELECCION EXPLICITA DE RADICADO (confianza ALTA: estructura
// real confirmada -- boton con <span class="v-btn__content"> conteniendo
// el radicado, dentro del listado ya entregado por LISTADO_DETECTADO).
//
// El Connector NUNCA decide por iniciativa propia que radicado abrir: el
// radicado SIEMPRE llega como parametro explicito desde afuera (mensaje
// SELECCIONAR_RADICADO_JUDICIAL). Se trata siempre como STRING -- nunca
// se convierte a numero, no se le quitan ceros, no se reformatea.
// =========================================================================

/**
 * Localiza TODOS los botones cuyo contenido (span.v-btn__content, o el
 * propio texto del boton como respaldo) coincide EXACTAMENTE con el
 * radicado solicitado. Nunca por id, posicion de fila, indice, ni clases
 * generadas dinamicamente -- solo por la estructura real confirmada y el
 * texto exacto.
 */
function localizarBotonesRadicado(radicadoObjetivo) {
  const botones = Array.from(document.querySelectorAll("button"));
  return botones.filter((b) => {
    const contenido = b.querySelector(".v-btn__content");
    const texto = limpiarTexto((contenido ? contenido.textContent : b.textContent) || "");
    return texto === radicadoObjetivo;
  });
}

/**
 * Espera (MutationObserver + polling, maximo 15s) a que el DOM muestre el
 * texto "DETALLE DEL PROCESO". Una vez visible, NO asume que el radicado
 * correcto ya esta renderizado: da un margen corto adicional (hasta ~1.6s,
 * polling de 200ms) para que el resto del detalle termine de cargar antes
 * de decidir si el radicado visible es el solicitado o si abrio un
 * proceso distinto.
 */
function esperarDetalleProceso(radicadoObjetivo, callback) {
  const TIMEOUT_MS = 15000;
  let resuelto = false;
  let verificandoRadicado = false;
  let observer = null;

  const detener = () => {
    if (observer) observer.disconnect();
  };

  const detalleVisible = () =>
    normalizarTexto(document.body.innerText || "").includes(normalizarTexto("detalle del proceso"));
  const radicadoVisible = () => (document.body.innerText || "").includes(radicadoObjetivo);

  const iniciarVerificacionRadicado = () => {
    if (verificandoRadicado) return;
    verificandoRadicado = true;
    let intentos = 0;
    const revisar = () => {
      if (resuelto) return;
      intentos++;
      if (radicadoVisible()) {
        resuelto = true;
        detener();
        callback({ exito: true, motivo: null });
        return;
      }
      if (intentos > 8) {
        resuelto = true;
        detener();
        callback({ exito: false, motivo: "ERROR_RADICADO_INCORRECTO" });
        return;
      }
      setTimeout(revisar, 200);
    };
    revisar();
  };

  const intentar = () => {
    if (resuelto) return;
    if (detalleVisible()) iniciarVerificacionRadicado();
  };

  intentar();
  if (!resuelto) {
    observer = new MutationObserver(() => intentar());
    observer.observe(document.body, { childList: true, subtree: true });
  }

  setTimeout(() => {
    if (resuelto) return;
    resuelto = true;
    detener();
    callback({ exito: false, motivo: "ERROR_DETALLE_TIMEOUT" });
  }, TIMEOUT_MS);
}

/**
 * Orquesta FASE 2A completa: localizar (0/1/>1 coincidencias), click,
 * esperar y validar el detalle. Reporta cada paso via enviarEstado/
 * NEXORA_LOG, tal como se especifico. NO llama a enviarResultadoFinal en
 * ningun caso -- ni en exito ni en error -- para no disparar el cierre
 * automatico de la pestana Judicial en background.js (que hoy solo se
 * evita para LISTADO_DETECTADO): el usuario debe poder ver el resultado,
 * o intentar con otro radicado, sin perder la pestana.
 */
function seleccionarYAbrirRadicado(radicado) {
  const coincidencias = localizarBotonesRadicado(radicado);

  if (coincidencias.length === 0) {
    NEXORA_LOG(`ERROR_RADICADO_NO_ENCONTRADO - ${radicado}`);
    enviarEstado("ERROR_RADICADO_NO_ENCONTRADO", `No se encontro el radicado ${radicado} en el listado actual.`);
    return;
  }
  if (coincidencias.length > 1) {
    NEXORA_LOG(`ERROR_RADICADO_AMBIGUO - ${radicado} (${coincidencias.length} coincidencias)`);
    enviarEstado(
      "ERROR_RADICADO_AMBIGUO",
      `Se encontraron ${coincidencias.length} coincidencias para el radicado ${radicado}.`
    );
    return;
  }

  NEXORA_LOG(`RADICADO_VALIDADO - ${radicado}`);
  enviarEstado("RADICADO_VALIDADO", `Radicado ${radicado} localizado de forma unica en el listado.`);

  coincidencias[0].click();

  NEXORA_LOG("RADICADO_ABIERTO - esperando detalle");
  enviarEstado("RADICADO_ABRIENDO", `Abriendo el proceso ${radicado}...`);

  esperarDetalleProceso(radicado, (resultado) => {
    if (!resultado.exito) {
      NEXORA_LOG(`${resultado.motivo} - ${radicado}`);
      enviarEstado(resultado.motivo, `Radicado solicitado: ${radicado}.`);
      return;
    }

    NEXORA_LOG(`DETALLE_DETECTADO - ${radicado}`);
    enviarEstado("DETALLE_DETECTADO", `Detalle del proceso ${radicado} confirmado correctamente.`);

    NEXORA_LOG(`ACTUACIONES_ABRIENDO - ${radicado}`);
    enviarEstado("ACTUACIONES_ABRIENDO", `Abriendo la pestaña Actuaciones del proceso ${radicado}...`);

    abrirActuaciones((resultadoActuaciones) => {
      if (!resultadoActuaciones.exito) {
        NEXORA_LOG(`${resultadoActuaciones.motivo} - ${radicado}`);
        enviarEstado(resultadoActuaciones.motivo, `Radicado: ${radicado}.`);
        return;
      }

      NEXORA_LOG(`ACTUACIONES_DETECTADAS - ${radicado}`);
      enviarEstado("ACTUACIONES_DETECTADAS", `Pestaña Actuaciones activa para el proceso ${radicado}.`);

      NEXORA_LOG(`ACTUACIONES_EXTRAYENDO - ${radicado}`);
      enviarEstado("ACTUACIONES_EXTRAYENDO", `Extrayendo la tabla de actuaciones del proceso ${radicado}...`);

      extraerActuacionesJudicial(radicado, (resultadoExtraccion) => {
        if (!resultadoExtraccion.exito) {
          NEXORA_LOG(`${resultadoExtraccion.motivo} - ${radicado}`);
          enviarEstado(resultadoExtraccion.motivo, `Radicado: ${radicado}.`);
          guardarUltimoResultadoActuaciones({
            estado: "ERROR",
            fuente: "JUDICIAL",
            radicado,
            motivo: resultadoExtraccion.motivo,
            actuaciones: [],
          });
          return;
        }

        NEXORA_LOG(`ACTUACIONES_EXTRAIDAS - ${radicado} (${resultadoExtraccion.actuaciones.length} fila(s))`);
        enviarEstado(
          "ACTUACIONES_EXTRAIDAS",
          `${resultadoExtraccion.actuaciones.length} actuacion(es) extraida(s) para el proceso ${radicado}.`
        );
        guardarUltimoResultadoActuaciones({
          estado: "OK",
          fuente: "JUDICIAL",
          radicado,
          actuaciones: resultadoExtraccion.actuaciones,
        });

        // NUEVO (encargo "retorno al listado"): recien DESPUES de entregar
        // el resultado de actuaciones (linea de arriba) se intenta volver
        // al listado -- nunca antes. Reutiliza volverAlListadoJudicial()
        // TAL CUAL existe (sin modificar su interior); esto es una llamada
        // adicional, no un reemplazo de su uso como guardia previa en
        // SELECCIONAR_RADICADO_JUDICIAL (mas abajo, sin cambios).
        NEXORA_LOG(`RETORNO_AL_LISTADO_POST_ACTUACIONES - iniciando para ${radicado}`);
        volverAlListadoJudicial((resultadoRegreso) => {
          if (!resultadoRegreso.exito) {
            NEXORA_LOG(`${resultadoRegreso.motivo} - no se pudo regresar al listado tras actuaciones de ${radicado}`);
            enviarEstado(resultadoRegreso.motivo, `No se pudo confirmar el regreso al listado tras el proceso ${radicado}.`);
            return;
          }
          NEXORA_LOG(`LISTADO_JUDICIAL_RESTAURADO - tras actuaciones de ${radicado} (${resultadoRegreso.totalRadicados} radicado(s))`);
          enviarEstado(
            "LISTADO_JUDICIAL_RESTAURADO",
            `${resultadoRegreso.totalRadicados} radicado(s) disponibles nuevamente en el listado.`
          );
        });
      });
    });
  });
}

// =========================================================================
// FASE 2B - PASO 1: ABRIR LA PESTANA "ACTUACIONES" DEL DETALLE (confianza
// ALTA: estructura real confirmada -- elemento [role="tab"] con texto
// "Actuaciones"; al quedar activa, el MISMO elemento gana aria-selected="true"
// y la clase real "v-tab--active" -- evidencia confirmada tanto para la
// pestana activa por defecto ("Datos del Proceso") como para "Actuaciones"
// inactiva, en el mismo diagnostico real).
//
// ESTA ETAPA NO EXTRAE NINGUNA FILA: solo abre la pestana y confirma que
// quedo activa. La extraccion de actuaciones es una fase posterior.
// =========================================================================

/**
 * Busca TODOS los [role="tab"] y devuelve el que tiene texto EXACTO
 * (normalizado: espacios colapsados, sin mayusculas/acentos) igual a
 * "Actuaciones". Nunca por id, posicion, ni clases generadas
 * dinamicamente.
 */
function localizarTabActuaciones() {
  const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
  return tabs.find((t) => normalizarTexto(t.textContent) === normalizarTexto("Actuaciones")) || null;
}

/**
 * Un tab de Vuetify queda activo con aria-selected="true" Y la clase real
 * "v-tab--active" (ambas evidencias confirmadas en el mismo diagnostico
 * real). Se revisan las dos por redundancia, no se inventa ninguna.
 */
function estaTabActuacionesActiva(tab) {
  if (!tab) return false;
  const ariaOk = tab.getAttribute("aria-selected") === "true";
  const claseOk = typeof tab.className === "string" && tab.className.includes("v-tab--active");
  return ariaOk || claseOk;
}

/**
 * Localiza el tab, hace click si aun no esta activo, y espera (MutationObserver
 * con childList+subtree+attributes, mas polling corto de respaldo, maximo
 * 8s) a que quede realmente activo -- nunca se considera exito solo porque
 * se ejecuto .click(). Re-localiza el tab en cada revision (en vez de
 * conservar la referencia original) por si Vue reemplaza el nodo al
 * renderizar.
 */
function abrirActuaciones(callback) {
  const TIMEOUT_MS = 8000;
  const INTERVALO_MS = 300;

  const tab = localizarTabActuaciones();
  if (!tab) {
    callback({ exito: false, motivo: "ERROR_ACTUACIONES_NO_ENCONTRADAS" });
    return;
  }

  if (estaTabActuacionesActiva(tab)) {
    callback({ exito: true, motivo: null });
    return;
  }

  tab.click();

  let resuelto = false;
  let observer = null;
  let intervalo = null;

  const detener = () => {
    if (observer) observer.disconnect();
    if (intervalo) clearInterval(intervalo);
  };

  const revisar = () => {
    if (resuelto) return;
    if (estaTabActuacionesActiva(localizarTabActuaciones())) {
      resuelto = true;
      detener();
      callback({ exito: true, motivo: null });
    }
  };

  revisar();
  if (!resuelto) {
    observer = new MutationObserver(() => revisar());
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    intervalo = setInterval(revisar, INTERVALO_MS);
  }

  setTimeout(() => {
    if (resuelto) return;
    resuelto = true;
    detener();
    callback({ exito: false, motivo: "ERROR_ACTUACIONES_TIMEOUT" });
  }, TIMEOUT_MS);
}

// =========================================================================
// FASE 2B.2: EXTRACCION ESTRUCTURADA DE ACTUACIONES (confianza ALTA:
// mismas columnas reales confirmadas que ya se documentaron para la
// seccion dormida de abajo -- ENCABEZADOS_ACTUACIONES/encontrarTablaActuaciones/
// extraerActuacionesDeTabla, escritas para el recorrido automatico de
// multiples procesos que hoy no esta en uso). Se escriben funciones
// PROPIAS aqui (mismo criterio, cero cambios a ese codigo dormido) para
// cumplir "agregar de forma aditiva" sin modificar nada existente.
//
// Solo abre/lee la tabla y confirma que el radicado visible sigue siendo
// el solicitado -- NO interpreta, NO clasifica, NO decide nada juridico.
// =========================================================================

const ENCABEZADOS_ACTUACIONES_2B = [
  "fecha de actuacion",
  "actuacion",
  "anotacion",
  "fecha inicia termino",
  "fecha finaliza termino",
  "fecha de registro",
];

/**
 * Igual criterio de puntaje que la version dormida: cuenta cuantos de los
 * 6 encabezados esperados aparecen en la primera fila de cada <table> del
 * documento, y se queda con la de mayor puntaje. Devuelve tanto la tabla
 * como su puntaje para poder distinguir "no hay tabla en absoluto"
 * (puntaje nunca subio de 0, tabla=null) de "hay una tabla pero sus
 * encabezados no coinciden lo suficiente" (tabla existe, puntaje bajo).
 */
function encontrarMejorTablaActuaciones() {
  const tablas = Array.from(document.querySelectorAll("table"));
  let mejor = null;
  let mejorPuntaje = 0;
  for (const tabla of tablas) {
    const encabezados = Array.from(tabla.querySelectorAll("th, tr:first-child td")).map((c) => normalizarTexto(c.textContent));
    let puntaje = 0;
    for (const esperado of ENCABEZADOS_ACTUACIONES_2B) {
      if (encabezados.some((t) => t.includes(esperado))) puntaje++;
    }
    if (puntaje > mejorPuntaje) {
      mejorPuntaje = puntaje;
      mejor = tabla;
    }
  }
  return { tabla: mejor, puntaje: mejorPuntaje };
}

function indiceColumnaActuacion2B(tabla, nombre) {
  const encabezados = Array.from(tabla.querySelectorAll("th, tr:first-child td")).map((c) => normalizarTexto(c.textContent));
  return encabezados.findIndex((t) => t.includes(normalizarTexto(nombre)));
}

/**
 * Convierte cada <tr> de datos (se salta la fila de encabezados) al objeto
 * estructurado pedido. Celda vacia o columna no encontrada -> null, nunca
 * se inventa un valor. Descarta filas totalmente vacias (ninguna celda con
 * contenido real).
 */
function extraerFilasActuaciones(tabla) {
  const indices = {
    fecha_actuacion: indiceColumnaActuacion2B(tabla, "fecha de actuacion"),
    actuacion: indiceColumnaActuacion2B(tabla, "actuacion"),
    anotacion: indiceColumnaActuacion2B(tabla, "anotacion"),
    fecha_inicia_termino: indiceColumnaActuacion2B(tabla, "fecha inicia termino"),
    fecha_finaliza_termino: indiceColumnaActuacion2B(tabla, "fecha finaliza termino"),
    fecha_registro: indiceColumnaActuacion2B(tabla, "fecha de registro"),
  };

  return Array.from(tabla.querySelectorAll("tr"))
    .slice(1)
    .map((fila) => {
      const celdas = fila.children;
      const registro = {};
      for (const [campo, idx] of Object.entries(indices)) {
        registro[campo] = idx !== -1 && celdas[idx] ? limpiarTexto(celdas[idx].textContent) || null : null;
      }
      return registro;
    })
    .filter((r) => Object.values(r).some((v) => v));
}

/**
 * Espera (MutationObserver + polling, maximo 10s) hasta tener: tabla real
 * encontrada, encabezados validos (umbral identico al ya confirmado: 3 de
 * 6), Y al menos una fila de datos -- ademas confirma que el radicado
 * solicitado sigue siendo visible antes de dar por buena la extraccion
 * (reutiliza ERROR_RADICADO_INCORRECTO, el mismo estado ya usado en Fase
 * 2A, en vez de inventar uno nuevo). NO decide "encabezados invalidos" en
 * un poll temprano (evita falsos negativos por una tabla a medio
 * renderizar): esa distincion solo se hace al agotarse el timeout, con el
 * ultimo estado real observado.
 */
function extraerActuacionesJudicial(radicado, callback) {
  const TIMEOUT_MS = 10000;
  const INTERVALO_MS = 300;
  const UMBRAL_ENCABEZADOS = 3;
  let resuelto = false;
  let observer = null;
  let intervalo = null;

  const detener = () => {
    if (observer) observer.disconnect();
    if (intervalo) clearInterval(intervalo);
  };

  const intentar = () => {
    if (resuelto) return;

    const { tabla, puntaje } = encontrarMejorTablaActuaciones();
    if (!tabla || puntaje < UMBRAL_ENCABEZADOS) return;

    const filas = extraerFilasActuaciones(tabla);
    if (filas.length === 0) return;

    if (!document.body.innerText.includes(radicado)) {
      resuelto = true;
      detener();
      callback({ exito: false, motivo: "ERROR_RADICADO_INCORRECTO" });
      return;
    }

    resuelto = true;
    detener();
    callback({ exito: true, motivo: null, actuaciones: filas });
  };

  intentar();
  if (!resuelto) {
    observer = new MutationObserver(() => intentar());
    observer.observe(document.body, { childList: true, subtree: true });
    intervalo = setInterval(intentar, INTERVALO_MS);
  }

  setTimeout(() => {
    if (resuelto) return;
    resuelto = true;
    detener();

    const { tabla, puntaje } = encontrarMejorTablaActuaciones();
    if (!tabla) {
      callback({ exito: false, motivo: "ERROR_ACTUACIONES_TABLA_NO_ENCONTRADA" });
    } else if (puntaje < UMBRAL_ENCABEZADOS) {
      callback({ exito: false, motivo: "ERROR_ACTUACIONES_ENCABEZADOS_INVALIDOS" });
    } else {
      callback({ exito: false, motivo: "ERROR_ACTUACIONES_SIN_DATOS" });
    }
  }, TIMEOUT_MS);
}

/**
 * Persiste el resultado en chrome.storage.local bajo una clave PROPIA
 * (ultimoResultadoActuaciones) -- deliberadamente NO usa enviarResultadoFinal
 * (que dispara RESULTADO_FINAL en background.js). Motivo: background.js
 * cierra tabJudicialActual en cada RESULTADO_FINAL salvo que
 * estado_consulta sea exactamente "LISTADO_DETECTADO"; este resultado usa
 * una forma distinta (estado/fuente/radicado/actuaciones, tal como se
 * especifico) que no encaja en esa excepcion, y esta fase exige
 * explicitamente "no cerrar ninguna pestaña". Igual que en Fase 2A/2A.1,
 * no se toca background.js para lograrlo.
 */
function guardarUltimoResultadoActuaciones(resultado) {
  chrome.storage.local.set({ ultimoResultadoActuaciones: resultado });
}

// =========================================================================
// FASE 2B.4: REGRESAR AL LISTADO YA CARGADO (sin re-ejecutar la consulta)
//
// CORRECCION tras evidencia DOM real (nexora_judicial_clics_3_0.txt,
// nexora_judicial_datos_actuaciones_1_0.txt): confirmado que mientras se
// ve el DETALLE/ACTUACIONES, la tabla del listado NO esta en el DOM (no
// es un simple ocultamiento CSS) -- por eso la version anterior, que solo
// comprobaba presencia sin hacer click, siempre habria fallado. El
// mecanismo real y confirmado es un boton real:
//
//   <button class="v-btn v-btn--text theme--light v-size--default" tab="">
//     <span class="v-btn__content">
//       <i class="... fas fa-arrow-left ..."></i>
//       <span class="ml-2 text-none grey--text body-2">Regresar al listado</span>
//     </span>
//   </button>
//
// (sin id, sin aria-label, sin role -- se localiza por texto EXACTO,
// nunca por id/clase/posicion/href/URL). Una prueba real de clics ya
// registrada (mismo diagnostico) confirma que al pulsarlo la tabla
// original reaparece completa (mismos 7 radicados, mismos datos) y vuelve
// a ser clicable de inmediato -- sin volver a ejecutar Natural, Todos los
// Procesos, Nombre, CONSULTAR ni ninguna consulta nueva.
// =========================================================================

/**
 * Busca el boton "Regresar al listado" por texto EXACTO normalizado
 * (espacios colapsados, sin mayusculas/acentos). Nunca por id, clase,
 * posicion, href ni URL -- ninguno de esos existe de forma fiable en este
 * boton segun la evidencia real.
 */
function localizarBotonRegresarAlListado() {
  const botones = Array.from(document.querySelectorAll("button"));
  return botones.find((b) => normalizarTexto(b.textContent) === normalizarTexto("Regresar al listado")) || null;
}

/**
 * CORRECCION (evidencia real de Brave): encontrarCeldasConRadicado() por
 * si sola NO distingue LISTADO de DETALLE, porque el encabezado "DETALLE
 * DEL PROCESO 11001400300220260067500" tambien contiene un numero de
 * 20-25 digitos como texto plano, y esa funcion busca en TODA la pagina.
 *
 * Deteccion real del LISTADO: exige la tabla real de resultados
 * (encontrarTablaListadoProcesos(), YA validada -- exige encabezados
 * especificos como "Numero de Radicacion"/"Despacho"/"Sujetos
 * Procesales", que NO existen en el encabezado de texto plano del
 * detalle ni en la tabla de Actuaciones) Y, ademas, que DENTRO de esa
 * tabla exista al menos un <button> real con un radicado (mismo
 * PATRON_RADICADO). El radicado del titulo de "DETALLE DEL PROCESO" es
 * texto plano fuera de cualquier tabla asi -- no puede satisfacer esta
 * condicion.
 */
function listadoJudicialRealDisponible() {
  const tabla = encontrarTablaListadoProcesos();
  if (!tabla) return { disponible: false, totalRadicados: 0 };

  const botonesConRadicado = Array.from(tabla.querySelectorAll("button")).filter((b) => {
    const contenido = b.querySelector(".v-btn__content");
    const texto = limpiarTexto((contenido ? contenido.textContent : b.textContent) || "");
    return PATRON_RADICADO.test(texto);
  });

  return { disponible: botonesConRadicado.length > 0, totalRadicados: botonesConRadicado.length };
}

/**
 * Localiza el boton real, hace click, y espera (MutationObserver +
 * polling, timeout controlado de 10s) a que listadoJudicialRealDisponible()
 * confirme el LISTADO REAL (tabla de resultados + botones de radicado
 * dentro de ella) -- nunca solo "hay un numero de 20-25 digitos en la
 * pagina". NO asume exito solo por haber ejecutado el click. Si el
 * listado ya esta presente (por ejemplo, es la primera seleccion de la
 * sesion y nunca hubo un detalle abierto), no hace ningun click -- exito
 * inmediato, sin efecto secundario.
 *
 * Dos errores distintos, cada uno con evidencia propia:
 *   ERROR_REGRESAR_LISTADO    -> el boton "Regresar al listado" ni
 *                                siquiera se encontro (estructura
 *                                inesperada).
 *   ERROR_LISTADO_NO_DISPONIBLE -> el boton SI se encontro y se hizo
 *                                click, pero el listado real no
 *                                reaparecio dentro del timeout.
 */
function volverAlListadoJudicial(callback) {
  const TIMEOUT_MS = 10000;
  const INTERVALO_MS = 250;

  const yaEnListado = listadoJudicialRealDisponible();
  if (yaEnListado.disponible) {
    callback({ exito: true, motivo: null, totalRadicados: yaEnListado.totalRadicados });
    return;
  }

  NEXORA_LOG("REGRESANDO_AL_LISTADO");
  enviarEstado("REGRESANDO_AL_LISTADO", "Buscando el boton 'Regresar al listado'...");

  const boton = localizarBotonRegresarAlListado();
  if (!boton) {
    NEXORA_LOG("ERROR_REGRESAR_LISTADO - boton 'Regresar al listado' no encontrado");
    callback({ exito: false, motivo: "ERROR_REGRESAR_LISTADO" });
    return;
  }

  NEXORA_LOG("boton 'Regresar al listado' encontrado");
  boton.click();
  NEXORA_LOG("clic ejecutado - esperando restauracion del listado");

  let resuelto = false;
  let observer = null;
  let intervalo = null;

  const detener = () => {
    if (observer) observer.disconnect();
    if (intervalo) clearInterval(intervalo);
  };

  const revisar = () => {
    if (resuelto) return;
    const resultado = listadoJudicialRealDisponible();
    if (resultado.disponible) {
      resuelto = true;
      detener();
      NEXORA_LOG(`LISTADO_JUDICIAL_RESTAURADO - ${resultado.totalRadicados} radicado(s) detectados`);
      callback({ exito: true, motivo: null, totalRadicados: resultado.totalRadicados });
    }
  };

  revisar();
  if (!resuelto) {
    observer = new MutationObserver(() => revisar());
    observer.observe(document.body, { childList: true, subtree: true });
    intervalo = setInterval(revisar, INTERVALO_MS);
  }

  setTimeout(() => {
    if (resuelto) return;
    resuelto = true;
    detener();
    NEXORA_LOG("ERROR_LISTADO_NO_DISPONIBLE - el listado no reaparecio dentro del timeout");
    callback({ exito: false, motivo: "ERROR_LISTADO_NO_DISPONIBLE" });
  }, TIMEOUT_MS);
}

// =========================================================================
// PROCESAMIENTO SECUENCIAL DE CADA PROCESO (cola persistida en
// chrome.storage.local, para sobrevivir a navegaciones completas de
// pagina) -- YA NO SE INVOCA AUTOMATICAMENTE desde observarListadoResultados
// (ver entregarListadoDeProcesos arriba). Se conserva intacta para la
// siguiente fase: abrir SOLO el proceso que el usuario seleccione desde
// NEXORA CORE/Web.
// =========================================================================

function iniciarProcesamientoDeProcesos(nombre, radicados) {
  chrome.storage.local.set(
    {
      nexoraJudicialTrabajo: {
        nombre,
        radicadosPendientes: radicados,
        radicadosProcesados: [],
        procesosExtraidos: [],
        timestamp: Date.now(),
      },
    },
    () => continuarConSiguienteProceso()
  );
}

function continuarConSiguienteProceso() {
  chrome.storage.local.get("nexoraJudicialTrabajo", (datos) => {
    const trabajo = datos.nexoraJudicialTrabajo;
    if (!trabajo) return;

    if (trabajo.radicadosPendientes.length === 0) {
      finalizarConsultaJudicial(trabajo);
      return;
    }

    const radicadoActual = trabajo.radicadosPendientes[0];
    const candidatos = encontrarCeldasConRadicado();
    const candidato = candidatos.find((c) => c.radicado === radicadoActual);

    if (!candidato) {
      // No estamos (todavia) en la pagina de listado -- probablemente
      // seguimos en el detalle del proceso anterior. Intentar volver.
      enviarEstado("VOLVIENDO_AL_LISTADO", `Regresando para procesar el radicado ${radicadoActual}...`);
      history.back();
      setTimeout(() => continuarConSiguienteProceso(), 1500);
      return;
    }

    const controlClicable = candidato.elemento.closest("a, button, [role='button']") || candidato.elemento;
    enviarEstado("ABRIENDO_PROCESO", `Abriendo proceso ${radicadoActual}...`);
    controlClicable.click();
    observarDetalleProceso(radicadoActual);
  });
}

// =========================================================================
// DETALLE DEL PROCESO (confianza BAJA para Datos del Proceso; ALTA para
// Actuaciones)
// =========================================================================

function buscarValorPorEtiquetaGenerico(etiquetaBuscada) {
  const normalizado = normalizarTexto(etiquetaBuscada).replace(/:$/, "");
  const elementos = Array.from(document.querySelectorAll("td, th, div, span, dt, label"));
  for (const el of elementos) {
    const texto = normalizarTexto(el.textContent).replace(/:$/, "");
    if (texto !== normalizado) continue;

    const siguiente = el.nextElementSibling;
    if (siguiente) {
      const valor = limpiarTexto(siguiente.textContent);
      if (valor) return valor;
    }
    const contenedor = el.parentElement;
    const siguienteContenedor = contenedor ? contenedor.nextElementSibling : null;
    if (siguienteContenedor) {
      const valor = limpiarTexto(siguienteContenedor.textContent);
      if (valor) return valor;
    }
  }
  return null;
}

function extraerDatosDelProceso() {
  return {
    radicado: buscarValorPorEtiquetaGenerico("Radicación") || buscarValorPorEtiquetaGenerico("Número de Radicado") || null,
    fecha_radicacion: buscarValorPorEtiquetaGenerico("Fecha de Radicación"),
    despacho: buscarValorPorEtiquetaGenerico("Despacho"),
    tipo_proceso: buscarValorPorEtiquetaGenerico("Tipo de Proceso"),
  };
}

const ENCABEZADOS_ACTUACIONES = [
  "fecha de actuacion",
  "actuacion",
  "anotacion",
  "fecha inicia termino",
  "fecha finaliza termino",
  "fecha de registro",
];

function encontrarTablaActuaciones() {
  const tablas = Array.from(document.querySelectorAll("table"));
  let mejor = null;
  let mejorPuntaje = 0;
  for (const tabla of tablas) {
    const encabezados = Array.from(tabla.querySelectorAll("th, tr:first-child td")).map((c) => normalizarTexto(c.textContent));
    let puntaje = 0;
    for (const esperado of ENCABEZADOS_ACTUACIONES) {
      if (encabezados.some((t) => t.includes(esperado))) puntaje++;
    }
    if (puntaje > mejorPuntaje) {
      mejorPuntaje = puntaje;
      mejor = tabla;
    }
  }
  return mejorPuntaje >= 3 ? mejor : null;
}

function indiceColumnaActuacion(tabla, nombres) {
  const encabezados = Array.from(tabla.querySelectorAll("th, tr:first-child td")).map((c) => normalizarTexto(c.textContent));
  for (const nombre of nombres) {
    const idx = encabezados.findIndex((t) => t.includes(normalizarTexto(nombre)));
    if (idx !== -1) return idx;
  }
  return -1;
}

function extraerActuacionesDeTabla(tabla) {
  const indices = {
    fecha_actuacion: indiceColumnaActuacion(tabla, ["fecha de actuacion"]),
    actuacion: indiceColumnaActuacion(tabla, ["actuacion"]),
    anotacion: indiceColumnaActuacion(tabla, ["anotacion"]),
    fecha_inicia_termino: indiceColumnaActuacion(tabla, ["fecha inicia termino"]),
    fecha_finaliza_termino: indiceColumnaActuacion(tabla, ["fecha finaliza termino"]),
    fecha_registro: indiceColumnaActuacion(tabla, ["fecha de registro"]),
  };
  return Array.from(tabla.querySelectorAll("tr"))
    .slice(1)
    .map((fila) => {
      const celdas = fila.children;
      const registro = {};
      for (const [campo, idx] of Object.entries(indices)) {
        registro[campo] = idx !== -1 && celdas[idx] ? limpiarTexto(celdas[idx].textContent) || null : null;
      }
      return registro;
    })
    .filter((r) => Object.values(r).some((v) => v));
}

/**
 * Control de "siguiente pagina": buscado CERCA de la tabla (su
 * contenedor), nunca en toda la pagina, para no confundirlo con otro
 * boton generico. Se descarta si esta deshabilitado.
 */
function encontrarControlSiguientePagina(tabla) {
  const zona = tabla.closest("div") || tabla.parentElement || document;
  const candidatos = Array.from(zona.querySelectorAll("button, a, [role='button']"));
  return (
    candidatos.find((el) => {
      const etiqueta = normalizarTexto(el.getAttribute("aria-label") || el.textContent || "");
      const deshabilitado = el.disabled || el.getAttribute("aria-disabled") === "true";
      return etiqueta.includes("siguiente") && !deshabilitado;
    }) || null
  );
}

/**
 * Recolecta TODAS las actuaciones recorriendo paginacion real: tras cada
 * clic en "siguiente", valida que la primera fila de la tabla realmente
 * cambio antes de continuar (evita falsos positivos de paginacion y
 * bucles infinitos). Deduplica por combinacion fecha_actuacion+actuacion+
 * fecha_registro.
 */
function recolectarTodasLasActuaciones(callback, acumulado = []) {
  const tabla = encontrarTablaActuaciones();
  if (!tabla) {
    callback(acumulado, acumulado.length === 0 ? "TABLA_ACTUACIONES_NO_ENCONTRADA" : null);
    return;
  }

  const nuevasFilas = extraerActuacionesDeTabla(tabla);
  const firmaAntes = JSON.stringify(nuevasFilas[0] || null);

  const clave = (a) => `${a.fecha_actuacion}|${a.actuacion}|${a.fecha_registro}`;
  const clavesExistentes = new Set(acumulado.map(clave));
  const filasNuevas = nuevasFilas.filter((f) => !clavesExistentes.has(clave(f)));
  const totalAcumulado = acumulado.concat(filasNuevas);

  const controlSiguiente = encontrarControlSiguientePagina(tabla);
  if (!controlSiguiente) {
    callback(totalAcumulado, null);
    return;
  }

  controlSiguiente.click();

  let verificaciones = 0;
  const verificar = () => {
    verificaciones++;
    const tablaNueva = encontrarTablaActuaciones();
    const primeraFilaNueva = tablaNueva ? extraerActuacionesDeTabla(tablaNueva)[0] : null;
    const firmaAhora = JSON.stringify(primeraFilaNueva || null);

    if (firmaAhora !== firmaAntes) {
      recolectarTodasLasActuaciones(callback, totalAcumulado);
      return;
    }
    if (verificaciones > 10) {
      callback(totalAcumulado, null); // se asume ultima pagina real
      return;
    }
    setTimeout(verificar, 400);
  };
  setTimeout(verificar, 400);
}

// =========================================================================
// ANALISIS DE ACTUACIONES RELEVANTES (nunca una decision juridica: solo
// marca coincidencias de texto, conservando TODA la evidencia)
// =========================================================================

const PALABRAS_TERMINACION = ["terminacion", "archivo", "desistimiento", "sentencia", "transaccion"];
const PALABRAS_LEVANTAMIENTO = ["levantamiento"];

function clasificarProcesoPorActuaciones(actuaciones) {
  if (!actuaciones || actuaciones.length === 0) return { estado: "SIN_INFORMACION", relevantes: [] };

  const relevantes = [];
  let hayTerminacion = false;
  let hayLevantamiento = false;

  for (const a of actuaciones) {
    const texto = normalizarTexto(`${a.actuacion || ""} ${a.anotacion || ""}`);
    const esTerminacion = PALABRAS_TERMINACION.some((p) => texto.includes(p));
    const esLevantamiento = PALABRAS_LEVANTAMIENTO.some((p) => texto.includes(p));
    if (esTerminacion || esLevantamiento) {
      relevantes.push({ fecha_actuacion: a.fecha_actuacion, actuacion: a.actuacion, anotacion: a.anotacion });
      if (esTerminacion) hayTerminacion = true;
      if (esLevantamiento) hayLevantamiento = true;
    }
  }

  let estado = "ACTIVO";
  if (hayTerminacion) estado = "TERMINADO";
  else if (hayLevantamiento) estado = "LEVANTAMIENTO_MEDIDAS";

  return { estado, relevantes };
}

function observarDetalleProceso(radicadoEsperado) {
  const TIMEOUT_MS = 20000;
  let resuelto = false;

  const intentar = () => {
    if (resuelto) return true;
    if (!document.body.innerText.includes(radicadoEsperado)) return false;

    resuelto = true;
    enviarEstado("EXTRAYENDO_PROCESO", `Extrayendo datos del proceso ${radicadoEsperado}...`);

    const datosProceso = extraerDatosDelProceso();
    recolectarTodasLasActuaciones((actuaciones, motivoError) => {
      const clasificacion = clasificarProcesoPorActuaciones(actuaciones);
      const proceso = {
        datos_proceso: datosProceso,
        estado_proceso: clasificacion.estado,
        actuaciones_relevantes: clasificacion.relevantes,
        actuaciones,
      };
      if (motivoError) proceso._diagnostico = { motivo: motivoError };
      guardarProcesoExtraido(radicadoEsperado, proceso);
    });
    return true;
  };

  if (intentar()) return;
  const observer = new MutationObserver(() => {
    if (intentar()) observer.disconnect();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => {
    if (resuelto) return;
    resuelto = true;
    observer.disconnect();
    guardarProcesoExtraido(radicadoEsperado, {
      datos_proceso: { radicado: radicadoEsperado, fecha_radicacion: null, despacho: null, tipo_proceso: null },
      estado_proceso: "REQUIERE_REVISION",
      actuaciones_relevantes: [],
      actuaciones: [],
      _diagnostico: { motivo: "DETALLE_TIMEOUT" },
    });
  }, TIMEOUT_MS);
}

function guardarProcesoExtraido(radicado, procesoExtraido) {
  chrome.storage.local.get("nexoraJudicialTrabajo", (datos) => {
    const trabajo = datos.nexoraJudicialTrabajo;
    if (!trabajo) return;

    trabajo.radicadosPendientes = trabajo.radicadosPendientes.filter((r) => r !== radicado);
    trabajo.radicadosProcesados.push(radicado);
    trabajo.procesosExtraidos.push(procesoExtraido);

    chrome.storage.local.set({ nexoraJudicialTrabajo: trabajo }, () => {
      if (trabajo.radicadosPendientes.length > 0) {
        enviarEstado("VOLVIENDO_AL_LISTADO", "Regresando al listado para el siguiente proceso...");
        history.back();
        setTimeout(() => continuarConSiguienteProceso(), 1500);
      } else {
        finalizarConsultaJudicial(trabajo);
      }
    });
  });
}

function finalizarConsultaJudicial(trabajo) {
  enviarEstado("EXTRACCION_COMPLETADA", `${trabajo.procesosExtraidos.length} proceso(s) procesado(s).`);
  chrome.storage.local.set({ nexoraJudicialTrabajo: null });
  enviarResultadoFinal({
    fuente: "RAMA_JUDICIAL",
    nombre_consultado: trabajo.nombre,
    estado_consulta: "OK",
    procesos: trabajo.procesosExtraidos,
  });
}

// =========================================================================
// DIAGNOSTICO Y ERRORES
// =========================================================================

function capturarSnapshotDesconocido(nombre, motivo, extra) {
  registrarTrace(motivo && String(motivo).includes("TIMEOUT") ? "TIMEOUT" : "ERROR", `motivo=${motivo}`);
  enviarEstado("ERROR_CONSULTA", `Motivo: ${motivo}. Se guardo un snapshot de diagnostico.`);
  chrome.storage.local.set({
    ultimoSnapshotJudicialDesconocido: {
      nombre,
      motivo,
      extra: extra || null,
      url: location.href,
      titulo: document.title,
      timestamp: new Date().toISOString(),
    },
    nexoraJudicialTrabajo: null,
  });
  enviarResultadoFinal({
    fuente: "RAMA_JUDICIAL",
    nombre_consultado: nombre,
    estado_consulta: "ERROR_CONSULTA",
    motivo,
    procesos: [],
    _nota: "Revisa 'ultimoSnapshotJudicialDesconocido' en chrome.storage.local para disenar la correccion.",
  });
  registrarTrace("FINALIZACION", `estado_final=ERROR_CONSULTA motivo=${motivo}`);
}

// =========================================================================
// PUNTO DE ENTRADA
// =========================================================================

chrome.runtime.onMessage.addListener((mensaje, sender, sendResponse) => {
  if (mensaje.tipo === "EJECUTAR_CONSULTA_JUDICIAL") {
    NEXORA_LOG(`Connector Judicial iniciado. Nombre: ${mensaje.nombre}`);
    ejecutarConsultaJudicial(mensaje.nombre);
    sendResponse({ ok: true });
  }

  if (mensaje.tipo === "SELECCIONAR_RADICADO_JUDICIAL") {
    // El radicado SIEMPRE se trata como string: String() no reformatea ni
    // convierte a numero, solo garantiza el tipo; trim() solo quita
    // espacios sobrantes, nunca toca los digitos del radicado en si.
    const radicado = String(mensaje.radicado || "").trim();
    NEXORA_LOG(`Solicitud de seleccion de radicado recibida: ${radicado}`);

    // CORRECCION (proceso privado): el listado YA clasifico este radicado
    // cuando se entrego (extraerProcesosDeTablaListado, reutilizado via
    // ultimoListadoJudicialProcesos -- nunca se vuelve a buscar en el DOM
    // ni se duplica esa clasificacion). Si es PROCESO_PRIVADO, NUNCA se
    // llama a volverAlListadoJudicial() ni a seleccionarYAbrirRadicado():
    // no hay nada que abrir, no es un error tecnico, no se toca la
    // pestana ni el listado actual. Solo se informa y se detiene ESTA
    // seleccion -- la sesion sigue intacta para elegir otro radicado.
    const procesoClasificado = buscarProcesoClasificado(radicado);
    if (procesoClasificado && procesoClasificado.estado_proceso === "PROCESO_PRIVADO") {
      NEXORA_LOG(`RADICADO_VALIDADO - ${radicado} (proceso privado)`);
      enviarEstado("RADICADO_VALIDADO", `Radicado ${radicado} localizado en el listado (proceso privado).`);
      NEXORA_LOG(`PROCESO_PRIVADO - ${radicado}`);
      enviarEstado("PROCESO_PRIVADO", `El proceso ${radicado} es privado: no se puede abrir su detalle.`);
      sendResponse({ ok: true });
      return true;
    }

    // CORRECCION (transicion DETALLE -> LISTADO -> SIGUIENTE RADICADO):
    // antes de intentar localizar el boton del radicado solicitado, nos
    // aseguramos de estar en el listado. Si ya estabamos ahi (primera
    // seleccion de la sesion), esto es un chequeo instantaneo sin ningun
    // click. Si habia un detalle abierto de un radicado anterior, esto lo
    // cierra via "Regresar al listado" (mecanismo real confirmado) antes
    // de continuar. seleccionarYAbrirRadicado() en si NO se modifica: se
    // sigue llamando exactamente igual, solo que ahora garantizado a
    // ejecutarse con el listado ya confirmado en pantalla.
    volverAlListadoJudicial((resultadoListado) => {
      if (!resultadoListado.exito) {
        NEXORA_LOG(`${resultadoListado.motivo} - no se puede seleccionar ${radicado}`);
        enviarEstado(resultadoListado.motivo, `No se pudo confirmar el listado antes de seleccionar ${radicado}.`);
        return;
      }
      NEXORA_LOG("listo para seleccionar siguiente radicado");
      seleccionarYAbrirRadicado(radicado);
    });

    sendResponse({ ok: true });
  }

  if (mensaje.tipo === "REGRESAR_LISTADO_JUDICIAL") {
    NEXORA_LOG("Solicitud de regreso al listado recibida.");
    volverAlListadoJudicial((resultado) => {
      if (!resultado.exito) {
        enviarEstado(resultado.motivo, "No se pudo confirmar que el listado de procesos siga disponible en el DOM.");
        return;
      }
      enviarEstado(
        "LISTADO_JUDICIAL_RESTAURADO",
        `${resultado.totalRadicados} radicado(s) disponibles para seleccionar.`
      );
    });
    sendResponse({ ok: true });
  }

  return true;
});

// Si esta pagina se cargo por una navegacion completa en medio de un
// trabajo Judicial en curso (radicados pendientes), retomamos donde
// quedamos en vez de tratarla como una consulta nueva.
(function reanudarTrabajoJudicialSiExiste() {
  chrome.storage.local.get("nexoraJudicialTrabajo", (datos) => {
    const trabajo = datos.nexoraJudicialTrabajo;
    if (!trabajo) return;
    const antiguedadMs = Date.now() - (trabajo.timestamp || 0);
    if (antiguedadMs > 120000) {
      chrome.storage.local.set({ nexoraJudicialTrabajo: null });
      return;
    }
    NEXORA_LOG("Reanudando trabajo Judicial en curso tras navegacion completa...");
    setTimeout(() => continuarConSiguienteProceso(), 800);
  });
})();

NEXORA_LOG("Content script Judicial cargado en " + location.href);
_crearPanelDebugJudicial();
