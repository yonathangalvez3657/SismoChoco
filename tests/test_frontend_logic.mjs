import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..');
const mainJs = fs.readFileSync(path.join(APP_DIR, 'js', 'main.js'), 'utf8');
const municipios = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'data', 'municipios_choco_nsr10.json'), 'utf8'));

function extractTopLevelFunction(source, fnName) {
    const startRegex = new RegExp(`^function\\s+${fnName}\\s*\\(`, 'm');
    const match = startRegex.exec(source);
    assert.ok(match, `No se encontró función de nivel superior: ${fnName}`);
    const rest = source.slice(match.index);
    const endMatch = /\n\}(?=\n|$)/.exec(rest);
    assert.ok(endMatch, `No se encontró cierre de función de nivel superior para: ${fnName}`);
    return rest.slice(0, endMatch.index + 2);
}

const context = vm.createContext({ Math, Number, String, Array, Object, Infinity, parseFloat, isNaN });
const fns = [
    'getFactoresSitioNSR10',
    'calcularEspectroNSR10',
    'calculateGutenbergRichterMLE',
    'classifyLiquefaction',
    'escapeHtml',
    'safeCsvField',
    'distToSegment',
    'haversineDistanceKm',
    'tileToMercatorBbox',
];
const infraMatch = /const INFRA_COLORS = \{[\s\S]*?\n\};/.exec(mainJs);
assert.ok(infraMatch, 'No se encontró INFRA_COLORS en main.js');
vm.runInContext(
    `${infraMatch[0].replace(/^const /, 'var ')}\n\n` +
    fns.map(name => extractTopLevelFunction(mainJs, name)).join('\n\n'),
    context
);

test('NSR-10 espectro alinea curva Roca Base con períodos del suelo evaluado y alcanza TL', () => {
    for (const suelo of ['D', 'E', 'F']) {
        for (const muniName of ['Quibdó', 'Bahía Solano (Mutis)', 'Pereira', 'Manizales']) {
            const m = municipios.find(x => x.nombre === muniName);
            assert.ok(m, `Municipio requerido no encontrado: ${muniName}`);
            const spec = context.calcularEspectroNSR10(m.aa, m.av, suelo, 1.0);
            const specRoca = context.calcularEspectroNSR10(m.aa, m.av, 'B', 1.0, spec.periods);

            assert.equal(spec.periods.length, specRoca.periods.length);
            assert.deepEqual(Array.from(spec.periods), Array.from(specRoca.periods));
            assert.equal(spec.accelerations.length, specRoca.accelerations.length);
            assert.ok(
                spec.periods[spec.periods.length - 1] >= spec.TL,
                `${m.nombre} suelo ${suelo}: último período ${spec.periods[spec.periods.length - 1]} < TL=${spec.TL}`
            );
        }
    }
});

test('Gutenberg-Richter Aki-Utsu retorna null cuando el filtro supera Mc o rango < 1.0', () => {
    const synthetic = [];
    for (let i = 0; i < 40; i++) {
        synthetic.push({ properties: { magnitud: 2.5 + (i % 25) * 0.1 } });
    }
    const grValid = context.calculateGutenbergRichterMLE(synthetic, 10, 0);
    assert.ok(grValid && Number.isFinite(grValid.b) && grValid.b > 0.5 && grValid.b < 2.0);

    const highFilter = synthetic.filter(f => f.properties.magnitud >= 4.7);
    assert.equal(context.calculateGutenbergRichterMLE(highFilter, 10, 4.7), null);

    const narrowWindow = [];
    for (let i = 0; i < 30; i++) {
        narrowWindow.push({ properties: { magnitud: 3.5 + (i % 6) * 0.1 } });
    }
    assert.equal(context.calculateGutenbergRichterMLE(narrowWindow, 10, 3.5), null);
});

test('Clasificador de licuación diferencia ladera alta, suelos E/F y municipios en Baja', () => {
    const q = municipios.find(m => m.nombre === 'Quibdó');
    const bb = municipios.find(m => m.nombre === 'Bajo Baudó (Pizarro)');
    const ca = municipios.find(m => m.nombre === 'El Carmen de Atrato');
    const sjp = municipios.find(m => m.nombre === 'San José del Palmar');
    const pr = municipios.find(m => m.nombre === 'Pueblo Rico');
    const mi = municipios.find(m => m.nombre === 'Mistrató');

    assert.equal(context.classifyLiquefaction(q.licuacion_riesgo, q.suelo_defecto).pillClass, 'critico');
    assert.equal(context.classifyLiquefaction(bb.licuacion_riesgo, bb.suelo_defecto).pillClass, 'critico');
    assert.equal(context.classifyLiquefaction(ca.licuacion_riesgo, ca.suelo_defecto).uiText, '🟢 Baja (Ladera alta)');
    assert.equal(context.classifyLiquefaction(sjp.licuacion_riesgo, sjp.suelo_defecto).uiText, '🟢 Baja (Ladera alta)');
    assert.equal(context.classifyLiquefaction(pr.licuacion_riesgo, pr.suelo_defecto).uiText, '🟢 Baja (Ladera alta)');
    assert.equal(context.classifyLiquefaction(mi.licuacion_riesgo, mi.suelo_defecto).uiText, '🟢 Baja');
    assert.equal(context.classifyLiquefaction(mi.licuacion_riesgo, mi.suelo_defecto).potText, '🟢 BAJA');
    assert.equal(context.classifyLiquefaction(mi.licuacion_riesgo, 'F').pillClass, 'critico');
});

test('Sanitización XSS (escapeHtml) y anti-fórmula CSV (safeCsvField)', () => {
    assert.equal(
        context.escapeHtml('<img src=x onerror="alert(1)">'),
        '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'
    );
    assert.equal(context.safeCsvField('=CMD|calc!A0'), "'=CMD|calc!A0");
    assert.equal(context.safeCsvField('+2+3'), "'+2+3");
    assert.equal(context.safeCsvField('@SUM(A1)'), "'@SUM(A1)");
    assert.equal(context.safeCsvField('Quibdó'), 'Quibdó');
});

test('Geometría espacial Haversine y distancia punto-segmento consistentes', () => {
    const quibdo = [ -76.661, 5.695 ];
    const medellin = [ -75.565, 6.244 ];
    const km = context.haversineDistanceKm(quibdo[1], quibdo[0], medellin[1], medellin[0]);
    assert.ok(km > 125 && km < 145, `Distancia esperada ~136 km, obtenida ${km}`);
    const degDist = context.distToSegment(-76.6, 5.7, -76.7, 5.7, -76.5, 5.7);
    assert.ok(Math.abs(degDist) < 1e-9);
});

test('SGC OGC tileToMercatorBbox y 6 colores distintos en convenciones INFRA_COLORS', () => {
    const world = context.tileToMercatorBbox(0, 0, 0);
    assert.ok(Math.abs(world[0] + 20037508.342789244) < 1e-6);
    assert.ok(Math.abs(world[2] - 20037508.342789244) < 1e-6);
    const chocoTile = context.tileToMercatorBbox(73, 124, 8);
    assert.ok(chocoTile[0] < chocoTile[2] && chocoTile[1] < chocoTile[3]);

    const keys = ['vial', 'fluvial', 'maritimo', 'aeropuerto', 'hospital', 'puerto'];
    const hexes = keys.map(k => context.INFRA_COLORS[k]?.hex);
    assert.equal(new Set(hexes).size, 6, 'Cada una de las 6 convenciones debe tener color único');

    const html = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
    for (const h of hexes) {
        assert.ok(html.includes(h), `Falta color ${h} en convenciones de index.html`);
    }
});
