/**
 * tests/test_rgm_plan_a.js
 * Prompt 8c punto 1 + RGM-PLAN-A.md: plan A probado con HTML/delta
 * simulados escritos a mano segun la especificacion (grilla de 0, 1 y 2
 * filas; delta con pageRedirect; detalle ficticio). NUNCA contra el portal
 * real (CLAUDE.md). Node puro (node:assert): `node tests/test_rgm_plan_a.js`.
 */

const assert = require("node:assert");
const {
  rgmPlanAExtraerCampoOculto,
  rgmPlanAExtraerCamposOcultos,
  rgmPlanAParsearDelta,
  rgmPlanABuscarHiddenFieldEnDelta,
  rgmPlanABuscarUpdatePanelEnDelta,
  rgmPlanAExtraerPageRedirect,
  rgmPlanAExtraerFilasGrid,
  rgmPlanAElegirFilaMasReciente,
  rgmPlanAConstruirCuerpoBusqueda,
  rgmPlanAConstruirCuerpoDetalle,
  rgmPlanAPareceDesafioOCaptcha,
  rgmPlanAFormularioValido,
  consultarRgmPlanA,
} = require("../rgm_plan_a.js");

function test(nombre, fn) {
  try {
    fn();
    console.log(`OK   ${nombre}`);
  } catch (e) {
    console.error(`FAIL ${nombre}`);
    console.error(e);
    process.exitCode = 1;
  }
}

async function testAsync(nombre, fn) {
  try {
    await fn();
    console.log(`OK   ${nombre}`);
  } catch (e) {
    console.error(`FAIL ${nombre}`);
    console.error(e);
    process.exitCode = 1;
  }
}

// --------------------------------------------------------------------------
// Fixtures (ficticios, sin datos reales) segun RGM-PLAN-A.md
// --------------------------------------------------------------------------

function segmentoDelta(tipo, id, contenido) {
  return `${contenido.length}|${tipo}|${id}|${contenido}|`;
}

// Prompt 8d punto 1: el formulario REAL trae un campo "recaptchaResponse"
// vacio y suele mencionar la palabra "captcha" en algun script, sin que eso
// signifique que haya un desafio de verdad. Este fixture lo incluye a
// proposito para probar que ya no causa una falsa alarma.
const HTML_FORMULARIO = `
<html><body><form>
<input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="VS_FICTICIO_ABC123" />
<input type="hidden" name="__VIEWSTATEGENERATOR" id="__VIEWSTATEGENERATOR" value="FICTICI0" />
<input type="hidden" name="__EVENTVALIDATION" id="__EVENTVALIDATION" value="EV_FICTICIO_XYZ789" />
<input type="hidden" name="__VIEWSTATEENCRYPTED" id="__VIEWSTATEENCRYPTED" value="" />
<input type="hidden" name="__SCROLLPOSITIONX" id="__SCROLLPOSITIONX" value="0" />
<input type="hidden" name="__SCROLLPOSITIONY" id="__SCROLLPOSITIONY" value="0" />
<input type="hidden" name="ctl00$ctl00$hdnCSFK" id="hdnCSFK" value="CSFK_FICTICIO_0000000000000000000000000000000000000000000000000000000000000000" />
<input type="hidden" name="ContentPlaceHolderSeguridad_ToolkitScriptManager1_HiddenField" id="TSM" value=";;AjaxControlToolkit, Version=3.5.7.123, FICTICIO" />
<input type="text" name="ctl00$ctl00$ContentPlaceHolderSeguridad$ContentPlaceHolderContenido$txtNumBien" id="txtNumBien" value="" />
<input type="hidden" name="ctl00$ctl00$ContentPlaceHolderSeguridad$ContentPlaceHolderContenido$recaptchaResponse" id="recaptchaResponse" value="" />
<script>// carga del widget de captcha, siempre presente aunque no se use</script>
</form></body></html>
`;

// Pagina de desafio REAL: sin __VIEWSTATE (no es la pagina de ASP.NET) y con
// un widget de reCAPTCHA visible (data-sitekey).
const HTML_PAGINA_DESAFIO_REAL = `<html><body><div class="g-recaptcha" data-sitekey="6LVERYFAKEKEY0000000000000"></div><p>Verificación adicional requerida antes de continuar.</p></body></html>`;

function gridConFilas(n) {
  let filas = "";
  for (let i = 0; i < n; i++) {
    const ctl = `ctl0${i + 2}`;
    const fecha = i === 0 ? "01/01/2026" : "15/06/2026"; // la segunda fila (si existe) es mas reciente
    filas += `<tr><td>${17 + i}00000000000000${i}</td><td>Deudor Ficticio ${i}</td><td>Acreedor Ficticio ${i}</td><td>${fecha}</td>
      <input type="image" name="ctl00$ctl00$ContentPlaceHolderSeguridad$ContentPlaceHolderContenido$gvBusqueda$${ctl}$lnkBtnConsultar" title="Consultar detalle garantia" src="x.png" />
    </tr>`;
  }
  return `<table id="gvBusqueda"><tr><th>Folio</th><th>Deudor</th><th>Acreedor</th><th>Fecha</th></tr>${filas}</table>`;
}

