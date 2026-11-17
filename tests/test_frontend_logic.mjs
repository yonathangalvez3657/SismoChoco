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

const context = vm.createContext({ Math, Number, String, Array, Object, Set, Infinity, parseFloat, isNaN, encodeURIComponent });
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
    'lngLatToTilePixel',
    'classifySgcRasterColor',
    'buildInfraSvgDataUrl',
    'getInfraPixelOffset',
];
const infraMatch = /const INFRA_COLORS = \{[\s\S]*?\n\};/.exec(mainJs);
assert.ok(infraMatch, 'No se encontró INFRA_COLORS en main.js');
const infraIconsMatch = /const INFRA_ICON_URLS = \{[\s\S]*?\n\};/.exec(mainJs);
assert.ok(infraIconsMatch, 'No se encontró INFRA_ICON_URLS en main.js');
const sgcRampMatch = /const SGC_PGA_COLOR_RAMP = \[[\s\S]*?\n\];/.exec(mainJs);
assert.ok(sgcRampMatch, 'No se encontró SGC_PGA_COLOR_RAMP en main.js');
vm.runInContext(
    `${infraMatch[0].replace(/^const /, 'var ')}\n\n` +
    `${sgcRampMatch[0].replace(/^const /, 'var ')}\n\n` +
    fns.map(name => extractTopLevelFunction(mainJs, name)).join('\n\n') + '\n\n' +
    `${infraIconsMatch[0].replace(/^const /, 'var ')}\n\n`,
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

test('SGC OGC raster hover: lngLatToTilePixel y classifySgcRasterColor interpretan los 15 tonos oficiales', () => {
    const pxQuibdo = context.lngLatToTilePixel(-76.6611, 5.6947, 8);
    assert.equal(pxQuibdo.z, 8);
    assert.ok(Number.isInteger(pxQuibdo.x) && Number.isInteger(pxQuibdo.y));
    assert.ok(pxQuibdo.px >= 0 && pxQuibdo.px <= 255);
    assert.ok(pxQuibdo.py >= 0 && pxQuibdo.py <= 255);

    const low = context.classifySgcRasterColor(26, 150, 65);
    assert.ok(low.pgaEst <= 0.01);
    assert.ok(low.bandLabel.includes('Baja'));

    const mid = context.classifySgcRasterColor(255, 255, 192);
    assert.ok(Math.abs(mid.pgaEst - 0.10) < 0.015);

    const high = context.classifySgcRasterColor(254, 209, 138);
    assert.ok(Math.abs(high.pgaEst - 0.30) < 0.02);
    assert.ok(high.bandLabel.includes('Alta'));

    const veryHigh = context.classifySgcRasterColor(215, 25, 28);
    assert.ok(veryHigh.pgaEst > 0.40);
    assert.ok(veryHigh.bandLabel.includes('Muy Alta'));
});

test('Todos los botones de ayuda (data-info) cuentan con explicación en modalData', () => {
    const html = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
    const keys = [...html.matchAll(/data-info="([^"]+)"/g)].map(m => m[1]);
    assert.ok(keys.length >= 24);
    for (const key of keys) {
        const pattern = new RegExp(`'${key}'\\s*:\\s*\``);
        assert.ok(pattern.test(mainJs), `Falta modalData['${key}'] en js/main.js`);
    }
});

test('Puertos DIMAR en vías e infraestructura tienen ícono SVG válido y separación ante hospitales colindantes', () => {
    const infraGeo = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'data', 'vias_infraestructura.geojson'), 'utf8'));
    const pts = infraGeo.features.filter(f => f.geometry.type === 'Point');
    const puertos = pts.filter(f => f.properties.tipo === 'puerto');
    assert.equal(puertos.length, 7);

    for (const tipo of ['puerto', 'hospital', 'aeropuerto']) {
        const url = context.INFRA_ICON_URLS[tipo];
        assert.ok(url && url.startsWith('data:image/svg+xml;charset=utf-8,'));
        assert.ok(!url.includes('#'), `La URL SVG de ${tipo} no debe contener # sin codificar`);
    }

    const acandiPuerto = puertos.find(f => f.properties.id === 'puerto_acandi');
    const acandiHosp = pts.find(f => f.properties.tipo === 'hospital' && f.properties.ciudad === 'Acandí');
    assert.ok(acandiPuerto && acandiHosp);
    const offPuerto = Array.from(context.getInfraPixelOffset(acandiPuerto, pts));
    const offHosp = Array.from(context.getInfraPixelOffset(acandiHosp, pts));
    assert.notDeepEqual(offPuerto, offHosp);
});
