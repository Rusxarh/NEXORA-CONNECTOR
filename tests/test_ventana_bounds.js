/**
 * tests/test_ventana_bounds.js
 * Prompt 8c punto 0: valida que nunca volvamos a pedirle a chrome.windows.create
 * unos bounds que Chrome rechace ("Invalid value for bounds. Bounds must be at
 * least 50% within visible screen space."). Node puro (node:assert), sin chrome.*,
 * sin red: correr con `node tests/test_ventana_bounds.js`.
 */

const assert = require("node:assert");
const {
  calcularPorcentajeVisible,
  boundsValidosParaChrome,
  construirBoundsEnEsquina,
  PANTALLA_DE_RESPALDO,
} = require("../ventana_bounds.js");

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

const PANTALLA_FHD = { left: 0, top: 0, width: 1920, height: 1080 };

test("una ventana totalmente dentro de la pantalla es 100% visible", () => {
  const bounds = { left: 100, top: 100, width: 480, height: 360 };
  assert.strictEqual(calcularPorcentajeVisible(bounds, PANTALLA_FHD), 1);
  assert.ok(boundsValidosParaChrome(bounds, PANTALLA_FHD));
});

test("el bug real (left/top: -32000) es 0% visible y queda invalido", () => {
  const bounds = { left: -32000, top: -32000, width: 1024, height: 768 };
  assert.strictEqual(calcularPorcentajeVisible(bounds, PANTALLA_FHD), 0);
  assert.strictEqual(boundsValidosParaChrome(bounds, PANTALLA_FHD), false);
});

test("una ventana con solo la mitad dentro de la pantalla queda en el limite (50%)", () => {
  // 480 de ancho, mitad (240) fuera por la izquierda.
  const bounds = { left: -240, top: 0, width: 480, height: 360 };
  assert.strictEqual(calcularPorcentajeVisible(bounds, PANTALLA_FHD), 0.5);
  assert.ok(boundsValidosParaChrome(bounds, PANTALLA_FHD));
});

test("una ventana con menos del 50% dentro queda invalida", () => {
  const bounds = { left: -300, top: 0, width: 480, height: 360 }; // 180/480 = 37.5%
  assert.ok(calcularPorcentajeVisible(bounds, PANTALLA_FHD) < 0.5);
  assert.strictEqual(boundsValidosParaChrome(bounds, PANTALLA_FHD), false);
});

test("construirBoundsEnEsquina siempre da bounds validos (100% dentro) en pantallas grandes y chicas", () => {
  for (const pantalla of [
    PANTALLA_FHD,
    { left: 0, top: 0, width: 1366, height: 768 },
    { left: 0, top: 0, width: 320, height: 240 }, // mas chica que el default 480x360
    { left: 100, top: 50, width: 1024, height: 768 }, // workArea con offset (barra de tareas)
  ]) {
    const bounds = construirBoundsEnEsquina(pantalla);
    assert.ok(boundsValidosParaChrome(bounds, pantalla), `fallo con pantalla ${JSON.stringify(pantalla)}`);
    assert.strictEqual(calcularPorcentajeVisible(bounds, pantalla), 1);
    assert.ok(bounds.width <= pantalla.width);
    assert.ok(bounds.height <= pantalla.height);
  }
});

test("PANTALLA_DE_RESPALDO existe y produce bounds validos", () => {
  const bounds = construirBoundsEnEsquina(PANTALLA_DE_RESPALDO);
  assert.ok(boundsValidosParaChrome(bounds, PANTALLA_DE_RESPALDO));
});