function deltaBusqueda(grid, camposNuevos) {
  camposNuevos = camposNuevos || {};
  let s = "";
  s += segmentoDelta(
    "updatePanel",
    "ContentPlaceHolderSeguridad_ContentPlaceHolderContenido_upBusqueda",
    grid
  );
  for (const [nombre, valor] of Object.entries(camposNuevos)) {
    s += segmentoDelta("hiddenField", nombre, valor);
  }
  s += segmentoDelta("asyncPostBackControlIDs", "", "");
  return s;
}

function deltaDetalle(urlRedirect) {
  return segmentoDelta("pageRedirect", "", encodeURIComponent(urlRedirect));
}

// --------------------------------------------------------------------------
// Pruebas de las funciones puras
// --------------------------------------------------------------------------

test("extrae los 8 campos ocultos del GET del formulario", () => {
  const campos = rgmPlanAExtraerCamposOcultos(HTML_FORMULARIO);
  assert.strictEqual(campos["__VIEWSTATE"], "VS_FICTICIO_ABC123");
  assert.strictEqual(campos["__VIEWSTATEGENERATOR"], "FICTICI0");
  assert.strictEqual(campos["__EVENTVALIDATION"], "EV_FICTICIO_XYZ789");
  assert.strictEqual(campos["__VIEWSTATEENCRYPTED"], "");
  assert.strictEqual(campos["ctl00$ctl00$hdnCSFK"].length, 64 + "CSFK_FICTICIO_".length);
  assert.ok(campos["ContentPlaceHolderSeguridad_ToolkitScriptManager1_HiddenField"].startsWith(";;AjaxControlToolkit"));
});

test("extraerCampoOculto funciona con value antes de name (orden invertido)", () => {
  const html = `<input type="hidden" value="123" name="__VIEWSTATE" />`;
  assert.strictEqual(rgmPlanAExtraerCampoOculto(html, "__VIEWSTATE"), "123");
});

test("campo ausente devuelve null, no lanza", () => {
  assert.strictEqual(rgmPlanAExtraerCampoOculto("<html></html>", "__VIEWSTATE"), null);
});

test("parsearDelta lee varios segmentos, incluso con '|' dentro del contenido", () => {
  const contenidoConPipes = "a|b|c"; // 5 caracteres
  const texto = segmentoDelta("updatePanel", "miId", contenidoConPipes) + segmentoDelta("hiddenField", "__VIEWSTATE", "nuevo");
  const segmentos = rgmPlanAParsearDelta(texto);
  assert.strictEqual(segmentos.length, 2);
  assert.deepStrictEqual(segmentos[0], { tipo: "updatePanel", id: "miId", contenido: "a|b|c" });
  assert.deepStrictEqual(segmentos[1], { tipo: "hiddenField", id: "__VIEWSTATE", contenido: "nuevo" });
});

test("parsearDelta con texto vacio o basura no lanza, devuelve []", () => {
  assert.deepStrictEqual(rgmPlanAParsearDelta(""), []);
  assert.deepStrictEqual(rgmPlanAParsearDelta("esto no es un delta"), []);
});

test("buscarHiddenFieldEnDelta y buscarUpdatePanelEnDelta encuentran por nombre/sufijo", () => {
  const segmentos = rgmPlanAParsearDelta(
    segmentoDelta("hiddenField", "__VIEWSTATE", "nuevo_vs") +
      segmentoDelta("updatePanel", "ContentPlaceHolderSeguridad_ContentPlaceHolderContenido_upBusqueda", "<table></table>")
  );
  assert.strictEqual(rgmPlanABuscarHiddenFieldEnDelta(segmentos, "__VIEWSTATE"), "nuevo_vs");
  assert.strictEqual(rgmPlanABuscarHiddenFieldEnDelta(segmentos, "__EVENTVALIDATION"), null);
  assert.strictEqual(rgmPlanABuscarUpdatePanelEnDelta(segmentos, "upBusqueda"), "<table></table>");
});

test("extraerPageRedirect decodifica la URL", () => {
  const url = "/rgm/Garantias/ResultadoConsultaGarantias.aspx?CodigoGarantia=ABC 123";
  const segmentos = rgmPlanAParsearDelta(deltaDetalle(url));
  assert.strictEqual(rgmPlanAExtraerPageRedirect(segmentos), url);
});

test("0 filas en la grilla = sin garantias (no lanza, devuelve [])", () => {
  const filas = rgmPlanAExtraerFilasGrid(gridConFilas(0));
  assert.deepStrictEqual(filas, []);
});

test("1 fila: se detecta su ctl y se elige esa (unica) como la mas reciente", () => {
  const filas = rgmPlanAExtraerFilasGrid(gridConFilas(1));
  assert.strictEqual(filas.length, 1);
  assert.strictEqual(filas[0].ctl, "ctl02");
  const { elegida, otras } = rgmPlanAElegirFilaMasReciente(filas);
  assert.strictEqual(elegida.ctl, "ctl02");
  assert.deepStrictEqual(otras, []);
});

test("2 filas: se elige la de fecha mas reciente, la otra queda en 'otras'", () => {
  const filas = rgmPlanAExtraerFilasGrid(gridConFilas(2)); // fechas 01/01/2026 y 15/06/2026
  assert.strictEqual(filas.length, 2);
  const { elegida, otras } = rgmPlanAElegirFilaMasReciente(filas);
  assert.strictEqual(elegida.ctl, "ctl03"); // la de 15/06/2026
  assert.strictEqual(otras.length, 1);
  assert.strictEqual(otras[0].ctl, "ctl02");
});

test("construirCuerpoBusqueda incluye la placa y 'Consultas no oficiales'", () => {
  const cuerpo = rgmPlanAConstruirCuerpoBusqueda(rgmPlanAExtraerCamposOcultos(HTML_FORMULARIO), "GCT953");
  const params = new URLSearchParams(cuerpo);
  assert.strictEqual(
    params.get("ctl00$ctl00$ContentPlaceHolderSeguridad$ContentPlaceHolderContenido$txtNumBien"),
    "GCT953"
  );
  assert.strictEqual(
    params.get("ctl00$ctl00$ContentPlaceHolderSeguridad$ContentPlaceHolderContenido$rblTiposConsulta"),
    "Consultas no oficiales"
  );
  assert.strictEqual(params.get("__ASYNCPOST"), "true");
  assert.strictEqual(params.get("__VIEWSTATE"), "VS_FICTICIO_ABC123");
});

test("construirCuerpoDetalle manda .x/.y de la fila elegida y nunca btnConsultarNumBien", () => {
  const cuerpo = rgmPlanAConstruirCuerpoDetalle(rgmPlanAExtraerCamposOcultos(HTML_FORMULARIO), "ctl03");
  const params = new URLSearchParams(cuerpo);
  assert.strictEqual(
    params.get("ctl00$ctl00$ContentPlaceHolderSeguridad$ContentPlaceHolderContenido$gvBusqueda$ctl03$lnkBtnConsultar.x"),
    "18"
  );
  assert.strictEqual(
    params.get("ctl00$ctl00$ContentPlaceHolderSeguridad$ContentPlaceHolderContenido$btnConsultarNumBien"),
    null
  );
});

test("pareceDesafioOCaptcha detecta un desafio real y no un formulario normal", () => {
  assert.ok(rgmPlanAPareceDesafioOCaptcha(HTML_PAGINA_DESAFIO_REAL));
  assert.ok(!rgmPlanAPareceDesafioOCaptcha(HTML_FORMULARIO));
});

test("Prompt 8d punto 1: formulario con recaptchaResponse vacio NO es falsa alarma de captcha", () => {
  // El formulario real trae la palabra "captcha" (script, campo
  // recaptchaResponse) sin que eso sea un desafio: decidir solo por la
  // palabra daba una falsa alarma siempre. Debe seguir siendo valido.
  assert.ok(HTML_FORMULARIO.toLowerCase().includes("captcha"));
  assert.ok(rgmPlanAFormularioValido(HTML_FORMULARIO));
  assert.ok(!rgmPlanAPareceDesafioOCaptcha(HTML_FORMULARIO));
});

// --------------------------------------------------------------------------
// Orquestacion completa (consultarRgmPlanA) con fetch/offscreen simulados
// --------------------------------------------------------------------------

function respuestaFalsa(texto, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => texto };
}

testAsync("consultarRgmPlanA: flujo feliz de punta a punta con 1 fila", async () => {
  let llamada = 0;
  const fetchFn = async (url) => {
    llamada += 1;
    if (llamada === 1) return respuestaFalsa(HTML_FORMULARIO); // GET formulario
    if (llamada === 2) return respuestaFalsa(deltaBusqueda(gridConFilas(1))); // POST busqueda
    if (llamada === 3) {
      return respuestaFalsa(
        deltaDetalle("/rgm/Garantias/ResultadoConsultaGarantias.aspx?CodigoGarantia=FICTICIO")
      ); // POST detalle
    }
    if (llamada === 4) return respuestaFalsa("<html>detalle ficticio</html>"); // GET detalle
    throw new Error("llamada inesperada #" + llamada);
  };
  const extractorFalso = async (html, placa) => ({
    ok: true,
    resultado: { fuente: "RGM", placa_consultada: placa, estado: "OK", deudor_garante: {}, acreedor: {}, vehiculo: {} },
    camposFaltantes: [],
  });

  const resultado = await consultarRgmPlanA("GCT953", { fetchFn, crearOffscreenYExtraer: extractorFalso });
  assert.strictEqual(resultado.ok, true);
  assert.strictEqual(resultado.resultado.estado, "OK");
  assert.strictEqual(llamada, 4);
});

testAsync("consultarRgmPlanA: 0 filas es SIN_DATOS (ok:true, no cae a plan B)", async () => {
  const fetchFn = async () => {
    fetchFn.n = (fetchFn.n || 0) + 1;
    if (fetchFn.n === 1) return respuestaFalsa(HTML_FORMULARIO);
    return respuestaFalsa(deltaBusqueda(gridConFilas(0)));
  };
  const resultado = await consultarRgmPlanA("ZZZ999", { fetchFn });
  assert.strictEqual(resultado.ok, true);
  assert.strictEqual(resultado.resultado.estado, "SIN_DATOS");
});

testAsync("consultarRgmPlanA: sin __VIEWSTATE cae a plan B con motivo legible", async () => {
  const fetchFn = async () => respuestaFalsa("<html>pagina sin los campos esperados</html>");
  const resultado = await consultarRgmPlanA("GCT953", { fetchFn });
  assert.strictEqual(resultado.ok, false);
  assert.ok(resultado.motivo.includes("__VIEWSTATE"));
});

testAsync("consultarRgmPlanA: desafio real en el paso 1 cae a plan B con motivo legible", async () => {
  const fetchFn = async () => respuestaFalsa(HTML_PAGINA_DESAFIO_REAL);
  const resultado = await consultarRgmPlanA("GCT953", { fetchFn });
  assert.strictEqual(resultado.ok, false);
  assert.ok(resultado.motivo.includes("captcha"));
  assert.ok(!resultado.motivo.includes("VIEWSTATE_REAL")); // nunca revienta nada sensible en el motivo
});

testAsync("consultarRgmPlanA: formulario con recaptchaResponse vacio NO cae a plan B (falsa alarma corregida)", async () => {
  let llamada = 0;
  const fetchFn = async () => {
    llamada += 1;
    if (llamada === 1) return respuestaFalsa(HTML_FORMULARIO); // trae la palabra "captcha", pero es valido
    return respuestaFalsa(deltaBusqueda(gridConFilas(0)));
  };
  const resultado = await consultarRgmPlanA("ZZZ999", { fetchFn });
  assert.strictEqual(resultado.ok, true);
  assert.strictEqual(resultado.resultado.estado, "SIN_DATOS");
});

testAsync("consultarRgmPlanA: HTTP 500 en cualquier paso cae a plan B con el codigo", async () => {
  const fetchFn = async () => respuestaFalsa("error interno", 500);
  const resultado = await consultarRgmPlanA("GCT953", { fetchFn });
  assert.strictEqual(resultado.ok, false);
  assert.strictEqual(resultado.httpStatus, 500);
});

testAsync("consultarRgmPlanA: delta sin la grilla esperada cae a plan B", async () => {
  let llamada = 0;
  const fetchFn = async () => {
    llamada += 1;
    if (llamada === 1) return respuestaFalsa(HTML_FORMULARIO);
    return respuestaFalsa(segmentoDelta("updatePanel", "OtroPanelQueNoEsLaGrilla", "<div>nada util</div>"));
  };
  const resultado = await consultarRgmPlanA("GCT953", { fetchFn });
  assert.strictEqual(resultado.ok, false);
  assert.ok(resultado.motivo.includes("grilla"));
});

testAsync("consultarRgmPlanA: el extractor del detalle falla -> plan B, nunca lanza", async () => {
  let llamada = 0;
  const fetchFn = async () => {
    llamada += 1;
    if (llamada === 1) return respuestaFalsa(HTML_FORMULARIO);
    if (llamada === 2) return respuestaFalsa(deltaBusqueda(gridConFilas(1)));
    if (llamada === 3) return respuestaFalsa(deltaDetalle("/rgm/Garantias/ResultadoConsultaGarantias.aspx?CodigoGarantia=X"));
    return respuestaFalsa("<html>detalle</html>");
  };
  const extractorQueFalla = async () => ({ ok: false, error: "no se encontro ninguna tabla esperada" });
  const resultado = await consultarRgmPlanA("GCT953", { fetchFn, crearOffscreenYExtraer: extractorQueFalla });
  assert.strictEqual(resultado.ok, false);
  assert.ok(resultado.motivo.includes("no se encontro ninguna tabla"));
});
