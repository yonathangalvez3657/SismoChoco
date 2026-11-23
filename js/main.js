// ============================================================================
// CONFIGURACIÓN DINÁMICA DE RED Y ENDPOINTS
// ============================================================================
const getApiEndpoints = () => {
    // Si corre en puerto 5500 (live-server local), apunta al backend en 8000
    // Si corre en puerto 8000 o producción (Heroku/Render/AWS), usa el mismo host
    const isDev5500 = window.location.port === '5500';
    const host = isDev5500 ? `${window.location.hostname}:8000` : window.location.host;
    const httpProto = window.location.protocol === 'https:' ? 'https:' : 'http:';
    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    
    return {
        API_URL: `${httpProto}//${host}/api/sismos`,
        SGC_API: `${httpProto}//${host}/api/live_sgc`,
        ML_API: `${httpProto}//${host}/api/ml_clusters`,
        FALLAS_API: `${httpProto}//${host}/api/fallas`,
        MUNICIPIOS_API: `${httpProto}//${host}/api/municipios_nsr10`,
        INFRA_API: `${httpProto}//${host}/api/infraestructura`,
        HEALTH_API: `${httpProto}//${host}/api/health`,
        WS_URL: `${wsProto}//${host}/ws/live_sgc`
    };
};

const ENDPOINTS = getApiEndpoints();
const API_URL = ENDPOINTS.API_URL;
const SGC_API = ENDPOINTS.SGC_API;
const ML_API = ENDPOINTS.ML_API;
const MUNICIPIOS_API = ENDPOINTS.MUNICIPIOS_API;
const INFRA_API = ENDPOINTS.INFRA_API;

let mapData = { features: [] };
let sgcData = { features: [] };
let mlData = { features: [] };
let infraData = null;
let faultData = null;
let chocoBaseData = null;
let municipiosData = [];
let nsrEspectroChart = null;

const SGC_MAPSERVER_BASE = 'https://srvags.sgc.gov.co/arcprod/rest/services/Amenaza_Sismica/Amenaza_Sismica/MapServer';

const INFRA_COLORS = {
    vial:       { rgba: [255, 183, 3, 230],   hex: '#FFB703', textHex: '#FFB703' },
    fluvial:    { rgba: [56, 189, 248, 230],  hex: '#38BDF8', textHex: '#38BDF8' },
    maritimo:   { rgba: [20, 184, 166, 230],  hex: '#14B8A6', textHex: '#2DD4BF' },
    aeropuerto: { rgba: [59, 130, 246, 240],  hex: '#3B82F6', textHex: '#60A5FA' },
    hospital:   { rgba: [255, 45, 85, 245],   hex: '#FF2D55', textHex: '#FF6482' },
    puerto:     { rgba: [168, 85, 247, 240],  hex: '#A855F7', textHex: '#C084FC' }
};

function buildInfraSvgDataUrl(bgHex, glyphSvg) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><circle cx="32" cy="32" r="27" fill="${bgHex}" stroke="#FFFFFF" stroke-width="5"/>${glyphSvg}</svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const INFRA_ICON_URLS = {
    puerto: buildInfraSvgDataUrl(
        INFRA_COLORS.puerto.hex,
        '<circle cx="32" cy="18" r="3.8" fill="none" stroke="#FFFFFF" stroke-width="3.2"/><line x1="32" y1="22" x2="32" y2="47" stroke="#FFFFFF" stroke-width="3.5" stroke-linecap="round"/><line x1="23" y1="28" x2="41" y2="28" stroke="#FFFFFF" stroke-width="3.2" stroke-linecap="round"/><path d="M18 37 C18 46, 25 49, 32 49 C39 49, 46 46, 46 37" fill="none" stroke="#FFFFFF" stroke-width="3.5" stroke-linecap="round"/><polyline points="15,40 18,35 22,39" fill="none" stroke="#FFFFFF" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><polyline points="42,39 46,35 49,40" fill="none" stroke="#FFFFFF" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>'
    ),
    hospital: buildInfraSvgDataUrl(
        INFRA_COLORS.hospital.hex,
        '<rect x="28" y="18" width="8" height="28" rx="1.8" fill="#FFFFFF"/><rect x="18" y="28" width="28" height="8" rx="1.8" fill="#FFFFFF"/>'
    ),
    aeropuerto: buildInfraSvgDataUrl(
        INFRA_COLORS.aeropuerto.hex,
        '<path d="M32 16 L35 28 L47 34 L47 38 L35 35 L35 43 L40 46 L40 49 L32 47 L24 49 L24 46 L29 43 L29 35 L17 38 L17 34 L29 28 Z" fill="#FFFFFF"/>'
    )
};

function getInfraPixelOffset(feature, allPoints) {
    if (!feature || !feature.geometry || !feature.properties) return [0, 0];
    const tipo = feature.properties.tipo;
    const [lng, lat] = feature.geometry.coordinates;
    const hasNearbyPeer = Array.isArray(allPoints) && allPoints.some(other => {
        if (!other || other === feature || !other.geometry || !other.properties) return false;
        if (other.properties.tipo === tipo) return false;
        const [olng, olat] = other.geometry.coordinates;
        return Math.abs(lng - olng) < 0.03 && Math.abs(lat - olat) < 0.03;
    });
    if (!hasNearbyPeer) return [0, 0];
    if (tipo === 'puerto') return [-16, -6];
    if (tipo === 'aeropuerto') return [16, -6];
    if (tipo === 'hospital') return [12, 10];
    return [0, 0];
}

function tileToMercatorBbox(x, y, z) {
    const MAX_EXTENT = 20037508.342789244;
    const tileSpan = (2 * MAX_EXTENT) / Math.pow(2, z);
    const minX = -MAX_EXTENT + x * tileSpan;
    const maxX = minX + tileSpan;
    const maxY = MAX_EXTENT - y * tileSpan;
    const minY = maxY - tileSpan;
    return [minX, minY, maxX, maxY];
}

// Paleta oficial de 15 clases del SGC (Capa 9: PGA [g] Tr=475 años)
const SGC_PGA_COLOR_RAMP = [
    { pga: 0.000, rgb: [26, 150, 65], hex: '#1a9641', label: '0.00 g' },
    { pga: 0.005, rgb: [66, 169, 77], hex: '#42a94d', label: '0.005 g' },
    { pga: 0.010, rgb: [106, 189, 88], hex: '#6abd58', label: '0.01 g' },
    { pga: 0.020, rgb: [146, 208, 100], hex: '#92d064', label: '0.02 g' },
    { pga: 0.030, rgb: [179, 223, 118], hex: '#b3df76', label: '0.03 g' },
    { pga: 0.050, rgb: [204, 234, 143], hex: '#ccea8f', label: '0.05 g' },
    { pga: 0.075, rgb: [230, 245, 168], hex: '#e6f5a8', label: '0.075 g' },
    { pga: 0.100, rgb: [255, 255, 192], hex: '#ffffc0', label: '0.10 g' },
    { pga: 0.200, rgb: [255, 232, 165], hex: '#ffe8a5', label: '0.20 g' },
    { pga: 0.300, rgb: [254, 209, 138], hex: '#fed18a', label: '0.30 g' },
    { pga: 0.500, rgb: [254, 186, 111], hex: '#feba6f', label: '0.50 g' },
    { pga: 1.000, rgb: [248, 153, 87], hex: '#f89957', label: '1.00 g' },
    { pga: 1.500, rgb: [237, 110, 67], hex: '#ed6e43', label: '1.50 g' },
    { pga: 2.500, rgb: [226, 47, 67], hex: '#e22f43', label: '2.50 g' },
    { pga: 3.500, rgb: [215, 25, 28], hex: '#d7191c', label: '3.50 g' }
];

const SGC_TILE_CACHE_MAX = 160;
const sgcTilePixelCache = new Map();
let _sgcSampleCtx = null;

function getSgcSampleContext() {
    if (_sgcSampleCtx) return _sgcSampleCtx;
    try {
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 256;
        _sgcSampleCtx = canvas.getContext('2d', { willReadFrequently: true });
    } catch (_) {
        _sgcSampleCtx = null;
    }
    return _sgcSampleCtx;
}

function lngLatToTilePixel(lng, lat, z) {
    const zoom = Math.max(0, Math.min(20, Math.floor(z)));
    const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
    const n = Math.pow(2, zoom);
    const xFloat = ((lng + 180) / 360) * n;
    const latRad = clampedLat * Math.PI / 180;
    const yFloat = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
    const x = Math.floor(xFloat);
    const y = Math.floor(yFloat);
    const px = Math.max(0, Math.min(255, Math.floor((xFloat - x) * 256)));
    const py = Math.max(0, Math.min(255, Math.floor((yFloat - y) * 256)));
    return { x, y, z: zoom, px, py };
}

function classifySgcRasterColor(r, g, b) {
    let bestDistSq = Infinity;
    let bestSegIdx = 0;
    let bestT = 0;

    for (let i = 0; i < SGC_PGA_COLOR_RAMP.length - 1; i++) {
        const a = SGC_PGA_COLOR_RAMP[i].rgb;
        const c = SGC_PGA_COLOR_RAMP[i + 1].rgb;
        const dr = c[0] - a[0];
        const dg = c[1] - a[1];
        const db = c[2] - a[2];
        const lenSq = dr * dr + dg * dg + db * db;
        let t = 0;
        if (lenSq > 0) {
            t = ((r - a[0]) * dr + (g - a[1]) * dg + (b - a[2]) * db) / lenSq;
            t = Math.max(0, Math.min(1, t));
        }
        const pr = a[0] + t * dr;
        const pg = a[1] + t * dg;
        const pb = a[2] + t * db;
        const distSq = (r - pr) * (r - pr) + (g - pg) * (g - pg) + (b - pb) * (b - pb);
        if (distSq < bestDistSq) {
            bestDistSq = distSq;
            bestSegIdx = i;
            bestT = t;
        }
    }

    const stopA = SGC_PGA_COLOR_RAMP[bestSegIdx];
    const stopB = SGC_PGA_COLOR_RAMP[bestSegIdx + 1];
    const pgaEst = stopA.pga + bestT * (stopB.pga - stopA.pga);
    const rangeLabel = `${stopA.label.replace(' g', '')} – ${stopB.label}`;
    const toHex = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
    const hexSample = `#${toHex(r)}${toHex(g)}${toHex(b)}`;

    let bandLabel;
    let bandColor;
    let bandBg;
    let bandBorder;
    let bandDesc;
    if (pgaEst <= 0.10) {
        bandLabel = 'Amenaza Sísmica Baja (NSR-10 ≤ 0.10 g)';
        bandColor = '#15803d';
        bandBg = 'rgba(34, 197, 94, 0.16)';
        bandBorder = 'rgba(34, 197, 94, 0.45)';
        bandDesc = 'Sacudida leve esperada en roca firme (probabilidad del 10 % en 50 años). Exige cumplimiento básico de construcción segura.';
    } else if (pgaEst <= 0.20) {
        bandLabel = 'Amenaza Sísmica Intermedia (0.10 – 0.20 g)';
        bandColor = '#b45309';
        bandBg = 'rgba(234, 179, 8, 0.18)';
        bandBorder = 'rgba(234, 179, 8, 0.48)';
        bandDesc = 'Sacudida moderada a fuerte en roca firme. En suelos blandos o de orilla de río puede amplificarse y requerir refuerzo estructural.';
    } else if (pgaEst <= 0.40) {
        bandLabel = 'Amenaza Sísmica Alta (0.20 – 0.40 g)';
        bandColor = '#ea580c';
        bandBg = 'rgba(249, 115, 22, 0.18)';
        bandBorder = 'rgba(249, 115, 22, 0.48)';
        bandDesc = 'Sacudida fuerte posible (~10 % en 50 años). Exige diseño sismorresistente estricto (NSR-10), amarre de muros y estudio de suelos.';
    } else {
        bandLabel = 'Amenaza Sísmica Muy Alta (> 0.40 g)';
        bandColor = '#dc2626';
        bandBg = 'rgba(239, 68, 68, 0.18)';
        bandBorder = 'rgba(239, 68, 68, 0.50)';
        bandDesc = 'Zona de sacudida muy intensa en el Pacífico y Chocó. Demanda máximos estándares sismorresistentes NSR-10 y cimentación verificada.';
    }

    return {
        pgaEst,
        pgaPctG: (pgaEst * 100).toFixed(1),
        pgaMs2: (pgaEst * 9.81).toFixed(2),
        rangeLabel,
        bandLabel,
        bandColor,
        bandBg,
        bandBorder,
        bandDesc,
        hexSample
    };
}

function sampleSgcPixelAtCoord(lng, lat, zoom) {
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    const baseZ = Number.isFinite(zoom) ? Math.round(zoom) : 6;
    const candidates = [baseZ, baseZ - 1, baseZ + 1, 8, 7, 6, 5, 4];
    const seen = new Set();
    for (const z of candidates) {
        if (z < 4 || z > 12 || seen.has(z)) continue;
        seen.add(z);
        const { x, y, px, py } = lngLatToTilePixel(lng, lat, z);
        const tile = sgcTilePixelCache.get(`${z}/${x}/${y}`);
        if (!tile || !tile.data) continue;
        const offset = (py * tile.width + px) * 4;
        const a = tile.data[offset + 3];
        if (a < 25) continue;
        return {
            r: tile.data[offset],
            g: tile.data[offset + 1],
            b: tile.data[offset + 2],
            a,
            z
        };
    }
    return null;
}

function hideSgcRasterTooltipIfActive() {
    if (tooltip && tooltip.dataset && tooltip.dataset.sgcHover === '1') {
        tooltip.dataset.sgcHover = '';
        tooltip.style.display = 'none';
        tooltip.style.transform = '';
    }
}

function handleSgcRasterHover(info) {
    if (!showSgcWms || !info || !info.coordinate || !tooltip) {
        hideSgcRasterTooltipIfActive();
        return;
    }
    const lng = info.coordinate[0];
    const lat = info.coordinate[1];
    const sample = sampleSgcPixelAtCoord(lng, lat, currentDeckZoom);
    if (!sample) {
        hideSgcRasterTooltipIfActive();
        return;
    }

    const cls = classifySgcRasterColor(sample.r, sample.g, sample.b);
    let nearestMunHtml = '';
    if (municipiosData && municipiosData.length > 0) {
        let bestM = null;
        let bestD = Infinity;
        for (const m of municipiosData) {
            const d = haversineDistanceKm(lat, lng, m.lat, m.lng);
            if (d < bestD) { bestD = d; bestM = m; }
        }
        if (bestM && bestD <= 50) {
            nearestMunHtml = `<p style="margin-top:4px; color:var(--text-tertiary);">Cerca de <strong style="color:var(--text-primary);">${escapeHtml(bestM.nombre)}</strong> (~${bestD.toFixed(1)} km) · Ref. NSR-10: Aa = ${bestM.aa.toFixed(2)} g</p>`;
        }
    }

    tooltip.dataset.sgcHover = '1';
    applyTooltipContext('sgc', cls.bandColor);
    tooltip.style.display = 'block';
    tooltip.innerHTML = `
        <h4 style="display:flex; align-items:center; gap:8px;">
            <span style="display:inline-block; width:13px; height:13px; border-radius:4px; background:${cls.hexSample}; border:1px solid rgba(148,163,184,0.6); flex-shrink:0;"></span>
            <span>Amenaza Sísmica Oficial SGC</span>
        </h4>
        <div style="display:inline-block; margin:4px 0 6px 0; padding:2px 8px; border-radius:6px; background:${cls.bandBg}; border:1px solid ${cls.bandBorder}; color:${cls.bandColor}; font-size:var(--fs-2xs); font-weight:700;">
            ${cls.bandLabel}
        </div>
        <p><strong>Aceleración estimada (PGA):</strong> ~${cls.pgaEst.toFixed(2)} g <span style="color:var(--text-tertiary);">(${cls.pgaPctG}% g · ${cls.pgaMs2} m/s²)</span></p>
        <p><strong>Rango de color en mapa:</strong> ${cls.rangeLabel} <span style="color:var(--text-tertiary);">(Tr = 475 años)</span></p>
        <p style="margin-top:5px; font-size:var(--fs-xs); line-height:1.4; color:var(--text-secondary);">${cls.bandDesc}</p>
        ${nearestMunHtml}
        <p style="margin-top:6px; font-size:var(--fs-2xs); color:var(--accent); font-weight:600;">💡 Haz clic en este punto para consultar el dato exacto oficial SGC.</p>
    `;
    positionTooltip(tooltip, info.x, info.y);
}

function loadSgcWmsTile({ index, signal }) {
    if (!index || index.x === undefined || index.y === undefined || index.z === undefined) {
        return Promise.resolve(null);
    }
    const [minX, minY, maxX, maxY] = tileToMercatorBbox(index.x, index.y, index.z);
    const url = `${SGC_MAPSERVER_BASE}/export?bbox=${minX},${minY},${maxX},${maxY}&bboxSR=3857&imageSR=3857&size=256,256&layers=show:9&format=png32&transparent=true&f=image`;
    return new Promise((resolve) => {
        if (signal && signal.aborted) {
            resolve(null);
            return;
        }
        const img = new Image();
        img.crossOrigin = 'anonymous';
        const onAbort = () => {
            img.src = '';
            resolve(null);
        };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        img.onload = () => {
            if (signal) signal.removeEventListener('abort', onAbort);
            const ctx = getSgcSampleContext();
            if (ctx) {
                try {
                    ctx.clearRect(0, 0, 256, 256);
                    ctx.drawImage(img, 0, 0, 256, 256);
                    const imgData = ctx.getImageData(0, 0, 256, 256);
                    const tileKey = `${index.z}/${index.x}/${index.y}`;
                    if (sgcTilePixelCache.size >= SGC_TILE_CACHE_MAX) {
                        const oldestKey = sgcTilePixelCache.keys().next().value;
                        sgcTilePixelCache.delete(oldestKey);
                    }
                    sgcTilePixelCache.set(tileKey, {
                        width: 256,
                        height: 256,
                        data: imgData.data
                    });
                } catch (_) {
                    // Entorno sin lectura de píxeles CORS o sin soporte canvas
                }
            }
            resolve(img);
        };
        img.onerror = () => {
            if (signal) signal.removeEventListener('abort', onAbort);
            resolve(null);
        };
        img.src = url;
    });
}

let lastSgcIdentifyData = null;

async function querySgcOfficialPoint(lng, lat, customLabel = null) {
    const resultBox = document.getElementById('sgc-wms-identify-result');
    const coordTxt = `${Number(lat).toFixed(4)}° N, ${Number(lng).toFixed(4)}°`;
    const titleLabel = customLabel ? escapeHtml(customLabel) : `Punto (${coordTxt})`;
    if (resultBox) {
        resultBox.innerHTML = `<span style="color:#38bdf8;">Consultando servidor OGC SGC para ${titleLabel}...</span>`;
    }
    try {
        const pad = 1.5;
        const url = `${SGC_MAPSERVER_BASE}/identify?geometry=${lng},${lat}&geometryType=esriGeometryPoint&sr=4326&layers=all:9,10,11&tolerance=2&mapExtent=${lng - pad},${lat - pad},${lng + pad},${lat + pad}&imageDisplay=400,400,96&returnGeometry=false&f=json`;
        const resp = await fetchWithTimeout(url, 8000);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const json = await resp.json();
        const rows = json.results || [];
        const pickVal = (layerId) => {
            const r = rows.find(item => item.layerId === layerId);
            const raw = r && r.attributes ? r.attributes['Classify.Pixel Value'] : null;
            const num = parseFloat(raw);
            return Number.isFinite(num) ? num : null;
        };
        const pga = pickVal(9);
        const sa02 = pickVal(10);
        const sa10 = pickVal(11);
        lastSgcIdentifyData = { label: customLabel || coordTxt, lat, lng, pga, sa02, sa10 };

        if (pga === null && sa02 === null && sa10 === null) {
            if (resultBox) {
                resultBox.innerHTML = `<strong>${titleLabel}:</strong> Sin cobertura de malla SGC en esta coordenada (fuera del dominio raster nacional).`;
            }
            return;
        }
        let nsrRefHtml = '';
        if (municipiosData && municipiosData.length > 0) {
            let bestM = null;
            let bestD = Infinity;
            for (const m of municipiosData) {
                const d = haversineDistanceKm(lat, lng, m.lat, m.lng);
                if (d < bestD) { bestD = d; bestM = m; }
            }
            if (bestM && bestD <= 60) {
                nsrRefHtml = `<div style="margin-top:4px; color:var(--text-tertiary);">Ref. NSR-10 (${escapeHtml(bestM.nombre)}): Aa=${bestM.aa.toFixed(2)} g · Av=${bestM.av.toFixed(2)} g</div>`;
            }
        }
        const htmlOut = `
            <div><strong>${titleLabel}</strong> <span style="color:var(--text-tertiary);">(${coordTxt})</span></div>
            <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:6px; margin-top:6px;">
                <div class="surface-card-soft" style="border-radius:6px; padding:4px 6px;"><span style="color:var(--text-tertiary); display:block;">PGA 475a</span><strong class="tabular-num" style="color:var(--pill-warn-fg);">${pga !== null ? pga.toFixed(3) + ' g' : '--'}</strong></div>
                <div class="surface-card-soft" style="border-radius:6px; padding:4px 6px;"><span style="color:var(--text-tertiary); display:block;">Sa(0.2s)</span><strong class="tabular-num" style="color:var(--pill-crit-fg);">${sa02 !== null ? sa02.toFixed(3) + ' g' : '--'}</strong></div>
                <div class="surface-card-soft" style="border-radius:6px; padding:4px 6px;"><span style="color:var(--text-tertiary); display:block;">Sa(1.0s)</span><strong class="tabular-num" style="color:var(--accent-ui);">${sa10 !== null ? sa10.toFixed(3) + ' g' : '--'}</strong></div>
            </div>
            ${nsrRefHtml}
        `;
        if (resultBox) resultBox.innerHTML = htmlOut;
        const legendIdentify = document.getElementById('legend-sgc-identify');
        if (legendIdentify) legendIdentify.innerHTML = htmlOut;
    } catch (err) {
        if (resultBox) {
            resultBox.innerHTML = `<span style="color:var(--pill-crit-fg);">No fue posible consultar el servicio OGC del SGC en este momento.</span>`;
        }
    }
}

async function fetchWithTimeout(url, timeoutMs = 6500, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

let viewMode = 'none'; 
let currentMag = 0.0;
let currentTime = 1993;
let currentMaxDepth = 250.0;
let highQualityOnly = false;
let showFaults = false;
let showInfra = false;
let selectedFaultId = null;
let faultKinematicFilter = 'all';
let showFaultBuffer = false;
let showLiveSGC = false;
let showSgcWms = false;
let showML = false;
let viewportFilterEnabled = false;
let currentViewportState = { longitude: -77.0, latitude: 6.0, zoom: 6.5 };
let _viewportRenderTimer = null;
let pinnedInspectorItem = null;
let pinnedCompareItem = null;

// Variables de Estado (NSR-10, POT, Benioff, ShakeMap, Time-Lapse)
let currentProfile = 'sismologia';
let isBenioffMode = false;
let benioffExaggeration = 1.5;
let benioffSector = 'all';
let selectedNsrMunicipio = null;
let selectedPotMunicipio = null;

// ShakeMap Simulado y Cinemática de Frentes de Onda
let isSimulatorActive = false;
let activeShakemapScenario = 'palmar_74';
let currentShakemapData = null;
let waveAnimTimeSec = 0.0;
let isWaveAnimPlaying = false;
let waveAnimRafId = null;
let waveAnimLastTimestamp = null;
const WAVE_MAX_TIME_SEC = 120.0; // Duración máxima de propagación regional e interdepartamental (120 s)
const WAVE_VEL_P_KMS = 6.0;      // Velocidad Onda P (6.0 km/s)
const WAVE_VEL_S_KMS = 3.5;      // Velocidad Onda S (3.5 km/s)

// Time-Lapse Dinámico
let timelapseTimer = null;
let isTimelapsePlaying = false;

let chartInstance = null;

// Paleta de Mapas Base Disponibles
const BASEMAP_STYLES = {
    'pos': 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
    'voy': 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json',
    'dark': 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'
};
let currentMapStyle = BASEMAP_STYLES['voy'];

let currentDeckZoom = 6.5;

function normalizeSearchText(str) {
    return String(str || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim();
}

function computeApproxMercatorBounds(viewState, widthPx = 1024, heightPx = 768) {
    if (!viewState || !Number.isFinite(viewState.longitude) || !Number.isFinite(viewState.latitude) || !Number.isFinite(viewState.zoom)) {
        return null;
    }
    const worldSize = 512 * Math.pow(2, viewState.zoom);
    const degPerPxLng = 360 / worldSize;
    const latRad = Math.max(-85, Math.min(85, viewState.latitude)) * Math.PI / 180;
    const degPerPxLat = degPerPxLng * Math.cos(latRad);
    const halfLng = Math.min(180, (Math.max(200, widthPx) / 2) * degPerPxLng);
    const halfLat = Math.min(85, (Math.max(200, heightPx) / 2) * degPerPxLat);
    return {
        minLng: viewState.longitude - halfLng,
        maxLng: viewState.longitude + halfLng,
        minLat: viewState.latitude - halfLat,
        maxLat: viewState.latitude + halfLat
    };
}

function buildActiveFilterChipsState(state) {
    const chips = [];
    if (!state) return chips;
    const modeLabels = {
        puntos: 'Eventos 3D',
        calor: 'Concentración Energía',
        hex: 'Agrupación Hexagonal'
    };
    if (state.viewMode && state.viewMode !== 'none' && modeLabels[state.viewMode]) {
        chips.push({ key: 'viewMode', label: modeLabels[state.viewMode] });
    }
    if (state.isBenioffMode) chips.push({ key: 'benioff', label: 'Perfil Benioff 3D' });
    if (Number(state.currentMag) > 0) chips.push({ key: 'mag', label: `M ≥ ${Number(state.currentMag).toFixed(1)}` });
    if (Number(state.currentTime) > 1993) chips.push({ key: 'time', label: `Desde ${state.currentTime}` });
    if (Number(state.currentMaxDepth) < 250) chips.push({ key: 'depth', label: `Prof. ≤ ${Math.round(state.currentMaxDepth)} km` });
    if (state.highQualityOnly) chips.push({ key: 'calidad', label: 'Alta precisión' });
    if (state.viewportFilterEnabled) chips.push({ key: 'viewport', label: 'Encuadre visible' });
    if (state.showFaults) chips.push({ key: 'fallas', label: 'Fallas geológicas' });
    if (state.showML) chips.push({ key: 'ml', label: 'Zonas DBSCAN' });
    if (state.showLiveSGC) chips.push({ key: 'liveSgc', label: 'FDSN Live 14d' });
    if (state.showSgcWms) chips.push({ key: 'sgcWms', label: 'SGC OGC (Tr=475a)' });
    if (state.showInfra) chips.push({ key: 'infra', label: 'Líneas vitales' });
    if (state.isSimulatorActive) chips.push({ key: 'shakemap', label: 'ShakeMap activo' });
    return chips;
}

function extractInspectorData(object, layerId) {
    if (!object) return null;
    const p = object.properties || {};
    if (layerId === 'fallas-core-layer' || layerId === 'fallas-layer') {
        const coords = object.geometry && object.geometry.coordinates;
        const samplePt = Array.isArray(coords) && Array.isArray(coords[0])
            ? (Array.isArray(coords[0][0]) ? coords[0][0] : coords[0])
            : [-76.6, 5.7];
        return {
            id: p.id || p.nombre || 'falla',
            kicker: 'Estructura Tectónica',
            title: p.nombre || 'Falla Geológica Activa',
            lng: samplePt[0],
            lat: samplePt[1],
            accentColor: '#D97706',
            metrics: [
                { label: 'Mmax', value: `${p.m_max || '--'} Mw` },
                { label: 'Tasa', value: `${p.tasa_mm_ano || '--'} mm/año` },
                { label: 'Longitud', value: `${p.longitud_km || '--'} km` },
                { label: 'Cinemática', value: p.tipo || 'Activa' }
            ],
            compareVal: Number(p.m_max) || 0,
            compareUnit: 'Mw'
        };
    }
    if (layerId === 'infra-iconos' || layerId === 'infra-lineas') {
        const coords = object.geometry && object.geometry.coordinates;
        const samplePt = Array.isArray(coords)
            ? (typeof coords[0] === 'number' ? coords : (Array.isArray(coords[0]) && typeof coords[0][0] === 'number' ? coords[0] : [-76.6, 5.7]))
            : [-76.6, 5.7];
        return {
            id: p.id || p.nombre || 'infra',
            kicker: 'Infraestructura Crítica',
            title: p.nombre || 'Nodo Estratégico',
            lng: samplePt[0],
            lat: samplePt[1],
            accentColor: '#0284C7',
            metrics: [
                { label: 'Tipo', value: (p.tipo || 'Red').toUpperCase() },
                { label: 'Ciudad / Eje', value: p.ciudad || p.ruta || 'Chocó' },
                { label: 'Criticidad', value: p.grupo_nsr10 || 'Estratégica' },
                { label: 'Estado', value: p.estado || 'Referencial' }
            ],
            compareVal: null,
            compareUnit: ''
        };
    }
    if (layerId === 'pot-municipio-pin' && object.m) {
        const m = object.m;
        return {
            id: m.id || m.nombre,
            kicker: `Cabecera Municipal · ${m.departamento}`,
            title: m.nombre,
            lng: m.lng,
            lat: m.lat,
            accentColor: '#16A34A',
            metrics: [
                { label: 'Aa (NSR-10)', value: `${Number(m.aa).toFixed(2)} g` },
                { label: 'Av (NSR-10)', value: `${Number(m.av).toFixed(2)} g` },
                { label: 'Suelo ref.', value: `Tipo ${m.suelo_defecto || 'E'}` },
                { label: 'Población', value: (m.poblacion || 0).toLocaleString() }
            ],
            compareVal: Number(m.aa) || 0,
            compareUnit: 'g (Aa)'
        };
    }
    if (object.geometry && Array.isArray(object.geometry.coordinates)) {
        const coords = object.geometry.coordinates;
        const mag = Number(p.magnitud ?? p.mag ?? 0);
        const prof = Number(p.profundidad ?? 0);
        return {
            id: p.id || `${p.fecha || ''}_${coords[0]}_${coords[1]}`,
            kicker: (layerId === 'sgc-live-layer-core' || layerId === 'sgc-live-dots') ? 'Telemetría FDSN en Vivo' : 'Evento Sísmico Catalogado',
            title: p.municipio || 'Región Pacífica / Chocó',
            lng: coords[0],
            lat: coords[1],
            accentColor: mag >= 5.0 ? '#DC2626' : '#0066CC',
            metrics: [
                { label: 'Magnitud', value: `${mag.toFixed(1)} Mw` },
                { label: 'Profundidad', value: `${prof.toFixed(1)} km` },
                { label: 'Fecha', value: p.fecha ? String(p.fecha).slice(0, 10) : String(p.anio || '--') },
                { label: 'GAP / RMS', value: p.gap !== undefined ? `${p.gap}° / ${p.rms || '-'}s` : (p.fuente || 'SGC') }
            ],
            compareVal: mag,
            compareUnit: 'Mw'
        };
    }
    return null;
}

function openAccordionForElement(el) {
    if (!el) return;
    const acc = el.closest ? el.closest('details.bento-accordion') : null;
    if (acc && !acc.open) acc.open = true;
}

function renderPinnedInspector() {
    const box = document.getElementById('pinned-inspector');
    if (!box) return;
    if (!pinnedInspectorItem) {
        box.style.display = 'none';
        box.innerHTML = '';
        return;
    }
    const item = pinnedInspectorItem;
    const cellsHtml = item.metrics.map(mt => `
        <div class="pinned-inspector-cell">
            <span>${escapeHtml(mt.label)}</span>
            <strong>${escapeHtml(mt.value)}</strong>
        </div>
    `).join('');

    let compareHtml = '';
    if (pinnedCompareItem && pinnedCompareItem.id !== item.id) {
        let deltaText = '';
        if (item.compareVal !== null && pinnedCompareItem.compareVal !== null && item.compareUnit === pinnedCompareItem.compareUnit) {
            const diff = item.compareVal - pinnedCompareItem.compareVal;
            const sign = diff >= 0 ? '+' : '';
            deltaText = ` (Δ ${sign}${diff.toFixed(2)} ${item.compareUnit})`;
        }
        compareHtml = `
            <div class="pinned-compare-box">
                <strong>Referencia A:</strong> ${escapeHtml(pinnedCompareItem.title)}${escapeHtml(deltaText)}
                <button type="button" id="btn-clear-pin-compare" class="filter-chip-close" title="Limpiar referencia" aria-label="Limpiar comparación">✕</button>
            </div>
        `;
    } else if (pinnedCompareItem && pinnedCompareItem.id === item.id) {
        compareHtml = `
            <div class="pinned-compare-box">
                <span>Fijado como Referencia A. Seleccione otra entidad en el mapa para comparar.</span>
            </div>
        `;
    }

    box.style.borderLeftColor = item.accentColor || 'var(--accent)';
    box.innerHTML = `
        <div class="pinned-inspector-head">
            <div>
                <div class="pinned-inspector-kicker">${escapeHtml(item.kicker)}</div>
                <h4 class="pinned-inspector-title">${escapeHtml(item.title)}</h4>
            </div>
            <button type="button" id="btn-close-pin" class="filter-chip-close" aria-label="Cerrar inspector fijado" title="Cerrar inspector (Esc)">✕</button>
        </div>
        <div class="pinned-inspector-grid">${cellsHtml}</div>
        <div class="pinned-inspector-actions">
            <button type="button" id="btn-pin-focus" class="overview-cta-btn">Enfocar</button>
            <button type="button" id="btn-pin-compare" class="overview-cta-btn overview-cta-btn--ghost">${pinnedCompareItem && pinnedCompareItem.id === item.id ? 'Referencia A activa' : 'Comparar A/B'}</button>
        </div>
        ${compareHtml}
    `;
    box.style.display = 'block';

    const closeBtn = document.getElementById('btn-close-pin');
    if (closeBtn) closeBtn.addEventListener('click', () => { pinnedInspectorItem = null; renderPinnedInspector(); });
    const focusBtn = document.getElementById('btn-pin-focus');
    if (focusBtn && deckgl && Number.isFinite(item.lng) && Number.isFinite(item.lat)) {
        focusBtn.addEventListener('click', () => {
            deckgl.setProps({
                initialViewState: {
                    longitude: item.lng,
                    latitude: item.lat,
                    zoom: 9.8,
                    pitch: 45,
                    bearing: 15,
                    transitionDuration: 1100,
                    transitionInterpolator: new deck.FlyToInterpolator()
                }
            });
        });
    }
    const cmpBtn = document.getElementById('btn-pin-compare');
    if (cmpBtn) {
        cmpBtn.addEventListener('click', () => {
            pinnedCompareItem = item;
            renderPinnedInspector();
        });
    }
    const clrCmpBtn = document.getElementById('btn-clear-pin-compare');
    if (clrCmpBtn) {
        clrCmpBtn.addEventListener('click', () => {
            pinnedCompareItem = null;
            renderPinnedInspector();
        });
    }
}

function pinInspectorFromPick(info) {
    if (!info || !info.object) return;
    const layerId = info.layer && info.layer.id ? info.layer.id : '';
    const extracted = extractInspectorData(info.object, layerId);
    if (!extracted) return;
    pinnedInspectorItem = extracted;
    renderPinnedInspector();
}

function updateCapasActiveBadge() {
    const badge = document.getElementById('capas-active-count');
    if (!badge) return;
    const count = [highQualityOnly, showFaults, showML, showLiveSGC, showSgcWms].filter(Boolean).length;
    badge.innerText = count === 1 ? '1 activa' : `${count} activas`;
    badge.classList.toggle('has-active', count > 0);
}

function renderActiveFiltersBar(filteredCount) {
    const bar = document.getElementById('active-filters-bar');
    if (!bar) return;
    const chips = buildActiveFilterChipsState({
        viewMode,
        isBenioffMode,
        currentMag,
        currentTime,
        currentMaxDepth,
        highQualityOnly,
        viewportFilterEnabled,
        showFaults,
        showML,
        showLiveSGC,
        showSgcWms,
        showInfra,
        isSimulatorActive
    });

    const totalLoaded = mapData && Array.isArray(mapData.features) ? mapData.features.length : 0;
    const isEmptyResult = typeof filteredCount === 'number' && filteredCount === 0 && totalLoaded > 0;
    if (chips.length === 0 && !isEmptyResult) {
        bar.innerHTML = '';
        return;
    }

    let html = chips.map(ch => `
        <span class="filter-chip">
            <span>${escapeHtml(ch.label)}</span>
            <button type="button" class="filter-chip-close" data-chip-key="${escapeHtml(ch.key)}" aria-label="Desactivar ${escapeHtml(ch.label)}" title="Quitar filtro">✕</button>
        </span>
    `).join('');

    if (isEmptyResult) {
        html += `
            <span class="empty-state-pill">
                <span>0 sismos cumplen estos filtros</span>
                <button type="button" id="btn-empty-recover" class="overview-cta-btn">Restablecer filtros</button>
            </span>
        `;
    }

    bar.innerHTML = html;

    bar.querySelectorAll('.filter-chip-close[data-chip-key]').forEach(btn => {
        btn.addEventListener('click', () => {
            const key = btn.getAttribute('data-chip-key');
            if (key === 'viewMode') {
                viewMode = 'none';
                ['btn-puntos', 'btn-calor', 'btn-hex'].forEach(id => {
                    const el = document.getElementById(id);
                    if (el) el.classList.remove('active');
                });
            } else if (key === 'benioff' && isBenioffMode) {
                toggleBenioffMode(false);
                return;
            } else if (key === 'mag') {
                currentMag = 0;
                const el = document.getElementById('mag-slider');
                const lbl = document.getElementById('mag-val');
                if (el) el.value = '0';
                if (lbl) lbl.innerText = '0.0';
            } else if (key === 'time') {
                currentTime = 1993;
                const el = document.getElementById('time-slider');
                const lbl = document.getElementById('time-val');
                if (el) el.value = '1993';
                if (lbl) lbl.innerText = '1993';
            } else if (key === 'depth') {
                currentMaxDepth = 250;
                const el = document.getElementById('depth-slider');
                const lbl = document.getElementById('depth-val');
                if (el) el.value = '250';
                if (lbl) lbl.innerText = '250 km (Todos)';
            } else if (key === 'calidad') {
                const el = document.getElementById('check-calidad');
                if (el) { el.checked = false; el.dispatchEvent(new Event('change')); return; }
            } else if (key === 'viewport') {
                viewportFilterEnabled = false;
                const el = document.getElementById('check-viewport-filter');
                if (el) el.checked = false;
            } else if (key === 'fallas') {
                const el = document.getElementById('check-fallas');
                if (el) { el.checked = false; el.dispatchEvent(new Event('change')); return; }
            } else if (key === 'ml') {
                const el = document.getElementById('check-ml');
                if (el) { el.checked = false; el.dispatchEvent(new Event('change')); return; }
            } else if (key === 'liveSgc') {
                const el = document.getElementById('check-live-sgc');
                if (el) { el.checked = false; el.dispatchEvent(new Event('change')); return; }
            } else if (key === 'sgcWms') {
                const el = document.getElementById('check-sgc-wms');
                if (el) { el.checked = false; el.dispatchEvent(new Event('change')); return; }
            } else if (key === 'infra') {
                const el = document.getElementById('check-infra');
                if (el) { el.checked = false; el.dispatchEvent(new Event('change')); return; }
            } else if (key === 'shakemap' && isSimulatorActive) {
                deactivateShakemap();
                return;
            }
            renderLayers();
        });
    });

    const recoverBtn = document.getElementById('btn-empty-recover');
    if (recoverBtn) {
        recoverBtn.addEventListener('click', () => {
            viewportFilterEnabled = false;
            const vp = document.getElementById('check-viewport-filter');
            if (vp) vp.checked = false;
            resetParametricFilters(true);
        });
    }
}

const deckgl = new deck.DeckGL({
    container: 'map-container',
    mapStyle: currentMapStyle,
    glOptions: { preserveDrawingBuffer: true }, // Requerido para capturar Canvas en PDF
    initialViewState: { longitude: -77.0, latitude: 6.0, zoom: 6.5, pitch: 45, bearing: 15 },
    controller: { dragRotate: true },
    layers: [],
    getCursor: ({isDragging}) => isDragging ? 'grabbing' : 'default',
    onViewStateChange: ({ viewState }) => {
        if (viewState) {
            currentViewportState = {
                longitude: viewState.longitude,
                latitude: viewState.latitude,
                zoom: viewState.zoom
            };
            if (typeof viewState.zoom === 'number') {
                currentDeckZoom = viewState.zoom;
            }
            if (viewportFilterEnabled) {
                if (_viewportRenderTimer) clearTimeout(_viewportRenderTimer);
                _viewportRenderTimer = setTimeout(() => {
                    queueRender();
                }, 140);
            }
        }
    },
    onHover: (info) => {
        if (showSgcWms && (!info || !info.picked)) {
            handleSgcRasterHover(info);
        } else if ((!info || !info.picked)) {
            hideSgcRasterTooltipIfActive();
        }
    },
    onClick: (info) => {
        if (info && info.picked && info.object) {
            pinInspectorFromPick(info);
        }
        if (showSgcWms && info && info.coordinate && !info.picked) {
            querySgcOfficialPoint(info.coordinate[0], info.coordinate[1]);
        }
    }
});

const mapContainerEl = document.getElementById('map-container');
if (mapContainerEl) {
    mapContainerEl.addEventListener('mouseleave', () => {
        hideSgcRasterTooltipIfActive();
    });
}

const ctx = document.getElementById('gr-chart').getContext('2d');
Chart.defaults.color = '#94a3b8';
Chart.defaults.font.family = 'Inter';

function applyThemeToCharts(isLight) {
    const tickColor = isLight ? '#334155' : '#94a3b8';
    const gridColor = isLight ? 'rgba(15, 23, 42, 0.10)' : 'rgba(255, 255, 255, 0.06)';
    Chart.defaults.color = tickColor;

    [chartInstance, nsrEspectroChart].forEach(ch => {
        if (!ch || !ch.options || !ch.options.scales) return;
        ['x', 'y'].forEach(axis => {
            const sc = ch.options.scales[axis];
            if (!sc) return;
            if (sc.grid) sc.grid.color = gridColor;
            if (sc.ticks) sc.ticks.color = tickColor;
            if (sc.title) sc.title.color = tickColor;
        });
        if (ch.options.plugins && ch.options.plugins.legend && ch.options.plugins.legend.labels) {
            ch.options.plugins.legend.labels.color = tickColor;
        }
        ch.update('none');
    });
}

// ============================================================================
// LEY DE GUTENBERG-RICHTER: Log10(N) = a - b * Mw (Máxima Verosimilitud Aki-Utsu)
// ============================================================================
function calculateGutenbergRichterMLE(filteredData, yearsSpan, minMagFilter = 0) {
    if (minMagFilter > 4.5) return null;
    const mags = filteredData
        .map(f => parseFloat(f.properties.magnitud))
        .filter(m => Number.isFinite(m));
    if (mags.length < 15) return null;

    // Estimación de magnitud de completitud (Mc) por máxima curvatura en bines de 0.1
    const binCounts = {};
    mags.forEach(m => {
        const bin = Math.round(m * 10) / 10;
        binCounts[bin] = (binCounts[bin] || 0) + 1;
    });
    let maxBin = 3.0;
    let maxCount = -1;
    Object.keys(binCounts).forEach(k => {
        const b = parseFloat(k);
        if (b >= 2.0 && b <= 4.5 && binCounts[k] > maxCount) {
            maxCount = binCounts[k];
            maxBin = b;
        }
    });
    const mc = Math.max(2.5, minMagFilter, maxBin);
    const completeMags = mags.filter(m => m >= mc - 1e-6);
    if (completeMags.length < 10) return null;

    const maxObsMag = completeMags.reduce((mx, v) => (v > mx ? v : mx), -Infinity);
    if ((maxObsMag - mc) < 1.0) return null;

    const meanM = completeMags.reduce((s, v) => s + v, 0) / completeMags.length;
    const denom = meanM - (mc - 0.05);
    if (denom <= 0.05) return null;

    const bVal = Math.LOG10E / denom;
    const annualRateMc = completeMags.length / Math.max(1, yearsSpan);
    const aAnnual = Math.log10(annualRateMc) + bVal * mc;
    return { b: bVal, aAnnual, mc, nComplete: completeMags.length };
}

function updateChart(filteredData) {
    let counts = {};
    filteredData.forEach(f => {
        let m = Math.round((parseFloat(f.properties.magnitud) || 0) * 10) / 10;
        counts[m] = (counts[m] || 0) + 1;
    });
    let labels = Object.keys(counts).map(Number).sort((a,b) => a-b);
    let dataLog = [];
    for(let i = 0; i < labels.length; i++) {
        let sum = 0;
        for(let j = i; j < labels.length; j++) { sum += counts[labels[j]]; }
        dataLog.push(sum > 0 ? Math.log10(sum) : 0);
    }

    const yearsSpan = Math.max(1, 2026 - currentTime + 1);
    const gr = calculateGutenbergRichterMLE(filteredData, yearsSpan, currentMag);

    const bBadge = document.getElementById('b-value-badge');
    const grMetaNote = document.getElementById('gr-meta-note');
    if (bBadge) {
        if (gr && Number.isFinite(gr.b)) {
            bBadge.innerText = `b = ${gr.b.toFixed(2)}`;
            bBadge.style.color = '#38bdf8';
            bBadge.style.borderColor = 'rgba(56,189,248,0.35)';
            bBadge.title = `Aki-Utsu MLE (Mc = ${gr.mc.toFixed(1)}, N ≥ Mc = ${gr.nComplete}). Catálogo heterogéneo ML/Mw/mb; referencia exploratoria.`;
            if (grMetaNote) grMetaNote.innerText = `Mc=${gr.mc.toFixed(1)} · N=${gr.nComplete}`;
        } else {
            bBadge.innerText = 'b = --';
            if (grMetaNote) grMetaNote.innerText = 'Muestra insuficiente';
        }
    }

    const formatTr = (magTarget, observedCount) => {
        if (gr && Number.isFinite(gr.b)) {
            const lambda = Math.pow(10, gr.aAnnual - gr.b * magTarget);
            if (lambda > 0) {
                const tr = 1 / lambda;
                if (tr > 999) return '> 999 a';
                return `~${tr.toFixed(1)} a`;
            }
        }
        return observedCount > 0 ? `~${(yearsSpan / observedCount).toFixed(1)} a` : 's/d';
    };

    const countM5 = filteredData.filter(f => (f.properties.magnitud || 0) >= 5.0).length;
    const countM6 = filteredData.filter(f => (f.properties.magnitud || 0) >= 6.0).length;
    const countM7 = filteredData.filter(f => (f.properties.magnitud || 0) >= 7.0).length;

    const elTr5 = document.getElementById('tr-m5');
    const elTr6 = document.getElementById('tr-m6');
    const elTr7 = document.getElementById('tr-m7');
    const elP50 = document.getElementById('tr-p50-m6');
    if (elTr5) elTr5.innerText = formatTr(5.0, countM5);
    if (elTr6) elTr6.innerText = formatTr(6.0, countM6);
    if (elTr7) elTr7.innerText = formatTr(7.0, countM7);
    if (elP50) {
        if (gr && Number.isFinite(gr.b)) {
            const lam6 = Math.pow(10, gr.aAnnual - gr.b * 6.0);
            const p50 = (1 - Math.exp(-50 * lam6)) * 100;
            elP50.innerText = `${Math.min(99.9, p50).toFixed(1)}%`;
        } else {
            elP50.innerText = '--';
        }
    }

    if (chartInstance) {
        chartInstance.data.labels = labels;
        chartInstance.data.datasets[0].data = dataLog;
        chartInstance.update('none');
        return;
    }

    chartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'Log₁₀(N) Acumulado', data: dataLog, borderColor: '#38bdf8',
                backgroundColor: 'rgba(56, 189, 248, 0.15)', borderWidth: 2, pointRadius: 0, fill: true, tension: 0.25
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: false } },
            scales: {
                x: { title: { display: true, text: 'M' }, grid: { color: 'rgba(255,255,255,0.05)' } },
                y: { title: { display: true, text: 'Log₁₀(N)' }, grid: { color: 'rgba(255,255,255,0.05)' } }
            },
            onClick: (event, elements, chart) => {
                if (elements.length > 0) {
                    const dataIndex = elements[0].index;
                    const clickedMag = chart.data.labels[dataIndex];
                    document.getElementById('mag-slider').value = clickedMag;
                    currentMag = parseFloat(clickedMag);
                    document.getElementById('mag-val').innerText = currentMag.toFixed(1);
                    renderLayers();
                }
            }
        }
    });
    applyThemeToCharts(document.body.classList.contains('theme-light'));
}

// ============================================================================
// PALETA CROMÁTICA CATEGÓRICA PARA CLÚSTERES (MACHINE LEARNING DBSCAN)
// ============================================================================
const CLUSTER_PALETTE = [
    [0, 240, 255],   // Cian eléctrico
    [255, 0, 127],   // Fucsia neón
    [255, 215, 0],   // Oro brillante
    [57, 255, 20],   // Verde lima neón
    [255, 140, 0],   // Naranja intenso
    [186, 85, 211],  // Orquídea / Violeta
    [255, 69, 58],   // Coral
    [0, 122, 255]    // Azul Real
];

function getClusterColor(id, alpha = 220) {
    if (id === undefined || id < 0) return [150, 150, 150, alpha];
    const c = CLUSTER_PALETTE[Math.abs(id) % CLUSTER_PALETTE.length];
    return [c[0], c[1], c[2], alpha];
}

const tooltip = document.getElementById('tooltip');
const TOOLTIP_CTX_CLASSES = [
    'tooltip-ctx-sismo', 'tooltip-ctx-benioff', 'tooltip-ctx-calor', 'tooltip-ctx-hex',
    'tooltip-ctx-falla', 'tooltip-ctx-ml', 'tooltip-ctx-fdsn', 'tooltip-ctx-shakemap',
    'tooltip-ctx-nsr', 'tooltip-ctx-pot', 'tooltip-ctx-sgc'
];

function applyTooltipContext(ctxName, customAccentHex = null, customDarkTitleHex = null, customLightTitleHex = null) {
    if (!tooltip) return;
    tooltip.classList.remove(...TOOLTIP_CTX_CLASSES);
    if (ctxName) tooltip.classList.add(`tooltip-ctx-${ctxName}`);
    if (customAccentHex) {
        tooltip.style.setProperty('--tooltip-accent', customAccentHex);
        tooltip.style.setProperty('--tooltip-title-dark', customDarkTitleHex || customAccentHex);
        tooltip.style.setProperty('--tooltip-title-light', customLightTitleHex || customAccentHex);
    } else {
        tooltip.style.removeProperty('--tooltip-accent');
        tooltip.style.removeProperty('--tooltip-title-dark');
        tooltip.style.removeProperty('--tooltip-title-light');
    }
}

function handleHover(info) {
    if (info.object) {
        const p = info.object.properties;
        if (tooltip.dataset) tooltip.dataset.sgcHover = '';
        tooltip.style.transform = '';
        tooltip.style.display = 'block';
        tooltip.style.left = `${info.x}px`; tooltip.style.top = `${info.y}px`;
        
        if (p.cluster_id !== undefined) {
            const col = getClusterColor(p.cluster_id);
            const colorHex = `rgb(${col[0]},${col[1]},${col[2]})`;
            applyTooltipContext('ml', colorHex);
            const magTxt = p.magnitud ? `${p.magnitud.toFixed(1)} M` : '≥ 4.0 M';
            const munTxt = escapeHtml(p.municipio ? p.municipio.replace(/_/g, ' ') : 'Chocó, Colombia');
            const profTxt = (p.profundidad !== undefined && p.profundidad !== null) ? `<p><strong>Profundidad:</strong> ${escapeHtml(p.profundidad)} km</p>` : '';
            const fechaTxt = p.fecha ? `<p><strong>Fecha:</strong> ${escapeHtml(p.fecha)}</p>` : '';
            tooltip.innerHTML = `<h4>Enjambre Sísmico (IA DBSCAN)</h4>
                                 <p><strong>Ubicación:</strong> ${munTxt}</p>
                                 <p><strong>Clúster Tectónico:</strong> <span style="color:${colorHex}; font-weight:bold; text-shadow:0 0 8px ${colorHex};">Grupo #${escapeHtml(p.cluster_id)}</span></p>
                                 <p><strong>Magnitud del Evento:</strong> ${escapeHtml(magTxt)}</p>
                                 ${profTxt}
                                 ${fechaTxt}
                                 <p style="font-size: var(--fs-2xs); margin-top: 6px; line-height: 1.3;">Agrupación de alta densidad espacial (≥4.0 M) detectada en radio geodésico de 15 km mediante algoritmo DBSCAN sobre el catálogo sísmico.</p>`;
        } else if (p.tipo && ['vial', 'fluvial', 'maritimo', 'aeropuerto', 'hospital', 'puerto'].includes(p.tipo)) {
            const infraPalette = INFRA_COLORS[p.tipo] || INFRA_COLORS.fluvial;
            const lightTitleMap = {
                vial: '#B45309',
                fluvial: '#0369A1',
                maritimo: '#0F766E',
                aeropuerto: '#1D4ED8',
                hospital: '#BE123C',
                puerto: '#7E22CE'
            };
            applyTooltipContext('sgc', infraPalette.hex, infraPalette.textHex, lightTitleMap[p.tipo] || '#0F172A');
            const iconMap = {
                aeropuerto: '✈️',
                hospital: '🏥',
                fluvial: '🚢',
                maritimo: '⛵',
                puerto: '⚓',
                vial: '🛣️'
            };
            const icon = iconMap[p.tipo] || '📍';
            const sub = escapeHtml(p.subtipo || p.nivel || p.tipo);
            tooltip.innerHTML = `<h4>${icon} ${escapeHtml(p.nombre)}</h4>
                                 <p><strong>Categoría:</strong> ${sub}</p>
                                 ${p.ciudad ? `<p><strong>Municipio:</strong> ${escapeHtml(p.ciudad)}</p>` : ''}
                                 ${p.longitud_km ? `<p><strong>Longitud de Corredor:</strong> ${escapeHtml(p.longitud_km)} km</p>` : ''}
                                 ${p.vulnerabilidad ? `<p style="color:#ffb703;"><strong>Vulnerabilidad:</strong> ${escapeHtml(p.vulnerabilidad)}</p>` : ''}
                                 ${p.rol ? `<p><strong>Función Estratégica:</strong> ${escapeHtml(p.rol)}</p>` : ''}
                                 ${p.importancia_nsr10 ? `<p style="color:#38bdf8;"><strong>Clasificación NSR-10:</strong> ${escapeHtml(p.importancia_nsr10)}</p>` : ''}`;
        } else if (p.nombre) {
            let desc = "";
            if (p.nombre.includes("Nazca")) {
                applyTooltipContext('benioff');
                desc = `<p style="font-size: var(--fs-2xs); margin-top: 6px; line-height: 1.3;">Límite de colisión tectónica (Margen Convergente o Fosa) donde la placa oceánica de Nazca se subduce bajo la placa continental Sudamericana, responsable de la sismicidad más destructiva de la región.</p>`;
            } else {
                const fColor = p.tipo === 'inversa' ? '#EF4444' : (p.tipo === 'subduccion' ? '#38BDF8' : '#F59E0B');
                applyTooltipContext('falla', fColor, p.tipo === 'inversa' ? '#F87171' : fColor, p.tipo === 'inversa' ? '#B91C1C' : '#B45309');
            }
            tooltip.innerHTML = `<h4>Estructura Geológica</h4>
                                 <p><strong>Falla:</strong> ${escapeHtml(p.nombre.replace(' (Margen)', ''))}</p>
                                 ${desc}`;
        } else if (p.fuente && (p.fuente.includes('SGC') || p.fuente.includes('Telemétrica') || p.fuente.includes('USGS') || p.fuente.includes('EMSC'))) {
            applyTooltipContext('fdsn');
            const depthStr = p.profundidad < 30 ? 'Superficial' : (p.profundidad < 70 ? 'Intermedio' : 'Profundo');
            const magVal = (p.mag !== undefined ? p.mag : p.magnitud) || 0;
            const tiempoBadge = p.esHoy
                ? `<span style="background:rgba(16,185,129,0.25); color:#34d399; border:1px solid #10b981; border-radius:4px; padding:1px 6px; font-size:var(--fs-2xs); font-weight:700;">● HOY (${escapeHtml(p.diffHours || 0)}h)</span>`
                : `<span style="background:rgba(148,163,184,0.15); color:#cbd5e1; border:1px solid #64748b; border-radius:4px; padding:1px 6px; font-size:var(--fs-2xs);">Reciente (${escapeHtml(p.diffHours ? Math.round(p.diffHours/24) + 'd atrás' : 'Telemétrico')})</span>`;

            tooltip.innerHTML = `<h4 style="display:flex; align-items:center; justify-content:space-between; gap:6px;">
                                    <span style="display:flex; align-items:center; gap:6px;">
                                        <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:#10b981; box-shadow:0 0 8px #10b981;"></span>
                                        📡 Telemetría FDSN: ${escapeHtml(p.fecha)}
                                    </span>
                                    ${tiempoBadge}
                                 </h4>
                                 <p><strong>Magnitud:</strong> <span style="color:#ffd60a; font-weight:bold;">${escapeHtml(magVal)} M</span></p>
                                 <p><strong>Profundidad Hipocentral:</strong> ${escapeHtml(p.profundidad)} km (${depthStr})</p>
                                 <p><strong>Ubicación:</strong> ${escapeHtml(p.municipio)}</p>
                                 <p style="color:#a7f3d0; font-size:var(--fs-xs); margin-top:4px;"><strong>Agencia / Red:</strong> ${escapeHtml(p.fuente)}</p>
                                 ${p.rms ? `<p style="color:#94a3b8; font-size:var(--fs-2xs);">RMS: ${escapeHtml(p.rms)}s | Gap: ${escapeHtml(p.gap)}°</p>` : ''}`;
        } else {
            applyTooltipContext(isBenioffMode ? 'benioff' : 'sismo');
            const depthStr = p.profundidad < 30 ? 'Superficial' : (p.profundidad < 70 ? 'Intermedio' : 'Profundo');
            const fuenteInfo = (p.fuente) ? `<span style="color:#38bdf8; font-weight:600;">[${escapeHtml(p.fuente)}]</span> ` : '';
            let benioffExtra = '';
            if (isBenioffMode) {
                const zVisual = (p.profundidad * benioffExaggeration).toFixed(1);
                benioffExtra = `<p style="color:#38bdf8; font-size:var(--fs-xs); margin-top:4px;">📐 <strong>Corte Benioff:</strong> Profundidad Z: -${zVisual} km (${benioffExaggeration.toFixed(2)}x)</p>`;
            }
            tooltip.innerHTML = `<h4>${escapeHtml(p.fecha)}</h4><p><strong>Magnitud:</strong> ${escapeHtml(p.magnitud)} M <span style="font-size:var(--fs-2xs);color:#94a3b8;">(ML/Mw/mb)</span></p><p><strong>Profundidad:</strong> ${escapeHtml(p.profundidad)} km (${depthStr})</p><p><strong>Ubicación:</strong> ${fuenteInfo}${escapeHtml(p.municipio)}</p>${benioffExtra}`;
        }
    } else if (showSgcWms) {
        handleSgcRasterHover(info);
    } else {
        if (tooltip.dataset) tooltip.dataset.sgcHover = '';
        tooltip.style.transform = '';
        tooltip.style.display = 'none';
    }
}

// ============================================================================
// MANEJADORES DE HOVER Y PROCESADORES 3D PARA MODOS VISUALES
// ============================================================================
function handleStandardCalorHover(info) {
    if (info.object) {
        tooltip.style.display = 'block';
        tooltip.style.left = `${info.x}px`;
        tooltip.style.top = `${info.y}px`;

        let maxMag = 0;
        let totalSismos = 0;
        let municipiosMap = {};
        let mainLocation = "Chocó, Colombia";

        if (info.object.points && info.object.points.length > 0) {
            totalSismos = info.object.points.length;
            info.object.points.forEach(pt => {
                const dataObj = pt.source ? pt.source : pt;
                if (dataObj && dataObj.properties) {
                    if (dataObj.properties.magnitud !== undefined) {
                        let m = parseFloat(dataObj.properties.magnitud);
                        if (!isNaN(m) && m > maxMag) maxMag = m;
                    }
                    if (dataObj.properties.municipio) {
                        let mun = dataObj.properties.municipio;
                        municipiosMap[mun] = (municipiosMap[mun] || 0) + 1;
                    }
                }
            });
            let topCount = 0;
            for (let key in municipiosMap) {
                if (municipiosMap[key] > topCount) {
                    topCount = municipiosMap[key];
                    mainLocation = key;
                }
            }
        }

        applyTooltipContext('calor');
        tooltip.innerHTML = `<h4>Foco de Acumulación Sísmica</h4>
                             <p><strong>Ubicación:</strong> ${escapeHtml(mainLocation)}</p>
                             <p>Total sismos acumulados: <strong>${totalSismos} eventos</strong></p>
                             <p>Magnitud Máxima en zona: <strong>${maxMag > 0 ? maxMag.toFixed(1) + ' M' : 'N/A'}</strong></p>`;
    } else {
        tooltip.style.display = 'none';
    }
}

function handleStandardHexHover(info) {
    if (info.object) {
        tooltip.style.display = 'block';
        tooltip.style.left = `${info.x}px`;
        tooltip.style.top = `${info.y}px`;

        let municipiosMap = {};
        let mainLocation = "Chocó, Colombia";
        if (info.object.points && info.object.points.length > 0) {
            info.object.points.forEach(pt => {
                const dataObj = pt.source ? pt.source : pt;
                if (dataObj && dataObj.properties && dataObj.properties.municipio) {
                    let mun = dataObj.properties.municipio;
                    municipiosMap[mun] = (municipiosMap[mun] || 0) + 1;
                }
            });
            let topCount = 0;
            for (let key in municipiosMap) {
                if (municipiosMap[key] > topCount) {
                    topCount = municipiosMap[key];
                    mainLocation = key;
                }
            }
        }

        applyTooltipContext('hex');
        tooltip.innerHTML = `<h4>Agrupación Espacial 3D</h4>
                             <p><strong>Ubicación:</strong> ${escapeHtml(mainLocation)}</p>
                             <p>Eventos registrados: <strong>${info.object.points.length}</strong></p>`;
    } else {
        tooltip.style.display = 'none';
    }
}

function handleBenioffCalorHover(info) {
    if (info.object) {
        const p = info.object.properties;
        const mag = parseFloat(p.magnitud) || 3.0;
        const prof = parseFloat(p.profundidad) || 10.0;
        const joules = Math.pow(10, 4.8 + 1.5 * mag);
        const tonsTnt = joules / 4.184e9;

        let estrato = "Superficial (Interfase Fosa 0-30 km)";
        if (prof >= 70) estrato = "Profundo (Manto / Intralosa >70 km)";
        else if (prof >= 30) estrato = "Intermedio (Losa Nazca 30-70 km)";

        tooltip.style.display = 'block';
        tooltip.style.left = `${info.x}px`;
        tooltip.style.top = `${info.y}px`;
        applyTooltipContext('calor');
        tooltip.innerHTML = `
            <h4>Concentración de Energía Sísmica 3D</h4>
            <p><strong>Ubicación:</strong> ${escapeHtml(p.municipio || 'Chocó - Región Pacífica')}</p>
            <p><strong>Magnitud:</strong> <span style="color:#fbbf24; font-weight:bold;">${mag.toFixed(1)} M</span></p>
            <p><strong>Profundidad Hipocentral:</strong> ${prof.toFixed(1)} km (${estrato})</p>
            <p><strong>Energía Radiada:</strong> <span style="color:#f97316; font-weight:700;">${joules.toExponential(2)} Joules</span></p>
            <p style="font-size:var(--fs-xs); color:var(--text-secondary); margin-top:4px; line-height:1.3;">Equivalente detonante: ≈ ${tonsTnt < 1 ? (tonsTnt * 1000).toFixed(0) + ' kg TNT' : tonsTnt.toFixed(1) + ' Toneladas TNT'}.</p>
        `;
    } else {
        tooltip.style.display = 'none';
    }
}

function handleBenioffHexHover(info) {
    if (info.object) {
        const d = info.object;
        tooltip.style.display = 'block';
        tooltip.style.left = `${info.x}px`;
        tooltip.style.top = `${info.y}px`;

        let nivel = '🔹 Agrupación Dispersa';
        if (d.count >= 15) nivel = '🔥 Enjambre Sísmico Denso';
        else if (d.count >= 5) nivel = '⚡ Concentración Moderada';

        applyTooltipContext('hex');
        tooltip.innerHTML = `
            <h4>Agrupación Espacial 3D (Cúmulo de Subducción)</h4>
            <p><strong>Sector:</strong> ${escapeHtml(d.municipio || 'Sector Benioff')}</p>
            <p><strong>Profundidad Media:</strong> ${d.avgProf.toFixed(1)} km</p>
            <p><strong>Sismos Agrupados en Celda:</strong> <span style="color:#34d399; font-weight:bold;">${d.count} eventos</span></p>
            <p><strong>Rango de Magnitud:</strong> ${d.minMag.toFixed(1)} - ${d.maxMag.toFixed(1)} M</p>
            <p style="font-size:var(--fs-xs); color:var(--text-secondary); margin-top:4px; line-height:1.3;">Nivel: ${nivel}. Prisma 3D anclado a la losa subducente.</p>
        `;
    } else {
        tooltip.style.display = 'none';
    }
}

function buildBenioffSpatialClusters(data, exaggeration) {
    const clusterMap = new Map();
    const cellSize = 0.18; // ~20 km en latitud/longitud
    const depthInterval = 25.0; // capas de 25 km en profundidad

    data.forEach(f => {
        const c = f.geometry.coordinates;
        const p = f.properties;
        const lng = c[0];
        const lat = c[1];
        const prof = parseFloat(p.profundidad) || 10.0;
        const mag = parseFloat(p.magnitud) || 3.0;

        const cellX = Math.floor(lng / cellSize);
        const cellY = Math.floor(lat / cellSize);
        const cellZ = Math.floor(prof / depthInterval);
        const key = `${cellX}_${cellY}_${cellZ}`;

        if (!clusterMap.has(key)) {
            clusterMap.set(key, {
                lngSum: 0, latSum: 0, profSum: 0,
                count: 0, maxMag: 0, minMag: 99,
                municipios: {},
                depthTier: cellZ * depthInterval
            });
        }

        const cell = clusterMap.get(key);
        cell.lngSum += lng;
        cell.latSum += lat;
        cell.profSum += prof;
        cell.count += 1;
        if (mag > cell.maxMag) cell.maxMag = mag;
        if (mag < cell.minMag) cell.minMag = mag;
        if (p.municipio) {
            cell.municipios[p.municipio] = (cell.municipios[p.municipio] || 0) + 1;
        }
    });

    const clusters = [];
    clusterMap.forEach((val) => {
        const avgLng = val.lngSum / val.count;
        const avgLat = val.latSum / val.count;
        const avgProf = val.profSum / val.count;

        let topMun = 'Chocó - Litoral Pacífico';
        let topCount = 0;
        for (const m in val.municipios) {
            if (val.municipios[m] > topCount) {
                topCount = val.municipios[m];
                topMun = m;
            }
        }

        const zBase = -avgProf * 1000 * exaggeration;
        const height = Math.max(3500, Math.min(26000, val.count * 1600 * exaggeration));

        clusters.push({
            lng: avgLng,
            lat: avgLat,
            zBase: zBase,
            height: height,
            avgProf: avgProf,
            count: val.count,
            maxMag: val.maxMag,
            minMag: val.minMag === 99 ? val.maxMag : val.minMag,
            municipio: topMun
        });
    });

    return clusters;
}

// ============================================================================
// CÁLCULO GEODÉSICO DE DISTANCIAS Y MANEJADORES DE FALLAS GEOLÓGICAS
// ============================================================================
function distToSegment(px, py, x1, y1, x2, y2) {
    const cosLat = Math.cos(((py + (y1 + y2) / 2) / 2) * Math.PI / 180);
    const kx = 111.32 * cosLat;
    const ky = 110.57;

    const pxKm = px * kx;
    const pyKm = py * ky;
    const x1Km = x1 * kx;
    const y1Km = y1 * ky;
    const x2Km = x2 * kx;
    const y2Km = y2 * ky;

    const dx = x2Km - x1Km;
    const dy = y2Km - y1Km;
    const lenSq = dx * dx + dy * dy;

    if (lenSq === 0) {
        return Math.hypot(pxKm - x1Km, pyKm - y1Km);
    }

    let t = ((pxKm - x1Km) * dx + (pyKm - y1Km) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));

    const projX = x1Km + t * dx;
    const projY = y1Km + t * dy;
    return Math.hypot(pxKm - projX, pyKm - projY);
}

function getMinDistanceToLine(pointLng, pointLat, lineCoords) {
    if (!lineCoords || lineCoords.length < 2) return Infinity;
    let minDist = Infinity;
    for (let i = 0; i < lineCoords.length - 1; i++) {
        const p1 = lineCoords[i];
        const p2 = lineCoords[i + 1];
        const d = distToSegment(pointLng, pointLat, p1[0], p1[1], p2[0], p2[1]);
        if (d < minDist) minDist = d;
    }
    return minDist;
}

function handleFaultHover(info) {
    if (info.object && info.object.properties) {
        const p = info.object.properties;
        tooltip.style.display = 'block';
        tooltip.style.left = `${info.x}px`;
        tooltip.style.top = `${info.y}px`;

        let tipoBadge = 'Rumbo Dextral';
        let colorBadge = '#fbbf24';
        if (p.tipo === 'subduccion') {
            tipoBadge = 'Subducción Convergente';
            colorBadge = '#38bdf8';
        } else if (p.tipo === 'inversa') {
            tipoBadge = 'Inversa de Cabalgamiento';
            colorBadge = '#f87171';
        }

        tooltip.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                <h4 style="margin:0; font-size:var(--fs-sm); color:#fff;">${escapeHtml(p.nombre)}</h4>
            </div>
            <p style="margin:2px 0;"><span style="display:inline-block; padding:1px 6px; border-radius:4px; font-size:var(--fs-2xs); font-weight:bold; background:rgba(255,255,255,0.1); color:${colorBadge};">${escapeHtml(tipoBadge)}</span></p>
            <p style="margin:2px 0;"><strong>Sistema:</strong> ${escapeHtml(p.sistema || 'Falla Activa')}</p>
            <p style="margin:2px 0;"><strong>Tasa de Desplazamiento:</strong> ${escapeHtml(p.tasa_mm_ano || 2.0)} mm/año</p>
            <p style="margin:2px 0;"><strong>Potencial Sismogénico:</strong> <span style="color:#ef4444; font-weight:bold;">${escapeHtml(p.m_max || 7.0)} Mw</span></p>
            <p style="margin:2px 0;"><strong>Longitud de Traza:</strong> ${escapeHtml(p.longitud_km || 100)} km</p>
            ${p.sismo_historico ? `<p style="margin:2px 0; color:#fbbf24; font-size:var(--fs-xs);"><strong>Sismo Destructor:</strong> ${escapeHtml(p.sismo_historico)}</p>` : ''}
        `;
    } else {
        tooltip.style.display = 'none';
    }
}

function handleFaultClick(info) {
    if (!info.object || !info.object.properties) return;
    const p = info.object.properties;
    selectFault(p.id, true);
    pinInspectorFromPick(info);
}

function selectFault(faultId, shouldFly = false) {
    if (!faultData || !faultData.features) return;
    
    if (!faultId || faultId === 'all') {
        selectedFaultId = null;
        const sel = document.getElementById('select-falla-activa');
        if (sel) sel.value = 'all';
        const cardNombre = document.getElementById('falla-card-nombre');
        const cardBadge = document.getElementById('falla-card-badge');
        const cardTasa = document.getElementById('falla-card-tasa');
        const cardMmax = document.getElementById('falla-card-mmax');
        const cardLong = document.getElementById('falla-card-longitud');
        const cardSismos = document.getElementById('falla-card-sismos');
        const cardHist = document.getElementById('falla-card-sismo-hist');

        if (cardNombre) cardNombre.innerText = 'Todas las Fallas (11 Sistemas)';
        if (cardBadge) {
            cardBadge.innerText = 'Red Geodinámica';
            cardBadge.style.color = '#38bdf8';
        }
        if (cardTasa) cardTasa.innerText = 'Variable';
        if (cardMmax) cardMmax.innerText = 'Hasta 8.8 Mw';
        if (cardLong) cardLong.innerText = '~2,500 km';
        if (cardSismos) cardSismos.innerText = (mapData.features ? mapData.features.length.toLocaleString() : '0') + ' en total';
        if (cardHist) cardHist.innerText = 'Historial regional activo';
        renderLayers();
        return;
    }

    const feature = faultData.features.find(f => f.properties && f.properties.id === faultId);
    if (!feature) return;

    selectedFaultId = faultId;
    const p = feature.properties;
    const coords = feature.geometry.coordinates;

    // Actualizar selector desplegable
    const sel = document.getElementById('select-falla-activa');
    if (sel && sel.value !== faultId) sel.value = faultId;

    // Calcular sismos cercanos (< 25 km) a partir del catálogo
    let sismosCercaCount = 0;
    let maxMagCerca = 0;
    if (mapData && mapData.features) {
        mapData.features.forEach(f => {
            const c = f.geometry.coordinates;
            const dist = getMinDistanceToLine(c[0], c[1], coords);
            if (dist <= 25.0) {
                sismosCercaCount++;
                const m = parseFloat(f.properties.magnitud) || 0;
                if (m > maxMagCerca) maxMagCerca = m;
            }
        });
    }

    // Actualizar Tarjeta Informativa
    const cardNombre = document.getElementById('falla-card-nombre');
    const cardBadge = document.getElementById('falla-card-badge');
    const cardTasa = document.getElementById('falla-card-tasa');
    const cardMmax = document.getElementById('falla-card-mmax');
    const cardLong = document.getElementById('falla-card-longitud');
    const cardSismos = document.getElementById('falla-card-sismos');
    const cardHist = document.getElementById('falla-card-sismo-hist');

    if (cardNombre) cardNombre.innerText = p.nombre;
    if (cardBadge) {
        cardBadge.innerText = p.tipo_label || (p.tipo === 'subduccion' ? 'Subducción' : (p.tipo === 'rumbo' ? 'Rumbo Dextral' : 'Inversa'));
        cardBadge.style.color = p.tipo === 'subduccion' ? '#38bdf8' : (p.tipo === 'rumbo' ? '#fbbf24' : '#f87171');
    }
    if (cardTasa) cardTasa.innerText = `${p.tasa_mm_ano || 2.0} mm/año`;
    if (cardMmax) cardMmax.innerText = `${p.m_max || 7.0} Mw`;
    if (cardLong) cardLong.innerText = `${p.longitud_km || 100} km`;
    if (cardSismos) cardSismos.innerText = `${sismosCercaCount} eventos (Máx ${maxMagCerca > 0 ? maxMagCerca.toFixed(1) : '--'} Mw)`;
    if (cardHist) cardHist.innerText = p.sismo_historico ? `Sismo histórico: ${p.sismo_historico}` : 'Sismicidad recurrente';

    // Vuelo de cámara suave si es requerido
    if (shouldFly && deckgl && coords && coords.length > 0) {
        let sumLng = 0, sumLat = 0;
        coords.forEach(c => { sumLng += c[0]; sumLat += c[1]; });
        const centerLng = sumLng / coords.length;
        const centerLat = sumLat / coords.length;
        const len = p.longitud_km || 150;
        const targetZoom = len > 350 ? 6.2 : (len > 180 ? 7.2 : 8.0);

        deckgl.setProps({
            initialViewState: {
                longitude: centerLng,
                latitude: centerLat,
                zoom: targetZoom,
                pitch: 45,
                bearing: 20,
                transitionDuration: 1400,
                transitionInterpolator: new deck.FlyToInterpolator()
            }
        });
    }

    renderLayers();
}

function renderLayers(options = {}) {
    let layers = [];

    if (chocoBaseData && chocoBaseData.features) {
        layers.push(new deck.GeoJsonLayer({
            id: 'choco-offline-basemap',
            data: chocoBaseData,
            filled: true,
            stroked: true,
            getFillColor: d => d.properties && d.properties.es_choco && d.properties.nivel === 'municipio'
                ? [56, 189, 248, 12]
                : (d.properties && d.properties.es_choco ? [56, 189, 248, 22] : [148, 163, 184, 8]),
            getLineColor: d => d.properties && d.properties.es_choco && d.properties.nivel === 'departamento'
                ? [56, 189, 248, 160]
                : (d.properties && d.properties.es_choco ? [56, 189, 248, 55] : [148, 163, 184, 65]),
            lineWidthMinPixels: d => (d.properties && d.properties.nivel === 'departamento' && d.properties.es_choco) ? 2 : 1,
            pickable: false
        }));
    }

    if (showSgcWms) {
        layers.push(new deck.TileLayer({
            id: 'sgc-official-pga-wms',
            extent: [-81.8, -4.3, -66.8, 13.5],
            minZoom: 4,
            maxZoom: 13,
            tileSize: 256,
            opacity: 0.68,
            getTileData: loadSgcWmsTile,
            renderSubLayers: props => {
                const { bbox } = props.tile || {};
                if (!props.data || !bbox) return null;
                return new deck.BitmapLayer(props, {
                    data: null,
                    image: props.data,
                    bounds: [bbox.west, bbox.south, bbox.east, bbox.north]
                });
            }
        }));
    }

    const vpBounds = viewportFilterEnabled
        ? computeApproxMercatorBounds(currentViewportState, window.innerWidth, window.innerHeight)
        : null;

    const filteredData = mapData.features.filter(f => {
        const p = f.properties;
        if(p.anio < currentTime) return false; // Filtra descartando sismos anteriores al año mínimo
        if(p.magnitud < currentMag) return false;
        if(p.profundidad !== undefined && p.profundidad > currentMaxDepth) return false; // Filtro de profundidad hipocentral
        if(highQualityOnly && p.gap !== undefined && (p.gap > 180 || p.rms > 1.0)) return false;

        if (vpBounds && f.geometry && Array.isArray(f.geometry.coordinates)) {
            const [lng, lat] = f.geometry.coordinates;
            if (lng < vpBounds.minLng || lng > vpBounds.maxLng || lat < vpBounds.minLat || lat > vpBounds.maxLat) {
                return false;
            }
        }

        // Filtro de trinchera o corte transversal latitudinal en Modo Benioff
        if (isBenioffMode && benioffSector !== 'all') {
            const lat = f.geometry.coordinates[1];
            if (benioffSector === 'norte' && (lat < 6.0 || lat > 8.5)) return false;
            if (benioffSector === 'centro' && (lat < 5.0 || lat >= 6.0)) return false;
            if (benioffSector === 'sur' && (lat < 3.8 || lat >= 5.0)) return false;
        }

        return true;
    });

    document.getElementById('count').innerText = filteredData.length.toLocaleString();
    renderActiveFiltersBar(filteredData.length);
    updateCapasActiveBadge();
    if (!options.skipChart) {
        updateChart(filteredData);
    }
    window.currentFilteredData = filteredData;

    if (viewMode === 'puntos') {
        layers.push(new deck.ScatterplotLayer({
            id: 'sismos-3d',
            data: filteredData,
            getPosition: d => {
                const c = d.geometry.coordinates;
                const z = isBenioffMode ? (-d.properties.profundidad * 1000 * benioffExaggeration) : 0;
                return [c[0], c[1], z];
            },
            radiusUnits: 'meters',
            radiusMinPixels: 3,
            radiusMaxPixels: 28,
            getRadius: d => Math.pow(1.6, d.properties.magnitud) * (isBenioffMode ? 1400 : 1000),
            getFillColor: d => {
                const prof = d.properties.profundidad;
                if (prof < 30) return [230, 159, 0, 225];   // Ámbar Okabe-Ito (< 30 km)
                if (prof < 70) return [204, 121, 167, 215]; // Magenta-rosa Okabe-Ito (30-70 km)
                return [0, 114, 178, 220];                  // Azul profundo Okabe-Ito (> 70 km)
            },
            pickable: true, autoHighlight: true, highlightColor: [255, 255, 255, 200], onHover: handleHover,
            updateTriggers: { 
                getRadius: [currentMag, isBenioffMode], 
                getPosition: [isBenioffMode, benioffExaggeration, benioffSector] 
            }
        }));
    } else if (viewMode === 'calor') {
        if (isBenioffMode) {
            // Modo Benioff 3D: Nube térmica volumétrica de energía radiada (Gutenberg-Richter)
            // 1. Halo difuso exterior con radio proporcional a energía sísmica liberada
            layers.push(new deck.ScatterplotLayer({
                id: 'benioff-calor-halo',
                data: filteredData,
                getPosition: d => {
                    const c = d.geometry.coordinates;
                    const z = -d.properties.profundidad * 1000 * benioffExaggeration;
                    return [c[0], c[1], z];
                },
                getRadius: d => {
                    const mag = d.properties.magnitud || 3.0;
                    const eRatio = Math.pow(10, 0.32 * (mag - 3.0));
                    return Math.min(26000, Math.max(3500, 3000 * eRatio)) * (benioffExaggeration >= 1.5 ? 1.25 : 1.0);
                },
                getFillColor: d => {
                    const mag = d.properties.magnitud || 3.0;
                    if (mag >= 6.5) return [255, 255, 220, 210]; // Blanco incandescente (ruptura severa)
                    if (mag >= 5.5) return [250, 193, 39, 180];  // Amarillo solar (alta energía)
                    if (mag >= 4.5) return [212, 72, 66, 150];   // Rojo fuego (energía moderada-alta)
                    if (mag >= 3.8) return [159, 42, 99, 120];   // Magenta
                    return [101, 21, 110, 90];                   // Púrpura térmico (fondo)
                },
                pickable: true,
                autoHighlight: true,
                highlightColor: [255, 255, 255, 200],
                onHover: handleBenioffCalorHover,
                updateTriggers: {
                    getPosition: [isBenioffMode, benioffExaggeration, benioffSector],
                    getRadius: [isBenioffMode, benioffExaggeration]
                }
            }));

            // 2. Núcleo denso de asperidad sísmica
            layers.push(new deck.ScatterplotLayer({
                id: 'benioff-calor-core',
                data: filteredData,
                getPosition: d => {
                    const c = d.geometry.coordinates;
                    const z = -d.properties.profundidad * 1000 * benioffExaggeration;
                    return [c[0], c[1], z];
                },
                getRadius: d => {
                    const mag = d.properties.magnitud || 3.0;
                    const eRatio = Math.pow(10, 0.25 * (mag - 3.0));
                    return Math.max(1200, 1600 * eRatio);
                },
                getFillColor: d => {
                    const mag = d.properties.magnitud || 3.0;
                    if (mag >= 5.5) return [255, 245, 180, 240];
                    return [255, 140, 40, 220];
                },
                pickable: false,
                updateTriggers: {
                    getPosition: [isBenioffMode, benioffExaggeration, benioffSector]
                }
            }));
        } else {
            // Modo 2D estándar: Heatmap superficial + Hexagon hover interceptor
            layers.push(new deck.HeatmapLayer({
                id: 'sismos-calor', data: filteredData,
                getPosition: d => [d.geometry.coordinates[0], d.geometry.coordinates[1]],
                getWeight: d => Math.pow(10, 1.5 * d.properties.magnitud), 
                radiusPixels: 55, intensity: 1.2, threshold: 0.05,
                colorRange: [ [0,0,4], [40,11,84], [101,21,110], [159,42,99], [212,72,66], [245,125,21], [250,193,39], [252,253,191] ]
            }));
            
            layers.push(new deck.HexagonLayer({
                id: 'calor-hover', data: filteredData,
                getPosition: d => [d.geometry.coordinates[0], d.geometry.coordinates[1]],
                radius: 12000, elevationScale: 0, extruded: false, pickable: true,
                colorRange: [ [255,255,255,1], [255,255,255,1], [255,255,255,1], [255,255,255,1], [255,255,255,1], [255,255,255,1] ],
                onHover: handleStandardCalorHover
            }));
        }
    } else if (viewMode === 'hex') {
        if (isBenioffMode) {
            // Modo Benioff 3D: Cúmulos Espaciales 3D prismáticos situados en la losa de subducción
            const benioffClusters = buildBenioffSpatialClusters(filteredData, benioffExaggeration);
            layers.push(new deck.ColumnLayer({
                id: 'benioff-spatial-clusters',
                data: benioffClusters,
                diskResolution: 6, // Prisma hexagonal
                radius: 6500,
                extruded: true,
                getPosition: d => [d.lng, d.lat, d.zBase],
                getElevation: d => d.height,
                getFillColor: d => {
                    const cnt = d.count;
                    if (cnt >= 20) return [253, 231, 37, 235];  // Amarillo (máxima densidad)
                    if (cnt >= 10) return [94, 201, 98, 220];   // Verde claro
                    if (cnt >= 5)  return [33, 145, 140, 210];  // Turquesa
                    if (cnt >= 3)  return [59, 82, 139, 200];   // Azul
                    return [68, 1, 84, 190];                    // Violeta oscuro (baja densidad)
                },
                pickable: true,
                autoHighlight: true,
                highlightColor: [255, 255, 255, 180],
                onHover: handleBenioffHexHover,
                updateTriggers: {
                    getPosition: [isBenioffMode, benioffExaggeration, benioffSector],
                    getElevation: [isBenioffMode, benioffExaggeration],
                    getFillColor: [isBenioffMode]
                }
            }));
        } else {
            // Modo 2D estándar: HexagonLayer extrusor vertical
            layers.push(new deck.HexagonLayer({
                id: 'sismos-hex', data: filteredData,
                getPosition: d => [d.geometry.coordinates[0], d.geometry.coordinates[1]],
                radius: 8000, elevationScale: 100, extruded: true, pickable: true,
                colorRange: [ [68,1,84], [72,40,120], [62,74,137], [49,104,142], [38,130,142], [31,158,137], [53,183,121], [109,206,89], [181,222,43], [253,231,37] ],
                autoHighlight: true,
                onHover: handleStandardHexHover
            }));
        }
    }

    if (showLiveSGC && sgcData.features.length > 0) {
        // Capa Exclusiva para SGC Live en Píxeles (superpuesta de forma simultánea con la Visualización Espacial)
        // Se diferencia cromáticamente entre sismos de hoy (<24h) y sismos recientes de días previos
        layers.push(new deck.ScatterplotLayer({
            id: 'sgc-live-layer-halo',
            data: sgcData.features,
            getPosition: d => [
                d.geometry.coordinates[0],
                d.geometry.coordinates[1],
                isBenioffMode ? (-(d.properties.profundidad || 10) * 1000 * benioffExaggeration + 800) : 15000
            ],
            radiusUnits: 'pixels',
            getRadius: d => Math.max((d.properties.mag || d.properties.magnitud || 3.0) * 6, 22),
            getFillColor: d => d.properties.esHoy ? [16, 185, 129, 90] : [13, 148, 136, 40], // Halo esmeralda vibrante si es hoy; cian translúcido si es anterior
            stroked: true,
            getLineColor: d => d.properties.esHoy ? [52, 211, 153, 230] : [20, 184, 166, 140],
            lineWidthMinPixels: 2,
            pickable: false,
            updateTriggers: {
                getPosition: [isBenioffMode, benioffExaggeration]
            }
        }));

        layers.push(new deck.ScatterplotLayer({
            id: 'sgc-live-layer-core',
            data: sgcData.features,
            getPosition: d => [
                d.geometry.coordinates[0],
                d.geometry.coordinates[1],
                isBenioffMode ? (-(d.properties.profundidad || 10) * 1000 * benioffExaggeration + 1200) : 16000
            ],
            radiusUnits: 'pixels',
            getRadius: d => Math.max((d.properties.mag || d.properties.magnitud || 3.0) * 3, 10),
            getFillColor: d => d.properties.esHoy ? [16, 185, 129, 240] : [15, 118, 110, 190], // Núcleo esmeralda puro vs teal
            stroked: true,
            getLineColor: d => d.properties.esHoy ? [255, 255, 255, 255] : [204, 251, 241, 180],
            lineWidthMinPixels: 2,
            pickable: true,
            onHover: handleHover,
            updateTriggers: {
                getPosition: [isBenioffMode, benioffExaggeration]
            }
        }));
    }

    if (showFaults && faultData && faultData.features) {
        const visibleFaults = faultData.features.filter(f => {
            if (faultKinematicFilter === 'all') return true;
            return f.properties && f.properties.tipo === faultKinematicFilter;
        });

        // 1. Franja de Retiro y Amortiguamiento (Buffer de 5 km a cada lado = 10 km de corredor total)
        if (showFaultBuffer) {
            layers.push(new deck.GeoJsonLayer({
                id: 'fallas-buffer-layer',
                data: { type: 'FeatureCollection', features: visibleFaults },
                stroked: true,
                filled: false,
                getLineWidth: 10000,
                lineWidthUnits: 'meters',
                lineWidthMinPixels: 8,
                lineWidthMaxPixels: 80,
                getLineColor: d => {
                    const isSelected = selectedFaultId && d.properties && d.properties.id === selectedFaultId;
                    if (isSelected) return [0, 245, 255, 175]; // Resplandor cian eléctrico para falla enfocada
                    return [245, 158, 11, 95]; // Ámbar neón brillante con 37% opacidad
                },
                pickable: false,
                updateTriggers: {
                    getLineWidth: [showFaultBuffer, faultKinematicFilter],
                    getLineColor: [showFaultBuffer, selectedFaultId, faultKinematicFilter]
                }
            }));
        }

        // 2. Halo Neón de Resplandor Difuso
        layers.push(new deck.GeoJsonLayer({
            id: 'fallas-glow-layer',
            data: { type: 'FeatureCollection', features: visibleFaults },
            stroked: true,
            filled: false,
            getLineWidth: 1600,
            lineWidthMinPixels: 6,
            getLineColor: d => {
                const isSelected = selectedFaultId && d.properties && d.properties.id === selectedFaultId;
                if (isSelected) return [0, 255, 204, 250]; // Halo Turquesa Neón Ultra-Luminoso
                const t = d.properties && d.properties.tipo;
                if (t === 'subduccion') return [14, 165, 233, 130]; // Cian neón
                if (t === 'rumbo') return [245, 158, 11, 140];     // Ámbar neón
                return [239, 68, 68, 140];                         // Rojo carmesí
            },
            pickable: false,
            updateTriggers: {
                getLineColor: [selectedFaultId, faultKinematicFilter]
            }
        }));

        // 3. Trazo Núcleo Principal (Interactivo con hover y click)
        layers.push(new deck.GeoJsonLayer({
            id: 'fallas-core-layer',
            data: { type: 'FeatureCollection', features: visibleFaults },
            stroked: true,
            filled: false,
            getLineWidth: 950,
            lineWidthMinPixels: d => {
                const isSelected = selectedFaultId && d.properties && d.properties.id === selectedFaultId;
                return isSelected ? 6 : 3;
            },
            getLineColor: d => {
                const isSelected = selectedFaultId && d.properties && d.properties.id === selectedFaultId;
                if (isSelected) return [0, 255, 255, 255]; // Núcleo Cian Eléctrico Hi-Vis
                const t = d.properties && d.properties.tipo;
                if (t === 'subduccion') return [56, 189, 248, 250]; // Cian brillante
                if (t === 'rumbo') return [251, 191, 36, 250];      // Ámbar brillante
                return [248, 113, 113, 250];                        // Carmesí brillante
            },
            pickable: true,
            autoHighlight: true,
            highlightColor: [0, 255, 255, 220],
            onHover: handleFaultHover,
            onClick: handleFaultClick,
            updateTriggers: {
                getLineColor: [selectedFaultId, faultKinematicFilter],
                lineWidthMinPixels: [selectedFaultId]
            }
        }));
    }

    if (showML && mlData.features.length > 0) {
        layers.push(new deck.ScatterplotLayer({
            id: 'ml-clusters',
            data: mlData.features,
            getPosition: d => [d.geometry.coordinates[0], d.geometry.coordinates[1], 4000],
            getRadius: 8000,
            getFillColor: d => getClusterColor(d.properties.cluster_id, 160),
            stroked: true,
            getLineColor: d => getClusterColor(d.properties.cluster_id, 255),
            lineWidthMinPixels: 2.5,
            pickable: true,
            onHover: handleHover
        }));
    }

    // CAPA 1: INFRAESTRUCTURA CRÍTICA (VÍAS PRIMARIAS, FLUVIAL, CABOTAJE MARÍTIMO, HOSPITALES, AEROPUERTOS, MUELLES)
    if (showInfra && infraData && infraData.features) {
        const lineasInfra = infraData.features.filter(f => f.geometry.type === 'LineString');
        const puntosInfra = infraData.features.filter(f => f.geometry.type === 'Point');

        if (lineasInfra.length > 0) {
            layers.push(new deck.PathLayer({
                id: 'infra-lineas',
                data: lineasInfra,
                getPath: d => d.geometry.coordinates,
                getWidth: d => d.properties.tipo === 'vial' ? 4 : (d.properties.tipo === 'maritimo' ? 3 : 5),
                widthUnits: 'pixels',
                getColor: d => {
                    const st = INFRA_COLORS[d.properties.tipo] || INFRA_COLORS.fluvial;
                    return st.rgba;
                },
                pickable: true,
                autoHighlight: true,
                highlightColor: [255, 255, 255, 240],
                onHover: handleHover
            }));
        }

        if (puntosInfra.length > 0) {
            const ordenPrioridad = { hospital: 0, aeropuerto: 1, puerto: 2 };
            const puntosOrdenados = [...puntosInfra].sort(
                (a, b) => (ordenPrioridad[a.properties?.tipo] ?? 1) - (ordenPrioridad[b.properties?.tipo] ?? 1)
            );
            layers.push(new deck.ScatterplotLayer({
                id: 'infra-puntos',
                data: puntosOrdenados,
                getPosition: d => [d.geometry.coordinates[0], d.geometry.coordinates[1], 20],
                radiusUnits: 'pixels',
                getRadius: 5,
                getFillColor: d => {
                    const st = INFRA_COLORS[d.properties.tipo] || INFRA_COLORS.aeropuerto;
                    return st.rgba;
                },
                stroked: true,
                getLineColor: [255, 255, 255, 230],
                lineWidthMinPixels: 1.5,
                pickable: false
            }));

            layers.push(new deck.IconLayer({
                id: 'infra-iconos',
                data: puntosOrdenados,
                billboard: true,
                sizeUnits: 'pixels',
                getPosition: d => [d.geometry.coordinates[0], d.geometry.coordinates[1], 32],
                getIcon: d => ({
                    url: INFRA_ICON_URLS[d.properties.tipo] || INFRA_ICON_URLS.aeropuerto,
                    width: 64,
                    height: 64,
                    anchorX: 32,
                    anchorY: 32
                }),
                getSize: d => d.properties.tipo === 'puerto' ? 28 : (d.properties.tipo === 'aeropuerto' ? 26 : 26),
                getPixelOffset: d => getInfraPixelOffset(d, puntosOrdenados),
                pickable: true,
                autoHighlight: true,
                highlightColor: [255, 255, 255, 220],
                onHover: handleHover
            }));
        }
    }

    // CAPA 2: SIMULADOR INTERACTIVO SHAKEMAP (FALLA FINITA LOBULAR + PROPAGACIÓN CINEMÁTICA P/S)
    if (isSimulatorActive && currentShakemapData) {
        const epi = currentShakemapData.epicentro;
        const strikeRad = ((currentShakemapData.strikeDeg || 0) * Math.PI) / 180;
        const faultCoords = currentShakemapData.faultCoords || [epi, epi];

        // 2.1 Traza del Plano de Ruptura de Falla Finita Cosísmica (Extrusión 3D de foco hipocentral)
        layers.push(new deck.PathLayer({
            id: 'shakemap-fault-rupture-trace',
            data: [{
                path: faultCoords,
                prof: currentShakemapData.profundidad,
                nombre: currentShakemapData.falla
            }],
            getPath: d => d.path,
            getColor: [255, 69, 58, 255],
            getWidth: 7,
            widthUnits: 'pixels',
            capRounded: true,
            jointRounded: true,
            pickable: true,
            onHover: (info) => {
                if (info.object) {
                    if (tooltip.dataset) tooltip.dataset.sgcHover = '';
                    applyTooltipContext('shakemap');
                    tooltip.style.display = 'block';
                    tooltip.innerHTML = formatShakemapFaultTraceTooltip(info.object, currentShakemapData);
                    positionTooltip(tooltip, info.x, info.y);
                } else if (showSgcWms) {
                    handleSgcRasterHover(info);
                } else {
                    tooltip.style.display = 'none';
                }
            }
        }));

        // 2.2 Proyección Superficial del Plano de Deslizamiento (Zona de Deformación Cosísmica Inmediata)
        const cosLatEpi = Math.cos(epi[1] * Math.PI / 180);
        const halfLenDegX = ((currentShakemapData.faultLengthKm || 45) / 2 / 111.32) / cosLatEpi;
        const halfWidthDeg = (Math.min(20, (currentShakemapData.faultLengthKm || 45) * 0.4) / 110.57);
        const cosS = Math.cos(strikeRad);
        const sinS = Math.sin(strikeRad);

        const rupturePolygon = [
            [epi[0] - halfLenDegX * sinS - halfWidthDeg * cosS, epi[1] - halfLenDegX * cosS + halfWidthDeg * sinS],
            [epi[0] + halfLenDegX * sinS - halfWidthDeg * cosS, epi[1] + halfLenDegX * cosS + halfWidthDeg * sinS],
            [epi[0] + halfLenDegX * sinS + halfWidthDeg * cosS, epi[1] + halfLenDegX * cosS - halfWidthDeg * sinS],
            [epi[0] - halfLenDegX * sinS + halfWidthDeg * cosS, epi[1] - halfLenDegX * cosS - halfWidthDeg * sinS],
            [epi[0] - halfLenDegX * sinS - halfWidthDeg * cosS, epi[1] - halfLenDegX * cosS + halfWidthDeg * sinS]
        ];

        layers.push(new deck.PolygonLayer({
            id: 'shakemap-fault-surface-plane',
            data: [{ polygon: rupturePolygon }],
            getPolygon: d => d.polygon,
            getFillColor: [255, 59, 48, 55],
            getLineColor: [255, 69, 58, 230],
            getLineWidth: 2,
            lineWidthUnits: 'pixels',
            stroked: true,
            filled: true,
            pickable: false
        }));

        // 2.3 Isoseistas Lobulares Orientadas de Atenuación GMPE (Geometría Elíptica Falla Finita)
        // Se construyen polígonos elípticos de 48 vértices alineados con el strike de la falla
        const sortedIsoseistas = [...currentShakemapData.isoseistas].sort((a, b) => b.radioM - a.radioM);
        const lobularPolygons = sortedIsoseistas.map(iso => {
            const radM = iso.radioM;
            // Elongación longitudinal por directividad de falla finita: a/b = 1.35 a 1.55
            const aMeters = radM * 1.30; // Semieje mayor paralelo al rumbo
            const bMeters = radM * 0.90; // Semieje menor perpendicular al rumbo
            const coords = [];
            const steps = 48;
            for (let i = 0; i <= steps; i++) {
                const theta = (i / steps) * 2 * Math.PI;
                // Coordenadas en plano local centrado en epicentro
                const lx = aMeters * Math.sin(theta);
                const ly = bMeters * Math.cos(theta);
                // Rotación por rumbo de falla (strike)
                const rx = lx * cosS + ly * sinS;
                const ry = -lx * sinS + ly * cosS;
                // Conversión a grados geográficos
                const lng = epi[0] + (rx / 1000) / (111.32 * cosLatEpi);
                const lat = epi[1] + (ry / 1000) / 110.57;
                coords.push([lng, lat]);
            }
            return {
                polygon: coords,
                mmi: iso.mmi,
                label: iso.label,
                pgaRange: iso.pgaRange,
                color: iso.color,
                borde: iso.borde,
                radioKm: Math.round(radM / 1000)
            };
        });

        layers.push(new deck.PolygonLayer({
            id: 'shakemap-isoseistas-lobulares',
            data: lobularPolygons,
            getPolygon: d => d.polygon,
            getFillColor: d => d.color,
            getLineColor: d => d.borde,
            getLineWidth: 2.2,
            lineWidthUnits: 'pixels',
            stroked: true,
            filled: true,
            pickable: true,
            updateTriggers: {
                getPolygon: [activeShakemapScenario],
                getFillColor: [activeShakemapScenario],
                getLineColor: [activeShakemapScenario]
            },
            onHover: (info) => {
                if (info.object) {
                    if (tooltip.dataset) tooltip.dataset.sgcHover = '';
                    applyTooltipContext('shakemap');
                    tooltip.style.display = 'block';
                    tooltip.innerHTML = formatShakemapIsoseistaTooltip(info.object);
                    positionTooltip(tooltip, info.x, info.y);
                } else if (showSgcWms) {
                    handleSgcRasterHover(info);
                } else {
                    tooltip.style.display = 'none';
                }
            }
        }));

        // 2.4 FRENTES DE ONDA CINEMÁTICOS DINÁMICOS (Onda P Compresional y Onda S Cizallante)
        if (waveAnimTimeSec > 0.05) {
            const distPKm = Math.min(850, waveAnimTimeSec * WAVE_VEL_P_KMS);
            const distSKm = Math.min(850, waveAnimTimeSec * WAVE_VEL_S_KMS);

            // Generador de anillos de onda elípticos deformados por directividad
            const buildWaveRing = (distKm, aspectMinor = 0.85) => {
                const ring = [];
                const steps = 40;
                const aM = distKm * 1000 * 1.15;
                const bM = distKm * 1000 * aspectMinor;
                for (let i = 0; i <= steps; i++) {
                    const t = (i / steps) * 2 * Math.PI;
                    const lx = aM * Math.sin(t);
                    const ly = bM * Math.cos(t);
                    const rx = lx * cosS + ly * sinS;
                    const ry = -lx * sinS + ly * cosS;
                    const lng = epi[0] + (rx / 1000) / (111.32 * cosLatEpi);
                    const lat = epi[1] + (ry / 1000) / 110.57;
                    ring.push([lng, lat]);
                }
                return ring;
            };

            const pathWaveP = buildWaveRing(distPKm, 0.90);
            const pathWaveS = buildWaveRing(distSKm, 0.82);

            // Frente de Onda P (Azul celeste eléctrico, rápido)
            layers.push(new deck.PathLayer({
                id: 'shakemap-wavefront-p',
                data: [{
                    path: pathWaveP,
                    distKm: distPKm.toFixed(1),
                    tSec: waveAnimTimeSec.toFixed(1)
                }],
                getPath: d => d.path,
                getColor: [56, 189, 248, 235],
                getWidth: 4.5,
                widthUnits: 'pixels',
                capRounded: true,
                jointRounded: true,
                pickable: true,
                onHover: (info) => {
                    if (info.object) {
                        if (tooltip.dataset) tooltip.dataset.sgcHover = '';
                        applyTooltipContext('benioff');
                        tooltip.style.display = 'block';
                        tooltip.innerHTML = formatShakemapWavePTooltip(info.object, WAVE_VEL_P_KMS);
                        positionTooltip(tooltip, info.x, info.y);
                    } else if (showSgcWms) {
                        handleSgcRasterHover(info);
                    } else {
                        tooltip.style.display = 'none';
                    }
                }
            }));

            // Frente de Onda S (Rojo fuego / Naranja de máxima energía destructora)
            layers.push(new deck.PathLayer({
                id: 'shakemap-wavefront-s',
                data: [{
                    path: pathWaveS,
                    distKm: distSKm.toFixed(1),
                    tSec: waveAnimTimeSec.toFixed(1)
                }],
                getPath: d => d.path,
                getColor: [255, 69, 58, 255],
                getWidth: 6.5,
                widthUnits: 'pixels',
                capRounded: true,
                jointRounded: true,
                pickable: true,
                onHover: (info) => {
                    if (info.object) {
                        if (tooltip.dataset) tooltip.dataset.sgcHover = '';
                        applyTooltipContext('shakemap');
                        tooltip.style.display = 'block';
                        tooltip.innerHTML = formatShakemapWaveSTooltip(info.object, WAVE_VEL_S_KMS);
                        positionTooltip(tooltip, info.x, info.y);
                    } else if (showSgcWms) {
                        handleSgcRasterHover(info);
                    } else {
                        tooltip.style.display = 'none';
                    }
                }
            }));
        }

        // 2.5 Marcador nuclear del Epicentro Cosísmico con halo pulsante
        layers.push(new deck.ScatterplotLayer({
            id: 'shakemap-epicentro-halo',
            data: [currentShakemapData],
            getPosition: d => [d.epicentro[0], d.epicentro[1], 45],
            radiusUnits: 'pixels',
            getRadius: 38,
            getFillColor: [255, 69, 58, 70],
            stroked: true,
            getLineColor: [255, 69, 58, 220],
            lineWidthMinPixels: 2.5,
            pickable: false,
            updateTriggers: {
                getPosition: [activeShakemapScenario]
            }
        }));

        layers.push(new deck.ScatterplotLayer({
            id: 'shakemap-epicentro',
            data: [currentShakemapData],
            getPosition: d => [d.epicentro[0], d.epicentro[1], 50],
            radiusUnits: 'pixels',
            getRadius: 16,
            getFillColor: [255, 255, 255, 255],
            stroked: true,
            getLineColor: [255, 59, 48, 255],
            lineWidthMinPixels: 4,
            pickable: true,
            updateTriggers: {
                getPosition: [activeShakemapScenario]
            },
            onHover: (info) => {
                if (info.object) {
                    if (tooltip.dataset) tooltip.dataset.sgcHover = '';
                    applyTooltipContext('shakemap');
                    tooltip.style.display = 'block';
                    tooltip.innerHTML = formatShakemapEpicentroTooltip(info.object);
                    positionTooltip(tooltip, info.x, info.y);
                } else if (showSgcWms) {
                    handleSgcRasterHover(info);
                } else {
                    tooltip.style.display = 'none';
                }
            }
        }));
    }

    // Pin de Ubicación y Halo de Amplificación Dinámica NSR-10 para Municipio Seleccionado (solo en Diseño Estructural)
    if (currentProfile === 'nsr10' && selectedNsrMunicipio && selectedNsrMunicipio.lat) {
        const sueloSel = document.getElementById('nsr-suelo-select');
        const usoSel = document.getElementById('nsr-grupo-uso-select');
        const curSuelo = sueloSel ? sueloSel.value : (selectedNsrMunicipio.suelo_defecto || 'E');
        const curI = usoSel ? parseFloat(usoSel.value) : 1.0;
        const curFactors = getFactoresSitioNSR10(selectedNsrMunicipio.aa, selectedNsrMunicipio.av, curSuelo);
        const curSaMax = 2.5 * selectedNsrMunicipio.aa * curFactors.Fa * curI;
        const curPga = (curFactors.Fa * selectedNsrMunicipio.aa).toFixed(2);

        const SOIL_COLORS_RGB = {
            'A': [0, 158, 115],    // Roca Competente (Okabe-Ito #009E73)
            'B': [86, 180, 233],   // Roca Media (Okabe-Ito #56B4E9)
            'C': [0, 114, 178],    // Suelos Densos / Roca Blanda (Okabe-Ito #0072B2)
            'D': [240, 228, 66],   // Suelos Rígidos (Okabe-Ito #F0E442)
            'E': [230, 159, 0],    // Suelos Blandos / Aluviales (Okabe-Ito #E69F00)
            'F': [204, 121, 167]   // Suelos Especiales / Licuables (Okabe-Ito #CC79A7)
        };
        const baseSoilRgb = SOIL_COLORS_RGB[curSuelo] || [230, 159, 0];
        const haloColor = [...baseSoilRgb, 85];
        const pinColor = [...baseSoilRgb, 240];
        const haloRadiusMeters = 2500 + curSaMax * 2500;

        // 1. Halo volumétrico de amplificación de suelo y demanda estructural
        layers.push(new deck.ScatterplotLayer({
            id: 'selected-municipio-halo',
            data: [{ pos: [selectedNsrMunicipio.lng, selectedNsrMunicipio.lat] }],
            getPosition: d => [d.pos[0], d.pos[1], 10],
            radiusUnits: 'meters',
            getRadius: haloRadiusMeters,
            getFillColor: haloColor,
            stroked: true,
            getLineColor: [255, 255, 255, 180],
            lineWidthMinPixels: 1.5,
            pickable: false,
            updateTriggers: {
                getPosition: [selectedNsrMunicipio.lng, selectedNsrMunicipio.lat],
                getRadius: [curSaMax, curSuelo],
                getFillColor: [curSuelo, curSaMax]
            }
        }));

        // 2. Pin central de localización interactiva
        layers.push(new deck.ScatterplotLayer({
            id: 'selected-municipio-pin',
            data: [{ pos: [selectedNsrMunicipio.lng, selectedNsrMunicipio.lat], m: selectedNsrMunicipio, curSuelo, curI, curFactors, curSaMax, curPga }],
            getPosition: d => [d.pos[0], d.pos[1], 100],
            radiusUnits: 'pixels',
            getRadius: 16,
            getFillColor: pinColor,
            stroked: true,
            getLineColor: [255, 255, 255, 255],
            lineWidthMinPixels: 2.5,
            pickable: true,
            onHover: (info) => {
                if (info.object) {
                    const obj = info.object;
                    const m = obj.m;
                    applyTooltipContext('nsr');
                    tooltip.style.display = 'block';
                    tooltip.style.left = `${info.x}px`;
                    tooltip.style.top = `${info.y}px`;
                    tooltip.innerHTML = `<h4>🏛️ ${escapeHtml(m.nombre)} (${escapeHtml(m.departamento)})</h4>
                                         <p><strong>Perfil de Suelo:</strong> Tipo ${escapeHtml(obj.curSuelo)} (Fa=${obj.curFactors.Fa}, Fv=${obj.curFactors.Fv})</p>
                                         <p><strong>Grupo de Uso:</strong> I = ${obj.curI.toFixed(2)}</p>
                                         <p><strong>PGA Terreno:</strong> <strong style="color:#38bdf8;">${obj.curPga} g</strong> (Aa=${m.aa.toFixed(2)}g)</p>
                                         <p><strong>Sa Máx Meseta (Diseño):</strong> <strong style="color:#ff453a;">${obj.curSaMax.toFixed(2)} g</strong></p>
                                         <p style="font-size:var(--fs-xs); margin-top:4px; color:#A1A1A6;">${escapeHtml(m.geologia)}</p>`;
                } else {
                    tooltip.style.display = 'none';
                }
            },
            updateTriggers: {
                getPosition: [selectedNsrMunicipio.lng, selectedNsrMunicipio.lat],
                getFillColor: [curSuelo, curSaMax],
                getRadius: [curSaMax, curSuelo]
            }
        }));
    }

    // Pin y Radio de Influencia Territorial (30 km) para Perfil POT
    if (currentProfile === 'alcaldia' && selectedPotMunicipio && selectedPotMunicipio.lat) {
        // Halo de área de influencia directa territorial (30 km — Ámbar/Ocre Gestión Territorial)
        layers.push(new deck.ScatterplotLayer({
            id: 'pot-municipio-influence-radius',
            data: [{ pos: [selectedPotMunicipio.lng, selectedPotMunicipio.lat] }],
            getPosition: d => [d.pos[0], d.pos[1], 5],
            radiusUnits: 'meters',
            getRadius: 30000,
            getFillColor: [180, 83, 9, 42],
            stroked: true,
            getLineColor: [217, 119, 6, 215],
            lineWidthMinPixels: 1.5,
            pickable: false,
            updateTriggers: {
                getPosition: [selectedPotMunicipio.lng, selectedPotMunicipio.lat]
            }
        }));

        // Pin de cabecera municipal POT (Ámbar/Ocre #B45309)
        layers.push(new deck.ScatterplotLayer({
            id: 'pot-municipio-pin',
            data: [{ pos: [selectedPotMunicipio.lng, selectedPotMunicipio.lat], m: selectedPotMunicipio }],
            getPosition: d => [d.pos[0], d.pos[1], 100],
            radiusUnits: 'pixels',
            getRadius: 15,
            getFillColor: [180, 83, 9, 235],
            stroked: true,
            getLineColor: [255, 255, 255, 255],
            lineWidthMinPixels: 2.5,
            pickable: true,
            onHover: (info) => {
                if (info.object) {
                    const m = info.object.m;
                    applyTooltipContext('pot');
                    tooltip.style.display = 'block';
                    tooltip.style.left = `${info.x}px`;
                    tooltip.style.top = `${info.y}px`;
                    tooltip.innerHTML = `<h4>🏛️ ${escapeHtml(m.nombre)} (${escapeHtml(m.departamento)}) — POT</h4>
                                         <p><strong>Población Expuesta:</strong> ${(m.poblacion || 0).toLocaleString()} hab.</p>
                                         <p><strong>Aceleración Aa:</strong> <strong style="color:#ffd60a;">${escapeHtml(m.aa)} g</strong></p>
                                         <p><strong>Radio de Análisis:</strong> 30 km circundantes</p>
                                         <p style="font-size:var(--fs-xs); margin-top:4px; color:#A1A1A6;">${escapeHtml(m.geologia || '')}</p>`;
                } else {
                    tooltip.style.display = 'none';
                }
            },
            updateTriggers: {
                getPosition: [selectedPotMunicipio.lng, selectedPotMunicipio.lat]
            }
        }));
    }

    // Lógica para la Leyenda Cartográfica Dinámica
    const legend = document.getElementById('map-legend');
    if (legend) {
        if (isSimulatorActive && currentShakemapData) {
            legend.style.display = 'block';
            legend.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; border-bottom:1px solid rgba(255,255,255,0.12); padding-bottom:5px;">
                    <h4 style="margin:0; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; color:#fff; font-size:var(--fs-sm);">ShakeMap: Demanda MMI</h4>
                    <span style="font-size:var(--fs-2xs); color:#ffd60a; font-weight:600;">${currentShakemapData.mw} Mw</span>
                </div>
                <div style="display:flex; flex-direction:column; gap:5px; color:#A1A1A6; font-size:var(--fs-xs); font-weight:500;">
                    <div style="display:flex; align-items:center; gap:8px;"><span style="display:block; width:12px; height:12px; border-radius:50%; background:rgb(255,59,48); border:1px solid #fff;"></span> <strong>MMI VIII - IX</strong> (≥ 0.50g - Severo)</div>
                    <div style="display:flex; align-items:center; gap:8px;"><span style="display:block; width:12px; height:12px; border-radius:50%; background:rgb(255,140,0); border:1px solid #ffb703;"></span> <strong>MMI VII</strong> (0.25 - 0.50g - Daño Mod.)</div>
                    <div style="display:flex; align-items:center; gap:8px;"><span style="display:block; width:12px; height:12px; border-radius:50%; background:rgb(255,214,10); border:1px solid #ffe600;"></span> <strong>MMI V - VI</strong> (0.10 - 0.25g - Fuerte)</div>
                    <div style="display:flex; align-items:center; gap:8px;"><span style="display:block; width:12px; height:12px; border-radius:50%; background:rgb(56,189,248); border:1px solid #38bdf8;"></span> <strong>MMI IV</strong> (&lt; 0.10g - Perceptible)</div>
                </div>
            `;
        } else if (viewMode === 'puntos') {
            legend.style.display = 'block';
            legend.innerHTML = `
                <h4 style="margin: 0 0 10px 0; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-primary);">Profundidad (Okabe-Ito)</h4>
                <div style="display: flex; flex-direction: column; gap: 6px; color: var(--text-secondary); font-size: var(--fs-xs); font-weight: 500;">
                    <div style="display:flex; align-items:center; gap: 8px;"><span style="display:inline-flex; align-items:center; justify-content:center; width:12px; height:12px; border-radius:50%; background:rgb(230,159,0); border:1px solid rgba(255,255,255,0.4);"></span> &lt; 30 km (Superficial)</div>
                    <div style="display:flex; align-items:center; gap: 8px;"><span style="display:inline-flex; align-items:center; justify-content:center; width:12px; height:12px; border-radius:2px; background:rgb(204,121,167); border:1px solid rgba(255,255,255,0.4);"></span> 30 – 70 km (Intermedio)</div>
                    <div style="display:flex; align-items:center; gap: 8px;"><span style="display:inline-flex; align-items:center; justify-content:center; width:12px; height:12px; border-radius:50%; background:rgb(0,114,178); border:1px solid rgba(255,255,255,0.4);"></span> &gt; 70 km (Profundo)</div>
                </div>
            `;
        } else if (viewMode === 'calor') {
            legend.style.display = 'block';
            if (isBenioffMode) {
                legend.innerHTML = `
                    <h4 style="margin: 0 0 10px 0; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-primary);">Energía Radiada 3D</h4>
                    <div style="display: flex; align-items: center; justify-content: space-between; height: 12px; border-radius: 6px; margin-bottom: 5px; background: linear-gradient(to right, rgb(101,21,110), rgb(159,42,99), rgb(212,72,66), rgb(250,193,39), rgb(255,255,220));"></div>
                    <div style="display: flex; justify-content: space-between; color: var(--text-secondary); font-size: var(--fs-xs); font-weight: 500;">
                        <span>10¹⁰ J (M3)</span>
                        <span>10¹⁵ J (M7+)</span>
                    </div>
                `;
            } else {
                legend.innerHTML = `
                    <h4 style="margin: 0 0 10px 0; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-primary);">Densidad Térmica</h4>
                    <div style="display: flex; align-items: center; justify-content: space-between; height: 12px; border-radius: 6px; margin-bottom: 5px; background: linear-gradient(to right, rgb(0,0,4), rgb(101,21,110), rgb(159,42,99), rgb(212,72,66), rgb(250,193,39), rgb(252,253,191));"></div>
                    <div style="display: flex; justify-content: space-between; color: var(--text-secondary); font-size: var(--fs-xs); font-weight: 500;">
                        <span>Baja</span>
                        <span>Alta</span>
                    </div>
                `;
            }
        } else if (viewMode === 'hex') {
            legend.style.display = 'block';
            if (isBenioffMode) {
                legend.innerHTML = `
                    <h4 style="margin: 0 0 10px 0; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-primary);">Cúmulos 3D (Subducción)</h4>
                    <div style="display: flex; align-items: center; justify-content: space-between; height: 12px; border-radius: 6px; margin-bottom: 5px; background: linear-gradient(to right, rgb(68,1,84), rgb(59,82,139), rgb(33,145,140), rgb(94,201,98), rgb(253,231,37));"></div>
                    <div style="display: flex; justify-content: space-between; color: var(--text-secondary); font-size: var(--fs-xs); font-weight: 500;">
                        <span>1 Sismo</span>
                        <span>20+ Sismos</span>
                    </div>
                `;
            } else {
                legend.innerHTML = `
                    <h4 style="margin: 0 0 10px 0; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-primary);">Agrupación (8 km)</h4>
                    <div style="display: flex; align-items: center; justify-content: space-between; height: 12px; border-radius: 6px; margin-bottom: 5px; background: linear-gradient(to right, rgb(68,1,84), rgb(49,104,142), rgb(53,183,121), rgb(181,222,43), rgb(253,231,37));"></div>
                    <div style="display: flex; justify-content: space-between; color: var(--text-secondary); font-size: var(--fs-xs); font-weight: 500;">
                        <span>1 Sismo</span>
                        <span>50+ Sismos</span>
                    </div>
                `;
            }
        } else if (showSgcWms) {
            legend.style.display = 'block';
            legend.innerHTML = `
                <h4 style="margin: 0 0 8px 0; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-primary);">SGC Oficial · PGA Tr=475a</h4>
                <div style="height: 12px; border-radius: 6px; margin-bottom: 5px; background: linear-gradient(to right, #1a9641 0%, #6abd58 14%, #b3df76 28%, #ffffc0 45%, #ffe8a5 58%, #fed18a 70%, #feba6f 80%, #f89957 88%, #ed6e43 94%, #d7191c 100%); border: 1px solid rgba(148,163,184,0.35);"></div>
                <div style="display: flex; justify-content: space-between; color: var(--text-secondary); font-size: var(--fs-2xs); font-weight: 600; margin-bottom: 8px;">
                    <span>0.0 g (Muy baja)</span>
                    <span>0.10 g (Interm.)</span>
                    <span>0.20–0.40 g (Alta)</span>
                    <span>≥ 0.50 g (Muy alta)</span>
                </div>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:4px; font-size:var(--fs-2xs); color:var(--text-secondary); margin-bottom:8px;">
                    <div><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:#1a9641;vertical-align:middle;margin-right:4px;"></span><strong>Baja:</strong> ≤ 0.10 g</div>
                    <div><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:#ffffc0;border:1px solid #94a3b8;vertical-align:middle;margin-right:4px;"></span><strong>Interm.:</strong> 0.10–0.20 g</div>
                    <div><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:#fed18a;vertical-align:middle;margin-right:4px;"></span><strong>Alta:</strong> 0.20–0.40 g</div>
                    <div><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:#d7191c;vertical-align:middle;margin-right:4px;"></span><strong>Muy Alta:</strong> &gt; 0.40 g</div>
                </div>
                <div id="legend-sgc-identify" style="font-size: var(--fs-xs); color: var(--text-secondary); line-height: 1.4; margin-bottom: 6px;">
                    Pase el cursor sobre cualquier color del mapa para ver su nivel de amenaza y haga clic para consultar el dato oficial SGC.
                </div>
                <a href="https://amenazasismica.sgc.gov.co/" target="_blank" rel="noopener noreferrer" style="color:var(--accent-ui); font-size: var(--fs-xs); font-weight:600;">Consultar visor oficial SGC ↗</a>
            `;
        } else if (showInfra) {
            legend.style.display = 'block';
            legend.innerHTML = `
                <h4 style="margin: 0 0 10px 0; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-primary);">Conectividad y Líneas Vitales</h4>
                <div style="display: flex; flex-direction: column; gap: 7px; color: var(--text-secondary); font-size: var(--fs-xs); font-weight: 500;">
                    <div style="display:flex; align-items:center; gap: 8px;">
                        <span style="display:inline-block; width:16px; height:4px; border-radius:2px; background:${INFRA_COLORS.vial.hex};"></span>
                        <span><strong style="color:${INFRA_COLORS.vial.textHex};">Red Vial Primaria</strong></span>
                    </div>
                    <div style="display:flex; align-items:center; gap: 8px;">
                        <span style="display:inline-block; width:16px; height:5px; border-radius:2px; background:${INFRA_COLORS.fluvial.hex};"></span>
                        <span><strong style="color:${INFRA_COLORS.fluvial.textHex};">Corredor Fluvial</strong></span>
                    </div>
                    <div style="display:flex; align-items:center; gap: 8px;">
                        <span style="display:inline-block; width:16px; height:3px; border-radius:2px; background:${INFRA_COLORS.maritimo.hex};"></span>
                        <span><strong style="color:${INFRA_COLORS.maritimo.textHex};">Ruta Marítima</strong></span>
                    </div>
                    <div style="display:flex; align-items:center; gap: 8px;">
                        <span style="display:inline-block; width:10px; height:10px; border-radius:50%; background:${INFRA_COLORS.aeropuerto.hex}; border:1.5px solid #fff;"></span>
                        <span><strong style="color:${INFRA_COLORS.aeropuerto.textHex};">Terminal Aéreo</strong></span>
                    </div>
                    <div style="display:flex; align-items:center; gap: 8px;">
                        <span style="display:inline-block; width:11px; height:11px; border-radius:50%; background:${INFRA_COLORS.hospital.hex}; border:1.5px solid #fff;"></span>
                        <span><strong style="color:${INFRA_COLORS.hospital.textHex};">Centro Asistencial</strong></span>
                    </div>
                    <div style="display:flex; align-items:center; gap: 8px;">
                        <span style="display:inline-block; width:10px; height:10px; border-radius:50%; background:${INFRA_COLORS.puerto.hex}; border:1.5px solid #fff;"></span>
                        <span><strong style="color:${INFRA_COLORS.puerto.textHex};">Muelle / Puerto</strong></span>
                    </div>
                </div>
            `;
        } else if (showLiveSGC) {
            legend.style.display = 'block';
            legend.innerHTML = `
                <h4 style="margin: 0 0 10px 0; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-primary);">Telemetría FDSN Live (14d)</h4>
                <div style="display: flex; flex-direction: column; gap: 6px; color: var(--text-secondary); font-size: var(--fs-xs); font-weight: 500;">
                    <div style="display:flex; align-items:center; gap: 8px;"><span style="display:inline-block; width:12px; height:12px; border-radius:50%; background:rgb(16,185,129); border:2px solid #ffffff;"></span> Sismos últimas 24h</div>
                    <div style="display:flex; align-items:center; gap: 8px;"><span style="display:inline-block; width:12px; height:12px; border-radius:50%; background:rgb(15,118,110); border:1.5px solid #ccfbf1;"></span> Ventana reciente (2–14 días)</div>
                </div>
            `;
        } else {
            legend.innerHTML = '';
            legend.style.display = 'none';
        }

        if (showLiveSGC && (viewMode !== 'none' || showSgcWms || showInfra || (isSimulatorActive && currentShakemapData))) {
            legend.innerHTML += `
                <div style="margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--border-subtle);">
                    <div style="font-size: var(--fs-2xs); font-weight: 700; text-transform: uppercase; color: var(--pill-ok-fg); margin-bottom: 5px;">Telemetría FDSN Live (14d)</div>
                    <div style="display: flex; flex-direction: column; gap: 4px; font-size: var(--fs-2xs); color: var(--text-secondary);">
                        <div style="display:flex; align-items:center; gap:6px;"><span style="width:9px; height:9px; border-radius:50%; background:rgb(16,185,129); border:1.5px solid #fff; display:inline-block;"></span> Últimas 24h</div>
                        <div style="display:flex; align-items:center; gap:6px;"><span style="width:9px; height:9px; border-radius:50%; background:rgb(15,118,110); border:1.5px solid #ccfbf1; display:inline-block;"></span> Recientes (2–14 días)</div>
                    </div>
                </div>
            `;
        }

        // Si hay una capa sismica activa y ademas estan visibles las lineas vitales, concatenar sub-leyenda compacta
        if (showInfra && (viewMode !== 'none' || showSgcWms || (isSimulatorActive && currentShakemapData))) {
            legend.innerHTML += `
                <div style="margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--border-subtle);">
                    <div style="font-size: var(--fs-2xs); font-weight: 700; text-transform: uppercase; color: var(--accent-ui); margin-bottom: 5px;">Líneas Vitales</div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 5px; font-size: var(--fs-2xs); color: var(--text-secondary);">
                        <div style="display:flex; align-items:center; gap:5px;"><span style="width:12px; height:3px; background:${INFRA_COLORS.vial.hex}; display:inline-block; border-radius:1px;"></span> Vías</div>
                        <div style="display:flex; align-items:center; gap:5px;"><span style="width:12px; height:4px; background:${INFRA_COLORS.fluvial.hex}; display:inline-block; border-radius:1px;"></span> Fluvial</div>
                        <div style="display:flex; align-items:center; gap:5px;"><span style="width:12px; height:3px; background:${INFRA_COLORS.maritimo.hex}; display:inline-block; border-radius:1px;"></span> Marítimo</div>
                        <div style="display:flex; align-items:center; gap:5px;"><span style="width:8px; height:8px; border-radius:50%; background:${INFRA_COLORS.aeropuerto.hex}; border:1px solid #fff; display:inline-block;"></span> Aéreo</div>
                        <div style="display:flex; align-items:center; gap:5px;"><span style="width:8px; height:8px; border-radius:50%; background:${INFRA_COLORS.hospital.hex}; border:1px solid #fff; display:inline-block;"></span> Salud</div>
                        <div style="display:flex; align-items:center; gap:5px;"><span style="width:8px; height:8px; border-radius:50%; background:${INFRA_COLORS.puerto.hex}; border:1px solid #fff; display:inline-block;"></span> Puertos</div>
                    </div>
                </div>
            `;
        }

        // Leyenda contextual para el marcador municipal de Diseño Estructural (NSR-10 Okabe-Ito) o Gestión Territorial (POT)
        if (currentProfile === 'nsr10' && selectedNsrMunicipio && selectedNsrMunicipio.lat) {
            const hasBaseLegend = legend.style.display === 'block' && legend.innerHTML.trim().length > 0;
            legend.style.display = 'block';
            legend.innerHTML += `
                <div style="${hasBaseLegend ? 'margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--border-subtle);' : ''}">
                    <div style="font-size: var(--fs-2xs); font-weight: 700; text-transform: uppercase; color: #34D399; margin-bottom: 5px;">Suelo NSR-10 (Okabe-Ito)</div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 4px 10px; font-size: var(--fs-2xs); color: var(--text-secondary);">
                        <div style="display:flex; align-items:center; gap:5px;"><span style="width:9px; height:9px; border-radius:50%; background:#009E73; border:1px solid #fff; display:inline-block;"></span> A · Roca</div>
                        <div style="display:flex; align-items:center; gap:5px;"><span style="width:9px; height:9px; border-radius:50%; background:#56B4E9; border:1px solid #fff; display:inline-block;"></span> B · Media</div>
                        <div style="display:flex; align-items:center; gap:5px;"><span style="width:9px; height:9px; border-radius:50%; background:#0072B2; border:1px solid #fff; display:inline-block;"></span> C · Denso</div>
                        <div style="display:flex; align-items:center; gap:5px;"><span style="width:9px; height:9px; border-radius:50%; background:#F0E442; border:1px solid #fff; display:inline-block;"></span> D · Rígido</div>
                        <div style="display:flex; align-items:center; gap:5px;"><span style="width:9px; height:9px; border-radius:50%; background:#E69F00; border:1px solid #fff; display:inline-block;"></span> E · Blando</div>
                        <div style="display:flex; align-items:center; gap:5px;"><span style="width:9px; height:9px; border-radius:50%; background:#CC79A7; border:1px solid #fff; display:inline-block;"></span> F · Especial</div>
                    </div>
                </div>
            `;
        } else if (currentProfile === 'alcaldia' && selectedPotMunicipio && selectedPotMunicipio.lat) {
            const hasBaseLegend = legend.style.display === 'block' && legend.innerHTML.trim().length > 0;
            legend.style.display = 'block';
            legend.innerHTML += `
                <div style="${hasBaseLegend ? 'margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--border-subtle);' : ''}">
                    <div style="font-size: var(--fs-2xs); font-weight: 700; text-transform: uppercase; color: #FBBF24; margin-bottom: 5px;">Gestión Territorial POT</div>
                    <div style="display:flex; align-items:center; gap:6px; font-size: var(--fs-2xs); color: var(--text-secondary);">
                        <span style="width:10px; height:10px; border-radius:50%; background:#B45309; border:1.5px solid #fff; display:inline-block;"></span> Cabecera y radio 30 km
                    </div>
                </div>
            `;
        }
    }

    deckgl.setProps({ layers: layers });
}

// ============================================================================
// BOTON HOME
// ============================================================================
function resetParametricFilters(shouldRender = true) {
    if (typeof stopTimelapse === 'function') {
        stopTimelapse();
    }
    const magSlider = document.getElementById('mag-slider');
    const magVal = document.getElementById('mag-val');
    if (magSlider) magSlider.value = 0;
    currentMag = 0;
    if (magVal) magVal.innerText = '0.0';

    const timeSliderEl = document.getElementById('time-slider');
    const timeValEl = document.getElementById('time-val');
    if (timeSliderEl) timeSliderEl.value = 1993;
    currentTime = 1993;
    if (timeValEl) timeValEl.innerText = '1993';

    const depthSlider = document.getElementById('depth-slider');
    if (depthSlider) {
        depthSlider.value = 250;
        currentMaxDepth = 250.0;
        const depthVal = document.getElementById('depth-val');
        if (depthVal) depthVal.innerText = '250 km (Todos)';
    }

    if (shouldRender) renderLayers();
}

function resetSpatialVisualization({ skipCameraReset = false, skipRender = false } = {}) {
    viewMode = 'none';
    const viewBtns = [
        document.getElementById('btn-puntos'),
        document.getElementById('btn-calor'),
        document.getElementById('btn-hex')
    ];
    viewBtns.forEach(b => { if (b) b.classList.remove('active'); });

    benioffSector = 'all';
    const benioffSectorSel = document.getElementById('benioff-sector-select');
    if (benioffSectorSel) benioffSectorSel.value = 'all';

    benioffExaggeration = 1.5;
    const benioffExagSel = document.getElementById('benioff-exag-slider');
    const benioffExagVal = document.getElementById('benioff-exag-val');
    if (benioffExagSel) benioffExagSel.value = '1.5';
    if (benioffExagVal) benioffExagVal.innerText = '1.50x';

    if (isBenioffMode) {
        toggleBenioffMode(false, { skipCameraReset, skipRender: true });
    } else {
        const btnBen = document.getElementById('btn-benioff');
        const btnBenTxt = document.getElementById('btn-benioff-text');
        const benCtrl = document.getElementById('benioff-controls');
        if (btnBen) {
            btnBen.classList.remove('active');
            btnBen.style.background = '';
            btnBen.style.color = '';
            btnBen.style.borderColor = '';
            btnBen.style.boxShadow = '';
        }
        if (btnBenTxt) btnBenTxt.innerHTML = 'Activar Perfil Benioff';
        if (benCtrl) benCtrl.style.display = 'none';
    }

    if (!skipRender) renderLayers();
}

function resetAdvancedLayers({ skipRender = false } = {}) {
    highQualityOnly = false;
    showFaults = false;
    showInfra = false;
    selectedFaultId = null;
    showFaultBuffer = false;
    faultKinematicFilter = 'all';
    showLiveSGC = false;
    showSgcWms = false;
    showML = false;
    viewportFilterEnabled = false;
    alertMagThreshold = 4.0;

    const checks = ['check-calidad', 'check-fallas', 'check-infra', 'check-live-sgc', 'check-sgc-wms', 'check-ml', 'check-fallas-buffer', 'check-viewport-filter'];
    checks.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.checked = false;
    });

    const selFalla = document.getElementById('select-falla-activa');
    if (selFalla) selFalla.selectedIndex = 0;

    const infraConvenciones = document.getElementById('infra-convenciones');
    if (infraConvenciones) infraConvenciones.style.display = 'none';

    const fallasPanel = document.getElementById('fallas-interactive-panel');
    if (fallasPanel) fallasPanel.style.display = 'none';

    lastSgcIdentifyData = null;
    const sgcQueryBox = document.getElementById('sgc-wms-query-box');
    if (sgcQueryBox) sgcQueryBox.style.display = 'none';
    const sgcIdentifyResult = document.getElementById('sgc-wms-identify-result');
    if (sgcIdentifyResult) {
        sgcIdentifyResult.innerHTML = 'Haga clic sobre cualquier punto del mapa o pulse <em>Consultar cabecera</em> para leer PGA, Sa(0.2s) y Sa(1.0s) desde el servidor oficial del SGC.';
    }
    hideSgcRasterTooltipIfActive();

    const sgcSettings = document.getElementById('sgc-alert-settings');
    if (sgcSettings) sgcSettings.style.display = 'none';
    const alertSlider = document.getElementById('slider-alert-threshold');
    const alertVal = document.getElementById('alert-mag-threshold-val');
    if (alertSlider) alertSlider.value = '4.0';
    if (alertVal) alertVal.innerText = '≥ 4.0 Mw';

    document.querySelectorAll('.falla-tipo-btn').forEach(b => {
        b.classList.remove('active');
        b.style.background = '';
        b.style.fontWeight = '';
    });
    const allTipoBtn = document.querySelector('.falla-tipo-btn[data-tipo="all"]');
    if (allTipoBtn) {
        allTipoBtn.classList.add('active');
    }

    if (liveSocket) {
        liveSocket.close();
        liveSocket = null;
    }
    if (livePollingInterval) {
        clearInterval(livePollingInterval);
        livePollingInterval = null;
    }
    if (bannerDismissTimeout) {
        clearTimeout(bannerDismissTimeout);
        bannerDismissTimeout = null;
    }
    sgcData.features = [];
    const sgcBadge = document.getElementById('sgc-live-status-badge');
    if (sgcBadge) sgcBadge.style.display = 'none';
    const sgcSubtext = document.getElementById('sgc-live-subtext');
    if (sgcSubtext) sgcSubtext.innerText = 'FDSN en vivo 14d · EMSC / USGS (M≥3.5)';
    const alertBanner = document.getElementById('live-seismic-alert-banner');
    if (alertBanner) {
        alertBanner.style.opacity = '0';
        alertBanner.style.display = 'none';
    }

    if (isSimulatorActive && typeof deactivateShakemap === 'function') {
        deactivateShakemap({ skipRender: true });
    }
    const shakemapSelect = document.getElementById('select-shakemap-escenario');
    if (shakemapSelect) shakemapSelect.value = 'palmar_74';

    updateCapasActiveBadge();
    if (!skipRender) renderLayers();
}

function resetBasemapAndThemeToDefault() {
    currentMapStyle = BASEMAP_STYLES['voy'];
    document.querySelectorAll('.basemap-btn[data-style]').forEach(b => {
        b.classList.toggle('active', b.getAttribute('data-style') === 'voy');
    });
    document.body.classList.remove('theme-light');
    const tBtn = document.getElementById('btn-theme-toggle');
    if (tBtn) {
        tBtn.classList.remove('active');
        tBtn.setAttribute('aria-pressed', 'false');
    }
    applyThemeToCharts(false);
}

function resetSpecialtyAndThemeControls() {
    resetBasemapAndThemeToDefault();

    document.body.classList.remove('panel-collapsed');
    const uiPanelEl = document.getElementById('ui-panel');
    if (uiPanelEl) uiPanelEl.inert = false;
    const collapseBtn = document.getElementById('btn-panel-collapse');
    if (collapseBtn) collapseBtn.setAttribute('aria-expanded', 'true');

    ['sec-benioff', 'sec-capas-avanzadas', 'sec-shakemap', 'sec-export'].forEach(id => {
        const det = document.getElementById(id);
        if (det) det.open = false;
    });

    pinnedInspectorItem = null;
    pinnedCompareItem = null;
    renderPinnedInspector();

    currentProfile = 'sismologia';
    document.querySelectorAll('.profile-tab').forEach(t => {
        const isDefault = t.getAttribute('data-profile') === 'sismologia';
        t.classList.toggle('active', isDefault);
        t.setAttribute('aria-selected', String(isDefault));
    });
    document.querySelectorAll('.profile-panel').forEach(p => {
        p.style.display = p.id === 'panel-sismologia' ? 'flex' : 'none';
    });

    selectedNsrMunicipio = null;
    selectedPotMunicipio = null;

    const nsrSearch = document.getElementById('nsr-municipio-search');
    if (nsrSearch) nsrSearch.value = '';
    const potSearch = document.getElementById('pot-municipio-search');
    if (potSearch) potSearch.value = '';

    const nsrSel = document.getElementById('nsr-municipio-select');
    if (nsrSel) nsrSel.value = '';
    const potSel = document.getElementById('pot-municipio-select');
    if (potSel) potSel.value = '';

    const nsrSuelo = document.getElementById('nsr-suelo-select');
    if (nsrSuelo) nsrSuelo.value = 'E';
    const nsrUso = document.getElementById('nsr-grupo-uso-select');
    if (nsrUso) nsrUso.value = '1.00';

    const potFilter = document.getElementById('pot-priority-filter');
    if (potFilter) potFilter.value = 'all';

    const potSummary = document.getElementById('pot-tabular-summary');
    if (potSummary) potSummary.style.display = 'none';
    const potSummaryBtn = document.getElementById('btn-pot-summary-toggle');
    if (potSummaryBtn) potSummaryBtn.innerText = 'Ver Tablero Municipal Simplificado';

    if (municipiosData && municipiosData.length > 0) {
        initMunicipiosUI();
    }
}

/**
 * Restablece todos los botones, interruptores, filtros y controles de interfaz a su estado inicial ("a cero").
 */
function resetAllControlsToZero({ resetCamera = false, skipRender = false } = {}) {
    try {
        localStorage.removeItem('sismochoco_prefs_v1');
    } catch (_) {}

    resetParametricFilters(false);
    resetSpatialVisualization({ skipCameraReset: !resetCamera, skipRender: true });
    resetAdvancedLayers({ skipRender: true });
    resetSpecialtyAndThemeControls();

    if (resetCamera && deckgl) {
        deckgl.setProps({
            mapStyle: currentMapStyle,
            initialViewState: {
                longitude: -77.0,
                latitude: 6.0,
                zoom: 6.5,
                pitch: 45,
                bearing: 15,
                transitionDuration: 1200,
                transitionInterpolator: new deck.FlyToInterpolator()
            }
        });
    } else if (deckgl) {
        deckgl.setProps({ mapStyle: currentMapStyle });
    }

    if (!skipRender) {
        renderLayers();
    }
}

const btnHome = document.getElementById('btn-home');
if (btnHome) {
    btnHome.addEventListener('click', () => {
        resetAllControlsToZero({ resetCamera: true, skipRender: false });
    });
}

// ============================================================================
// RESET FILTERS
// ============================================================================
document.getElementById('btn-reset').addEventListener('click', () => {
    resetParametricFilters(true);
});

// Reset Visualización
document.getElementById('btn-reset-vis').addEventListener('click', () => {
    resetSpatialVisualization({ skipCameraReset: false, skipRender: false });
});

// Reset Capas Avanzadas
document.getElementById('btn-reset-capas').addEventListener('click', (e) => {
    if (e) {
        e.preventDefault();
        e.stopPropagation();
    }
    resetAdvancedLayers({ skipRender: false });
});

// ============================================================================
// COMPROBACIÓN DE ESTADO DEL SERVIDOR FASTAPI (HEALTH CHECK)
// ============================================================================
async function checkServerHealth() {
    const badge = document.getElementById('server-status-badge');
    if (!badge) return;
    try {
        const res = await fetch(ENDPOINTS.HEALTH_API, { cache: 'no-store' });
        if (res.ok) {
            badge.innerHTML = '<span class="status-dot"></span> Online';
            badge.style.background = 'var(--pill-ok-bg)';
            badge.style.color = 'var(--pill-ok-fg)';
            badge.style.borderColor = 'var(--pill-ok-border)';
            badge.title = 'Servidor FastAPI conectado y operativo';
        } else {
            throw new Error('Servidor retornó código ' + res.status);
        }
    } catch(e) {
        badge.innerHTML = '<span class="status-dot"></span> Offline / Local';
        badge.style.background = 'var(--pill-crit-bg)';
        badge.style.color = 'var(--pill-crit-fg)';
        badge.style.borderColor = 'var(--pill-crit-border)';
        badge.title = 'Servidor local desconectado. Usando caché offline PWA.';
    }
}

async function fetchJsonWithFallback(primaryUrl, fallbackUrl, timeoutMs = 6500, validator = null) {
    if (primaryUrl) {
        try {
            const res = await fetchWithTimeout(primaryUrl, timeoutMs);
            if (res && res.ok) {
                const parsed = await res.json();
                if (!validator || validator(parsed)) return parsed;
            }
        } catch (e) {
            console.warn(`Fallback a caché/estático para ${primaryUrl}:`, e && e.name ? e.name : e);
        }
    }
    if (fallbackUrl) {
        const fbRes = await fetch(fallbackUrl);
        if (fbRes && fbRes.ok) {
            const fbParsed = await fbRes.json();
            if (!validator || validator(fbParsed)) return fbParsed;
        }
    }
    return null;
}

let _municipiosFetchPromise = null;
async function ensureMunicipiosData() {
    if (Array.isArray(municipiosData) && municipiosData.length > 0) {
        return municipiosData;
    }
    if (!_municipiosFetchPromise) {
        _municipiosFetchPromise = fetchJsonWithFallback(
            MUNICIPIOS_API,
            './data/municipios_choco_nsr10.json',
            5000,
            d => Array.isArray(d) && d.length > 0
        ).then(d => {
            if (Array.isArray(d) && d.length > 0) {
                municipiosData = d;
                initMunicipiosUI();
            }
            _municipiosFetchPromise = null;
            return municipiosData;
        }).catch(err => {
            _municipiosFetchPromise = null;
            console.warn('Error cargando catálogo municipal NSR-10:', err);
            return municipiosData;
        });
    }
    return _municipiosFetchPromise;
}

async function loadData() {
    checkServerHealth();
    const progressEl = document.getElementById('loader-progress');

    // Lanzar en paralelo las cargas auxiliares (sin bloquear por el catálogo principal)
    const auxPromise = Promise.allSettled([
        fetchJsonWithFallback(ENDPOINTS.FALLAS_API, './data/fallas.geojson', 5000).then(d => { if (d) faultData = d; }),
        ensureMunicipiosData(),
        fetchJsonWithFallback(INFRA_API, './data/vias_infraestructura.geojson', 5000).then(d => { if (d) infraData = d; }),
        fetchJsonWithFallback('./data/choco_base_offline.geojson', null, 4000).then(d => { if (d) chocoBaseData = d; })
    ]);

    try {
        let res = await fetchWithTimeout(API_URL, 8000).catch(() => null);
        if (!res || !res.ok) {
            res = await fetch('./sismicidad_choco_consolidado.geojson');
        }
        if (!res || !res.ok) {
            throw new Error('No fue posible cargar catálogo sísmico ni respaldo local');
        }

        if (!res.body) {
            mapData = await res.json();
            if (progressEl) progressEl.innerText = '100%';
        } else {
            const reader = res.body.getReader();
            const contentLength = +res.headers.get('Content-Length') || 4100000;
            let receivedLength = 0;
            let chunks = [];

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                receivedLength += value.length;
                if (progressEl) {
                    const perc = Math.min(100, Math.round((receivedLength / contentLength) * 100));
                    progressEl.innerText = `${perc}%`;
                }
            }

            let chunksAll = new Uint8Array(receivedLength);
            let position = 0;
            for (let chunk of chunks) { chunksAll.set(chunk, position); position += chunk.length; }
            mapData = JSON.parse(new TextDecoder('utf-8').decode(chunksAll));
        }
    } catch (e) {
        console.error('Error cargando catálogo sísmico:', e);
        const countEl = document.getElementById('count');
        if (countEl) countEl.innerText = 'Sin datos';
    }

    ['count', 'b-value-badge', 'gr-recurrence-box'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.remove('is-skeleton');
    });

    await auxPromise;

    try {
        restoreSavedPreferences();
        if (deckgl) {
            deckgl.setProps({ mapStyle: currentMapStyle });
        }
        renderLayers();
    } catch (e) { console.error('Error renderizando capas:', e); }

    const loader = document.getElementById('loader-overlay');
    if (loader) {
        loader.style.opacity = '0';
        setTimeout(() => loader.remove(), 500);
    }
}

// ============================================================================
// RENDER THROTTLING (requestAnimationFrame para 60 FPS fluido en Sliders)
// ============================================================================
let isRenderQueued = false;
function queueRender() {
    if (!isRenderQueued) {
        isRenderQueued = true;
        requestAnimationFrame(() => {
            renderLayers();
            isRenderQueued = false;
        });
    }
}

// UI Listeners con animación fluida
document.getElementById('mag-slider').addEventListener('input', e => { 
    currentMag = parseFloat(e.target.value); 
    document.getElementById('mag-val').innerText = currentMag.toFixed(1); 
    queueRender(); 
});
document.getElementById('time-slider').addEventListener('input', e => { 
    currentTime = parseInt(e.target.value); 
    document.getElementById('time-val').innerText = currentTime; 
    queueRender(); 
});
document.getElementById('check-calidad').addEventListener('change', e => { highQualityOnly = e.target.checked; renderLayers(); });

// ============================================================================
// CONTROL Y GESTIÓN INTERACTIVA DE FALLAS GEOLÓGICAS
// ============================================================================
const checkFallas = document.getElementById('check-fallas');
const fallasPanel = document.getElementById('fallas-interactive-panel');
if (checkFallas) {
    checkFallas.addEventListener('change', e => {
        showFaults = e.target.checked;
        if (fallasPanel) {
            fallasPanel.style.display = showFaults ? 'flex' : 'none';
        }
        if (showFaults && !selectedFaultId) {
            selectFault('falla_murindo', false);
        } else if (!showFaults) {
            showFaultBuffer = false;
            const checkBuffer = document.getElementById('check-fallas-buffer');
            if (checkBuffer) checkBuffer.checked = false;
        }
        renderLayers();
    });
}

const selFallaActiva = document.getElementById('select-falla-activa');
if (selFallaActiva) {
    selFallaActiva.addEventListener('change', e => {
        selectFault(e.target.value, e.target.value !== 'all');
    });
}

document.querySelectorAll('.falla-tipo-btn').forEach(btn => {
    btn.addEventListener('click', function() {
        document.querySelectorAll('.falla-tipo-btn').forEach(b => {
            b.classList.remove('active');
            b.style.background = '';
            b.style.fontWeight = '';
        });
        this.classList.add('active');
        faultKinematicFilter = this.getAttribute('data-tipo') || 'all';
        renderLayers();
    });
});

const checkFallasBuffer = document.getElementById('check-fallas-buffer');
if (checkFallasBuffer) {
    const handleBufferToggle = () => {
        showFaultBuffer = checkFallasBuffer.checked;
        if (showFaultBuffer) {
            showFaults = true;
            const checkFallas = document.getElementById('check-fallas');
            if (checkFallas) checkFallas.checked = true;
            if (fallasPanel) fallasPanel.style.display = 'flex';
            if (!selectedFaultId) {
                selectFault('falla_murindo', false);
            }
        }
        renderLayers();
        queueRender();
    };
    checkFallasBuffer.addEventListener('change', handleBufferToggle);
    checkFallasBuffer.addEventListener('click', (e) => {
        e.stopPropagation();
        handleBufferToggle();
    });
}


let liveSocket = null;
let livePollingInterval = null;

// Carga telemétrica en tiempo real: consulta el backend FastAPI o conecta directamente con el feed FDSN oficial de USGS en vivo
async function loadRealSgcHttp() {
    const badge = document.getElementById('sgc-live-status-badge');
    const subtext = document.getElementById('sgc-live-subtext');
    if (badge) {
        badge.style.display = 'inline-block';
        badge.innerText = '📡 Sincronizando...';
        badge.style.color = '#38bdf8';
        badge.style.borderColor = 'rgba(56,189,248,0.3)';
        badge.style.background = 'rgba(56,189,248,0.15)';
    }

    try {
        // 1. Intento primario: Endpoint de telemetría en vivo sin caché (EMSC + USGS, ventana móvil 14d)
        const resp = await fetchWithTimeout(ENDPOINTS.SGC_API, 6000, { cache: 'no-store' });
        if (resp.ok) {
            const data = await resp.json();
            const feats = Array.isArray(data.features) ? data.features : [];
            sgcData.features = feats;
            const eventos24h = (typeof data.eventos_24h === 'number')
                ? data.eventos_24h
                : feats.filter(f => f.properties && f.properties.esHoy).length;
            const ultimoFecha = data.ultimo_evento_fecha || (feats[0] && feats[0].properties ? feats[0].properties.fecha : null);
            updateSgcLiveBadge(feats.length, 'FDSN Live (EMSC/USGS)', {
                eventos24h,
                ultimoFecha,
                ventanaDias: data.ventana_dias || 14
            });
            if (showLiveSGC) queueRender();
            return;
        }
    } catch (err) {
        console.warn("Backend no disponible para telemetría FDSN. Consultando feed directo USGS...", err);
    }

    // 2. Consulta directa a la API FDSN oficial de USGS (misma ventana de 14 días)
    try {
        const dNow = new Date();
        const dStart = new Date(dNow.getTime() - (14 * 24 * 60 * 60 * 1000));
        const startIso = dStart.toISOString().split('T')[0];
        const usgsUrl = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&minlatitude=3.0&maxlatitude=8.8&minlongitude=-78.5&maxlongitude=-74.5&starttime=${startIso}&limit=30`;
        const usgsResp = await fetchWithTimeout(usgsUrl, 6000, { cache: 'no-store' });
        if (usgsResp.ok) {
            const usgsData = await usgsResp.json();
            const rawList = Array.isArray(usgsData.features) ? usgsData.features : [];
            const nowMs = Date.now();
            const parsedFeatures = rawList.map(item => {
                const p = item.properties || {};
                const c = (item.geometry && item.geometry.coordinates) || [0, 0, 0];
                const lon = c[0];
                const lat = c[1];
                const depth = Math.abs(c[2] || 10.0);

                // Conversión precisa a Hora Legal de Colombia (UTC-5)
                const dUtc = new Date(p.time);
                const dCol = new Date(dUtc.getTime() - (5 * 60 * 60 * 1000));
                const fechaStr = dCol.toISOString().replace('T', ' ').substring(0, 19);
                const diffHours = (nowMs - p.time) / (1000 * 60 * 60);

                let nearestName = p.place || 'Chocó / Pacífico';
                if (municipiosData && municipiosData.length > 0) {
                    let minDist = Infinity;
                    for (const m of municipiosData) {
                        const dLat = (lat - m.lat) * (Math.PI / 180);
                        const dLon = (lon - m.lng) * (Math.PI / 180);
                        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat * Math.PI / 180) * Math.cos(m.lat * Math.PI / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
                        const distKm = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
                        if (distKm < minDist) {
                            minDist = distKm;
                            nearestName = `${m.nombre} (${m.departamento}) [~${Math.round(distKm)} km]`;
                        }
                    }
                }

                return {
                    type: "Feature",
                    geometry: {
                        type: "Point",
                        coordinates: [lon, lat, -depth * 1000]
                    },
                    properties: {
                        id: item.id || p.code,
                        fecha: fechaStr,
                        timestampMs: p.time,
                        diffHours: parseFloat(diffHours.toFixed(1)),
                        esHoy: diffHours <= 24,
                        anio: dCol.getFullYear(),
                        magnitud: Math.round((p.mag || 0.0) * 10) / 10,
                        profundidad: Math.round(depth * 10) / 10,
                        municipio: nearestName,
                        fuente: diffHours <= 24 ? "USGS FDSN Live (Últimas 24h)" : "USGS FDSN Reciente (14d)",
                        rms: p.rms || 0.0,
                        gap: p.gap || 0.0
                    }
                };
            });

            sgcData.features = parsedFeatures;
            const rec24h = parsedFeatures.filter(f => f.properties.esHoy).length;
            const ultimoFecha = parsedFeatures[0] && parsedFeatures[0].properties ? parsedFeatures[0].properties.fecha : null;
            updateSgcLiveBadge(parsedFeatures.length, 'USGS FDSN Directo', {
                eventos24h: rec24h,
                ultimoFecha,
                ventanaDias: 14
            });
            if (showLiveSGC) queueRender();
            return;
        }
    } catch (fdsnErr) {
        console.warn("FDSN directo no accesible. Extrayendo sismos recientes del catálogo consolidado...", fdsnErr);
    }

    // 3. Fallback de respaldo local si no hay conexión a internet
    if (mapData && mapData.features && mapData.features.length > 0) {
        const recientes = mapData.features
            .filter(f => f.properties && f.properties.anio >= 2026)
            .slice(0, 25);
        if (recientes.length > 0) {
            sgcData.features = recientes;
            updateSgcLiveBadge(recientes.length, 'Catálogo Local Offline');
            if (showLiveSGC) queueRender();
        }
    }
}

function updateSgcLiveBadge(count, sourceName, meta = {}) {
    const badge = document.getElementById('sgc-live-status-badge');
    const subtext = document.getElementById('sgc-live-subtext');
    const eventos24h = typeof meta.eventos24h === 'number'
        ? meta.eventos24h
        : sgcData.features.filter(f => f.properties && f.properties.esHoy).length;
    const ventanaDias = meta.ventanaDias || 14;
    const ultimoStr = meta.ultimoFecha ? String(meta.ultimoFecha).slice(0, 16) : null;

    if (badge) {
        badge.style.display = 'inline-block';
        if (eventos24h > 0) {
            badge.innerText = `● HOY: ${eventos24h} (${count} en ${ventanaDias}d)`;
            badge.style.color = 'var(--pill-ok-fg)';
            badge.style.borderColor = 'var(--pill-ok-border)';
            badge.style.background = 'var(--pill-ok-bg)';
        } else {
            badge.innerText = `● 0 hoy · ${count} (${ventanaDias}d)`;
            badge.style.color = 'var(--accent-ui)';
            badge.style.borderColor = 'rgba(56,189,248,0.4)';
            badge.style.background = 'rgba(56,189,248,0.12)';
        }
    }
    if (subtext) {
        if (count === 0) {
            subtext.innerHTML = `<span style="color:var(--accent-ui);">● ${escapeHtml(sourceName)}:</span> Sin sismos M≥3.5 en últimos ${ventanaDias}d`;
        } else if (eventos24h > 0) {
            subtext.innerHTML = `<span style="color:var(--pill-ok-fg);">● ${escapeHtml(sourceName)}:</span> ${eventos24h} últimos 24h · Último: ${escapeHtml(ultimoStr || 'hoy')}`;
        } else {
            subtext.innerHTML = `<span style="color:var(--accent-ui);">● ${escapeHtml(sourceName)}:</span> Último ${escapeHtml(ultimoStr || '')} (sin sismos 24h; M≥3.5)`;
        }
    }
}

let alertMagThreshold = 4.0;
let notifiedEventIds = new Set();
let bannerDismissTimeout = null;

// Despliegue del Banner Flotante Telemétrico en Pantalla (Alerta estrictamente visual, sin sonido)
function triggerSeismicAlertBanner(eventFeature) {
    const banner = document.getElementById('live-seismic-alert-banner');
    if (!banner || !eventFeature) return;

    const p = eventFeature.properties || {};
    const mag = p.mag || p.magnitud || 0;
    const descEl = document.getElementById('alert-banner-desc');
    const timeEl = document.getElementById('alert-banner-time');
    const magEl = document.getElementById('alert-banner-mag');
    const depthEl = document.getElementById('alert-banner-depth');

    if (descEl) descEl.innerHTML = `<strong>${escapeHtml(p.municipio || 'Chocó / Pacífico')}</strong> (${escapeHtml(p.fuente || 'FDSN')}).`;
    if (timeEl) timeEl.innerText = p.fecha || 'Reciente';
    if (magEl) magEl.innerText = `${mag.toFixed(1)} Mw`;
    if (depthEl) depthEl.innerText = `${p.profundidad} km`;

    // Cambiar tonalidad si es sismo fuerte (≥ 5.0)
    if (mag >= 5.0) {
        banner.style.borderColor = '#ff453a';
        banner.style.boxShadow = '0 12px 36px rgba(0,0,0,0.6), 0 0 25px rgba(255,69,58,0.4)';
    } else {
        banner.style.borderColor = '#10b981';
        banner.style.boxShadow = '0 12px 36px rgba(0,0,0,0.6), 0 0 20px rgba(16,185,129,0.3)';
    }

    banner.style.display = 'block';
    banner.style.opacity = '1';

    // Auto-cierre tras 9 segundos si el usuario no lo cierra manualmente
    if (bannerDismissTimeout) clearTimeout(bannerDismissTimeout);
    bannerDismissTimeout = setTimeout(() => {
        banner.style.opacity = '0';
        setTimeout(() => { banner.style.display = 'none'; }, 300);
    }, 9000);
}

// Botón de cierre manual del banner flotante
const btnCloseAlertBanner = document.getElementById('btn-close-alert-banner');
if (btnCloseAlertBanner) {
    btnCloseAlertBanner.addEventListener('click', () => {
        const banner = document.getElementById('live-seismic-alert-banner');
        if (banner) {
            banner.style.opacity = '0';
            setTimeout(() => { banner.style.display = 'none'; }, 300);
        }
        if (bannerDismissTimeout) clearTimeout(bannerDismissTimeout);
    });
}

// Configuración del umbral interactivo de alerta visual
const sliderAlertThreshold = document.getElementById('slider-alert-threshold');
const alertThresholdVal = document.getElementById('alert-mag-threshold-val');
if (sliderAlertThreshold && alertThresholdVal) {
    sliderAlertThreshold.addEventListener('input', (e) => {
        alertMagThreshold = parseFloat(e.target.value);
        alertThresholdVal.innerText = `≥ ${alertMagThreshold.toFixed(1)} Mw`;
    });
}

// Evaluación de eventos entrantes contra el umbral configurado por el usuario
function checkIncomingEventsForAlert(features) {
    if (!features || features.length === 0) return;
    for (const f of features) {
        const p = f.properties || {};
        const id = p.id || p.fecha;
        const mag = p.mag || p.magnitud || 0;

        if (id && !notifiedEventIds.has(id)) {
            notifiedEventIds.add(id);
            if (mag >= alertMagThreshold) {
                triggerSeismicAlertBanner(f);
                break; // Disparar el evento prioritario
            }
        }
    }
}

document.getElementById('check-live-sgc').addEventListener('change', e => {
    showLiveSGC = e.target.checked;
    const settingsBox = document.getElementById('sgc-alert-settings');
    if (settingsBox) settingsBox.style.display = showLiveSGC ? 'flex' : 'none';
    
    if (showLiveSGC) {
        queueRender();
        // Carga inmediata de los sismos reales por telemetría
        loadRealSgcHttp().then(() => {
            if (sgcData && sgcData.features) {
                checkIncomingEventsForAlert(sgcData.features);
            }
        });

        // Sondeo telemétrico periódico cada 45 segundos para captar nuevos pulsos en tiempo real
        if (!livePollingInterval) {
            livePollingInterval = setInterval(() => {
                if (showLiveSGC) {
                    loadRealSgcHttp().then(() => {
                        if (sgcData && sgcData.features) {
                            checkIncomingEventsForAlert(sgcData.features);
                        }
                    });
                }
            }, 45000);
        }

        if (!liveSocket) {
            try {
                liveSocket = new WebSocket(ENDPOINTS.WS_URL);
                
                liveSocket.onmessage = (event) => {
                    const incoming = JSON.parse(event.data);
                    if (incoming.features && incoming.features.length > 0) {
                        const existingIds = new Set(sgcData.features.map(f => f.properties.id || f.properties.fecha));
                        const brandNew = incoming.features.filter(f => !existingIds.has(f.properties.id || f.properties.fecha));
                        if (brandNew.length > 0) {
                            sgcData.features = [...brandNew, ...sgcData.features];
                            checkIncomingEventsForAlert(brandNew);
                        } else if (sgcData.features.length === 0) {
                            sgcData.features = incoming.features;
                            checkIncomingEventsForAlert(incoming.features);
                        }
                        updateSgcLiveBadge(sgcData.features.length, 'WebSocket FDSN Live');
                        if (showLiveSGC) queueRender();
                    }
                };
                
                liveSocket.onerror = () => {
                    console.info("WebSocket opcional; operando con canal telemétrico REST en vivo");
                };
                
                liveSocket.onclose = () => { console.log("Satélite SGC Telemétrico WS Desconectado"); };
            } catch (wsErr) {
                console.info("WebSocket no disponible, canal REST en vivo activo");
            }
        }
    } else {
        // Desconectar satélite, detener sondeo y limpiar memoria
        if (liveSocket) {
            liveSocket.close();
            liveSocket = null;
        }
        if (livePollingInterval) {
            clearInterval(livePollingInterval);
            livePollingInterval = null;
        }
        const badge = document.getElementById('sgc-live-status-badge');
        const subtext = document.getElementById('sgc-live-subtext');
        if (badge) badge.style.display = 'none';
        if (subtext) subtext.innerText = 'FDSN en vivo 14d · EMSC / USGS (M≥3.5)';

        sgcData.features = [];
        renderLayers();
    }
});
const checkSgcWms = document.getElementById('check-sgc-wms');
if (checkSgcWms) {
    checkSgcWms.addEventListener('change', e => {
        showSgcWms = e.target.checked;
        const sgcQueryBox = document.getElementById('sgc-wms-query-box');
        if (sgcQueryBox) sgcQueryBox.style.display = showSgcWms ? 'flex' : 'none';
        if (!showSgcWms) hideSgcRasterTooltipIfActive();
        renderLayers();
    });
}
const btnSgcQueryMunicipio = document.getElementById('btn-sgc-query-municipio');
if (btnSgcQueryMunicipio) {
    btnSgcQueryMunicipio.addEventListener('click', () => {
        const m = selectedNsrMunicipio || selectedPotMunicipio || (municipiosData && municipiosData[0]);
        if (m && m.lng !== undefined && m.lat !== undefined) {
            querySgcOfficialPoint(m.lng, m.lat, `${m.nombre} (${m.departamento})`);
        }
    });
}
document.getElementById('check-ml').addEventListener('change', async e => {
    showML = e.target.checked;
    if (showML && mlData.features.length === 0) {
        const d = await fetchJsonWithFallback(ML_API, './data/ml_clusters_fallback.json', 5500);
        if (d && d.features) mlData = d;
    }
    renderLayers();
});

// Selector Dinámico de Mapas Base y Tema Claro del Panel
document.querySelectorAll('.basemap-btn[data-style]').forEach(btn => {
    btn.addEventListener('click', function() {
        document.querySelectorAll('.basemap-btn[data-style]').forEach(b => b.classList.remove('active'));
        this.classList.add('active');
        const styleKey = this.getAttribute('data-style');
        if (BASEMAP_STYLES[styleKey]) {
            currentMapStyle = BASEMAP_STYLES[styleKey];
            deckgl.setProps({ mapStyle: currentMapStyle });
            savePreferences();
        }
    });
});

const btnThemeToggle = document.getElementById('btn-theme-toggle');
if (btnThemeToggle) {
    btnThemeToggle.addEventListener('click', () => {
        const isLight = document.body.classList.toggle('theme-light');
        btnThemeToggle.classList.toggle('active', isLight);
        btnThemeToggle.setAttribute('aria-pressed', String(isLight));
        applyThemeToCharts(isLight);
        savePreferences();
    });
}

document.querySelectorAll('.toggle-btn').forEach(btn => {
    if (['btn-export-csv', 'btn-export-geojson', 'btn-export-png', 'btn-print'].includes(btn.id)) return;
    
    btn.addEventListener('click', function(e) {
        // Solo quitamos la clase active de los 3 botones principales
        const viewBtns = [document.getElementById('btn-puntos'), document.getElementById('btn-calor'), document.getElementById('btn-hex')];
        
        viewBtns.forEach(b => {
            if (b) {
                b.classList.remove('active');
            }
        });
        
        this.classList.add('active');
        viewMode = this.id.split('-')[1];
        if (isBenioffMode) {
            animateBenioffViewForMode(viewMode);
        }
        renderLayers();
    });
});

// Botones de Exportación Abierta (CSV UTF-8 BOM, GeoJSON, PNG WebGL)
function downloadBlob(blob, filename) {
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
    }, 150);
}

function safeCsvField(val) {
    const s = String(val ?? '');
    return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

document.getElementById('btn-export-csv').addEventListener('click', () => {
    if (!window.currentFilteredData) return;
    let csv = '\uFEFFFECHA,LATITUD,LONGITUD,PROFUNDIDAD_KM,MAGNITUD,MUNICIPIO,FUENTE\r\n';
    window.currentFilteredData.forEach(f => {
        const p = f.properties;
        const c = f.geometry.coordinates;
        const fecha = safeCsvField(p.fecha || '').replace(/"/g, '""');
        const mun = safeCsvField(p.municipio || '').replace(/"/g, '""');
        const fnt = safeCsvField(p.fuente || 'Catálogo SGC Consolidado').replace(/"/g, '""');
        csv += `"${fecha}",${c[1]},${c[0]},${p.profundidad ?? ''},${p.magnitud ?? ''},"${mun}","${fnt}"\r\n`;
    });
    downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), `sismos_choco_${currentTime}_2026.csv`);
});

const btnExportGeojson = document.getElementById('btn-export-geojson');
if (btnExportGeojson) {
    btnExportGeojson.addEventListener('click', () => {
        if (!window.currentFilteredData) return;
        const fc = {
            type: 'FeatureCollection',
            generado: new Date().toISOString(),
            filtros: { anio_inicio: currentTime, magnitud_min: currentMag, profundidad_max_km: currentMaxDepth },
            features: window.currentFilteredData
        };
        downloadBlob(new Blob([JSON.stringify(fc)], { type: 'application/geo+json;charset=utf-8;' }), `sismos_choco_${currentTime}_2026.geojson`);
    });
}

const btnExportPng = document.getElementById('btn-export-png');
if (btnExportPng) {
    btnExportPng.addEventListener('click', () => {
        try {
            const container = document.getElementById('map-container');
            const canvases = container ? Array.from(container.querySelectorAll('canvas')) : [];
            if (canvases.length === 0) return;
            const base = canvases[0];
            const out = document.createElement('canvas');
            out.width = base.width || window.innerWidth;
            out.height = base.height || window.innerHeight;
            const ctxOut = out.getContext('2d');
            ctxOut.fillStyle = '#0f172a';
            ctxOut.fillRect(0, 0, out.width, out.height);
            canvases.forEach(c => {
                try { ctxOut.drawImage(c, 0, 0, out.width, out.height); } catch (_) {}
            });
            out.toBlob(blob => {
                if (blob) downloadBlob(blob, `sismochoco_mapa_${Date.now()}.png`);
            }, 'image/png');
        } catch (err) {
            console.warn('No fue posible componer captura PNG:', err);
        }
    });
}

document.getElementById('btn-print').addEventListener('click', () => {
    const printDate = document.getElementById('print-date');
    if (printDate) {
        printDate.innerText = new Date().toLocaleDateString('es-CO', { 
            year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' 
        });
    }
    const printFilters = document.getElementById('print-filters-summary');
    if (printFilters) {
        const visModeNames = {
            'none': 'Sin visualización agregada',
            'puntos': 'Eventos Individuales (Scatter 3D)',
            'calor': 'Concentración de Energía (Heatmap)',
            'hex': 'Agrupación Espacial 3D (Hexbins)'
        };
        const activeCapas = [];
        if (highQualityOnly) activeCapas.push('Alta Precisión');
        if (showFaults) activeCapas.push('Fallas Geológicas');
        if (showLiveSGC) activeCapas.push('Telemetría Live');
        if (showSgcWms) activeCapas.push('SGC Oficial PGA Tr=475a');
        if (showML) activeCapas.push('Zonas Anómalas (IA)');
        
        const countStr = window.currentFilteredData ? window.currentFilteredData.length.toLocaleString() : '0';
        printFilters.innerText = `Ventana: ${currentTime}-2026 | M ≥ ${currentMag.toFixed(1)} | Prof ≤ ${currentMaxDepth} km | Muestra: ${countStr} eventos | Modo: ${visModeNames[viewMode] || viewMode}${activeCapas.length > 0 ? ' | Capas: ' + activeCapas.join(', ') : ''}`;
    }
    window.print();
});

// Mobile Panel Toggle & Gestos Táctiles (Swipe Up / Down tipo Apple Maps)
const mobileToggleBtn = document.getElementById('mobile-toggle');
const uiPanel = document.getElementById('ui-panel');

if (mobileToggleBtn && uiPanel) {
    mobileToggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = uiPanel.classList.toggle('open');
        mobileToggleBtn.setAttribute('aria-expanded', isOpen);
    });

    // Gestos táctiles en el drag handle
    let touchStartY = 0;
    let touchCurrentY = 0;

    mobileToggleBtn.addEventListener('touchstart', (e) => {
        if (e.touches && e.touches.length > 0) {
            touchStartY = e.touches[0].clientY;
            touchCurrentY = touchStartY;
        }
    }, { passive: true });

    mobileToggleBtn.addEventListener('touchmove', (e) => {
        if (e.touches && e.touches.length > 0) {
            touchCurrentY = e.touches[0].clientY;
        }
    }, { passive: true });

    mobileToggleBtn.addEventListener('touchend', () => {
        const deltaY = touchCurrentY - touchStartY;
        // Si desliza hacia arriba al menos 35px, expande el panel
        if (deltaY < -35 && !uiPanel.classList.contains('open')) {
            uiPanel.classList.add('open');
            mobileToggleBtn.setAttribute('aria-expanded', 'true');
        }
        // Si desliza hacia abajo al menos 35px, colapsa el panel
        else if (deltaY > 35 && uiPanel.classList.contains('open')) {
            uiPanel.classList.remove('open');
            mobileToggleBtn.setAttribute('aria-expanded', 'false');
        }
    }, { passive: true });

    // Si el usuario toca el contenedor del mapa mientras el panel está abierto en móvil, colapsarlo suavemente
    const mapContainer = document.getElementById('map-container');
    if (mapContainer) {
        mapContainer.addEventListener('click', () => {
            if (window.innerWidth <= 768 && uiPanel.classList.contains('open')) {
                uiPanel.classList.remove('open');
                mobileToggleBtn.setAttribute('aria-expanded', 'false');
            }
        });
        mapContainer.addEventListener('touchstart', () => {
            if (window.innerWidth <= 768 && uiPanel.classList.contains('open')) {
                uiPanel.classList.remove('open');
                mobileToggleBtn.setAttribute('aria-expanded', 'false');
            }
        }, { passive: true });
    }
}

// ============================================================================
// SUGERENCIA DE DISPOSITIVOS Y ORIENTACIÓN HORIZONTAL (TABLET / MÓVIL)
// ============================================================================
(function initDeviceAdvice() {
    const userAgent = navigator.userAgent || '';
    const isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    const screenW = window.innerWidth;
    const screenH = window.innerHeight;
    const isPortrait = screenH > screenW;

    // Criterios precisos para diferenciar Tablet de Teléfono móvil
    const isTabletUserAgent = /iPad|Tablet|(Android(?!.*Mobile))/i.test(userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1 && !window.MSStream); // iPads recientes con iPadOS
    const isTabletDimension = isTouch && (
        (Math.min(screenW, screenH) >= 600 && Math.max(screenW, screenH) <= 1366) || isTabletUserAgent
    );
    const isMobilePhone = !isTabletDimension && (
        /Android.*Mobile|iPhone|iPod|BlackBerry|IEMobile|Opera Mini/i.test(userAgent) ||
        (isTouch && Math.min(screenW, screenH) < 600)
    );

    const mobileModal = document.getElementById('mobile-device-modal');
    const continueMobileBtn = document.getElementById('btn-continue-mobile');
    const tabletModal = document.getElementById('tablet-orientation-modal');
    const continueTabletBtn = document.getElementById('btn-continue-tablet');
    const adviceBanner = document.getElementById('mobile-device-advice');
    const dismissAdviceBtn = document.getElementById('btn-dismiss-device-advice');

    // Descarte manual del banner contextual en la cabecera
    if (dismissAdviceBtn && adviceBanner) {
        dismissAdviceBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            adviceBanner.style.opacity = '0';
            adviceBanner.style.transition = 'opacity 0.25s ease';
            setTimeout(() => { adviceBanner.style.display = 'none'; }, 250);
            sessionStorage.setItem('sismochoco_device_advice_dismissed', 'true');
        });
    }

    // 1. Sugerencia de Visualización en PC para Dispositivo Móvil y Tablet
    const deviceModalSeen = sessionStorage.getItem('sismochoco_device_modal_seen') || sessionStorage.getItem('sismochoco_mobile_modal_seen');
    const isMobileOrTablet = isMobilePhone || isTabletDimension;

    if (isMobileOrTablet && !deviceModalSeen && mobileModal) {
        setTimeout(() => {
            mobileModal.style.display = 'flex';
            requestAnimationFrame(() => {
                mobileModal.style.opacity = '1';
            });
        }, 900);

        if (continueMobileBtn) {
            continueMobileBtn.addEventListener('click', () => {
                mobileModal.style.opacity = '0';
                setTimeout(() => {
                    mobileModal.style.display = 'none';
                    // Si es tablet y está en vertical, sugerir luego la orientación horizontal
                    if (isTabletDimension && window.innerHeight > window.innerWidth) {
                        checkTabletOrientation();
                    }
                }, 300);
                sessionStorage.setItem('sismochoco_device_modal_seen', 'true');
            });
        }

        const btnClearCacheModal = document.getElementById('btn-clear-cache-mobile-modal');
        if (btnClearCacheModal) {
            btnClearCacheModal.addEventListener('click', () => {
                if (window.limpiarCacheStorageTotal) {
                    window.limpiarCacheStorageTotal();
                } else {
                    window.location.reload(true);
                }
            });
        }
    }

    const btnClearCacheBanner = document.getElementById('btn-clear-cache-banner');
    if (btnClearCacheBanner) {
        btnClearCacheBanner.addEventListener('click', (e) => {
            e.stopPropagation();
            if (window.limpiarCacheStorageTotal) {
                window.limpiarCacheStorageTotal();
            } else {
                window.location.reload(true);
            }
        });
    }

    // Función para detectar si el dispositivo actual es una tablet
    function checkIsTablet() {
        const curW = window.innerWidth;
        const curH = window.innerHeight;
        const isTabletUA = /iPad|Tablet|(Android(?!.*Mobile))/i.test(navigator.userAgent || '') ||
            (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1 && !window.MSStream);
        const minDim = Math.min(curW, curH);
        const maxDim = Math.max(curW, curH);
        return isTouch && ((minDim >= 600 && maxDim <= 1366) || isTabletUA);
    }

    // 2. En Tablet: Detección y retiro automático al cambiar orientación
    let tabletPromptTimer = null;

    function checkTabletOrientation() {
        if (!tabletModal) return;

        // Evaluación dinámica y precisa de orientación
        let isLandscape = false;
        if (window.screen && window.screen.orientation && window.screen.orientation.type) {
            isLandscape = window.screen.orientation.type.includes('landscape');
        } else if (typeof window.orientation !== 'undefined') {
            isLandscape = (Math.abs(window.orientation) === 90);
        } else {
            isLandscape = window.innerWidth > window.innerHeight;
        }

        const currentlyPortrait = !isLandscape;
        const isTablet = checkIsTablet();
        const tabletSeen = sessionStorage.getItem('sismochoco_tablet_orientation_seen');
        const isPcModalOpen = mobileModal && (mobileModal.style.display === 'flex' || mobileModal.style.opacity === '1');

        if (isLandscape || !currentlyPortrait) {
            // RETIRO AUTOMÁTICO INMEDIATO si el usuario gira la tablet a horizontal
            if (tabletPromptTimer) {
                clearTimeout(tabletPromptTimer);
                tabletPromptTimer = null;
            }
            if (tabletModal.style.display !== 'none') {
                tabletModal.style.opacity = '0';
                setTimeout(() => {
                    tabletModal.style.display = 'none';
                }, 200);
            }
        } else if (isTablet && currentlyPortrait && !tabletSeen && !isPcModalOpen) {
            // Mostrar si está en vertical
            if (!tabletPromptTimer && tabletModal.style.display === 'none') {
                tabletPromptTimer = setTimeout(() => {
                    tabletPromptTimer = null;
                    if (window.innerHeight > window.innerWidth) {
                        tabletModal.style.display = 'flex';
                        requestAnimationFrame(() => {
                            tabletModal.style.opacity = '1';
                        });
                    }
                }, 500);
            }
        }
    }

    // Si ya vio el modal de PC o no aplica, verificar orientación de la tablet
    if (deviceModalSeen && checkIsTablet()) {
        checkTabletOrientation();
    }

    if (continueTabletBtn && tabletModal) {
        continueTabletBtn.addEventListener('click', () => {
            tabletModal.style.opacity = '0';
            setTimeout(() => {
                tabletModal.style.display = 'none';
            }, 250);
            sessionStorage.setItem('sismochoco_tablet_orientation_seen', 'true');
        });
    }

    // Escucha permanente multievento para retiro reactivo inmediato
    window.addEventListener('resize', checkTabletOrientation, { passive: true });
    window.addEventListener('orientationchange', () => {
        setTimeout(checkTabletOrientation, 50);
        setTimeout(checkTabletOrientation, 250);
    }, { passive: true });

    if (window.screen && window.screen.orientation) {
        window.screen.orientation.addEventListener('change', checkTabletOrientation);
    }
    const landscapeMql = window.matchMedia('(orientation: landscape)');
    if (landscapeMql.addEventListener) {
        landscapeMql.addEventListener('change', checkTabletOrientation);
    } else if (landscapeMql.addListener) {
        landscapeMql.addListener(checkTabletOrientation);
    }
})();



// Modal Dinámico de Información
const infoModal = document.getElementById('info-modal');
const closeInfoModal = document.getElementById('close-info-modal');
const infoContent = document.getElementById('info-modal-content');
const infoBtns = document.querySelectorAll('.info-btn');

// Biblioteca de íconos vectoriales SVG (trazo limpio 2px, coherente con el panel lateral)
const MODAL_ICONS = {
    compass: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"></polygon></svg>',
    help: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path><path d="M12 17h.01"></path></svg>',
    reset: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><path d="M3 3v5h5"></path></svg>',
    sismo: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12h3l2-6 4 12 3-8 2 4h6"></path></svg>',
    building: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 21h18"></path><path d="M5 21V7l7-4 7 4v14"></path><path d="M9 21v-6h6v6"></path></svg>',
    map: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"></polygon><line x1="9" x2="9" y1="3" y2="18"></line><line x1="15" x2="15" y1="6" y2="21"></line></svg>',
    move: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="5 9 2 12 5 15"></polyline><polyline points="9 5 12 2 15 5"></polyline><polyline points="15 19 12 22 9 19"></polyline><polyline points="19 9 22 12 19 15"></polyline><line x1="2" x2="22" y1="12" y2="12"></line><line x1="12" x2="12" y1="2" y2="22"></line></svg>',
    orbit: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"></path><path d="M21 3v5h-5"></path></svg>',
    zoom: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path><path d="M11 8v6"></path><path d="M8 11h6"></path></svg>',
    sun: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"></path></svg>',
    keyboard: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="20" height="16" x="2" y="4" rx="2"></rect><path d="M6 8h.001M10 8h.001M14 8h.001M18 8h.001M8 12h.001M12 12h.001M16 12h.001M7 16h10"></path></svg>',
    layers: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>',
    sliders: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="4" x2="4" y1="21" y2="14"></line><line x1="4" x2="4" y1="10" y2="3"></line><line x1="12" x2="12" y1="21" y2="12"></line><line x1="12" x2="12" y1="8" y2="3"></line><line x1="20" x2="20" y1="21" y2="16"></line><line x1="20" x2="20" y1="12" y2="3"></line><line x1="2" x2="6" y1="14" y2="14"></line><line x1="10" x2="14" y1="8" y2="8"></line><line x1="18" x2="22" y1="16" y2="16"></line></svg>',
    book: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path></svg>',
    pulse: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 12h-4l-3 9L9 3l-3 9H2"></path></svg>',
    clock: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>',
    scatter: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7.5" cy="7.5" r="2.5"></circle><circle cx="17" cy="10" r="3"></circle><circle cx="10.5" cy="16.5" r="3.5"></circle></svg>',
    flame: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"></path></svg>',
    hexagon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" x2="12" y1="22.08" y2="12"></line></svg>',
    chart: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3v18h18"></path><path d="m19 9-5 5-4-4-3 3"></path></svg>',
    crosshair: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="22" x2="18" y1="12" y2="12"></line><line x1="6" x2="2" y1="12" y2="12"></line><line x1="12" x2="12" y1="6" y2="2"></line><line x1="12" x2="12" y1="22" y2="18"></line></svg>',
    fault: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 17 5-5 4 4 9-9"></path><path d="M14 7h7v7"></path></svg>',
    clusters: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="2.5"></circle><circle cx="18" cy="7" r="2.5"></circle><circle cx="12" cy="17" r="3"></circle><path d="M8 7.5 10.5 14"></path><path d="M16 8.5 13.5 14"></path></svg>',
    radio: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="2"></circle><path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14"></path></svg>',
    shield: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>',
    subduction: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 8h10l10 10"></path><path d="M2 14h6l8 8"></path><path d="M15 8h7"></path></svg>',
    soil: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12h20"></path><path d="M2 16h20"></path><path d="M2 20h20"></path><path d="M6 8l6-5 6 5"></path></svg>',
    zap: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>',
    depth: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v18"></path><path d="m8 17 4 4 4-4"></path><path d="M4 7h16"></path></svg>',
    road: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19 8 5"></path><path d="M20 19 16 5"></path><path d="M12 6v2M12 11v2M12 16v2"></path></svg>',
    waves: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 6c.6.5 1.2 1 2.5 1C7 7 7 5 9.5 5c2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"></path><path d="M2 12c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"></path><path d="M2 18c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"></path></svg>',
    ship: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 21c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1 .6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"></path><path d="M19.38 20A11.6 11.6 0 0 0 21 14l-9-4-9 4c0 2.9.94 5.34 2.81 7.76"></path><path d="M12 2v8"></path></svg>',
    plane: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"></path></svg>',
    hospital: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 6v4"></path><path d="M14 14h-4"></path><path d="M14 18h-4"></path><path d="M14 8h-4"></path><path d="M18 12h2a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h2"></path><path d="M18 22V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v18"></path></svg>',
    anchor: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="5" r="3"></circle><line x1="12" x2="12" y1="22" y2="8"></line><path d="M5 12H2a10 10 0 0 0 20 0h-3"></path></svg>',
    arrowRight: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"></path><path d="m12 5 7 7-7 7"></path></svg>'
};

const modalData = {
    'guia': `
        <div class="sc-modal-header">
            <div class="sc-modal-icon-badge">${MODAL_ICONS.compass}</div>
            <div class="sc-modal-title-group">
                <h2 class="sc-modal-title">¿Cómo usar SismoChocó?</h2>
                <span class="sc-modal-subtitle">Guía rápida y sencilla para explorar la plataforma</span>
            </div>
        </div>

        <p class="sc-modal-lead">
            <strong>SismoChocó</strong> es una plataforma cartográfica interactiva para analizar dónde y por qué tiembla en el departamento del Chocó, qué municipios concentran mayor nivel de amenaza y qué criterios normativos aplican al diseñar o planificar el territorio.
        </p>

        <div class="sc-modal-callout sc-modal-callout--info">
            <div class="sc-modal-callout-icon">${MODAL_ICONS.help}</div>
            <div class="sc-modal-callout-body">
                <h4 class="sc-modal-callout-title">Botones de ayuda contextual (?) en cada sección</h4>
                <p class="sc-modal-callout-text">
                    Cada filtro, capa o gráfica incorpora un botón <strong>(?)</strong> a su lado. Al pulsarlo se despliega una explicación concisa sobre cómo interpretar la variable y cómo operar el control.
                </p>
            </div>
        </div>

        <div class="sc-modal-callout sc-modal-callout--warn">
            <div class="sc-modal-callout-icon">${MODAL_ICONS.reset}</div>
            <div class="sc-modal-callout-body">
                <h4 class="sc-modal-callout-title">Deshacer cambios y limpiar el mapa</h4>
                <p class="sc-modal-callout-text">
                    Los botones circulares de flecha (<strong>Restablecer</strong>) junto a cada bloque o en la barra superior permiten volver al estado inicial en cualquier momento:
                </p>
                <ul class="sc-modal-list">
                    <li><strong>Visualización Espacial:</strong> apaga puntos, manchas de calor o torres 3D y deja el mapa despejado.</li>
                    <li><strong>Filtros Paramétricos:</strong> restablece el catálogo completo desde 1993 hasta 2026 sin restricciones de magnitud ni profundidad.</li>
                    <li><strong>Capas Avanzadas:</strong> desactiva fallas, sismos en vivo, mapas de amenaza y capas complementarias.</li>
                    <li><strong>Restablecer Todo (barra superior o tecla 0):</strong> reinicia la plataforma y devuelve la cámara al encuadre general del Chocó.</li>
                </ul>
            </div>
        </div>

        <div class="sc-modal-section">
            <h3 class="sc-modal-section-title">${MODAL_ICONS.layers}<span>1. Selección de perfil disciplinar (3 pestañas superiores)</span></h3>
            <div class="sc-modal-stack">
                <div class="sc-modal-feature-card sc-card-sismo">
                    <div class="sc-modal-feature-icon">${MODAL_ICONS.sismo}</div>
                    <div class="sc-modal-feature-body">
                        <strong>Sismo Geología</strong>
                        <span>Exploración del catálogo histórico (1993–2026), profundidad focal, perfil 3D de subducción, fallas geológicas, simulación ShakeMap y telemetría reciente.</span>
                    </div>
                </div>
                <div class="sc-modal-feature-card sc-card-nsr">
                    <div class="sc-modal-feature-icon">${MODAL_ICONS.building}</div>
                    <div class="sc-modal-feature-body">
                        <strong>Diseño Estructural</strong>
                        <span>Consulta municipal de aceleraciones sísmicas, espectro elástico de diseño bajo norma NSR-10 y amplificación geotécnica según tipo de suelo y grupo de uso.</span>
                    </div>
                </div>
                <div class="sc-modal-feature-card sc-card-pot">
                    <div class="sc-modal-feature-icon">${MODAL_ICONS.map}</div>
                    <div class="sc-modal-feature-body">
                        <strong>Gestión Territorial</strong>
                        <span>Diagnóstico municipal orientado a POT / PBOT / EOT, infraestructura crítica (vías, ríos, hospitales y puertos) y generación de ficha técnica imprimible en PDF.</span>
                    </div>
                </div>
            </div>
        </div>

        <div class="sc-modal-section">
            <h3 class="sc-modal-section-title">${MODAL_ICONS.move}<span>2. Navegación sobre el mapa interactivo</span></h3>
            <div class="sc-modal-grid-2">
                <div class="sc-modal-tile">
                    <div class="sc-modal-tile-icon">${MODAL_ICONS.move}</div>
                    <div>
                        <strong>Clic izquierdo y arrastrar</strong>
                        <span>Desplazar el lienzo en cualquier dirección.</span>
                    </div>
                </div>
                <div class="sc-modal-tile">
                    <div class="sc-modal-tile-icon">${MODAL_ICONS.orbit}</div>
                    <div>
                        <strong>Clic derecho y arrastrar</strong>
                        <span>Inclinar y rotar la cámara para inspección 3D.</span>
                    </div>
                </div>
                <div class="sc-modal-tile">
                    <div class="sc-modal-tile-icon">${MODAL_ICONS.zoom}</div>
                    <div>
                        <strong>Rueda del ratón</strong>
                        <span>Acercar o alejar la escala cartográfica.</span>
                    </div>
                </div>
                <div class="sc-modal-tile">
                    <div class="sc-modal-tile-icon">${MODAL_ICONS.sun}</div>
                    <div>
                        <strong>Botón Claro / Oscuro</strong>
                        <span>Alternar contraste del panel para lectura en campo u oficina.</span>
                    </div>
                </div>
            </div>
        </div>

        <div class="sc-modal-callout sc-modal-callout--ok" style="display:block;">
            <h3 class="sc-modal-section-title" style="margin-bottom:8px;">${MODAL_ICONS.keyboard}<span>3. Atajos de teclado (escritorio)</span></h3>
            <div class="sc-modal-grid-2" style="gap:8px; margin-bottom:10px;">
                <div class="sc-modal-kbd-item"><kbd>1</kbd><kbd>2</kbd><kbd>3</kbd><span>Cambiar entre los 3 perfiles</span></div>
                <div class="sc-modal-kbd-item"><kbd>4</kbd><kbd>5</kbd><kbd>6</kbd><span>Puntos, Calor y Torres 3D</span></div>
                <div class="sc-modal-kbd-item"><kbd>7</kbd><span>Benioff</span> · <kbd>8</kbd><span>Live</span> · <kbd>9</kbd><span>Fallas</span></div>
                <div class="sc-modal-kbd-item"><kbd>0</kbd><span>Restablecer</span> · <kbd>C</kbd><span>Panel</span> · <kbd>+</kbd><kbd>-</kbd><span>Zoom</span></div>
            </div>
            <p class="sc-modal-note" style="margin:0;">
                Al mantener <kbd>Shift</kbd> + <kbd>↑ ↓ ← →</kbd> se ajusta la inclinación y rotación tridimensional de la cámara.
            </p>
        </div>

        <div class="sc-modal-actions">
            <button id="btn-entendido-guia" type="button" class="sc-modal-btn-primary">
                <span>Entendido, explorar el mapa</span>
                ${MODAL_ICONS.arrowRight}
            </button>
        </div>
    `,
    'vis_espacial': `
        <div class="sc-modal-header">
            <div class="sc-modal-icon-badge">${MODAL_ICONS.layers}</div>
            <div class="sc-modal-title-group">
                <h2 class="sc-modal-title">Visualización Espacial</h2>
                <span class="sc-modal-subtitle">Modos de representación cartográfica del catálogo sísmico</span>
            </div>
        </div>
        <p class="sc-modal-lead">
            Esta sección permite elegir cómo representar los eventos filtrados sobre el mapa. Los tres modos operan sobre la misma muestra sísmica, cambiando su codificación visual para facilitar distintos tipos de lectura:
        </p>
        <div class="sc-modal-stack">
            <div class="sc-modal-feature-card sc-card-sismo">
                <div class="sc-modal-feature-icon">${MODAL_ICONS.scatter}</div>
                <div class="sc-modal-feature-body">
                    <strong>Eventos Individuales (Scatter 3D)</strong>
                    <span>Dibuja cada temblor como un círculo independiente. Permite inspeccionar fecha, magnitud, profundidad y municipio más cercano al pasar el cursor.</span>
                </div>
            </div>
            <div class="sc-modal-feature-card sc-card-danger">
                <div class="sc-modal-feature-icon">${MODAL_ICONS.flame}</div>
                <div class="sc-modal-feature-body">
                    <strong>Concentración de Energía (Heatmap)</strong>
                    <span>Agrupa los eventos en superficies continuas de densidad para identificar rápidamente los sectores con mayor liberación histórica de energía.</span>
                </div>
            </div>
            <div class="sc-modal-feature-card sc-card-nsr">
                <div class="sc-modal-feature-icon">${MODAL_ICONS.hexagon}</div>
                <div class="sc-modal-feature-body">
                    <strong>Agrupación Espacial (Hexbins 3D)</strong>
                    <span>Divide el departamento en celdas hexagonales y eleva columnas tridimensionales proporcionales a la frecuencia de sismos en cada sector.</span>
                </div>
            </div>
        </div>
        <div class="sc-modal-callout sc-modal-callout--warn">
            <div class="sc-modal-callout-icon">${MODAL_ICONS.reset}</div>
            <div class="sc-modal-callout-body">
                <h4 class="sc-modal-callout-title">Uso y limpieza de la vista</h4>
                <ul class="sc-modal-list">
                    <li><strong>Uso:</strong> seleccione cualquiera de los tres modos para alternar la visualización de manera inmediata.</li>
                    <li><strong>Limpiar:</strong> pulse el botón circular de restablecer junto al título <em>Visualización Espacial</em> para despejar el lienzo.</li>
                </ul>
            </div>
        </div>
    `,
    'filtros_parametricos': `
        <div class="sc-modal-header">
            <div class="sc-modal-icon-badge">${MODAL_ICONS.sliders}</div>
            <div class="sc-modal-title-group">
                <h2 class="sc-modal-title">Filtros Paramétricos</h2>
                <span class="sc-modal-subtitle">Segmentación en tiempo real por magnitud, profundidad y año</span>
            </div>
        </div>
        <p class="sc-modal-lead">
            Dada la densidad del catálogo sísmico histórico, estos tres controles permiten aislar subconjuntos específicos de eventos y recalcular dinámicamente los indicadores:
        </p>
        <ul class="sc-modal-list">
            <li><strong>Magnitud (M):</strong> excluye los temblores menores al umbral definido para enfocar el análisis en eventos moderados o fuertes (por ejemplo, M ≥ 5.0).</li>
            <li><strong>Profundidad máxima:</strong> distingue los sismos corticales superficiales (más cercanos a centros poblados) de los eventos intermedios y profundos de la losa de subducción.</li>
            <li><strong>Año inicial y Reproducir:</strong> delimita el periodo de consulta (1993–2026) o activa una animación cronológica año por año de la evolución sísmica.</li>
        </ul>
        <div class="sc-modal-callout sc-modal-callout--warn">
            <div class="sc-modal-callout-icon">${MODAL_ICONS.reset}</div>
            <div class="sc-modal-callout-body">
                <h4 class="sc-modal-callout-title">Uso y restablecimiento</h4>
                <ul class="sc-modal-list">
                    <li><strong>Uso:</strong> desplace cualquiera de los deslizadores; el mapa, la gráfica Gutenberg-Richter y el contador se actualizan al instante.</li>
                    <li><strong>Restablecer:</strong> pulse el botón circular junto a <em>Filtros Paramétricos</em> para retornar al 100 % del catálogo (M 0.0, 250 km y año 1993).</li>
                </ul>
            </div>
        </div>
    `,
    'capas_avanzadas': `
        <div class="sc-modal-header">
            <div class="sc-modal-icon-badge">${MODAL_ICONS.layers}</div>
            <div class="sc-modal-title-group">
                <h2 class="sc-modal-title">Capas Avanzadas</h2>
                <span class="sc-modal-subtitle">Capas temáticas superpuestas sobre el lienzo cartográfico</span>
            </div>
        </div>
        <p class="sc-modal-lead">
            Cada interruptor activa o desactiva una capa temática adicional sobre el Chocó. Se recomienda habilitar únicamente las capas necesarias para mantener la legibilidad del mapa:
        </p>
        <ul class="sc-modal-list">
            <li><strong>Sismos de Alta Precisión:</strong> excluye eventos con alta incertidumbre instrumental (GAP &gt; 180° y RMS &gt; 1.0 s) y conserva los registros mejor localizados.</li>
            <li><strong>Fallas Geológicas:</strong> traza las 11 principales estructuras tectónicas con su potencial sismogénico (Mmax) y franja de retiro referencial.</li>
            <li><strong>Zonas Anómalas (IA DBSCAN):</strong> identifica agrupamientos densos de eventos cercanos (enjambres o secuencias de réplicas).</li>
            <li><strong>Telemetría FDSN Live:</strong> consulta sismos recientes (M ≥ 3.5 en los últimos 14 días) reportados por redes internacionales.</li>
            <li><strong>Modelo SGC Oficial (OGC):</strong> superpone el mapa oficial de amenaza sísmica del Servicio Geológico Colombiano con lectura interactiva por color y consulta puntual.</li>
        </ul>
        <div class="sc-modal-callout sc-modal-callout--warn">
            <div class="sc-modal-callout-icon">${MODAL_ICONS.reset}</div>
            <div class="sc-modal-callout-body">
                <h4 class="sc-modal-callout-title">Activación y limpieza rápida</h4>
                <ul class="sc-modal-list">
                    <li><strong>Uso:</strong> active cualquier interruptor; cada capa dispone de su propio botón <strong>(?)</strong> con detalles metodológicos.</li>
                    <li><strong>Apagar todo:</strong> utilice el botón circular de restablecer en la cabecera de <em>Capas Avanzadas</em> para desactivar todas las capas simultáneamente.</li>
                </ul>
            </div>
        </div>
    `,
    'rtd': `
        <div class="sc-modal-header">
            <div class="sc-modal-icon-badge">${MODAL_ICONS.book}</div>
            <div class="sc-modal-title-group">
                <h2 class="sc-modal-title">Marco Epistemológico: Research through Design (RtD)</h2>
                <span class="sc-modal-subtitle">Investigación a través del Diseño aplicada a la sismicidad del Chocó</span>
            </div>
        </div>
        <p class="sc-modal-lead">
            Las siglas <strong>RtD</strong> corresponden a <em>Research through Design</em> (Investigación a través del Diseño). Bajo este enfoque, el artefacto interactivo no es un simple contenedor de datos, sino el medio principal para investigar cómo el diseño de información transforma registros sismológicos complejos en conocimiento comprensible y accionable.
        </p>
        <div class="sc-modal-callout sc-modal-callout--info">
            <div class="sc-modal-callout-icon">${MODAL_ICONS.book}</div>
            <div class="sc-modal-callout-body">
                <h4 class="sc-modal-callout-title">Contexto académico e impacto territorial</h4>
                <p class="sc-modal-callout-text">
                    <strong>Programa:</strong> Maestría en Diseño y Creación Interactiva — Universidad de Caldas.<br>
                    <strong>Propósito:</strong> articular en una sola interfaz los requerimientos de geocientíficos, ingenieros estructurales (NSR-10) y planificadores territoriales (POT).
                </p>
            </div>
        </div>
        <div class="sc-modal-callout sc-modal-callout--warn">
            <div class="sc-modal-callout-icon">${MODAL_ICONS.help}</div>
            <div class="sc-modal-callout-body">
                <h4 class="sc-modal-callout-title">Cómo continuar la exploración</h4>
                <p class="sc-modal-callout-text">
                    Cierre esta ventana con el botón superior derecho o haciendo clic fuera del recuadro. Para consultar el recorrido completo de controles y atajos, abra el botón <strong>(?)</strong> ubicado junto a <strong>RtD</strong>.
                </p>
            </div>
        </div>
    `,
    'magnitud': `
        <div class="sc-modal-header">
            <div class="sc-modal-icon-badge">${MODAL_ICONS.pulse}</div>
            <div class="sc-modal-title-group">
                <h2 class="sc-modal-title">Magnitud Sísmica (M)</h2>
                <span class="sc-modal-subtitle">Umbral mínimo de energía liberada en el catálogo</span>
            </div>
        </div>
        <p class="sc-modal-lead">
            Este deslizador oculta los temblores inferiores al valor seleccionado (entre <strong>0.0</strong> y <strong>8.0</strong>), permitiendo aislar los eventos de mayor relevancia energética:
        </p>
        <ul class="sc-modal-legend-list">
            <li class="sc-modal-legend-item">
                <span class="sc-modal-swatch" style="color:#38BDF8; background:#38BDF8;"></span>
                <div><strong>Menor a 4.0:</strong> sismos leves; en muchos casos solo detectados por instrumentación o percibidos suavemente en pisos altos.</div>
            </li>
            <li class="sc-modal-legend-item">
                <span class="sc-modal-swatch" style="color:#F59E0B; background:#F59E0B;"></span>
                <div><strong>Entre 4.0 y 5.9:</strong> sismos percibidos claramente en edificaciones; pueden generar daños leves o moderados en suelos blandos.</div>
            </li>
            <li class="sc-modal-legend-item">
                <span class="sc-modal-swatch" style="color:#EF4444; background:#EF4444;"></span>
                <div><strong>6.0 o superior:</strong> terremotos fuertes con potencial destructivo. Cada incremento unitario en la escala representa un aumento logarítmico sustancial de energía liberada.</div>
            </li>
        </ul>
        <div class="sc-modal-callout sc-modal-callout--warn">
            <div class="sc-modal-callout-icon">${MODAL_ICONS.reset}</div>
            <div class="sc-modal-callout-body">
                <h4 class="sc-modal-callout-title">Uso y restablecimiento</h4>
                <ul class="sc-modal-list">
                    <li><strong>Uso:</strong> desplace el control hacia la derecha (por ejemplo a 5.0) para conservar solo los eventos de mayor magnitud.</li>
                    <li><strong>Restablecer:</strong> regrese la barra a 0.0 o pulse el botón de restablecer en <em>Filtros Paramétricos</em>.</li>
                </ul>
            </div>
        </div>
    `,
    'anio': `
        <div class="sc-modal-header">
            <div class="sc-modal-icon-badge">${MODAL_ICONS.clock}</div>
            <div class="sc-modal-title-group">
                <h2 class="sc-modal-title">Ventana Temporal y Reproducción Cronológica</h2>
                <span class="sc-modal-subtitle">Evolución histórica de la sismicidad (1993–2026)</span>
            </div>
        </div>
        <p class="sc-modal-lead">
            Permite definir desde qué año inicial se despliegan los registros sísmicos del Chocó dentro de la serie <strong>1993–2026</strong>.
        </p>
        <p class="sc-modal-body-p">
            El control <strong>Reproducir</strong> activa un recorrido cronológico automático que avanza año por año para observar la migración espacial de la actividad sísmica y las secuencias de réplicas.
        </p>
        <div class="sc-modal-callout sc-modal-callout--warn">
            <div class="sc-modal-callout-icon">${MODAL_ICONS.reset}</div>
            <div class="sc-modal-callout-body">
                <h4 class="sc-modal-callout-title">Uso y restablecimiento</h4>
                <ul class="sc-modal-list">
                    <li><strong>Uso:</strong> ubique el deslizador en el año deseado o pulse <em>Reproducir</em> (vuelva a pulsarlo para pausar).</li>
                    <li><strong>Restablecer:</strong> devuelva el control a 1993 o pulse el botón de restablecer en <em>Filtros Paramétricos</em>.</li>
                </ul>
            </div>
        </div>
    `,
    'puntos': `
        <div class="sc-modal-header">
            <div class="sc-modal-icon-badge">${MODAL_ICONS.scatter}</div>
            <div class="sc-modal-title-group">
                <h2 class="sc-modal-title">Eventos Individuales (Scatter 3D)</h2>
                <span class="sc-modal-subtitle">Lectura puntual de epicentros, magnitud y profundidad focal</span>
            </div>
        </div>
        <p class="sc-modal-lead">
            Representa cada registro sísmico como un marcador independiente en su ubicación epicentral. Al situar el cursor sobre un punto se muestran su fecha, magnitud, profundidad y municipio cercano; al hacer clic se fija en el inspector lateral.
        </p>
        <ul class="sc-modal-legend-list">
            <li class="sc-modal-legend-item">
                <span class="sc-modal-swatch" style="color:#EA580C; background:#EA580C;"></span>
                <div><strong>Superficial (&lt; 30 km):</strong> tono naranja. Sismos corticales próximos a la superficie.</div>
            </li>
            <li class="sc-modal-legend-item">
                <span class="sc-modal-swatch" style="color:#E11D48; background:#E11D48;"></span>
                <div><strong>Intermedio (30 a 70 km):</strong> tono magenta/rosado. Zona de acoplamiento interplaca.</div>
            </li>
            <li class="sc-modal-legend-item">
                <span class="sc-modal-swatch" style="color:#9333EA; background:#9333EA;"></span>
                <div><strong>Profundo (&gt; 70 km):</strong> tono púrpura. Eventos en la losa subducida de Nazca. El diámetro del círculo escala con la magnitud.</div>
            </li>
        </ul>
        <div class="sc-modal-callout sc-modal-callout--warn">
            <div class="sc-modal-callout-icon">${MODAL_ICONS.reset}</div>
            <div class="sc-modal-callout-body">
                <h4 class="sc-modal-callout-title">Activación y limpieza</h4>
                <p class="sc-modal-callout-text">
                    Pulse <strong>Eventos Individuales</strong> (o tecla <kbd>4</kbd>) para activar esta capa, o use el botón de restablecer en <em>Visualización Espacial</em> para despejar el mapa.
                </p>
            </div>
        </div>
    `,
    'calor': `
        <div class="sc-modal-header">
            <div class="sc-modal-icon-badge">${MODAL_ICONS.flame}</div>
            <div class="sc-modal-title-group">
                <h2 class="sc-modal-title">Concentración de Energía (Mapa de Calor)</h2>
                <span class="sc-modal-subtitle">Densidad espacial ponderada por actividad sísmica</span>
            </div>
        </div>
        <p class="sc-modal-lead">
            Sintetiza la superposición de miles de epicentros mediante una superficie continua de densidad cromática, destacando los focos donde se concentra la mayor recurrencia y energía sísmica.
        </p>
        <p class="sc-modal-body-p">
            Las tonalidades frías o suaves señalan baja densidad acumulada, mientras que los tonos cálidos intensos (naranja y rojo) identifican núcleos de alta concentración sismotectónica.
        </p>
        <div class="sc-modal-callout sc-modal-callout--warn">
            <div class="sc-modal-callout-icon">${MODAL_ICONS.reset}</div>
            <div class="sc-modal-callout-body">
                <h4 class="sc-modal-callout-title">Activación y limpieza</h4>
                <p class="sc-modal-callout-text">
                    Seleccione <strong>Concentración Energía</strong> (o tecla <kbd>5</kbd>). Para retornar a los marcadores puntuales elija <em>Eventos Individuales</em>, o pulse el botón de restablecer para apagar la capa.
                </p>
            </div>
        </div>
    `,
    'hex': `
        <div class="sc-modal-header">
            <div class="sc-modal-icon-badge">${MODAL_ICONS.hexagon}</div>
            <div class="sc-modal-title-group">
                <h2 class="sc-modal-title">Agrupación Espacial (Hexbins 3D)</h2>
                <span class="sc-modal-subtitle">Agregación volumétrica por celdas hexagonales</span>
            </div>
        </div>
        <p class="sc-modal-lead">
            Tesela el territorio en celdas hexagonales regulares y extruye columnas tridimensionales que permiten comparar visualmente la recurrencia sísmica entre subregiones:
        </p>
        <ul class="sc-modal-list">
            <li><strong>Altura de la columna:</strong> proporcional al número de sismos contabilizados dentro de la celda.</li>
            <li><strong>Color de la columna:</strong> refleja la intensidad agregada de los eventos contenidos en ese sector.</li>
        </ul>
        <p class="sc-modal-note">
            Sugerencia: incline la vista con clic derecho y arrastre para apreciar con mayor claridad el relieve tridimensional de las columnas.
        </p>
        <div class="sc-modal-callout sc-modal-callout--warn">
            <div class="sc-modal-callout-icon">${MODAL_ICONS.reset}</div>
            <div class="sc-modal-callout-body">
                <h4 class="sc-modal-callout-title">Activación y limpieza</h4>
                <p class="sc-modal-callout-text">
                    Pulse <strong>Agrupación Espacial</strong> (o tecla <kbd>6</kbd>) para activar las torres 3D y utilice el botón de restablecer junto a <em>Visualización Espacial</em> para retirarlas.
                </p>
            </div>
        </div>
    `,
    'grafico': `
        <div class="sc-modal-header">
            <div class="sc-modal-icon-badge">${MODAL_ICONS.chart}</div>
            <div class="sc-modal-title-group">
                <h2 class="sc-modal-title">Ley de Gutenberg-Richter y Recurrencia</h2>
                <span class="sc-modal-subtitle">Relación frecuencia-magnitud y estimación Aki-Utsu MLE</span>
            </div>
        </div>
        <p class="sc-modal-lead">
            En un régimen sísmico natural se registran numerosos eventos pequeños y pocos terremotos de gran magnitud. Esta gráfica expresa dicha distribución logarítmica sobre la muestra actualmente filtrada:
        </p>
        <div class="sc-modal-callout sc-modal-callout--info">
            <div class="sc-modal-callout-icon">${MODAL_ICONS.chart}</div>
            <div class="sc-modal-callout-body">
                <h4 class="sc-modal-callout-title">Interpretación del parámetro b (b-value)</h4>
                <p class="sc-modal-callout-text">
                    Cuantifica la pendiente entre sismos pequeños y grandes. Un valor cercano a <strong>1.0</strong> indica una proporción tectónica típica; valores menores sugieren una proporción relativa más alta de eventos moderados o fuertes dentro del subconjunto observado.
                </p>
            </div>
        </div>
        <ul class="sc-modal-list">
            <li><strong>Eje horizontal:</strong> magnitud del sismo (M).</li>
            <li><strong>Eje vertical:</strong> número acumulado de eventos con magnitud igual o superior.</li>
            <li><strong>Indicadores inferiores:</strong> periodos de retorno exploratorios (M ≥ 5, 6 y 7) y probabilidad de excedencia a 50 años bajo modelo Poisson.</li>
        </ul>
        <div class="sc-modal-callout sc-modal-callout--warn">
            <div class="sc-modal-callout-icon">${MODAL_ICONS.reset}</div>
            <div class="sc-modal-callout-body">
                <h4 class="sc-modal-callout-title">Filtrado interactivo (Brushing &amp; Linking)</h4>
                <p class="sc-modal-callout-text">
                    Al hacer clic sobre cualquier punto de la curva, el mapa se filtra automáticamente a partir de esa magnitud. Para volver al rango completo, pulse el botón de restablecer en <em>Filtros Paramétricos</em>.
                </p>
            </div>
        </div>
    `,
    'calidad': `
        <div class="sc-modal-header">
            <div class="sc-modal-icon-badge">${MODAL_ICONS.crosshair}</div>
            <div class="sc-modal-title-group">
                <h2 class="sc-modal-title">Sismos de Alta Precisión</h2>
                <span class="sc-modal-subtitle">Control de incertidumbre instrumental (GAP y RMS)</span>
            </div>
        </div>
        <p class="sc-modal-lead">
            Cuando un evento sísmico es captado por pocas estaciones o con cobertura azimutal limitada, su localización epicentral e hipocentral presenta mayor incertidumbre.
        </p>
        <p class="sc-modal-body-p">
            Al activar este filtro se <strong>excluyen los eventos con GAP &gt; 180° o RMS &gt; 1.0 s</strong>, conservando únicamente los sismos con mejor geometría de registro instrumental.
        </p>
        <div class="sc-modal-callout sc-modal-callout--warn">
            <div class="sc-modal-callout-icon">${MODAL_ICONS.reset}</div>
            <div class="sc-modal-callout-body">
                <h4 class="sc-modal-callout-title">Uso y restablecimiento</h4>
                <p class="sc-modal-callout-text">
                    Habilite este interruptor cuando requiera correlación espacial fina con trazas de fallas. Desactívelo o use el botón de restablecer en <em>Capas Avanzadas</em> para recuperar el catálogo completo.
                </p>
            </div>
        </div>
    `,
    'fallas': `
        <div class="sc-modal-header">
            <div class="sc-modal-icon-badge">${MODAL_ICONS.fault}</div>
            <div class="sc-modal-title-group">
                <h2 class="sc-modal-title">Fallas Geológicas Activas</h2>
                <span class="sc-modal-subtitle">Trazas tectónicas referenciales y potencial sismogénico (Mmax)</span>
            </div>
        </div>
        <p class="sc-modal-lead">
            Las fallas geológicas son discontinuidades corticales donde bloques rocosos acumulan y liberan esfuerzo tectónico. La codificación cromática distingue su cinemática principal:
        </p>
        <ul class="sc-modal-legend-list">
            <li class="sc-modal-legend-item">
                <span class="sc-modal-swatch" style="color:#0284C7; background:#0284C7;"></span>
                <div><strong>Subducción (azul):</strong> trinchera oceánica donde la placa de Nazca se sumerge bajo el bloque norandino.</div>
            </li>
            <li class="sc-modal-legend-item">
                <span class="sc-modal-swatch" style="color:#F59E0B; background:#F59E0B;"></span>
                <div><strong>Rumbo / Transcurrente (ámbar):</strong> fracturas con desplazamiento lateral predominante entre bloques (como la Falla de Murindó).</div>
            </li>
            <li class="sc-modal-legend-item">
                <span class="sc-modal-swatch" style="color:#EF4444; background:#EF4444;"></span>
                <div><strong>Inversa / Cabalgamiento (rojo):</strong> estructuras compresivas donde un bloque asciende sobre otro formando serranías.</div>
            </li>
        </ul>
        <div class="sc-modal-callout sc-modal-callout--warn">
            <div class="sc-modal-callout-icon">${MODAL_ICONS.reset}</div>
            <div class="sc-modal-callout-body">
                <h4 class="sc-modal-callout-title">Exploración por estructura</h4>
                <p class="sc-modal-callout-text">
                    Al encender la capa se habilita un selector con 11 sistemas de fallas, filtros por cinemática, ficha técnica y franja de influencia de 5 km a cada lado.
                </p>
            </div>
        </div>
    `,
    'ml': `
        <div class="sc-modal-header">
            <div class="sc-modal-icon-badge">${MODAL_ICONS.clusters}</div>
            <div class="sc-modal-title-group">
                <h2 class="sc-modal-title">Zonas Anómalas (Agrupamiento DBSCAN)</h2>
                <span class="sc-modal-subtitle">Detección no supervisada de enjambres y secuencias sísmicas</span>
            </div>
        </div>
        <p class="sc-modal-lead">
            Las concentraciones reiteradas de eventos en un mismo volumen cortical suelen corresponder a enjambres sísmicos o secuencias de réplicas asociadas a una ruptura principal.
        </p>
        <p class="sc-modal-body-p">
            El algoritmo <strong>DBSCAN</strong> agrupa automáticamente los epicentros de alta densidad espacial y los diferencia mediante paletas cromáticas para distinguir núcleos activos frente a la sismicidad de fondo.
        </p>
        <div class="sc-modal-callout sc-modal-callout--warn">
            <div class="sc-modal-callout-icon">${MODAL_ICONS.reset}</div>
            <div class="sc-modal-callout-body">
                <h4 class="sc-modal-callout-title">Activación y consulta</h4>
                <p class="sc-modal-callout-text">
                    Encienda el interruptor <em>Zonas Anómalas (IA DBSCAN)</em> y sitúe el cursor sobre los agrupamientos coloreados para inspeccionar su identificador y sector.
                </p>
            </div>
        </div>
    `,
    'sgc': `
        <div class="sc-modal-header">
            <div class="sc-modal-icon-badge">${MODAL_ICONS.radio}</div>
            <div class="sc-modal-title-group">
                <h2 class="sc-modal-title">Telemetría FDSN Live</h2>
                <span class="sc-modal-subtitle">Sismos recientes (M ≥ 3.5 · últimos 14 días)</span>
            </div>
        </div>
        <p class="sc-modal-lead">
            Consulta en línea los reportes sísmicos internacionales (<strong>EMSC</strong> y <strong>USGS</strong>) para desplegar los eventos de magnitud ≥ 3.5 ocurridos durante los últimos 14 días en la región del Chocó.
        </p>
        <p class="sc-modal-body-p">
            Los registros se representan como anillos verdes pulsantes sobre el mapa. La etiqueta contigua al interruptor indica si los datos provienen de la red en tiempo real o del respaldo local en modo desconectado.
        </p>
        <div class="sc-modal-callout sc-modal-callout--warn">
            <div class="sc-modal-callout-icon">${MODAL_ICONS.radio}</div>
            <div class="sc-modal-callout-body">
                <h4 class="sc-modal-callout-title">Contraste oficial en Colombia</h4>
                <p class="sc-modal-callout-text">
                    Sitúe el cursor sobre los anillos verdes para revisar hora, magnitud y municipio cercano. Para verificación oficial del Servicio Geológico Colombiano consulte <a href="https://sismo.sgc.gov.co/" target="_blank" rel="noopener noreferrer">sismo.sgc.gov.co</a>.
                </p>
            </div>
        </div>
    `,
    'sgc_wms': `
        <div class="sc-modal-header">
            <div class="sc-modal-icon-badge">${MODAL_ICONS.shield}</div>
            <div class="sc-modal-title-group">
                <h2 class="sc-modal-title">Modelo Oficial de Amenaza Sísmica (SGC)</h2>
                <span class="sc-modal-subtitle">Aceleración máxima esperada en roca (Tr = 475 años · OGC WMS)</span>
            </div>
        </div>
        <p class="sc-modal-lead">
            Superpone directamente la cartografía oficial del <strong>Servicio Geológico Colombiano (SGC)</strong> correspondiente a la aceleración pico efectiva en roca firme para un periodo de retorno de 475 años:
        </p>
        <ul class="sc-modal-legend-list">
            <li class="sc-modal-legend-item">
                <span class="sc-modal-swatch" style="color:#22C55E; background:#22C55E;"></span>
                <div><strong>Verde oscuro a verde claro:</strong> amenaza baja (sacudida esperada leve en roca firme).</div>
            </li>
            <li class="sc-modal-legend-item">
                <span class="sc-modal-swatch" style="color:#FACC15; background:#FACC15;"></span>
                <div><strong>Amarillo pálido:</strong> amenaza intermedia (sacudida moderada; amplificable en suelos blandos).</div>
            </li>
            <li class="sc-modal-legend-item">
                <span class="sc-modal-swatch" style="color:#FB923C; background:#FB923C;"></span>
                <div><strong>Durazno a naranja claro:</strong> amenaza alta (exige diseño sismorresistente estricto).</div>
            </li>
            <li class="sc-modal-legend-item">
                <span class="sc-modal-swatch" style="color:#DC2626; background:#DC2626;"></span>
                <div><strong>Naranja intenso a rojo:</strong> amenaza muy alta (predominante en el litoral Pacífico y sectores críticos del Chocó).</div>
            </li>
        </ul>
        <div class="sc-modal-callout sc-modal-callout--ok">
            <div class="sc-modal-callout-icon">${MODAL_ICONS.crosshair}</div>
            <div class="sc-modal-callout-body">
                <h4 class="sc-modal-callout-title">Lectura interactiva del servicio WMS</h4>
                <ul class="sc-modal-list">
                    <li><strong>Paso del cursor:</strong> estima la banda de amenaza correspondiente al color del píxel consultado.</li>
                    <li><strong>Clic en el mapa o "Consultar cabecera":</strong> recupera el valor puntual oficial emitido por el servidor del SGC.</li>
                </ul>
            </div>
        </div>
    `,
    'benioff': `
        <div class="sc-modal-header">
            <div class="sc-modal-icon-badge">${MODAL_ICONS.subduction}</div>
            <div class="sc-modal-title-group">
                <h2 class="sc-modal-title">Perfil 3D de Subducción (Zona de Benioff)</h2>
                <span class="sc-modal-subtitle">Sección transversal Oeste → Este de la Placa de Nazca</span>
            </div>
        </div>
        <p class="sc-modal-lead">
            Reorienta la cámara en perspectiva oblicua y proyecta la profundidad hipocentral de los eventos para visualizar la inclinación (~32°) de la <strong>Placa de Nazca</strong> hundiéndose bajo el bloque continental:
        </p>
        <ul class="sc-modal-list">
            <li><strong>Frente costero (Bahía Solano, Nuquí):</strong> sismicidad somera de 0 a 30 km próxima a la fosa oceánica.</li>
            <li><strong>Valle del Atrato (Quibdó):</strong> transición intermedia con focos entre 40 y 80 km de profundidad.</li>
            <li><strong>Flanco cordillerano:</strong> sismicidad intraplaca profunda superior a 100 km.</li>
        </ul>
        <div class="sc-modal-callout sc-modal-callout--warn">
            <div class="sc-modal-callout-icon">${MODAL_ICONS.reset}</div>
            <div class="sc-modal-callout-body">
                <h4 class="sc-modal-callout-title">Controles del corte transversal</h4>
                <ul class="sc-modal-list">
                    <li><strong>Uso:</strong> active <em>Activar Perfil Benioff</em> (o tecla <kbd>7</kbd>), elija el sector latitudinal y ajuste la exageración vertical (0.5x a 3.0x).</li>
                    <li><strong>Salir del perfil:</strong> pulse nuevamente el mismo botón o restablezca la vista en <em>Visualización Espacial</em>.</li>
                </ul>
            </div>
        </div>
    `,
    'nsr10_info': `
        <div class="sc-modal-header">
            <div class="sc-modal-icon-badge">${MODAL_ICONS.building}</div>
            <div class="sc-modal-title-group">
                <h2 class="sc-modal-title">Norma Sismorresistente Colombiana (NSR-10)</h2>
                <span class="sc-modal-subtitle">Parámetros oficiales de amenaza y diseño estructural (Título A)</span>
            </div>
        </div>
        <p class="sc-modal-lead">
            El Reglamento <strong>NSR-10</strong> establece los requisitos mínimos obligatorios de diseño y construcción sismorresistente en Colombia para proteger vidas y garantizar el desempeño de edificaciones esenciales:
        </p>
        <ul class="sc-modal-list">
            <li><strong>Municipio (Aa y Av):</strong> define los coeficientes de aceleración y velocidad horizontal pico efectiva asignados a cada cabecera municipal.</li>
            <li><strong>Perfil de suelo (A hasta F):</strong> cuantifica la amplificación de la onda sísmica desde roca competente (A) hasta depósitos blandos o especiales (E y F) mediante los factores Fa y Fv.</li>
            <li><strong>Grupo de uso (I a IV):</strong> aplica el coeficiente de importancia (I), exigiendo mayor margen de seguridad en escuelas (Grupo III) y hospitales o centros de atención de emergencias (Grupo IV).</li>
        </ul>
        <div class="sc-modal-callout sc-modal-callout--warn">
            <div class="sc-modal-callout-icon">${MODAL_ICONS.reset}</div>
            <div class="sc-modal-callout-body">
                <h4 class="sc-modal-callout-title">Consulta municipal</h4>
                <p class="sc-modal-callout-text">
                    Seleccione el municipio, el tipo de suelo y el grupo de uso; la plataforma centra el mapa y recalcula automáticamente el espectro y los coeficientes.
                </p>
            </div>
        </div>
    `,
    'geotecnia_info': `
        <div class="sc-modal-header">
            <div class="sc-modal-icon-badge">${MODAL_ICONS.soil}</div>
            <div class="sc-modal-title-group">
                <h2 class="sc-modal-title">Respuesta Geotécnica y Peligro de Licuación</h2>
                <span class="sc-modal-subtitle">Amplificación de sitio y estabilidad de depósitos aluviales</span>
            </div>
        </div>
        <p class="sc-modal-lead">
            El comportamiento de una estructura depende tanto de su sistema resistente como del perfil geotécnico que la soporta. Numerosas cabeceras del Chocó se asientan sobre depósitos aluviales saturados de los ríos Atrato, San Juan y Baudó o terrazas costeras.
        </p>
        <div class="sc-modal-callout sc-modal-callout--info">
            <div class="sc-modal-callout-icon">${MODAL_ICONS.soil}</div>
            <div class="sc-modal-callout-body">
                <h4 class="sc-modal-callout-title">¿En qué consiste la licuación de suelos?</h4>
                <p class="sc-modal-callout-text">
                    Ante una sacudida sísmica intensa, los suelos arenosos sueltos y saturados de agua incrementan súbitamente su presión de poros y pierden resistencia al corte, provocando asentamientos diferenciales, inclinación de estructuras o pérdida de soporte.
                </p>
            </div>
        </div>
        <div class="sc-modal-callout sc-modal-callout--warn">
            <div class="sc-modal-callout-icon">${MODAL_ICONS.sliders}</div>
            <div class="sc-modal-callout-body">
                <h4 class="sc-modal-callout-title">Evaluación comparativa</h4>
                <p class="sc-modal-callout-text">
                    Cambie el <em>Perfil de Suelo</em> entre A (roca) y E/F (suelos blandos o especiales) para observar la variación en la amplificación sísmica y las recomendaciones geotécnicas preliminares bajo NSR-10 Título H.
                </p>
            </div>
        </div>
    `,
    'pot_info': `
        <div class="sc-modal-header">
            <div class="sc-modal-icon-badge">${MODAL_ICONS.map}</div>
            <div class="sc-modal-title-group">
                <h2 class="sc-modal-title">Diagnóstico Municipal para Ordenamiento Territorial (POT)</h2>
                <span class="sc-modal-subtitle">Insumo orientador para POT / PBOT / EOT (Decreto 1077 de 2015)</span>
            </div>
        </div>
        <p class="sc-modal-lead">
            El <strong>Plan de Ordenamiento Territorial (POT)</strong> orienta la ocupación segura del suelo municipal, delimitando áreas con condición de amenaza o riesgo sísmico y priorizando la resiliencia de las líneas vitales:
        </p>
        <ul class="sc-modal-list">
            <li><strong>Filtro de prioridad territorial:</strong> organiza los municipios por categoría institucional, exposición costera al Pacífico o aislamiento modal fluvial/selvático.</li>
            <li><strong>Exposición histórica y tectónica:</strong> cuantifica sismos instrumentales cercanos, fallas cartografiadas e infraestructura crítica en el entorno del municipio.</li>
            <li><strong>Ficha Técnica en PDF:</strong> genera un documento estructurado imprimible como insumo referencial para mesas técnicas de gestión del riesgo.</li>
        </ul>
        <div class="sc-modal-callout sc-modal-callout--warn">
            <div class="sc-modal-callout-icon">${MODAL_ICONS.map}</div>
            <div class="sc-modal-callout-body">
                <h4 class="sc-modal-callout-title">Generación de ficha</h4>
                <p class="sc-modal-callout-text">
                    Seleccione un municipio en el listado, revise sus indicadores territoriales y pulse <em>Ficha Técnica Territorial (PDF / Imprimir)</em> para abrir el reporte imprimible.
                </p>
            </div>
        </div>
    `,
    'espectro_info': `
        <div class="sc-modal-header">
            <div class="sc-modal-icon-badge">${MODAL_ICONS.chart}</div>
            <div class="sc-modal-title-group">
                <h2 class="sc-modal-title">Espectro Elástico de Aceleraciones (NSR-10)</h2>
                <span class="sc-modal-subtitle">Demanda sísmica Sa(T) según periodo fundamental de la edificación</span>
            </div>
        </div>
        <p class="sc-modal-lead">
            La respuesta sísmica depende del periodo natural de vibración de cada edificación: estructuras bajas y rígidas responden en periodos cortos (izquierda de la curva), mientras que edificaciones altas y flexibles vibran en periodos más largos (derecha):
        </p>
        <ul class="sc-modal-legend-list">
            <li class="sc-modal-legend-item">
                <span class="sc-modal-swatch" style="color:#94A3B8; background:#94A3B8;"></span>
                <div><strong>Curva punteada (Roca Base — Perfil B):</strong> aceleración de referencia sin amplificación por suelo blando.</div>
            </li>
            <li class="sc-modal-legend-item">
                <span class="sc-modal-swatch" style="color:#10B981; background:#10B981;"></span>
                <div><strong>Curva continua rellena (Diseño):</strong> aceleración espectral resultante al combinar Aa, Av, factores de sitio (Fa, Fv) y coeficiente de importancia (I).</div>
            </li>
        </ul>
        <div class="sc-modal-callout sc-modal-callout--warn">
            <div class="sc-modal-callout-icon">${MODAL_ICONS.sliders}</div>
            <div class="sc-modal-callout-body">
                <h4 class="sc-modal-callout-title">Exportación y sensibilidad</h4>
                <p class="sc-modal-callout-text">
                    Compare los perfiles A y E para observar el desplazamiento de la meseta espectral. El botón <em>Exportar CSV</em> descarga los pares (T, Sa) para importación en software de análisis estructural.
                </p>
            </div>
        </div>
    `,
    'shakemap_info': `
        <div class="sc-modal-header">
            <div class="sc-modal-icon-badge">${MODAL_ICONS.zap}</div>
            <div class="sc-modal-title-group">
                <h2 class="sc-modal-title">Simulador de Escenarios Sísmicos (ShakeMap)</h2>
                <span class="sc-modal-subtitle">Propagación de ondas P y S e intensidad instrumental estimada</span>
            </div>
        </div>
        <p class="sc-modal-lead">
            Permite modelar de manera exploratoria la atenuación espacial de la sacudida y la propagación de frentes de onda para cinco escenarios históricos o determinísticos en el Chocó:
        </p>
        <ul class="sc-modal-legend-list">
            <li class="sc-modal-legend-item">
                <span class="sc-modal-swatch" style="color:#38BDF8; background:#38BDF8;"></span>
                <div><strong>Frente azul (Onda P):</strong> onda primaria compresiva de mayor velocidad que arriba primero a las cabeceras urbanas.</div>
            </li>
            <li class="sc-modal-legend-item">
                <span class="sc-modal-swatch" style="color:#EF4444; background:#EF4444;"></span>
                <div><strong>Frente rojo (Onda S):</strong> onda secundaria de corte que transporta la mayor energía destructiva segundos después.</div>
            </li>
        </ul>
        <div class="sc-modal-section" style="padding:11px 14px;">
            <p class="sc-modal-note" style="margin:0;">
                <strong>Escenarios incluidos:</strong> Referencia 2026 (Mw 7.4), Falla Murindó 1992 (Mw 7.3), Subducción Pacífico (Mw 8.2), Falla Atrato – Quibdó (Mw 6.8) y Falla Bahía Solano 1970 (Mw 7.0).
            </p>
        </div>
        <div class="sc-modal-callout sc-modal-callout--warn">
            <div class="sc-modal-callout-icon">${MODAL_ICONS.reset}</div>
            <div class="sc-modal-callout-body">
                <h4 class="sc-modal-callout-title">Ejecución y limpieza</h4>
                <ul class="sc-modal-list">
                    <li><strong>Simular:</strong> seleccione un escenario y pulse <em>Simular Ruptura Sísmica</em> para observar el avance de las ondas y los tiempos de arribo estimados a Quibdó e Istmina.</li>
                    <li><strong>Limpiar:</strong> utilice el botón <em>Limpiar</em> contiguo para retirar la simulación del lienzo.</li>
                </ul>
            </div>
        </div>
    `,
    'profundidad': `
        <div class="sc-modal-header">
            <div class="sc-modal-icon-badge">${MODAL_ICONS.depth}</div>
            <div class="sc-modal-title-group">
                <h2 class="sc-modal-title">Profundidad Hipocentral Máxima</h2>
                <span class="sc-modal-subtitle">Clasificación vertical del foco sísmico (10 km a 250 km)</span>
            </div>
        </div>
        <p class="sc-modal-lead">
            La profundidad del foco condiciona la atenuación de las ondas sísmicas antes de alcanzar la superficie. A igual magnitud, un evento somero genera sacudidas locales más severas:
        </p>
        <ul class="sc-modal-legend-list">
            <li class="sc-modal-legend-item">
                <span class="sc-modal-swatch" style="color:#EA580C; background:#EA580C;"></span>
                <div><strong>Menos de 30 km (Superficiales / Corticales):</strong> asociados a fallas locales; concentran mayor intensidad epicentral.</div>
            </li>
            <li class="sc-modal-legend-item">
                <span class="sc-modal-swatch" style="color:#E11D48; background:#E11D48;"></span>
                <div><strong>30 a 70 km (Intermedios):</strong> originados en la interfaz de convergencia entre las placas de Nazca y Sudamérica.</div>
            </li>
            <li class="sc-modal-legend-item">
                <span class="sc-modal-swatch" style="color:#9333EA; background:#9333EA;"></span>
                <div><strong>Más de 70 km (Profundos):</strong> sismicidad intraplaca en la losa subducida; se perciben en radios amplios con menor concentración puntual.</div>
            </li>
        </ul>
        <div class="sc-modal-callout sc-modal-callout--warn">
            <div class="sc-modal-callout-icon">${MODAL_ICONS.reset}</div>
            <div class="sc-modal-callout-body">
                <h4 class="sc-modal-callout-title">Uso y restablecimiento</h4>
                <ul class="sc-modal-list">
                    <li><strong>Uso:</strong> desplace la barra hasta 30 km para aislar exclusivamente la sismicidad cortical superficial.</li>
                    <li><strong>Restablecer:</strong> regrese el control a 250 km o pulse el botón de restablecer en <em>Filtros Paramétricos</em>.</li>
                </ul>
            </div>
        </div>
    `,
    'infra_info': `
        <div class="sc-modal-header">
            <div class="sc-modal-icon-badge">${MODAL_ICONS.map}</div>
            <div class="sc-modal-title-group">
                <h2 class="sc-modal-title">Infraestructura Crítica y Líneas Vitales</h2>
                <span class="sc-modal-subtitle">Red de conectividad multimodal y nodos esenciales de atención</span>
            </div>
        </div>
        <p class="sc-modal-lead">
            Despliega sobre el mapa las redes viales, fluviales, marítimas, aéreas y hospitalarias determinantes para la respuesta post-sismo y la mitigación del aislamiento territorial:
        </p>
        <ul class="sc-modal-legend-list">
            <li class="sc-modal-legend-item">
                <span class="sc-modal-legend-svg" style="--swatch-color:#F59E0B;">${MODAL_ICONS.road}</span>
                <div><strong>Red Vial Primaria:</strong> corredores carreteros expuestos a deslizamientos cosísmicos.</div>
            </li>
            <li class="sc-modal-legend-item">
                <span class="sc-modal-legend-svg" style="--swatch-color:#0284C7;">${MODAL_ICONS.waves}</span>
                <div><strong>Corredor Fluvial:</strong> ejes navegables (Atrato, San Juan, Baudó) vitales para abastecimiento y evacuación.</div>
            </li>
            <li class="sc-modal-legend-item">
                <span class="sc-modal-legend-svg" style="--swatch-color:#0D9488;">${MODAL_ICONS.ship}</span>
                <div><strong>Ruta Marítima:</strong> enlace costero del Pacífico entre cabeceras sin conexión terrestre.</div>
            </li>
            <li class="sc-modal-legend-item">
                <span class="sc-modal-legend-svg" style="--swatch-color:#2563EB;">${MODAL_ICONS.plane}</span>
                <div><strong>Terminal Aéreo:</strong> aeropuertos y pistas regionales para puentes aéreos de emergencia.</div>
            </li>
            <li class="sc-modal-legend-item">
                <span class="sc-modal-legend-svg" style="--swatch-color:#E11D48;">${MODAL_ICONS.hospital}</span>
                <div><strong>Centro Asistencial:</strong> hospitales y puestos de salud catalogados como edificaciones indispensables (NSR-10 Grupo IV).</div>
            </li>
            <li class="sc-modal-legend-item">
                <span class="sc-modal-legend-svg" style="--swatch-color:#9333EA;">${MODAL_ICONS.anchor}</span>
                <div><strong>Muelle / Puerto:</strong> nodos portuarios DIMAR para logística marítima y fluvial.</div>
            </li>
        </ul>
        <div class="sc-modal-callout sc-modal-callout--warn">
            <div class="sc-modal-callout-icon">${MODAL_ICONS.crosshair}</div>
            <div class="sc-modal-callout-body">
                <h4 class="sc-modal-callout-title">Inspección de elementos</h4>
                <p class="sc-modal-callout-text">
                    Encienda el interruptor y sitúe el cursor sobre cualquier trazo o ícono para ver el nombre y clasificación de la infraestructura. Apáguelo para despejar el mapa.
                </p>
            </div>
        </div>
    `
};

const INFO_MODAL_ACCENTS = {
    nsr10_info: '#047857',
    espectro_info: '#047857',
    geotecnia_info: '#047857',
    hex: '#047857',
    sgc: '#047857',
    pot_info: '#B45309',
    infra_info: '#B45309',
    fallas: '#B45309',
    calor: '#E11D48',
    shakemap_info: '#E11D48',
    ml: '#9333EA',
    profundidad: '#9333EA'
};

const INFO_MODAL_PROFILE_CLASSES = {
    nsr10_info: 'modal-ctx-nsr',
    espectro_info: 'modal-ctx-nsr',
    geotecnia_info: 'modal-ctx-nsr',
    hex: 'modal-ctx-nsr',
    sgc: 'modal-ctx-nsr',
    pot_info: 'modal-ctx-pot',
    infra_info: 'modal-ctx-pot',
    fallas: 'modal-ctx-pot',
    calor: 'modal-ctx-danger',
    shakemap_info: 'modal-ctx-danger',
    ml: 'modal-ctx-purple',
    profundidad: 'modal-ctx-purple'
};

if (infoModal && closeInfoModal) {
    const infoModalDialog = infoModal.querySelector(':scope > div');
    const applyModalContextBorder = (key) => {
        if (!infoModalDialog) return;
        const accent = INFO_MODAL_ACCENTS[key] || '#0066CC';
        infoModalDialog.style.borderTop = `4px solid ${accent}`;
        infoModal.classList.remove('modal-ctx-sismo', 'modal-ctx-nsr', 'modal-ctx-pot', 'modal-ctx-danger', 'modal-ctx-purple');
        infoModal.classList.add(INFO_MODAL_PROFILE_CLASSES[key] || 'modal-ctx-sismo');
    };

    let _lastInfoTrigger = null;
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('.info-btn');
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        const key = btn.getAttribute('data-info');
        if (modalData[key] && infoContent) {
            _lastInfoTrigger = btn;
            applyModalContextBorder(key);
            infoContent.innerHTML = modalData[key];
            infoModal.style.display = 'flex';
            setTimeout(() => {
                infoModal.style.opacity = '1';
                closeInfoModal.focus();
            }, 10);
        }
    });

    const closeModal = () => {
        infoModal.style.opacity = '0';
        setTimeout(() => {
            infoModal.style.display = 'none';
            if (_lastInfoTrigger && typeof _lastInfoTrigger.focus === 'function') {
                _lastInfoTrigger.focus();
                _lastInfoTrigger = null;
            }
        }, 300);
    };

    closeInfoModal.addEventListener('click', closeModal);
    infoModal.addEventListener('click', (e) => {
        if (e.target === infoModal) closeModal();
    });

    // Delegación para botón de cierre dentro de la Guía de Uso
    document.addEventListener('click', (e) => {
        if (e.target && e.target.closest('#btn-entendido-guia')) {
            closeModal();
        }
    });

    // Auto-apertura de la Guía de Uso SIEMPRE al cargar la plataforma (Requisito de Usabilidad)
    const triggerGuiaAutoOpen = () => {
        if (infoModal && infoContent && modalData['guia']) {
            // Solo auto-abrir la primera vez por sesión para respetar preferencia en recargas y modo offline
            if (sessionStorage.getItem('sismochoco_guia_seen')) return;
            sessionStorage.setItem('sismochoco_guia_seen', '1');
            applyModalContextBorder('guia');
            infoContent.innerHTML = modalData['guia'];
            infoModal.style.display = 'flex';
            requestAnimationFrame(() => {
                infoModal.style.opacity = '1';
            });
        }
    };

    if (document.readyState === 'complete') {
        triggerGuiaAutoOpen();
    } else {
        window.addEventListener('load', triggerGuiaAutoOpen);
    }
}

// ============================================================================
// MOTOR MULTIDISCIPLINAR: NSR-10, POT, BENIOFF Y SIMULADOR DE RIESGO
// ============================================================================

const NSR_FACTORS = {
    'A': { Fa: 0.8, Fv: 0.8 },
    'B': { Fa: 1.0, Fv: 1.0 },
    'C': { Fa: 1.1, Fv: 1.4 },
    'D': { Fa: 1.2, Fv: 1.7 },
    'E': { Fa: 1.2, Fv: 2.4 },
    'F': { Fa: 1.5, Fv: 2.8 }
};

function haversineDistanceKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function savePreferences() {
    // La plataforma restablece sus controles a cero en cada carga; no persiste estado entre sesiones.
    try {
        localStorage.removeItem('sismochoco_prefs_v1');
    } catch (_) {}
}

function restoreSavedPreferences() {
    try {
        localStorage.removeItem('sismochoco_prefs_v1');
    } catch (_) {}
    resetBasemapAndThemeToDefault();
}

function matchesPotPriorityFilter(m, filterMode = 'all') {
    if (!m) return false;
    if (filterMode === 'choco_cat6') {
        return m.departamento === 'Chocó' && String(m.categoria_ley617 || '').includes('Categoría 6');
    }
    if (filterMode === 'choco_aislados') {
        return m.departamento === 'Chocó' && m.aislamiento_modal === true;
    }
    if (filterMode === 'choco_costero') {
        return m.departamento === 'Chocó' && m.costero_pacifico === true;
    }
    if (filterMode === 'choco_all' || filterMode === 'choco') {
        return m.departamento === 'Chocó';
    }
    return true;
}

function resolvePotSelectedIdx(matchingItems, prevVal = '', filterMode = 'all') {
    if (!Array.isArray(matchingItems) || matchingItems.length === 0) return null;
    if (prevVal !== undefined && prevVal !== null && prevVal !== '') {
        const prevStr = String(prevVal);
        if (matchingItems.some(item => String(item.idx) === prevStr)) {
            return prevStr;
        }
    }
    if (filterMode === 'all' || filterMode === 'choco_all' || filterMode === 'choco') {
        const quibdo = matchingItems.find(item =>
            item.m && (item.m.id === 'quibdo' || String(item.m.nombre || '').toLowerCase().includes('quibdó'))
        );
        if (quibdo) return String(quibdo.idx);
    }
    return String(matchingItems[0].idx);
}

const DEPTS_CATALOG = [
    { name: 'Chocó', label: 'Chocó' },
    { name: 'Risaralda', label: 'Risaralda' },
    { name: 'Caldas', label: 'Caldas' },
    { name: 'Valle del Cauca', label: 'Valle del Cauca' }
];

function populateNsrSelect(searchQuery = '') {
    const nsrSelect = document.getElementById('nsr-municipio-select');
    if (!nsrSelect || !municipiosData || municipiosData.length === 0) return;
    const normQuery = normalizeSearchText(searchQuery);
    const prevVal = nsrSelect.value;

    const matching = municipiosData
        .map((m, idx) => ({ m, idx }))
        .filter(({ m }) => !normQuery || normalizeSearchText(`${m.nombre} ${m.departamento || ''}`).includes(normQuery));
    const targetVal = resolvePotSelectedIdx(matching, prevVal, 'all');

    nsrSelect.innerHTML = '';
    DEPTS_CATALOG.forEach(d => {
        const group = document.createElement('optgroup');
        let countInGroup = 0;
        matching.forEach(({ m, idx }) => {
            if ((m.departamento || 'Chocó') === d.name) {
                const opt = document.createElement('option');
                opt.value = String(idx);
                opt.textContent = `${m.nombre} (Aa = ${m.aa.toFixed(2)})`;
                if (targetVal !== null && String(idx) === targetVal) {
                    opt.selected = true;
                }
                group.appendChild(opt);
                countInGroup++;
            }
        });
        if (countInGroup > 0) {
            group.label = `${d.label} (${countInGroup})`;
            nsrSelect.appendChild(group);
        }
    });

    if (targetVal !== null) nsrSelect.value = targetVal;
    if (nsrSelect.options.length > 0 && nsrSelect.selectedIndex < 0) nsrSelect.selectedIndex = 0;
}

function populatePotSelect(filterMode = 'all', searchQuery = null) {
    const potSelect = document.getElementById('pot-municipio-select');
    if (!potSelect) return;
    if (!municipiosData || municipiosData.length === 0) {
        ensureMunicipiosData();
        return;
    }

    const searchInput = document.getElementById('pot-municipio-search');
    const rawQuery = searchQuery !== null ? searchQuery : (searchInput ? searchInput.value : '');
    const normQuery = normalizeSearchText(rawQuery);

    const prevVal = potSelect.value;
    const matchingItems = municipiosData
        .map((m, idx) => ({ m, idx }))
        .filter(({ m }) => (
            matchesPotPriorityFilter(m, filterMode) &&
            (!normQuery || normalizeSearchText(`${m.nombre} ${m.departamento || ''}`).includes(normQuery))
        ));
    const targetVal = resolvePotSelectedIdx(matchingItems, prevVal, filterMode);

    potSelect.innerHTML = '';
    DEPTS_CATALOG.forEach(d => {
        const group = document.createElement('optgroup');
        let countInGroup = 0;
        matchingItems.forEach(({ m, idx }) => {
            if ((m.departamento || 'Chocó') === d.name) {
                const opt = document.createElement('option');
                opt.value = String(idx);
                const isoTag = m.aislamiento_modal ? ' [Aislado]' : '';
                opt.textContent = `${m.nombre} (${(m.poblacion || 0).toLocaleString()} hab.)${isoTag}`;
                if (targetVal !== null && String(idx) === targetVal) {
                    opt.selected = true;
                }
                group.appendChild(opt);
                countInGroup++;
            }
        });
        if (countInGroup > 0) {
            group.label = `${d.label} (${countInGroup})`;
            potSelect.appendChild(group);
        }
    });

    if (targetVal !== null) {
        potSelect.value = targetVal;
    }
    if (potSelect.options.length > 0 && potSelect.selectedIndex < 0) {
        potSelect.selectedIndex = 0;
    }
    renderPotTabularSummary(filterMode);
}

function renderPotTabularSummary(filterMode = 'all') {
    const container = document.getElementById('pot-tabular-summary');
    if (!container || !municipiosData) return;
    const potSearch = document.getElementById('pot-municipio-search');
    const normQuery = normalizeSearchText(potSearch ? potSearch.value : '');
    const rows = municipiosData
        .map((m, idx) => ({ m, idx }))
        .filter(({ m }) => (
            (filterMode === 'all'
                ? m.departamento === 'Chocó'
                : matchesPotPriorityFilter(m, filterMode)) &&
            (!normQuery || normalizeSearchText(`${m.nombre} ${m.departamento || ''}`).includes(normQuery))
        ));

    let html = `<div style="font-weight:700; color:var(--accent-ui); margin-bottom:6px;">Resumen Municipal Chocó (${rows.length} municipios)</div>`;
    html += `<table class="ficha-pot-table" style="font-size:var(--fs-2xs);"><thead><tr><th>Municipio</th><th>Aa</th><th>Cat. Ley 617</th><th>Acceso</th></tr></thead><tbody>`;
    rows.forEach(({ m, idx }) => {
        const catShort = m.id === 'quibdo' ? 'Cat. 4' : (String(m.categoria_ley617 || '').includes('Categoría 6') ? 'Cat. 6' : 'Ref.');
        const accShort = m.costero_pacifico ? 'Marítimo/Aéreo' : (m.aislamiento_modal ? 'Fluvial' : 'Terrestre');
        html += `<tr data-mun-idx="${idx}" class="pot-summary-row" tabindex="0" role="button" aria-label="Seleccionar municipio ${escapeHtml(m.nombre)}" style="cursor:pointer;"><td>${escapeHtml(m.nombre)}</td><td class="tabular-num">${m.aa.toFixed(2)}g</td><td>${catShort}</td><td>${accShort}</td></tr>`;
    });
    html += `</tbody></table>`;
    container.innerHTML = html;
    container.querySelectorAll('.pot-summary-row').forEach(tr => {
        const selectRow = () => {
            const potSel = document.getElementById('pot-municipio-select');
            if (potSel) {
                potSel.value = tr.getAttribute('data-mun-idx');
                potSel.dispatchEvent(new Event('change'));
            }
        };
        tr.addEventListener('click', selectRow);
        tr.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                selectRow();
            }
        });
    });
}

function initMunicipiosUI() {
    if (!municipiosData || municipiosData.length === 0) return;

    const nsrSearch = document.getElementById('nsr-municipio-search');
    populateNsrSelect(nsrSearch ? nsrSearch.value : '');

    const priorityFilter = document.getElementById('pot-priority-filter');
    const potSearch = document.getElementById('pot-municipio-search');
    populatePotSelect(priorityFilter ? priorityFilter.value : 'all', potSearch ? potSearch.value : '');

    updateNSR10Metrics();
    updatePOTMetrics();
}

// ============================================================================
// CÁLCULO NORMATIVO NSR-10: FACTORES DE SITIO, ESPECTRO ELÁSTICO E IMPORTANCIA
// ============================================================================

function getFactoresSitioNSR10(Aa, Av, suelo) {
    const aaPoints = [0.1, 0.2, 0.3, 0.4, 0.5];
    const avPoints = [0.1, 0.2, 0.3, 0.4, 0.5];
    
    // Tabla A.2.4-3 Fa (NSR-10)
    const faTable = {
        'A': [0.8, 0.8, 0.8, 0.8, 0.8],
        'B': [1.0, 1.0, 1.0, 1.0, 1.0],
        'C': [1.2, 1.2, 1.1, 1.0, 1.0],
        'D': [1.6, 1.4, 1.2, 1.1, 1.0],
        'E': [2.5, 1.7, 1.2, 0.9, 0.9],
        'F': [2.8, 2.0, 1.5, 1.2, 1.1]
    };

    // Tabla A.2.4-4 Fv (NSR-10)
    const fvTable = {
        'A': [0.8, 0.8, 0.8, 0.8, 0.8],
        'B': [1.0, 1.0, 1.0, 1.0, 1.0],
        'C': [1.7, 1.6, 1.5, 1.4, 1.3],
        'D': [2.4, 2.0, 1.8, 1.6, 1.5],
        'E': [3.5, 3.2, 2.8, 2.4, 2.4],
        'F': [4.0, 3.6, 3.2, 2.8, 2.6]
    };

    function interpolate(val, points, vals) {
        if (val <= points[0]) return vals[0];
        if (val >= points[points.length - 1]) return vals[vals.length - 1];
        for (let i = 0; i < points.length - 1; i++) {
            if (val >= points[i] && val <= points[i + 1]) {
                const frac = (val - points[i]) / (points[i + 1] - points[i]);
                return vals[i] + frac * (vals[i + 1] - vals[i]);
            }
        }
        return vals[0];
    }

    const s = (suelo || 'E').toUpperCase();
    const faRow = faTable[s] || faTable['E'];
    const fvRow = fvTable[s] || fvTable['E'];

    const Fa = parseFloat(interpolate(Aa, aaPoints, faRow).toFixed(2));
    const Fv = parseFloat(interpolate(Av, avPoints, fvRow).toFixed(2));

    return { Fa, Fv };
}

function calcularEspectroNSR10(Aa, Av, suelo, I = 1.0, periodsOverride = null) {
    const { Fa, Fv } = getFactoresSitioNSR10(Aa, Av, suelo);

    // Ecuaciones Oficiales NSR-10 Título A.2.6
    const T0 = 0.1 * (Av * Fv) / (Aa * Fa);
    const Tc = 0.48 * (Av * Fv) / (Aa * Fa);
    const TL = 2.4 * Fv;
    const SaMax = 2.5 * Aa * Fa * I;

    const evalSa = (roundT) => {
        let Sa = 0;
        if (roundT < T0) {
            Sa = Aa * Fa * I * (1 + 1.5 * (roundT / T0));
        } else if (roundT >= T0 && roundT <= Tc) {
            Sa = 2.5 * Aa * Fa * I;
        } else if (roundT > Tc && roundT <= TL) {
            Sa = (1.2 * Av * Fv * I) / roundT;
        } else {
            Sa = (1.2 * Av * Fv * TL * I) / (roundT * roundT);
        }
        return parseFloat(Sa.toFixed(3));
    };

    const periods = [];
    const accelerations = [];

    if (Array.isArray(periodsOverride) && periodsOverride.length > 0) {
        for (let i = 0; i < periodsOverride.length; i++) {
            const roundT = parseFloat(periodsOverride[i]);
            periods.push(roundT);
            accelerations.push(evalSa(roundT));
        }
    } else {
        const tMax = Math.max(4.0, Math.min(10.0, Math.ceil((TL + 0.5) * 10) / 10));
        const step = tMax > 4.5 ? 0.08 : 0.04;
        for (let t = 0; t <= tMax + 0.001; t += step) {
            const roundT = parseFloat(t.toFixed(2));
            periods.push(roundT);
            accelerations.push(evalSa(roundT));
        }
    }

    return { Fa, Fv, T0, Tc, TL, SaMax, periods, accelerations };
}

function updateNSREspectroChart() {
    const sel = document.getElementById('nsr-municipio-select');
    const sueloSel = document.getElementById('nsr-suelo-select');
    const usoSel = document.getElementById('nsr-grupo-uso-select');
    if (!sel || !municipiosData || municipiosData.length === 0) return;

    const idx = parseInt(sel.value) || 0;
    const m = municipiosData[idx] || municipiosData[0];
    const suelo = sueloSel ? sueloSel.value : (m.suelo_defecto || 'E');
    const I = usoSel ? parseFloat(usoSel.value) : 1.0;

    // Curva de Sitio Real con Suelo e Importancia
    const spec = calcularEspectroNSR10(m.aa, m.av, suelo, I);
    // Curva de Referencia Base en Roca (Perfil B, I = 1.00) evaluada en idénticos períodos T
    const specRoca = calcularEspectroNSR10(m.aa, m.av, 'B', 1.0, spec.periods);

    const elT0 = document.getElementById('nsr-t0-val');
    const elTc = document.getElementById('nsr-tc-val');
    const elTl = document.getElementById('nsr-tl-val');
    const elSamax = document.getElementById('nsr-samax-val');
    const elAmpComp = document.getElementById('nsr-amplificacion-comparativa');

    if (elT0) elT0.innerText = `${spec.T0.toFixed(2)} s`;
    if (elTc) elTc.innerText = `${spec.Tc.toFixed(2)} s`;
    if (elTl) elTl.innerText = `${spec.TL.toFixed(2)} s`;
    if (elSamax) elSamax.innerText = `${spec.SaMax.toFixed(2)} g`;

    if (elAmpComp) {
        const diffPct = Math.round(((spec.SaMax - specRoca.SaMax) / specRoca.SaMax) * 100);
        if (diffPct > 0) {
            elAmpComp.innerText = `+${diffPct}% vs Roca`;
            elAmpComp.style.color = '#38bdf8';
            elAmpComp.style.background = 'rgba(56, 189, 248, 0.15)';
            elAmpComp.style.borderColor = 'rgba(56, 189, 248, 0.3)';
        } else if (diffPct < 0) {
            elAmpComp.innerText = `${diffPct}% vs Roca`;
            elAmpComp.style.color = '#32D74B';
            elAmpComp.style.background = 'rgba(50, 215, 75, 0.15)';
            elAmpComp.style.borderColor = 'rgba(50, 215, 75, 0.3)';
        } else {
            elAmpComp.innerText = `Ref. Roca Base (I=1)`;
            elAmpComp.style.color = '#94a3b8';
            elAmpComp.style.background = 'rgba(148, 163, 184, 0.15)';
            elAmpComp.style.borderColor = 'rgba(148, 163, 184, 0.3)';
        }
    }

    const canvas = document.getElementById('nsr-espectro-chart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    const datasets = [
        {
            label: `Roca Base (Perfil B, I=1.00)`,
            data: specRoca.accelerations,
            borderColor: '#64748b',
            backgroundColor: 'transparent',
            borderWidth: 1.5,
            borderDash: [5, 4],
            fill: false,
            tension: 0.15,
            pointRadius: 0,
            pointHoverRadius: 3
        },
        {
            label: `Diseño Sitio: Suelo ${suelo} (I=${I.toFixed(2)})`,
            data: spec.accelerations,
            borderColor: spec.SaMax >= 1.15 ? '#ff453a' : (spec.SaMax >= 0.85 ? '#38bdf8' : '#30d158'),
            backgroundColor: spec.SaMax >= 1.15 ? 'rgba(255, 69, 58, 0.18)' : (spec.SaMax >= 0.85 ? 'rgba(56, 189, 248, 0.18)' : 'rgba(48, 209, 88, 0.18)'),
            borderWidth: 2.5,
            fill: true,
            tension: 0.15,
            pointRadius: 0,
            pointHoverRadius: 5
        }
    ];

    if (nsrEspectroChart) {
        nsrEspectroChart.data.labels = spec.periods;
        nsrEspectroChart.data.datasets = datasets;
        nsrEspectroChart.options.scales.y.suggestedMax = Math.max(1.6, spec.SaMax * 1.25);
        nsrEspectroChart.update('active');
    } else {
        nsrEspectroChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: spec.periods,
                datasets: datasets
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 400 },
                plugins: {
                    legend: {
                        display: true,
                        position: 'top',
                        labels: {
                            color: '#CBD5E1',
                            font: { size: 8.5 },
                            boxWidth: 12,
                            boxHeight: 3
                        }
                    },
                    tooltip: {
                        callbacks: {
                            label: ctx => `${ctx.dataset.label}: Sa = ${ctx.parsed.y} g (${(ctx.parsed.y * 9.80665).toFixed(2)} m/s²)`
                        }
                    }
                },
                scales: {
                    x: {
                        title: { display: true, text: 'Período T (s)', color: '#94A3B8', font: { size: 9 } },
                        grid: { color: 'rgba(255,255,255,0.06)' },
                        ticks: { maxTicksLimit: 8, font: { size: 8 } }
                    },
                    y: {
                        beginAtZero: true,
                        suggestedMax: Math.max(1.6, spec.SaMax * 1.25),
                        title: { display: true, text: 'Sa (g)', color: '#94A3B8', font: { size: 9 } },
                        grid: { color: 'rgba(255,255,255,0.06)' },
                        ticks: { font: { size: 8 } }
                    }
                }
            }
        });
        applyThemeToCharts(document.body.classList.contains('theme-light'));
    }

    window.currentSpectrumData = {
        municipio: m.nombre,
        departamento: m.departamento,
        aa: m.aa,
        av: m.av,
        suelo: suelo,
        I: I,
        Fa: spec.Fa,
        Fv: spec.Fv,
        SaMax: spec.SaMax,
        periods: spec.periods,
        accelerations: spec.accelerations,
        rocaAccelerations: specRoca.accelerations
    };
}

function exportarEspectroCSV() {
    let data = window.currentSpectrumData;
    if (!data) {
        updateNSR10Metrics();
        data = window.currentSpectrumData;
    }
    if (!data || !data.periods || data.periods.length === 0) {
        alert('Por favor selecciona un municipio para generar el espectro antes de exportar.');
        return;
    }

    let csvContent = "";
    csvContent += `# ESPECTRO ELASTICO DE DISENO NSR-10 (TITULO A)\r\n`;
    csvContent += `# Municipio: ${safeCsvField(`${data.municipio} (${data.departamento})`)}\r\n`;
    csvContent += `# Parametros: Aa=${data.aa}, Av=${data.av}, Fa=${data.Fa}, Fv=${data.Fv}, Perfil_Suelo=${data.suelo}, Importancia_I=${data.I}\r\n`;
    csvContent += `# Sa_Max_Meseta: ${data.SaMax} g\r\n`;
    csvContent += `Periodo_T_seg,Sa_Diseno_Sitio_g,Sa_Diseno_Sitio_ms2,Sa_Roca_Base_g\r\n`;

    for (let i = 0; i < data.periods.length; i++) {
        const t = data.periods[i].toFixed(2);
        const saG = data.accelerations[i].toFixed(3);
        const saMs2 = (data.accelerations[i] * 9.80665).toFixed(3);
        const saRoca = (data.rocaAccelerations && data.rocaAccelerations[i] !== undefined) ? data.rocaAccelerations[i].toFixed(3) : '0.000';
        csvContent += `${t},${saG},${saMs2},${saRoca}\r\n`;
    }

    const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `espectro_NSR10_${data.municipio.replace(/\s+/g, '_')}_suelo_${data.suelo}_I_${data.I}.csv`);
    document.body.appendChild(link);
    link.click();
    setTimeout(() => {
        document.body.removeChild(link);
        window.URL.revokeObjectURL(url);
    }, 150);
}

function classifyLiquefaction(licRaw, suelo = '') {
    const raw = String(licRaw || '').trim();
    const low = raw.toLowerCase();
    const isSlopeLow = low.startsWith('baja') && (low.includes('deslizamiento') || low.includes('caída') || low.includes('movimientos'));
    if (isSlopeLow && suelo !== 'F') {
        return { pillClass: 'normal', uiText: '🟢 Baja (Ladera alta)', potText: `🟢 BAJA EN LICUACIÓN (${raw})` };
    }
    if (low === 'baja' && suelo !== 'F' && suelo !== 'E') {
        return { pillClass: 'normal', uiText: '🟢 Baja', potText: '🟢 BAJA' };
    }
    if (low.includes('crítica') || low.includes('critica') || low.includes('alta') || suelo === 'F') {
        const prefix = low.startsWith('baja') ? '🟢 BAJA EN LICUACIÓN / 🔴 PERFIL F' : (low.includes('crítica') ? '🔴 Crítica / Alta' : '🔴 Alta');
        const pot = low.startsWith('baja') ? `🟢 BAJA EN LICUACIÓN (${raw}) / 🔴 PERFIL F` : `🔴 ${raw.toUpperCase() || 'ALTA'}`;
        return { pillClass: 'critico', uiText: prefix, potText: pot };
    }
    if (low.includes('moderada') || low.includes('media') || suelo === 'E') {
        const pot = low === 'baja' ? '🟠 BAJA EN LICUACIÓN / AMPLIFICACIÓN PERFIL E' : `🟠 ${raw.toUpperCase() || 'MEDIA'}`;
        return { pillClass: 'alerta', uiText: '🟠 Moderada', potText: pot };
    }
    return { pillClass: 'normal', uiText: '🟢 Baja', potText: `🟢 ${raw.toUpperCase() || 'BAJA'}` };
}

function updateNSR10Metrics() {
    const sel = document.getElementById('nsr-municipio-select');
    const sueloSel = document.getElementById('nsr-suelo-select');
    const usoSel = document.getElementById('nsr-grupo-uso-select');
    if (!sel || !municipiosData || municipiosData.length === 0) return;
    
    const idx = parseInt(sel.value) || 0;
    const m = municipiosData[idx] || municipiosData[0];
    selectedNsrMunicipio = m;
    
    const suelo = sueloSel ? sueloSel.value : (m.suelo_defecto || 'E');
    const I = usoSel ? parseFloat(usoSel.value) : 1.0;
    const spec = calcularEspectroNSR10(m.aa, m.av, suelo, I);
    const Fa = spec.Fa;
    const Fv = spec.Fv;
    const pgaDiseno = (Fa * m.aa).toFixed(2);
    
    const elAa = document.getElementById('nsr-aa-val');
    const elAv = document.getElementById('nsr-av-val');
    const elFa = document.getElementById('nsr-fa-val');
    const elFv = document.getElementById('nsr-fv-val');
    const elIVal = document.getElementById('nsr-i-val');
    const elIDesc = document.getElementById('nsr-i-desc');
    const elPga = document.getElementById('nsr-pga-diseno');
    const elSamaxCard = document.getElementById('nsr-samax-card');
    const elDemandaBadge = document.getElementById('nsr-demanda-badge');
    const elGeo = document.getElementById('nsr-geologia-desc');
    const elLic = document.getElementById('nsr-licuacion-badge');
    const geoTitulo = document.getElementById('nsr-geo-titulo');
    const geoCuerpo = document.getElementById('nsr-geo-cuerpo');
    const geoFeedback = document.getElementById('nsr-geotecnia-feedback');
    
    if (elAa) elAa.innerText = `${m.aa.toFixed(2)} g`;
    if (elAv) elAv.innerText = `${m.av.toFixed(2)} g`;
    if (elFa) elFa.innerText = Fa.toFixed(2);
    if (elFv) elFv.innerText = Fv.toFixed(2);
    if (elPga) elPga.innerText = `${pgaDiseno} g`;
    if (elSamaxCard) elSamaxCard.innerText = `${spec.SaMax.toFixed(2)} g`;

    // Mapeo explicativo de Grupos de Uso NSR-10
    const usoDescriptions = {
        '1.00': 'Grupo I: Ocupación Normal (Vivienda/Comercio)',
        '1.10': 'Grupo II: Ocupación Especial (>200 personas)',
        '1.25': 'Grupo III: Atención Comunidad (Colegios/Policía)',
        '1.50': 'Grupo IV: Indispensable (Hospitales/Urgencias)'
    };
    const usoKey = I.toFixed(2);
    if (elIVal) elIVal.innerText = usoKey;
    if (elIDesc) elIDesc.innerText = usoDescriptions[usoKey] || `I = ${usoKey}`;

    // Nivel de demanda sísmica estructural
    if (elDemandaBadge) {
        if (spec.SaMax >= 1.15) {
            elDemandaBadge.innerText = 'Demanda Extrema';
            elDemandaBadge.className = 'status-pill critico';
        } else if (spec.SaMax >= 0.85) {
            elDemandaBadge.innerText = 'Demanda Severa';
            elDemandaBadge.className = 'status-pill alerta';
        } else {
            elDemandaBadge.innerText = 'Demanda Moderada';
            elDemandaBadge.className = 'status-pill normal';
        }
    }

    // Feedback Geotécnico Dinámico de Suelo & Importancia
    const soilProfiles = {
        'A': {
            title: 'Perfil A — Roca Competente (Vs > 1500 m/s)',
            desc: 'Macizo rocoso sano y continuo. No presenta amplificación de ondas sísmicas (Fa = 0.80, Fv = 0.80). Cimentaciones de máxima estabilidad.',
            color: '#32D74B',
            border: '#32D74B'
        },
        'B': {
            title: 'Perfil B — Roca Media (760 < Vs ≤ 1500 m/s)',
            desc: 'Roca de rigidez media o meteorizada. Perfil de referencia basal de la NSR-10 (Fa = 1.00, Fv = 1.00). Factor de amplificación unitario.',
            color: '#38bdf8',
            border: '#38bdf8'
        },
        'C': {
            title: 'Perfil C — Suelos Muy Densos o Roca Blanda (360 < Vs ≤ 760 m/s)',
            desc: 'Gravas compactas, arenas densas o lutitas blandas. Amplificación moderada en periodos intermedios y buena capacidad portante.',
            color: '#FFD60A',
            border: '#FFD60A'
        },
        'D': {
            title: 'Perfil D — Suelos Rígidos (180 < Vs ≤ 360 m/s)',
            desc: 'Arenas y limos de compacidad media a alta, o arcillas firmes. Amplificación sísmica notable en edificaciones de 3 a 8 pisos.',
            color: '#FF9F0A',
            border: '#FF9F0A'
        },
        'E': {
            title: 'Perfil E — Suelos Blandos / Aluviales (Vs < 180 m/s)',
            desc: `Depósitos aluviales de ríos, llanuras de inundación o bajamar. Alta amplificación por efecto gelatina (Fv = ${Fv.toFixed(2)}). Exige cimentaciones profundas.`,
            color: '#FF453A',
            border: '#FF453A'
        },
        'F': {
            title: 'Perfil F — Suelos Especiales / Licuables / Turbas',
            desc: 'Requiere estudio de respuesta dinámica de sitio según NSR-10 A.2.4.3. Alta susceptibilidad a colapso de resistencia por presión de poros.',
            color: '#BF5AF2',
            border: '#BF5AF2'
        }
    };

    const sp = soilProfiles[suelo] || soilProfiles['E'];
    if (geoTitulo) {
        geoTitulo.innerText = sp.title;
        geoTitulo.style.color = sp.color;
    }
    if (geoCuerpo) {
        let usoText = '';
        if (I >= 1.50) usoText = ` <br><strong style="color:#ff7b72;">¡Alerta Hospitalaria (I=1.50)!</strong> Obligatorio diseñar con espectro inelástico reducido y aislamiento/disipación de energía sísmica.`;
        else if (I >= 1.25) usoText = ` <br><strong style="color:#ffd60a;">Uso Comunitario (I=1.25):</strong> Estructura esencial para respuesta ante emergencias y albergue.`;
        geoCuerpo.innerHTML = `${sp.desc}${usoText}`;
    }
    if (geoFeedback) {
        geoFeedback.style.borderLeftColor = sp.border;
    }
    
    if (elGeo) elGeo.innerText = m.geologia;
    
    if (elLic) {
        const licInfo = classifyLiquefaction(m.licuacion_riesgo, suelo);
        elLic.innerText = licInfo.uiText;
        elLic.className = `status-pill ${licInfo.pillClass}`;
    }

    updateNSREspectroChart();
}

function getNearbyInfrastructure(m, radiusKm = 45) {
    const items = [];
    if (!infraData || !infraData.features) return items;
    infraData.features.forEach(f => {
        const p = f.properties || {};
        if (f.geometry && f.geometry.type === 'Point') {
            const c = f.geometry.coordinates;
            const d = haversineDistanceKm(m.lat, m.lng, c[1], c[0]);
            if (d <= radiusKm) {
                items.push({ nombre: p.nombre, tipo: p.tipo, distKm: Math.round(d) });
            }
        } else if (f.geometry && f.geometry.type === 'LineString') {
            const d = getMinDistanceToLine(m.lng, m.lat, f.geometry.coordinates);
            if (d <= 25) {
                items.push({ nombre: p.nombre, tipo: p.tipo, distKm: Math.round(d) });
            }
        }
    });
    return items.sort((a, b) => a.distKm - b.distKm);
}

function updatePOTMetrics() {
    const sel = document.getElementById('pot-municipio-select');
    if (!sel || !municipiosData || municipiosData.length === 0) return;

    const parsedIdx = parseInt(sel.value, 10);
    const idx = Number.isNaN(parsedIdx) ? 0 : parsedIdx;
    const m = municipiosData[idx] || municipiosData[0];
    selectedPotMunicipio = m;
    
    let sismos30km = 0;
    let maxMag30km = 0;
    
    if (mapData && mapData.features) {
        mapData.features.forEach(f => {
            const coords = f.geometry.coordinates;
            const dist = haversineDistanceKm(m.lat, m.lng, coords[1], coords[0]);
            if (dist <= 30) {
                sismos30km++;
                const mag = f.properties.magnitud || 0;
                if (mag > maxMag30km) maxMag30km = mag;
            }
        });
    }
    
    const nearbyInfra = getNearbyInfrastructure(m, 35);
    const elPob = document.getElementById('pot-pob-val');
    const elCat = document.getElementById('pot-cat-ley617');
    const elSismos = document.getElementById('pot-sismos-cercanos');
    const elInfraProx = document.getElementById('pot-infra-prox');
    const elAcceso = document.getElementById('pot-acceso-val');
    const elAisl = document.getElementById('pot-aislamiento-alert');
    const elDestructor = document.getElementById('pot-ultimo-destructor');
    const elSemaforo = document.getElementById('pot-semaforo-badge');
    
    if (elPob) elPob.innerText = (m.poblacion || 0).toLocaleString();
    if (elCat) elCat.innerText = m.categoria_ley617 || 'Categoría Ley 617';
    if (elSismos) elSismos.innerText = `${sismos30km} (${maxMag30km > 0 ? maxMag30km.toFixed(1) + ' M' : 's/d'})`;
    if (elInfraProx) elInfraProx.innerText = `${nearbyInfra.length} nodos/ejes (≤35 km)`;
    if (elAcceso) elAcceso.innerText = m.acceso_principal || 'Consultar cartografía vial';
    if (elAisl) {
        if (m.aislamiento_modal) {
            elAisl.style.display = 'block';
            elAisl.innerHTML = `<strong>Alerta de Aislamiento Modal:</strong> Cabecera sin conexión vial pavimentada continua. Ante bloqueo fluvial o colapso de muelle/pista, la respuesta de emergencia depende de corredores alternos marítimos, fluviales o aéreos.`;
        } else {
            elAisl.style.display = 'none';
        }
    }
    if (elDestructor) elDestructor.innerText = m.ultimo_destructor;
    
    if (elSemaforo) {
        if (m.aa >= 0.35 || sismos30km >= 50 || m.costero_pacifico) {
            elSemaforo.className = 'status-pill critico';
            elSemaforo.innerText = 'CRÍTICO';
        } else if (m.aa >= 0.25 || sismos30km >= 20) {
            elSemaforo.className = 'status-pill alerta';
            elSemaforo.innerText = 'ALTO';
        } else {
            elSemaforo.className = 'status-pill normal';
            elSemaforo.innerText = 'MEDIO';
        }
    }
}

function openFichaPOTModal() {
    const modal = document.getElementById('modal-ficha-pot');
    const body = document.getElementById('ficha-pot-body');
    const title = document.getElementById('ficha-pot-titulo');
    const subtitle = document.getElementById('ficha-pot-subtitulo');
    if (!modal || !body) return;

    const sel = document.getElementById('pot-municipio-select');
    const idx = parseInt(sel.value) || 0;
    const m = (municipiosData && municipiosData[idx]) ? municipiosData[idx] : {
        nombre: 'Quibdó', departamento: 'Chocó', aa: 0.35, av: 0.35, zona: 'Alta',
        suelo_defecto: 'E', geologia: 'Depósitos aluviales del Río Atrato', poblacion: 132000,
        licuacion_riesgo: 'Alta', costero_pacifico: false, ultimo_destructor: '1992 / 2024',
        lat: 5.6947, lng: -76.6611
    };

    // Calcular sismos cercanos (radio 50 km)
    let sismos50km = 0;
    let maxMag50km = 0;
    if (mapData && mapData.features) {
        mapData.features.forEach(f => {
            const c = f.geometry.coordinates;
            const dist = haversineDistanceKm(m.lat, m.lng, c[1], c[0]);
            if (dist <= 50) {
                sismos50km++;
                const mag = f.properties.magnitud || 0;
                if (mag > maxMag50km) maxMag50km = mag;
            }
        });
    }

    // Calcular distancia real punto-polilínea a fallas geológicas cercanas (<= 75 km)
    let fallasCercanas = [];
    if (faultData && faultData.features) {
        faultData.features.forEach(f => {
            const p = f.properties || {};
            let minDist = 999;
            if (f.geometry && f.geometry.coordinates) {
                if (f.geometry.type === 'MultiLineString') {
                    f.geometry.coordinates.forEach(line => {
                        const d = getMinDistanceToLine(m.lng, m.lat, line);
                        if (d < minDist) minDist = d;
                    });
                } else {
                    minDist = getMinDistanceToLine(m.lng, m.lat, f.geometry.coordinates);
                }
            }
            if (minDist <= 75) {
                fallasCercanas.push({
                    nombre: p.nombre || p.Nombre || p.NOMBRE || 'Falla Geológica Activa',
                    dist: Math.round(minDist)
                });
            }
        });
        fallasCercanas.sort((a, b) => a.dist - b.dist);
    }

    const factors = getFactoresSitioNSR10(m.aa, m.av, m.suelo_defecto || 'E');
    const pgaDiseno = (factors.Fa * m.aa).toFixed(2);
    const nearbyInfra = getNearbyInfrastructure(m, 45);
    const licInfo = classifyLiquefaction(m.licuacion_riesgo, m.suelo_defecto || '');
    const licLabel = escapeHtml(licInfo.potText);

    const directrizTerritorial = m.costero_pacifico
        ? '<strong>Frente Costero Pacífico:</strong> Incorporar planes locales de alerta ante tsunami, muelles alternos y cotas de evacuación rápida por sismo fuerte sentido en playa.'
        : (m.aislamiento_modal
            ? '<strong>Aislamiento Modal Fluvial/Selvático:</strong> Priorizar redundancia en embarcaderos fluviales, pistas locales y autonomía asistencial del Nivel I/II ante cortes de comunicación.'
            : '<strong>Eje Cordillerano / Carretero:</strong> Priorizar estabilización de taludes en vías troncales y verificación de puentes frente a deslizamientos cosísmicos.');

    title.innerText = `Ficha Técnica Territorial (Orientadora) — ${m.nombre}`;
    subtitle.innerText = `Departamento de ${m.departamento} | Insumo referencial para POT / PBOT / EOT (Decreto 1077/2015 · Ley 1523/2012)`;

    body.innerHTML = `
        <div class="sc-modal-grid-2 sc-pot-grid" style="margin-bottom:12px;">
            <div class="sc-pot-card">
                <h4 class="sc-pot-card-title">${MODAL_ICONS.map}<span>1. Localización y Capacidad Institucional</span></h4>
                <p><strong>Municipio:</strong> ${escapeHtml(m.nombre)} (${escapeHtml(m.departamento)})</p>
                <p><strong>Categoría Ley 617/2000:</strong> ${escapeHtml(m.categoria_ley617 || 'Referencia')}</p>
                <p><strong>Población de Referencia:</strong> ${(m.poblacion || 0).toLocaleString()} habitantes</p>
                <p><strong>Conectividad:</strong> ${escapeHtml(m.acceso_principal || 'Consultar red')}</p>
                <p><strong>Coordenadas Cabecera:</strong> Lat ${m.lat.toFixed(4)}°, Lon ${m.lng.toFixed(4)}°</p>
            </div>

            <div class="sc-pot-card">
                <h4 class="sc-pot-card-title">${MODAL_ICONS.building}<span>2. Parámetros Oficiales NSR-10</span></h4>
                <p><strong>Zona de Amenaza Sísmica:</strong> <span class="status-pill critico"><span class="sc-pot-dot sc-pot-dot--crit"></span>${escapeHtml(m.zona)}</span></p>
                <p><strong>Coeficientes de Aceleración:</strong> Aa = ${m.aa.toFixed(2)} g | Av = ${m.av.toFixed(2)} g</p>
                <p><strong>Perfil de Suelo Referencial:</strong> Tipo ${escapeHtml(m.suelo_defecto || 'E')} (Fa=${factors.Fa}, Fv=${factors.Fv})</p>
                <p><strong>PGA Esperado en Superficie:</strong> <strong class="sc-pot-metric-highlight">${pgaDiseno} g</strong></p>
            </div>
        </div>

        <div class="sc-pot-card">
            <h4 class="sc-pot-card-title">${MODAL_ICONS.sismo}<span>3. Contexto Sismotectónico y Exposición de Líneas Vitales</span></h4>
            <p><strong>Geología Local:</strong> ${escapeHtml(m.geologia)}</p>
            <p><strong>Sismos Instrumentales en 50 km:</strong> ${sismos50km} eventos (Magnitud máx: ${maxMag50km > 0 ? maxMag50km.toFixed(1) : 's/d'})</p>
            <p><strong>Eventos Históricos de Referencia:</strong> ${escapeHtml(m.ultimo_destructor)}</p>
            <p><strong>Fallas Cartografiadas Próximas:</strong> ${fallasCercanas.length > 0 ? fallasCercanas.map(f => `${escapeHtml(f.nombre)} (${f.dist} km)`).join(', ') : 'Sin trazas dentro de 75 km en capa local'}</p>
            <p><strong>Infraestructura Crítica en 45 km:</strong> ${nearbyInfra.length > 0 ? nearbyInfra.slice(0, 6).map(i => `${escapeHtml(i.nombre)} (${i.distKm} km)`).join('; ') : 'Sin nodos mapeados en 45 km — verificar red local REPS/DIMAR'}</p>
        </div>

        <div class="sc-pot-card sc-pot-card--danger">
            <h4 class="sc-pot-card-title">${MODAL_ICONS.shield}<span>4. Matriz Cualitativa de Fenómenos Concomitantes</span></h4>
            <table class="ficha-pot-table">
                <thead>
                    <tr>
                        <th>Fenómeno Concomitante</th>
                        <th>Susceptibilidad Cualitativa</th>
                        <th>Alcance Técnico y Verificación Requerida</th>
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <td><strong>Licuación de Suelos</strong></td>
                        <td><span class="sc-pot-dot sc-pot-dot--${licInfo.pillClass === 'critico' ? 'crit' : (licInfo.pillClass === 'alerta' ? 'warn' : 'ok')}"></span>${licLabel.replace(/^[^\wÁÉÍÓÚÑ]+/u, '')}</td>
                        <td>Indicador cualitativo regional; exige ensayos SPT/CPT y nivel freático en estudios geotécnicos de detalle (NSR-10 Título H).</td>
                    </tr>
                    <tr>
                        <td><strong>Exposición a Tsunami</strong></td>
                        <td>${m.costero_pacifico ? '<span class="sc-pot-dot sc-pot-dot--crit"></span>LITORAL PACÍFICO EXPUESTO' : '<span class="sc-pot-dot sc-pot-dot--ok"></span>INTERIOR (No costero)'}</td>
                        <td>${m.costero_pacifico ? 'Verificar cartografía oficial de inundación por tsunami (DIMAR / SGC / UNGRD) y rutas hacia cota segura.' : 'Sin exposición directa a oleaje tsunamigénico.'}</td>
                    </tr>
                    <tr>
                        <td><strong>Inestabilidad de Laderas</strong></td>
                        <td><span class="sc-pot-dot sc-pot-dot--warn"></span>ALTA / VARIABLE</td>
                        <td>Susceptibilidad potencial a bloqueos viales y fluviales por saturación hídrica cosísmica.</td>
                    </tr>
                </tbody>
            </table>
        </div>

        <div class="sc-pot-card sc-pot-card--info" style="margin-bottom:0;">
            <h4 class="sc-pot-card-title">${MODAL_ICONS.book}<span>5. Lineamientos Técnicos Orientadores (No Vinculantes)</span></h4>
            <ol class="sc-modal-list" style="margin:0; font-size:var(--fs-xs);">
                <li>${directrizTerritorial}</li>
                <li><strong>Articulación Decreto 1807 de 2014 (Dec. 1077/2015):</strong> Esta ficha constituye un insumo orientador preliminar y no reemplaza los Estudios Básicos ni Detallados ni las competencias de asistencia técnica de CODECHOCÓ.</li>
                <li><strong>Enfoque Territorial y Étnico (Ley 70/1993):</strong> Toda delimitación de suelos de protección o reasentamiento en consejos comunitarios y resguardos requiere cartografía IGAC/ANT y consulta previa (Convenio 169 OIT).</li>
                <li><strong>Edificaciones Indispensables (NSR-10 Grupo IV):</strong> Centros de salud (I = 1.50), sedes de emergencia y nodos portuarios deben priorizar evaluación de vulnerabilidad sísmica estructural.</li>
            </ol>
        </div>
    `;

    modal.style.display = 'flex';
    setTimeout(() => { modal.style.opacity = '1'; }, 20);
}

// ============================================================================
// LISTENERS MULTIDISCIPLINARES: PESTAÑAS, CONTROLES Y EVENTOS
// ============================================================================

// Listener de pestañas de perfil (Segmented Control)
document.querySelectorAll('.profile-tab').forEach(tab => {
    tab.addEventListener('click', function() {
        document.querySelectorAll('.profile-tab').forEach(t => {
            t.classList.remove('active');
            t.setAttribute('aria-selected', 'false');
        });
        this.classList.add('active');
        this.setAttribute('aria-selected', 'true');
        
        const profile = this.getAttribute('data-profile');
        currentProfile = profile;
        
        document.querySelectorAll('.profile-panel').forEach(p => p.style.display = 'none');
        const targetPanel = document.getElementById(`panel-${profile}`);
        if (targetPanel) {
            targetPanel.style.display = 'flex';
        }
        
        if (profile === 'nsr10') {
            updateNSR10Metrics();
        } else if (profile === 'alcaldia') {
            updatePOTMetrics();
        }
        savePreferences();
        queueRender();
    });
});

const btnPanelCollapse = document.getElementById('btn-panel-collapse');
if (btnPanelCollapse) {
    btnPanelCollapse.addEventListener('click', () => {
        const isCollapsed = document.body.classList.toggle('panel-collapsed');
        const uiPanelEl = document.getElementById('ui-panel');
        if (uiPanelEl) uiPanelEl.inert = isCollapsed;
        btnPanelCollapse.setAttribute('aria-expanded', String(!isCollapsed));
    });
}

const checkViewportFilter = document.getElementById('check-viewport-filter');
if (checkViewportFilter) {
    checkViewportFilter.addEventListener('change', (e) => {
        viewportFilterEnabled = !!e.target.checked;
        queueRender();
    });
}

const potPriorityFilter = document.getElementById('pot-priority-filter');
if (potPriorityFilter) {
    potPriorityFilter.addEventListener('change', async (e) => {
        const selectedMode = e.target.value || 'all';
        if (!municipiosData || municipiosData.length === 0) {
            await ensureMunicipiosData();
            potPriorityFilter.value = selectedMode;
        }
        populatePotSelect(selectedMode);
        updatePOTMetrics();
        queueRender();
    });
}

const potMunicipioSearch = document.getElementById('pot-municipio-search');
if (potMunicipioSearch) {
    potMunicipioSearch.addEventListener('input', () => {
        const mode = potPriorityFilter ? potPriorityFilter.value : 'all';
        populatePotSelect(mode, potMunicipioSearch.value);
        updatePOTMetrics();
        queueRender();
    });
}

const nsrMunicipioSearch = document.getElementById('nsr-municipio-search');
if (nsrMunicipioSearch) {
    nsrMunicipioSearch.addEventListener('input', () => {
        populateNsrSelect(nsrMunicipioSearch.value);
        const nsrSelEl = document.getElementById('nsr-municipio-select');
        const idx = nsrSelEl ? (parseInt(nsrSelEl.value, 10) || 0) : 0;
        const m = (municipiosData && municipiosData[idx]) ? municipiosData[idx] : null;
        if (m) {
            const sueloSel = document.getElementById('nsr-suelo-select');
            if (sueloSel) sueloSel.value = m.suelo_defecto || 'E';
        }
        updateNSR10Metrics();
        queueRender();
    });
}

const btnPotSummaryToggle = document.getElementById('btn-pot-summary-toggle');
if (btnPotSummaryToggle) {
    btnPotSummaryToggle.addEventListener('click', () => {
        const box = document.getElementById('pot-tabular-summary');
        if (!box) return;
        const isHidden = box.style.display === 'none' || !box.style.display;
        box.style.display = isHidden ? 'block' : 'none';
        btnPotSummaryToggle.innerText = isHidden ? 'Ocultar Tablero Municipal' : 'Ver Tablero Municipal Simplificado';
    });
}

// Listeners de Selección NSR-10
const nsrSelect = document.getElementById('nsr-municipio-select');
if (nsrSelect) {
    nsrSelect.addEventListener('change', () => {
        const idx = parseInt(nsrSelect.value) || 0;
        const m = (municipiosData && municipiosData[idx]) ? municipiosData[idx] : null;
        if (m) {
            const sueloSel = document.getElementById('nsr-suelo-select');
            if (sueloSel) sueloSel.value = m.suelo_defecto || 'E';
        }
        updateNSR10Metrics();
        queueRender();
    });
}

const nsrSueloSelect = document.getElementById('nsr-suelo-select');
if (nsrSueloSelect) {
    nsrSueloSelect.addEventListener('change', () => {
        updateNSR10Metrics();
        queueRender();
    });
}

const nsrGrupoUsoSelect = document.getElementById('nsr-grupo-uso-select');
if (nsrGrupoUsoSelect) {
    nsrGrupoUsoSelect.addEventListener('change', () => {
        updateNSR10Metrics();
        queueRender();
    });
}

const btnExportEspectroCSV = document.getElementById('btn-export-espectro-csv');
if (btnExportEspectroCSV) {
    btnExportEspectroCSV.addEventListener('click', () => {
        exportarEspectroCSV();
    });
}

const btnNsrLocate = document.getElementById('btn-nsr-locate');
if (btnNsrLocate) {
    btnNsrLocate.addEventListener('click', () => {
        if (!selectedNsrMunicipio) return;
        deckgl.setProps({
            initialViewState: {
                longitude: selectedNsrMunicipio.lng,
                latitude: selectedNsrMunicipio.lat,
                zoom: 10.5,
                pitch: 45,
                bearing: 15,
                transitionDuration: 1500,
                transitionInterpolator: new deck.FlyToInterpolator()
            }
        });
        queueRender();
    });
}

// Listeners de Selección POT y Ficha Ejecutiva
const potSelect = document.getElementById('pot-municipio-select');
if (potSelect) potSelect.addEventListener('change', () => { updatePOTMetrics(); queueRender(); });

const btnPotLocate = document.getElementById('btn-pot-locate');
if (btnPotLocate) {
    btnPotLocate.addEventListener('click', () => {
        if (!selectedPotMunicipio) return;
        deckgl.setProps({
            initialViewState: {
                longitude: selectedPotMunicipio.lng,
                latitude: selectedPotMunicipio.lat,
                zoom: 10.2,
                pitch: 45,
                bearing: 15,
                transitionDuration: 1500,
                transitionInterpolator: new deck.FlyToInterpolator()
            }
        });
        queueRender();
    });
}

const btnPotPrint = document.getElementById('btn-pot-print');
if (btnPotPrint) {
    btnPotPrint.addEventListener('click', () => {
        openFichaPOTModal();
    });
}

// Controles del Modal de Ficha Técnica POT
if (!window.__sismoAfterPrintBound) {
    window.__sismoAfterPrintBound = true;
    window.addEventListener('afterprint', () => {
        document.body.classList.remove('printing-ficha');
    });
}
const btnFichaPrintAction = document.getElementById('btn-ficha-print-action');
if (btnFichaPrintAction) {
    btnFichaPrintAction.addEventListener('click', () => {
        document.body.classList.add('printing-ficha');
        window.print();
    });
}

const btnFichaCloseAction = document.getElementById('btn-ficha-close-action');
if (btnFichaCloseAction) {
    btnFichaCloseAction.addEventListener('click', () => {
        const modal = document.getElementById('modal-ficha-pot');
        if (modal) {
            modal.style.opacity = '0';
            setTimeout(() => { modal.style.display = 'none'; }, 250);
        }
    });
}

const modalFichaPot = document.getElementById('modal-ficha-pot');
if (modalFichaPot) {
    modalFichaPot.addEventListener('click', (e) => {
        if (e.target === modalFichaPot) {
            modalFichaPot.style.opacity = '0';
            setTimeout(() => { modalFichaPot.style.display = 'none'; }, 250);
        }
    });
}

// ============================================================================
// GESTOR DEL PERFIL BENIOFF 3D (ZONA DE SUBDUCCIÓN DE NAZCA)
// ============================================================================
function animateBenioffViewForMode(mode) {
    if (!isBenioffMode || !deckgl) return;

    const badge = document.getElementById('benioff-status-badge');
    let targetViewState;

    let targetLat = 5.7;
    let targetLng = -77.3;
    if (benioffSector === 'norte') {
        targetLat = 7.0;
        targetLng = -77.35;
    } else if (benioffSector === 'centro') {
        targetLat = 5.5;
        targetLng = -77.25;
    } else if (benioffSector === 'sur') {
        targetLat = 4.5;
        targetLng = -77.3;
    }

    if (mode === 'puntos') {
        targetViewState = {
            longitude: targetLng,
            latitude: targetLat,
            zoom: 7.2,
            pitch: 82,
            bearing: 90,
            transitionDuration: 1600,
            transitionInterpolator: new deck.FlyToInterpolator()
        };
        if (badge) badge.innerText = '📐 Hipocentros 3D (W → E)';
    } else if (mode === 'calor') {
        targetViewState = {
            longitude: targetLng + 0.1,
            latitude: targetLat,
            zoom: 7.35,
            pitch: 78,
            bearing: 82,
            transitionDuration: 1600,
            transitionInterpolator: new deck.FlyToInterpolator()
        };
        if (badge) badge.innerText = '🔥 Concentración Energía 3D';
    } else if (mode === 'hex') {
        targetViewState = {
            longitude: targetLng + 0.15,
            latitude: targetLat + 0.1,
            zoom: 7.15,
            pitch: 74,
            bearing: 96,
            transitionDuration: 1600,
            transitionInterpolator: new deck.FlyToInterpolator()
        };
        if (badge) badge.innerText = '📊 Cúmulos Espaciales 3D';
    }

    if (targetViewState) {
        deckgl.setProps({ initialViewState: targetViewState });
    }
}

function toggleBenioffMode(forceState, { skipCameraReset = false, skipRender = false } = {}) {
    const newState = (forceState !== undefined) ? forceState : !isBenioffMode;
    isBenioffMode = newState;

    const btn = document.getElementById('btn-benioff');
    const btnText = document.getElementById('btn-benioff-text');
    const controls = document.getElementById('benioff-controls');

    if (isBenioffMode) {
        if (btn) {
            btn.classList.add('active');
            btn.style.background = '#0052CC';
            btn.style.color = '#ffffff';
            btn.style.borderColor = '#0052CC';
            btn.style.boxShadow = '0 0 14px rgba(0,82,204,0.5)';
        }
        if (btnText) btnText.innerHTML = '↺ Restaurar Vista 3D';
        if (controls) controls.style.display = 'flex';

        // Si no había ningún modo activo, activar 'calor' (Concentración Energía) por defecto
        if (viewMode === 'none') {
            viewMode = 'calor';
            const btnCalor = document.getElementById('btn-calor');
            if (btnCalor) btnCalor.classList.add('active');
        }

        // Animar la cámara de forma funcional según el modo activo (puntos, calor o hex)
        animateBenioffViewForMode(viewMode);
    } else {
        if (btn) {
            btn.classList.remove('active');
            btn.style.background = '';
            btn.style.color = '';
            btn.style.borderColor = '';
            btn.style.boxShadow = '';
        }
        if (btnText) btnText.innerHTML = 'Activar Perfil Benioff';
        if (controls) controls.style.display = 'none';

        if (!skipCameraReset && deckgl) {
            // Animar cámara de regreso a vista aérea tridimensional general
            deckgl.setProps({
                initialViewState: {
                    longitude: -77.0,
                    latitude: 6.0,
                    zoom: 6.5,
                    pitch: 45,
                    bearing: 15,
                    transitionDuration: 1500,
                    transitionInterpolator: new deck.FlyToInterpolator()
                }
            });
        }
    }

    if (!skipRender) queueRender();
}

const btnBenioff = document.getElementById('btn-benioff');
if (btnBenioff) {
    btnBenioff.addEventListener('click', () => {
        toggleBenioffMode();
    });
}

// Selector de sector latitudinal de Benioff
const selBenioffSector = document.getElementById('benioff-sector-select');
if (selBenioffSector) {
    selBenioffSector.addEventListener('change', (e) => {
        benioffSector = e.target.value;
        animateBenioffViewForMode(viewMode);
        queueRender();
    });
}

// Slider de exageración vertical
const sldBenioffExag = document.getElementById('benioff-exag-slider');
const lblBenioffExag = document.getElementById('benioff-exag-val');
if (sldBenioffExag) {
    sldBenioffExag.addEventListener('input', (e) => {
        benioffExaggeration = parseFloat(e.target.value);
        if (lblBenioffExag) lblBenioffExag.innerText = `${benioffExaggeration.toFixed(2)}x`;
        queueRender();
    });
}

// ============================================================================
// MÓDULO 1: FILTRO DE PROFUNDIDAD HIPOCENTRAL (SLIDER RANGO Z)
// ============================================================================
const sldDepth = document.getElementById('depth-slider');
const lblDepth = document.getElementById('depth-val');
if (sldDepth) {
    sldDepth.addEventListener('input', (e) => {
        currentMaxDepth = parseFloat(e.target.value);
        if (lblDepth) {
            lblDepth.innerText = currentMaxDepth >= 250 ? '250 km (Todos)' : `≤ ${currentMaxDepth.toFixed(0)} km`;
        }
        savePreferences();
        queueRender();
    });
}

// ============================================================================
// MÓDULO 2: CONTROLADOR DE CAPA VECTORIAL INFRAESTRUCTURA CRÍTICA
// ============================================================================
const checkInfra = document.getElementById('check-infra');
const infraConvenciones = document.getElementById('infra-convenciones');
if (checkInfra) {
    checkInfra.addEventListener('change', async (e) => {
        showInfra = e.target.checked;
        if (infraConvenciones) {
            infraConvenciones.style.display = showInfra ? 'block' : 'none';
        }
        if (showInfra && !infraData) {
            try {
                let infraRes = await fetch(INFRA_API).catch(() => null);
                if (!infraRes || !infraRes.ok) {
                    infraRes = await fetch('./data/vias_infraestructura.geojson');
                }
                infraData = await infraRes.json();
            } catch (err) {
                console.error("Error al cargar infraestructura:", err);
            }
        }
        renderLayers();
    });
}

// ============================================================================
// MÓDULO 3: REPRODUCTOR DINÁMICO DE LÍNEA TEMPORAL (TIME-LAPSE 1993 - 2026)
// ============================================================================
const btnTimelapsePlay = document.getElementById('btn-timelapse-play');
const timelapseIcon = document.getElementById('timelapse-icon');
const timelapseText = document.getElementById('timelapse-btn-text');
const timeSlider = document.getElementById('time-slider');
const timeVal = document.getElementById('time-val');

function stopTimelapse() {
    if (timelapseTimer) {
        clearInterval(timelapseTimer);
        timelapseTimer = null;
    }
    isTimelapsePlaying = false;
    if (timelapseIcon) timelapseIcon.innerText = '▶';
    if (timelapseText) timelapseText.innerText = 'Reproducir';
    if (btnTimelapsePlay) {
        btnTimelapsePlay.style.background = '#0052CC';
    }
}

function startTimelapse() {
    if (isTimelapsePlaying) return;
    isTimelapsePlaying = true;
    if (timelapseIcon) timelapseIcon.innerText = '⏸';
    if (timelapseText) timelapseText.innerText = 'Pausar';
    if (btnTimelapsePlay) {
        btnTimelapsePlay.style.background = '#ff453a';
    }

    // Si ya está al final, reiniciar al inicio (1993)
    if (currentTime >= 2026) {
        currentTime = 1993;
        if (timeSlider) timeSlider.value = 1993;
        if (timeVal) timeVal.innerText = '1993';
        queueRender();
    }

    timelapseTimer = setInterval(() => {
        if (currentTime < 2026) {
            currentTime += 1;
            if (timeSlider) timeSlider.value = currentTime;
            if (timeVal) timeVal.innerText = currentTime;
            queueRender();
        } else {
            stopTimelapse();
        }
    }, 750); // Avance cronológico de 1 año cada 750 ms
}

if (btnTimelapsePlay) {
    btnTimelapsePlay.addEventListener('click', () => {
        if (isTimelapsePlaying) {
            stopTimelapse();
        } else {
            startTimelapse();
        }
    });
}

// Si el usuario manipula manualmente el slider de tiempo, pausar la animación
if (timeSlider) {
    timeSlider.addEventListener('mousedown', () => { if (isTimelapsePlaying) stopTimelapse(); });
    timeSlider.addEventListener('touchstart', () => { if (isTimelapsePlaying) stopTimelapse(); });
}

// ============================================================================
// MÓDULO 4: MOTOR SIMULADOR INTERACTIVO DE SHAKEMAP (ATENUACIÓN GMPE & MMI)
// ============================================================================
const SHAKEMAP_SCENARIOS = {
    'palmar_74': {
        nombre: 'Sismo 10 de Agosto (San José del Palmar - Losa Benioff)',
        anio: 2026,
        fechaCompleta: '10 de Agosto de 2026',
        tipoEvento: 'Instrumental Profundo',
        noticiaUrl: 'https://www.sgc.gov.co/',
        noticiaTexto: 'Boletín SGC - Sismo San José del Palmar',
        mw: 7.4,
        profundidad: 108,
        epicentro: [-76.24, 4.97], // [lng, lat] San José del Palmar
        falla: 'Losa de Subducción Placa de Nazca (Intraplaca Profunda ~108 km)',
        pgaMax: '0.42 g',
        radioDestrKm: 28,
        strikeDeg: 25, // Rumbo N25E
        faultLengthKm: 42,
        faultCoords: [
            [-76.32, 4.82],
            [-76.24, 4.97],
            [-76.16, 5.14]
        ],
        isoseistas: [
            { mmi: 'VIII', label: 'Destructivo Epicentral (San José del Palmar / Ansermanuevo)', pgaRange: '≥ 0.38 g', radioM: 35000, color: [255, 59, 48, 175], borde: [255, 255, 255, 240] },
            { mmi: 'VII', label: 'Daño Severo y Colapsos Estructurales (Eje Cafetero: Pereira, Manizales, Armenia, Cartago)', pgaRange: '0.22 - 0.38 g', radioM: 115000, color: [255, 140, 0, 130], borde: [255, 180, 0, 210] },
            { mmi: 'VI', label: 'Fuerte Sacudimiento en Chocó (Cuenca San Juan e Istmina) y Valle', pgaRange: '0.10 - 0.22 g', radioM: 210000, color: [255, 214, 10, 85], borde: [255, 230, 80, 175] },
            { mmi: 'IV - V', label: 'Perceptible Amplio en Antioquia, Tolima y Cundinamarca', pgaRange: '0.03 - 0.10 g', radioM: 340000, color: [56, 189, 248, 55], borde: [56, 189, 248, 160] },
            { mmi: 'II - III', label: 'Débil / Sentido en Pisos Altos (Costa Caribe, Sucre, Córdoba, Bogotá)', pgaRange: '< 0.03 g', radioM: 580000, color: [30, 64, 175, 30], borde: [96, 165, 250, 120] }
        ]
    },
    'murindo_73': {
        nombre: 'Falla Murindó (Sismo Histórico 1992)',
        anio: 1992,
        fechaCompleta: '17 y 18 de Octubre de 1992',
        tipoEvento: 'Terremoto Histórico Cortical',
        noticiaUrl: 'https://historiasismica.sgc.gov.co/',
        noticiaTexto: 'Archivo SGC / El Tiempo - Terremoto Murindó 1992',
        mw: 7.3,
        profundidad: 15,
        epicentro: [-76.75, 6.95], // [lng, lat]
        falla: 'Falla de Murindó (Rumbo Dextral)',
        pgaMax: '0.68 g',
        radioDestrKm: 48,
        strikeDeg: 12, // Rumbo N12E paralelo al Valle del Atrato
        faultLengthKm: 65,
        faultCoords: [
            [-76.85, 6.65],
            [-76.75, 6.95],
            [-76.65, 7.25]
        ],
        isoseistas: [
            { mmi: 'VIII - IX', label: 'Daño Severo / Ruptura Superficial', pgaRange: '≥ 0.50 g', radioM: 48000, color: [255, 59, 48, 170], borde: [255, 255, 255, 240] },
            { mmi: 'VII', label: 'Daño Moderado a Estructuras', pgaRange: '0.25 - 0.50 g', radioM: 85000, color: [255, 140, 0, 120], borde: [255, 180, 0, 200] },
            { mmi: 'VI', label: 'Fuerte / Fisuras en Mampostería', pgaRange: '0.12 - 0.25 g', radioM: 135000, color: [255, 214, 10, 80], borde: [255, 230, 80, 170] },
            { mmi: 'IV - V', label: 'Moderado / Sentido Ampliamente', pgaRange: '0.04 - 0.12 g', radioM: 210000, color: [56, 189, 248, 55], borde: [56, 189, 248, 160] },
            { mmi: 'II - III', label: 'Débil / Sentido en Cuenca del Magdalena y Costa Norte', pgaRange: '< 0.04 g', radioM: 420000, color: [30, 64, 175, 30], borde: [96, 165, 250, 120] }
        ]
    },
    'subduccion_82': {
        nombre: 'Megaterremoto de Subducción Nazca (Fosa del Pacífico)',
        anio: 1906,
        fechaCompleta: '1906 / 1979 (Megathrust Pacífico)',
        tipoEvento: 'Megaterremoto & Tsunami',
        noticiaUrl: 'https://historiasismica.sgc.gov.co/',
        noticiaTexto: 'Catálogo SGC / OSSO - Megaterremoto Pacífico',
        mw: 8.2,
        profundidad: 25,
        epicentro: [-78.20, 5.50],
        falla: 'Zona de Subducción Placa de Nazca',
        pgaMax: '0.85 g',
        radioDestrKm: 95,
        strikeDeg: 28, // Rumbo N28E fosa oceánica
        faultLengthKm: 140,
        faultCoords: [
            [-78.50, 4.90],
            [-78.20, 5.50],
            [-77.90, 6.15]
        ],
        isoseistas: [
            { mmi: 'IX - X', label: 'Devastador / Tsunami Costero', pgaRange: '≥ 0.65 g', radioM: 95000, color: [220, 38, 38, 180], borde: [255, 255, 255, 240] },
            { mmi: 'VII - VIII', label: 'Daño Severo en Litoral Pacífico', pgaRange: '0.35 - 0.65 g', radioM: 170000, color: [249, 115, 22, 130], borde: [255, 160, 0, 200] },
            { mmi: 'VI', label: 'Fuerte en Toda la Cuenca Atrato', pgaRange: '0.15 - 0.35 g', radioM: 260000, color: [250, 204, 21, 85], borde: [255, 230, 80, 170] },
            { mmi: 'IV - V', label: 'Perceptible en Cordillera Occidental', pgaRange: '0.05 - 0.15 g', radioM: 380000, color: [56, 189, 248, 55], borde: [56, 189, 248, 160] },
            { mmi: 'II - III', label: 'Débil a Nivel Nacional (Costa Atlántica, Altiplano y Llanos)', pgaRange: '< 0.05 g', radioM: 750000, color: [30, 64, 175, 30], borde: [96, 165, 250, 120] }
        ]
    },
    'atrato_68': {
        nombre: 'Falla Atrato - Quibdó (Sismo Cortical Urbano)',
        anio: 'MCE',
        fechaCompleta: 'Modelo Máximo Creíble (SGC / NSR-10)',
        tipoEvento: 'Escenario Determinista / Paleosísmico',
        noticiaUrl: 'https://amenazasismica.sgc.gov.co/',
        noticiaTexto: 'Modelo General de Amenaza Sísmica SGC',
        mw: 6.8,
        profundidad: 12,
        epicentro: [-76.66, 5.70],
        falla: 'Falla Atrato - Uramita',
        pgaMax: '0.62 g',
        radioDestrKm: 32,
        strikeDeg: 15,
        faultLengthKm: 45,
        faultCoords: [
            [-76.75, 5.45],
            [-76.66, 5.70],
            [-76.58, 6.00]
        ],
        isoseistas: [
            { mmi: 'VIII', label: 'Daño Severo / Licuación Atrato', pgaRange: '≥ 0.45 g', radioM: 32000, color: [255, 59, 48, 175], borde: [255, 255, 255, 240] },
            { mmi: 'VII', label: 'Daño Moderado en Cabeceras', pgaRange: '0.20 - 0.45 g', radioM: 65000, color: [255, 140, 0, 125], borde: [255, 180, 0, 200] },
            { mmi: 'V - VI', label: 'Fuerte Sacudimiento Municipal', pgaRange: '0.08 - 0.20 g', radioM: 110000, color: [255, 214, 10, 80], borde: [255, 230, 80, 170] },
            { mmi: 'IV', label: 'Perceptible en Región Central', pgaRange: '0.03 - 0.08 g', radioM: 175000, color: [56, 189, 248, 55], borde: [56, 189, 248, 160] },
            { mmi: 'II - III', label: 'Débil en Eje Cafetero y Valle de Aburrá', pgaRange: '< 0.03 g', radioM: 320000, color: [30, 64, 175, 30], borde: [96, 165, 250, 120] }
        ]
    },
    'bahia_solano_70': {
        nombre: 'Falla Bahía Solano (Costa Pacífica)',
        anio: 1970,
        fechaCompleta: '26 de Septiembre de 1970',
        tipoEvento: 'Terremoto Histórico de Costa',
        noticiaUrl: 'https://historiasismica.sgc.gov.co/',
        noticiaTexto: 'Catálogo SGC - Terremoto Bahía Solano 1970',
        mw: 7.0,
        profundidad: 18,
        epicentro: [-77.40, 6.22],
        falla: 'Falla de Bahía Solano',
        pgaMax: '0.64 g',
        radioDestrKm: 38,
        strikeDeg: 345, // Rumbo N15W línea costera
        faultLengthKm: 52,
        faultCoords: [
            [-77.34, 5.95],
            [-77.40, 6.22],
            [-77.46, 6.50]
        ],
        isoseistas: [
            { mmi: 'VIII', label: 'Daño Severo en Costa y Serranía', pgaRange: '≥ 0.48 g', radioM: 38000, color: [255, 59, 48, 175], borde: [255, 255, 255, 240] },
            { mmi: 'VII', label: 'Fuerte en Bahía Solano y Nuquí', pgaRange: '0.22 - 0.48 g', radioM: 78000, color: [255, 140, 0, 125], borde: [255, 180, 0, 200] },
            { mmi: 'V - VI', label: 'Perceptible en Valle del Atrato', pgaRange: '0.09 - 0.22 g', radioM: 130000, color: [255, 214, 10, 80], borde: [255, 230, 80, 170] },
            { mmi: 'IV', label: 'Perceptible en Cordillera', pgaRange: '0.03 - 0.09 g', radioM: 200000, color: [56, 189, 248, 55], borde: [56, 189, 248, 160] },
            { mmi: 'II - III', label: 'Débil en Urabá Antioqueño y Cuenca del San Juan', pgaRange: '< 0.03 g', radioM: 360000, color: [30, 64, 175, 30], borde: [96, 165, 250, 120] }
        ]
    }
};

// ============================================================================
// HELPERS DE SEGURIDAD, VIEWPORT CLAMPING Y FORMATO DE TOOLTIPS SHAKEMAP
// ============================================================================
function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function positionTooltip(tooltipEl, x, y, offsetX = 14, offsetY = 14) {
    if (!tooltipEl) return;
    const rect = tooltipEl.getBoundingClientRect();
    const w = rect.width || 280;
    const h = rect.height || 180;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let posX = x + offsetX;
    let posY = y - h - offsetY;

    if (posX + w > vw - 14) posX = x - w - offsetX;
    if (posX < 14) posX = 14;
    if (posY < 14) posY = y + offsetY + 18;
    if (posY + h > vh - 14) posY = vh - h - 14;

    tooltipEl.style.transform = 'none';
    tooltipEl.style.left = `${posX}px`;
    tooltipEl.style.top = `${posY}px`;
}

const MMI_PALETTE_DECK = {
    'I':    { bg: '#38bdf8', text: '#082f49' },
    'II':   { bg: '#38bdf8', text: '#082f49' },
    'III':  { bg: '#22d3ee', text: '#083344' },
    'IV':   { bg: '#4ade80', text: '#052e16' },
    'V':    { bg: '#a3e635', text: '#1a2e05' },
    'VI':   { bg: '#facc15', text: '#422006' },
    'VII':  { bg: '#fb923c', text: '#431407' },
    'VIII': { bg: '#f87171', text: '#450a0a' },
    'IX':   { bg: '#ef4444', text: '#ffffff' },
    'X':    { bg: '#dc2626', text: '#ffffff' }
};

function getMmiBadgeStyle(mmiStr) {
    const raw = String(mmiStr || '').trim().toUpperCase();
    let entry = MMI_PALETTE_DECK['VI'];
    for (const key of Object.keys(MMI_PALETTE_DECK)) {
        if (raw.includes(key)) entry = MMI_PALETTE_DECK[key];
    }
    return `background:${entry.bg}; color:${entry.text}; font-weight:700; padding:2px 7px; border-radius:6px; font-size:var(--fs-2xs); letter-spacing:0.04em; text-transform:uppercase;`;
}

function formatShakemapEpicentroTooltip(d) {
    const safeNombre = escapeHtml(d.nombre || 'Escenario Cosísmico');
    const safeFalla = escapeHtml(d.falla || 'Falla Geológica Activa');
    const safePga = escapeHtml(d.pgaMax || '0.50 g');
    const mw = Number(d.mw || 7.0).toFixed(1);
    const prof = Number(d.profundidad || 15);
    const strike = Number(d.strikeDeg || 0);
    const lengthKm = Number(d.faultLengthKm || 45);
    const anio = escapeHtml(d.anio || '');

    const profTipo = prof < 30 ? 'Superficial (Corteza Superior)' : (prof < 70 ? 'Intermedio (Losa Subducente)' : 'Profundo (Intralosa Nazca)');
    const pgaVal = parseFloat(safePga) || 0.5;
    const pgaPct = Math.round(pgaVal * 100);

    return `
        <div style="font-family:'Inter',system-ui,sans-serif; max-width:320px; line-height:1.4; color:#f8fafc;">
            <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid rgba(255,255,255,0.12); padding-bottom:7px; margin-bottom:8px;">
                <div style="display:flex; align-items:center; gap:6px;">
                    <span style="font-size:var(--fs-md);">⚡</span>
                    <strong style="font-size:var(--fs-sm); color:#fff;">Foco Epicentral (${anio})</strong>
                </div>
                <span style="background:rgba(255,69,58,0.22); color:#ff6961; border:1px solid #ff453a; border-radius:6px; padding:1px 6px; font-size:var(--fs-2xs); font-weight:700;">
                    ${mw} Mw
                </span>
            </div>

            <div style="font-size:var(--fs-xs); font-weight:600; color:#cbd5e1; margin-bottom:8px;">
                ${safeNombre}
            </div>

            <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-bottom:8px;">
                <div style="background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); border-radius:8px; padding:5px 8px;">
                    <span style="display:block; font-size:var(--fs-2xs); color:#94a3b8; text-transform:uppercase;">Profundidad Focal</span>
                    <strong style="font-size:var(--fs-sm); color:#38bdf8;">${prof} km</strong>
                </div>
                <div style="background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); border-radius:8px; padding:5px 8px;">
                    <span style="display:block; font-size:var(--fs-2xs); color:#94a3b8; text-transform:uppercase;">PGA Epicentral</span>
                    <strong style="font-size:var(--fs-sm); color:#ffd60a;">${safePga}</strong>
                    <span style="font-size:var(--fs-2xs); color:#94a3b8;">(~${pgaPct}% g)</span>
                </div>
                <div style="background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); border-radius:8px; padding:5px 8px;">
                    <span style="display:block; font-size:var(--fs-2xs); color:#94a3b8; text-transform:uppercase;">Rumbo (Strike)</span>
                    <strong style="font-size:var(--fs-sm); color:#e2e8f0;">N${strike}°E</strong>
                </div>
                <div style="background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); border-radius:8px; padding:5px 8px;">
                    <span style="display:block; font-size:var(--fs-2xs); color:#94a3b8; text-transform:uppercase;">Longitud Plano</span>
                    <strong style="font-size:var(--fs-sm); color:#e2e8f0;">${lengthKm} km</strong>
                </div>
            </div>

            <div style="background:rgba(239,68,68,0.1); border-left:3px solid #ef4444; padding:6px 8px; border-radius:4px; font-size:var(--fs-xs); color:#fca5a5;">
                <strong>Estructura:</strong> ${safeFalla} (${profTipo}). Aceleración severa con potencial de daño directo en mampostería no confinada y palafitos.
            </div>
        </div>
    `;
}

function formatShakemapFaultTraceTooltip(infoObj, currentData) {
    const safeNombre = escapeHtml(infoObj.nombre || currentData.falla || 'Falla Geológica Activa');
    const lengthKm = Number(currentData.faultLengthKm || 45);
    const prof = Number(infoObj.prof || currentData.profundidad || 15);

    return `
        <div style="font-family:'Inter',system-ui,sans-serif; max-width:300px; line-height:1.4; color:#f8fafc;">
            <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid rgba(255,255,255,0.12); padding-bottom:6px; margin-bottom:8px;">
                <div style="display:flex; align-items:center; gap:6px;">
                    <span style="display:inline-block; width:10px; height:10px; background:#ef4444; border-radius:2px; box-shadow:0 0 6px #ef4444;"></span>
                    <strong style="font-size:var(--fs-sm); color:#fff;">Plano de Ruptura Cosísmico</strong>
                </div>
                <span style="font-size:var(--fs-2xs); color:#94a3b8; font-family: var(--font-mono);">Falla Finita</span>
            </div>

            <div style="font-size:var(--fs-xs); font-weight:600; color:#38bdf8; margin-bottom:8px;">
                ${safeNombre}
            </div>

            <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-bottom:8px;">
                <div style="background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); border-radius:6px; padding:5px 7px;">
                    <span style="font-size:var(--fs-2xs); color:#94a3b8; display:block;">Longitud Estimada</span>
                    <strong style="font-size:var(--fs-sm); color:#fff;">${lengthKm} km</strong>
                </div>
                <div style="background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); border-radius:6px; padding:5px 7px;">
                    <span style="font-size:var(--fs-2xs); color:#94a3b8; display:block;">Profundidad de Foco</span>
                    <strong style="font-size:var(--fs-sm); color:#fff;">${prof} km</strong>
                </div>
            </div>

            <p style="font-size:var(--fs-xs); color:#cbd5e1; margin:0; line-height:1.35;">
                Traza de dislocación tectónica y liberación de energía elástica. En el campo cercano rige directividad cosísmica e incremento de frecuencias destructivas.
            </p>
        </div>
    `;
}

function formatShakemapIsoseistaTooltip(obj) {
    const safeMmi = escapeHtml(obj.mmi || 'VI');
    const safeLabel = escapeHtml(obj.label || 'Sacudimiento Fuerte');
    const safePgaRange = escapeHtml(obj.pgaRange || '0.10 - 0.25 g');
    const radioKm = Number(obj.radioKm || 0);

    let efectoDesc = 'Perceptible por la población; oscilación de lámparas y líquidos en reposo.';
    if (safeMmi.includes('VIII') || safeMmi.includes('IX') || safeMmi.includes('X')) {
        efectoDesc = 'Destrucción severa y colapso generalizado en edificaciones de mampostería no reforzada, bahareque y palafitos; fallas en puentes, deslizamientos en masa cosísmicos y licuación severa en valles aluviales.';
    } else if (safeMmi.includes('VII')) {
        efectoDesc = 'Daño severo con colapsos estructurales parciales y totales comprobados en edificaciones antiguas, tapia pisada, mampostería no confinada y muros de carga (vulnerabilidad observada en Pereira, Manizales, Armenia y Cartago); agrietamiento de columnas y caída de fachadas.';
    } else if (safeMmi.includes('VI') || safeMmi.includes('V - VI')) {
        efectoDesc = 'Sacudimiento violento generalizado; colapsos parciales de muros divisorios, fisuración de pórticos estructurales, caída de mampostería en voladizos y daños moderados a graves en viviendas vulnerables y laderas inestables.';
    } else if (safeMmi.includes('IV') || safeMmi.includes('V')) {
        efectoDesc = 'Sentido ampliamente con alarma general; fisuración leve en acabados, caída de cornisas, oscilación fuerte en estructuras elevadas sin compromiso del sistema estructural sismorresistente.';
    } else if (safeMmi.includes('II') || safeMmi.includes('III')) {
        efectoDesc = 'Perceptible por personas en reposo y pisos altos; amplificación dinámica de ondas de periodo largo en cuencas sedimentarias profundas (Costa Caribe: Sucre, Córdoba, y sabana de Bogotá).';
    }

    return `
        <div style="font-family:'Inter',system-ui,sans-serif; max-width:310px; line-height:1.4; color:#f8fafc;">
            <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid rgba(255,255,255,0.12); padding-bottom:6px; margin-bottom:8px;">
                <div style="display:flex; align-items:center; gap:6px;">
                    <span style="font-size:var(--fs-md);">💥</span>
                    <strong style="font-size:var(--fs-sm); color:#fff;">ShakeMap: Isoseista</strong>
                </div>
                <span style="${getMmiBadgeStyle(safeMmi)}">
                    MMI ${safeMmi}
                </span>
            </div>

            <div style="font-size:var(--fs-sm); font-weight:600; color:#ffd60a; margin-bottom:6px;">
                ${safeLabel}
            </div>

            <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-bottom:8px;">
                <div style="background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); border-radius:6px; padding:5px 7px;">
                    <span style="font-size:var(--fs-2xs); color:#94a3b8; display:block;">Aceleración Pico (PGA)</span>
                    <strong style="font-size:var(--fs-sm); color:#38bdf8;">${safePgaRange}</strong>
                </div>
                <div style="background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); border-radius:6px; padding:5px 7px;">
                    <span style="font-size:var(--fs-2xs); color:#94a3b8; display:block;">Radio Atenuación</span>
                    <strong style="font-size:var(--fs-sm); color:#fff;">~${radioKm} km</strong>
                </div>
            </div>

            <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.06); border-radius:6px; padding:6px 8px; font-size:var(--fs-xs); color:#cbd5e1; line-height:1.35;">
                <strong style="color:#e2e8f0; display:block; margin-bottom:2px;">Efectos Físicos Estimados:</strong>
                ${efectoDesc}
            </div>
        </div>
    `;
}

function formatShakemapWavePTooltip(infoObj, velKmS) {
    const distKm = escapeHtml(infoObj.distKm || '0.0');
    const tSec = escapeHtml(infoObj.tSec || '0.0');
    const vel = Number(velKmS || 6.0).toFixed(1);

    return `
        <div style="font-family:'Inter',system-ui,sans-serif; max-width:290px; line-height:1.4; color:#f8fafc;">
            <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid rgba(255,255,255,0.12); padding-bottom:6px; margin-bottom:8px;">
                <div style="display:flex; align-items:center; gap:6px;">
                    <span style="display:inline-block; width:9px; height:9px; border-radius:50%; background:#38bdf8; box-shadow:0 0 8px #38bdf8;"></span>
                    <strong style="font-size:var(--fs-sm); color:#38bdf8;">Frente de Onda P</strong>
                </div>
                <span style="background:rgba(56,189,248,0.2); color:#38bdf8; border:1px solid rgba(56,189,248,0.4); border-radius:4px; padding:1px 6px; font-size:var(--fs-2xs); font-weight:700;">
                    Compresional
                </span>
            </div>

            <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-bottom:8px;">
                <div style="background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); border-radius:6px; padding:5px 7px;">
                    <span style="font-size:var(--fs-2xs); color:#94a3b8; display:block;">Velocidad Media</span>
                    <strong style="font-size:var(--fs-sm); color:#fff;">${vel} km/s</strong>
                </div>
                <div style="background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); border-radius:6px; padding:5px 7px;">
                    <span style="font-size:var(--fs-2xs); color:#94a3b8; display:block;">Radio Frontal</span>
                    <strong style="font-size:var(--fs-sm); color:#fff;">${distKm} km</strong>
                </div>
            </div>

            <div style="font-size:var(--fs-xs); color:#cbd5e1; line-height:1.35;">
                <p style="margin:0 0 4px 0;"><strong>Tiempo Cosísmico:</strong> <span style="font-family: var(--font-mono); color:#38bdf8;">t = ${tSec} s</span></p>
                <p style="margin:0; font-size:var(--fs-2xs); color:#94a3b8;">
                    Fase inicial de alerta previa. Produce vibración longitudinal leve y sirve como base técnica para sistemas de alerta temprana (EEW).
                </p>
            </div>
        </div>
    `;
}

function formatShakemapWaveSTooltip(infoObj, velKmS) {
    const distKm = escapeHtml(infoObj.distKm || '0.0');
    const tSec = escapeHtml(infoObj.tSec || '0.0');
    const vel = Number(velKmS || 3.5).toFixed(1);

    return `
        <div style="font-family:'Inter',system-ui,sans-serif; max-width:295px; line-height:1.4; color:#f8fafc;">
            <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid rgba(255,255,255,0.12); padding-bottom:6px; margin-bottom:8px;">
                <div style="display:flex; align-items:center; gap:6px;">
                    <span style="display:inline-block; width:9px; height:9px; border-radius:50%; background:#ef4444; box-shadow:0 0 8px #ef4444;"></span>
                    <strong style="font-size:var(--fs-sm); color:#ef4444;">Frente de Onda S</strong>
                </div>
                <span style="background:rgba(239,68,68,0.2); color:#fca5a5; border:1px solid #ef4444; border-radius:4px; padding:1px 6px; font-size:var(--fs-2xs); font-weight:700;">
                    Tren Destructor
                </span>
            </div>

            <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-bottom:8px;">
                <div style="background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); border-radius:6px; padding:5px 7px;">
                    <span style="font-size:var(--fs-2xs); color:#94a3b8; display:block;">Velocidad Media</span>
                    <strong style="font-size:var(--fs-sm); color:#fff;">${vel} km/s</strong>
                </div>
                <div style="background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); border-radius:6px; padding:5px 7px;">
                    <span style="font-size:var(--fs-2xs); color:#94a3b8; display:block;">Alcance Cizallante</span>
                    <strong style="font-size:var(--fs-sm); color:#fff;">${distKm} km</strong>
                </div>
            </div>

            <div style="font-size:var(--fs-xs); color:#cbd5e1; line-height:1.35;">
                <p style="margin:0 0 4px 0;"><strong>Tiempo Cosísmico:</strong> <span style="font-family: var(--font-mono); color:#ef4444;">t = ${tSec} s</span></p>
                <p style="margin:0; font-size:var(--fs-2xs); color:#fca5a5;">
                    Onda secundaria de corte transversal. Concentra la mayor energía destructiva y deformación dinámica, excitando estructuras y entrepisos.
                </p>
            </div>
        </div>
    `;
}

const selectShakemap = document.getElementById('select-shakemap-escenario');
const btnToggleShakemap = document.getElementById('btn-toggle-shakemap');
const btnClearShakemap = document.getElementById('btn-clear-shakemap');
const shakemapText = document.getElementById('btn-shakemap-text');
const shakemapImpactBox = document.getElementById('shakemap-impact-box');
const shakemapWaveControls = document.getElementById('shakemap-wave-controls');
const btnWavePlay = document.getElementById('btn-wave-play');
const btnWaveReset = document.getElementById('btn-wave-reset');
const wavePlayIcon = document.getElementById('wave-play-icon');
const wavePlayText = document.getElementById('wave-play-text');
const shakemapTimerLabel = document.getElementById('shakemap-timer-label');
const shakemapTimerProgress = document.getElementById('shakemap-timer-progress');
const shakemapEtaQuibdo = document.getElementById('shakemap-eta-quibdo');
const shakemapEtaIstmina = document.getElementById('shakemap-eta-istmina');
const shakemapEtaMedellin = document.getElementById('shakemap-eta-medellin');
const shakemapEtaSucre = document.getElementById('shakemap-eta-sucre');

// Coordenadas geográficas de referencia de centros urbanos y departamentales
const COORDS_QUIBDO = [-76.658, 5.692];
const COORDS_ISTMINA = [-76.683, 5.161];
const COORDS_MEDELLIN = [-75.567, 6.247];
const COORDS_SUCRE_SINCELEJO = [-75.397, 9.304];

function calculateETA(epi, targetCoords, velKmS) {
    if (!epi || !targetCoords) return '--';
    const cosLat = Math.cos(((epi[1] + targetCoords[1]) / 2) * Math.PI / 180);
    const dx = (targetCoords[0] - epi[0]) * 111.32 * cosLat;
    const dy = (targetCoords[1] - epi[1]) * 110.57;
    const distKm = Math.hypot(dx, dy);
    const etaSec = distKm / velKmS;
    return `${etaSec.toFixed(1)} s (${Math.round(distKm)} km)`;
}

function updateWaveUI() {
    if (shakemapTimerLabel) {
        shakemapTimerLabel.innerText = `t = ${waveAnimTimeSec.toFixed(1)} s / ${WAVE_MAX_TIME_SEC.toFixed(0)} s`;
    }
    if (shakemapTimerProgress) {
        const pct = Math.min(100, (waveAnimTimeSec / WAVE_MAX_TIME_SEC) * 100);
        shakemapTimerProgress.style.width = `${pct}%`;
    }
    if (currentShakemapData && currentShakemapData.epicentro) {
        const epi = currentShakemapData.epicentro;
        if (shakemapEtaQuibdo) {
            shakemapEtaQuibdo.innerText = `Onda S: ${calculateETA(epi, COORDS_QUIBDO, WAVE_VEL_S_KMS)}`;
        }
        if (shakemapEtaIstmina) {
            shakemapEtaIstmina.innerText = `Onda S: ${calculateETA(epi, COORDS_ISTMINA, WAVE_VEL_S_KMS)}`;
        }
        if (shakemapEtaMedellin) {
            shakemapEtaMedellin.innerText = `Onda S: ${calculateETA(epi, COORDS_MEDELLIN, WAVE_VEL_S_KMS)}`;
        }
        if (shakemapEtaSucre) {
            shakemapEtaSucre.innerText = `Onda S: ${calculateETA(epi, COORDS_SUCRE_SINCELEJO, WAVE_VEL_S_KMS)}`;
        }
    }
}

function stepWaveAnimation(timestamp) {
    if (!isWaveAnimPlaying) return;
    if (!waveAnimLastTimestamp) waveAnimLastTimestamp = timestamp;
    const dtSec = (timestamp - waveAnimLastTimestamp) / 1000;
    waveAnimLastTimestamp = timestamp;

    // Avance temporal a escala 1x
    waveAnimTimeSec += dtSec;
    if (waveAnimTimeSec >= WAVE_MAX_TIME_SEC) {
        waveAnimTimeSec = WAVE_MAX_TIME_SEC;
        stopWaveAnimation();
    }

    updateWaveUI();
    renderLayers({ skipChart: true });

    if (isWaveAnimPlaying) {
        waveAnimRafId = requestAnimationFrame(stepWaveAnimation);
    }
}

function startWaveAnimation() {
    if (isWaveAnimPlaying) return;
    if (waveAnimTimeSec >= WAVE_MAX_TIME_SEC) {
        waveAnimTimeSec = 0.0;
    }
    isWaveAnimPlaying = true;
    waveAnimLastTimestamp = null;
    if (wavePlayIcon) wavePlayIcon.innerText = '⏸';
    if (wavePlayText) wavePlayText.innerText = 'Pausar Ondas';
    waveAnimRafId = requestAnimationFrame(stepWaveAnimation);
}

function stopWaveAnimation() {
    isWaveAnimPlaying = false;
    if (waveAnimRafId) {
        cancelAnimationFrame(waveAnimRafId);
        waveAnimRafId = null;
    }
    waveAnimLastTimestamp = null;
    if (wavePlayIcon) wavePlayIcon.innerText = '▶';
    if (wavePlayText) wavePlayText.innerText = 'Propagar Ondas';
}

function resetWaveAnimation() {
    stopWaveAnimation();
    waveAnimTimeSec = 0.0;
    updateWaveUI();
    renderLayers({ skipChart: true });
}

async function activateShakemap(scenarioKey) {
    const scenario = SHAKEMAP_SCENARIOS[scenarioKey];
    if (!scenario) return;

    activeShakemapScenario = scenarioKey;
    isSimulatorActive = true;
    currentShakemapData = scenario;
    waveAnimTimeSec = 0.0;

    if (shakemapText) shakemapText.innerHTML = '🔄 Recalcular Ruptura';
    if (btnClearShakemap) btnClearShakemap.style.display = 'inline-flex';
    if (btnToggleShakemap) {
        btnToggleShakemap.style.background = '#ff453a';
        btnToggleShakemap.style.color = '#fff';
    }

    if (shakemapWaveControls) shakemapWaveControls.style.display = 'block';
    if (shakemapImpactBox) {
        shakemapImpactBox.style.display = 'block';
        const lblEpi = document.getElementById('shakemap-epicentro-label');
        const lblPga = document.getElementById('shakemap-pga-max');
        const lblRad = document.getElementById('shakemap-radio-destr');
        const badgeMmi = document.getElementById('shakemap-mmi-max');

        if (lblEpi) lblEpi.innerText = `Epicentro: ${scenario.nombre.split('(')[0].trim()}`;
        if (lblPga) lblPga.innerText = scenario.pgaMax;
        if (lblRad) lblRad.innerText = `~${scenario.faultLengthKm || 48} km (${scenario.falla.split('(')[0].trim()})`;
        if (badgeMmi) badgeMmi.innerText = scenario.isoseistas[0].mmi;
    }

    updateWaveUI();

    // Cámara vuela suavemente hacia el epicentro y plano de falla (encuadre optimizado para escala macrosisimica)
    if (deckgl && scenario.epicentro) {
        const targetZoom = scenario.mw >= 8.0 ? 6.2 : (scenario.profundidad > 70 ? 6.6 : 7.2);
        deckgl.setProps({
            initialViewState: {
                longitude: scenario.epicentro[0],
                latitude: scenario.epicentro[1],
                zoom: targetZoom,
                pitch: 42,
                bearing: 12,
                transitionDuration: 1400,
                transitionInterpolator: new deck.FlyToInterpolator()
            }
        });
    }

    // Iniciar automáticamente la cinemática de ondas P y S
    startWaveAnimation();
    renderLayers();
}

function deactivateShakemap({ skipRender = false } = {}) {
    stopWaveAnimation();
    isSimulatorActive = false;
    currentShakemapData = null;
    waveAnimTimeSec = 0.0;

    if (shakemapText) shakemapText.innerHTML = '⚡ Simular Ruptura Sísmica';
    if (btnClearShakemap) btnClearShakemap.style.display = 'none';
    if (btnToggleShakemap) {
        btnToggleShakemap.style.background = 'rgba(255,59,48,0.15)';
        btnToggleShakemap.style.color = '#ff453a';
    }
    if (shakemapWaveControls) shakemapWaveControls.style.display = 'none';
    if (shakemapImpactBox) shakemapImpactBox.style.display = 'none';

    if (!skipRender) renderLayers();
}

if (btnWavePlay) {
    btnWavePlay.addEventListener('click', () => {
        if (isWaveAnimPlaying) {
            stopWaveAnimation();
        } else {
            startWaveAnimation();
        }
    });
}

if (btnWaveReset) {
    btnWaveReset.addEventListener('click', () => {
        resetWaveAnimation();
    });
}

// Funciones globales expuestas para activación directa y a prueba de fallos
window.triggerShakemapToggle = function() {
    const sel = document.getElementById('select-shakemap-escenario');
    const scenarioKey = sel ? sel.value : (activeShakemapScenario || 'palmar_74');
    activateShakemap(scenarioKey);
};

window.triggerShakemapClear = function() {
    deactivateShakemap();
};

if (btnClearShakemap) {
    btnClearShakemap.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.triggerShakemapClear();
    });
}

if (btnToggleShakemap) {
    btnToggleShakemap.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.triggerShakemapToggle();
    });
}

if (selectShakemap) {
    selectShakemap.addEventListener('change', () => {
        if (isSimulatorActive) {
            window.triggerShakemapToggle();
        }
    });
}

// ============================================================================
// SISTEMA GLOBAL DE ATAJOS DE TECLADO NUMÉRICO (0 - 9)
// ============================================================================
function showShortcutToast(keyChar, label, icon = '⌨️') {
    let toast = document.getElementById('shortcut-quick-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'shortcut-quick-toast';
        toast.style.cssText = `
            position: fixed;
            bottom: 24px;
            right: 24px;
            z-index: 100000;
            background: rgba(15, 23, 42, 0.94);
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            border: 1px solid rgba(56, 189, 248, 0.4);
            border-radius: 12px;
            padding: 10px 16px;
            color: #F8FAFC;
            font-family: var(--font-sans);
            font-size: var(--fs-sm);
            display: flex;
            align-items: center;
            gap: 10px;
            box-shadow: 0 10px 25px rgba(0,0,0,0.5), 0 0 15px rgba(56,189,248,0.2);
            pointer-events: none;
            opacity: 0;
            transform: translateY(12px);
            transition: all 0.22s cubic-bezier(0.16, 1, 0.3, 1);
        `;
        document.body.appendChild(toast);
    }

    toast.innerHTML = `
        <span style="display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; border-radius:6px; background:#0284c7; color:#fff; font-weight:700; font-family: var(--font-mono); font-size:var(--fs-sm); border:1px solid #38bdf8;">${keyChar}</span>
        <span style="font-weight:600; color:#E2E8F0;">${icon} ${label}</span>
    `;

    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';

    if (window._shortcutToastTimer) clearTimeout(window._shortcutToastTimer);
    window._shortcutToastTimer = setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(12px)';
    }, 1800);
}

// ============================================================================
// SISTEMA DE TELEMETRÍA Y MÉTRICA DE INTERACCIÓN (TECLADO VS PUNTERO/RATÓN)
// ============================================================================
const interactionTelemetry = {
    keyboardEvents: 0,
    pointerEvents: 0,
    eventsLog: [],
    startTime: Date.now(),

    record(mode, action, details = {}) {
        const timestamp = Date.now();
        if (mode === 'keyboard') {
            this.keyboardEvents++;
        } else if (mode === 'pointer') {
            this.pointerEvents++;
        }
        this.eventsLog.push({
            timestamp,
            elapsedSec: parseFloat(((timestamp - this.startTime) / 1000).toFixed(2)),
            mode, // 'keyboard' | 'pointer'
            action,
            details
        });

        // Mantener tope en memoria para evitar saturación de heap en sesiones extensas
        if (this.eventsLog.length > 2500) {
            this.eventsLog.shift();
        }
    },

    getReport() {
        const total = this.keyboardEvents + this.pointerEvents;
        const keyboardRatio = total > 0 ? ((this.keyboardEvents / total) * 100).toFixed(1) : 0;
        const pointerRatio = total > 0 ? ((this.pointerEvents / total) * 100).toFixed(1) : 0;
        const durationMin = ((Date.now() - this.startTime) / 60000).toFixed(2);
        return {
            totalInteractions: total,
            keyboardEvents: this.keyboardEvents,
            pointerEvents: this.pointerEvents,
            keyboardUsagePercent: parseFloat(keyboardRatio),
            pointerUsagePercent: parseFloat(pointerRatio),
            sessionDurationMinutes: parseFloat(durationMin),
            eventsLog: this.eventsLog
        };
    },

    exportReportJSON() {
        const report = this.getReport();
        const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `sismochoco_telemetria_ux_${Date.now()}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
};
window.interactionTelemetry = interactionTelemetry;

let __suppressNextClickTelemetry = false;
function triggerProgrammaticClick(el) {
    if (!el) return;
    __suppressNextClickTelemetry = true;
    try {
        el.click();
    } finally {
        setTimeout(() => { __suppressNextClickTelemetry = false; }, 0);
    }
}

// Escuchador global de interacción (teclado Enter/Espacio o puntero/ratón) para telemetría
window.addEventListener('click', (e) => {
    if (__suppressNextClickTelemetry || !e.isTrusted) return;
    const target = e.target;
    const tag = (target && target.tagName) ? target.tagName : '';
    const id = target ? (target.id || target.className || tag) : '';
    const mode = (e.detail === 0) ? 'keyboard' : 'pointer';
    interactionTelemetry.record(mode, 'click', { targetId: id, tagName: tag });
}, { passive: true });

// Desplazamiento y orientación orbital del mapa 3D con teclas de flecha
function panMapWithArrows(dx, dy, isShift) {
    if (!deckgl) return;
    const vs = (deckgl.viewState && deckgl.viewState.longitude !== undefined)
        ? { ...deckgl.viewState }
        : { longitude: -77.0, latitude: 6.0, zoom: 6.5, pitch: 45, bearing: 15 };

    if (isShift) {
        // Shift + Flecha: Modificar Inclinación (Pitch) y Orientación Azimutal (Bearing)
        if (dy !== 0) {
            vs.pitch = Math.max(0, Math.min(85, (vs.pitch || 45) - dy * 5));
        }
        if (dx !== 0) {
            vs.bearing = ((vs.bearing || 15) + dx * 10) % 360;
        }
    } else {
        // Flecha simple: Desplazamiento geográfico cartográfico (Pan)
        const currentZoom = vs.zoom || 6.5;
        const latStep = Math.pow(2, 6.5 - currentZoom) * 0.25;
        const lngStep = latStep / Math.cos(((vs.latitude || 6.0) * Math.PI) / 180);
        vs.latitude = Math.max(-4.0, Math.min(13.0, (vs.latitude || 6.0) + dy * latStep));
        vs.longitude = Math.max(-84.0, Math.min(-66.0, (vs.longitude || -77.0) + dx * lngStep));
    }

    vs.transitionDuration = 220;
    vs.transitionInterpolator = new deck.LinearInterpolator(['longitude', 'latitude', 'pitch', 'bearing']);
    deckgl.setProps({ initialViewState: vs });
}

function initKeyboardShortcuts() {
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const im = document.getElementById('info-modal');
            const fm = document.getElementById('modal-ficha-pot');
            if (im && im.style.display !== 'none') {
                im.style.opacity = '0';
                setTimeout(() => { im.style.display = 'none'; }, 250);
            }
            if (fm && fm.style.display !== 'none') {
                fm.style.opacity = '0';
                setTimeout(() => { fm.style.display = 'none'; }, 250);
            }
            if (pinnedInspectorItem) {
                pinnedInspectorItem = null;
                renderPinnedInspector();
            }
            return;
        }

        // Ignorar atajos de una letra si el usuario está interactuando con campos editables
        const target = e.target;
        const tag = (target && target.tagName) ? target.tagName.toUpperCase() : '';
        const isEditable = target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag));
        
        if (isEditable) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;

        // ====================================================================
        // NAVEGACIÓN Y CÁMARA 3D CON TECLAS DE FLECHA
        // ====================================================================
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
            e.preventDefault();
            const isShift = !!e.shiftKey;
            let actionName = '';
            let iconToast = isShift ? '🔄' : '🧭';

            if (e.key === 'ArrowUp') {
                panMapWithArrows(0, 1, isShift);
                actionName = isShift ? 'Inclinar Cámara (+)' : 'Mover Norte';
            } else if (e.key === 'ArrowDown') {
                panMapWithArrows(0, -1, isShift);
                actionName = isShift ? 'Aplanar Cámara (-)' : 'Mover Sur';
            } else if (e.key === 'ArrowLeft') {
                panMapWithArrows(-1, 0, isShift);
                actionName = isShift ? 'Rotar Órbita (Izquierda)' : 'Mover Oeste';
            } else if (e.key === 'ArrowRight') {
                panMapWithArrows(1, 0, isShift);
                actionName = isShift ? 'Rotar Órbita (Derecha)' : 'Mover Este';
            }

            interactionTelemetry.record('keyboard', actionName, { key: e.key, shift: isShift });
            showShortcutToast(isShift ? `⇧+${e.key.replace('Arrow', '')}` : e.key.replace('Arrow', ''), actionName, iconToast);
            return;
        }

        switch (e.key) {
            case 'Escape': {
                const im = document.getElementById('info-modal');
                const fm = document.getElementById('modal-ficha-pot');
                if (im && im.style.display !== 'none') {
                    im.style.opacity = '0';
                    setTimeout(() => { im.style.display = 'none'; }, 250);
                }
                if (fm && fm.style.display !== 'none') {
                    fm.style.opacity = '0';
                    setTimeout(() => { fm.style.display = 'none'; }, 250);
                }
                if (pinnedInspectorItem) {
                    pinnedInspectorItem = null;
                    renderPinnedInspector();
                }
                break;
            }
            case 'c':
            case 'C': {
                const btnCol = document.getElementById('btn-panel-collapse');
                if (btnCol) {
                    e.preventDefault();
                    triggerProgrammaticClick(btnCol);
                    const collapsed = document.body.classList.contains('panel-collapsed');
                    showShortcutToast('C', collapsed ? 'Panel Lateral Oculto' : 'Panel Lateral Visible', '▣');
                }
                break;
            }
            case '1': {
                e.preventDefault();
                interactionTelemetry.record('keyboard', 'Perfil: Sismo-Geología', { key: '1' });
                const tab1 = document.querySelector('.profile-tab[data-profile="sismologia"]');
                if (tab1) {
                    triggerProgrammaticClick(tab1);
                    showShortcutToast('1', 'Perfil: Sismo-Geología', '🌋');
                }
                break;
            }
            case '2': {
                e.preventDefault();
                interactionTelemetry.record('keyboard', 'Perfil: Diseño Estructural', { key: '2' });
                const tab2 = document.querySelector('.profile-tab[data-profile="nsr10"]');
                if (tab2) {
                    triggerProgrammaticClick(tab2);
                    showShortcutToast('2', 'Perfil: Diseño Estructural', '🏗️');
                }
                break;
            }
            case '3': {
                e.preventDefault();
                interactionTelemetry.record('keyboard', 'Perfil: Gestión Territorial', { key: '3' });
                const tab3 = document.querySelector('.profile-tab[data-profile="alcaldia"]');
                if (tab3) {
                    triggerProgrammaticClick(tab3);
                    showShortcutToast('3', 'Perfil: Gestión Territorial', '🏛️');
                }
                break;
            }
            case '4': {
                e.preventDefault();
                interactionTelemetry.record('keyboard', 'Visualización: Eventos 3D', { key: '4' });
                const btnPuntos = document.getElementById('btn-puntos');
                if (btnPuntos) {
                    triggerProgrammaticClick(btnPuntos);
                    showShortcutToast('4', 'Visualización: Eventos 3D', '⚪');
                }
                break;
            }
            case '5': {
                e.preventDefault();
                interactionTelemetry.record('keyboard', 'Visualización: Mapa de Calor', { key: '5' });
                const btnCalor = document.getElementById('btn-calor');
                if (btnCalor) {
                    triggerProgrammaticClick(btnCalor);
                    showShortcutToast('5', 'Visualización: Mapa de Calor', '🔥');
                }
                break;
            }
            case '6': {
                e.preventDefault();
                interactionTelemetry.record('keyboard', 'Visualización: Hexbins 3D', { key: '6' });
                const btnHex = document.getElementById('btn-hex');
                if (btnHex) {
                    triggerProgrammaticClick(btnHex);
                    showShortcutToast('6', 'Visualización: Hexbins 3D', '🔷');
                }
                break;
            }
            case '7': {
                e.preventDefault();
                interactionTelemetry.record('keyboard', 'Corte Benioff 3D', { key: '7' });
                const btnBenioff = document.getElementById('btn-benioff');
                if (btnBenioff) {
                    openAccordionForElement(btnBenioff);
                    triggerProgrammaticClick(btnBenioff);
                    const estado = isBenioffMode ? 'Activado' : 'Desactivado';
                    showShortcutToast('7', `Corte Benioff 3D: ${estado}`, '▣');
                }
                break;
            }
            case '8': {
                e.preventDefault();
                interactionTelemetry.record('keyboard', 'Telemetría FDSN Live', { key: '8' });
                const checkLive = document.getElementById('check-live-sgc');
                if (checkLive) {
                    openAccordionForElement(checkLive);
                    checkLive.checked = !checkLive.checked;
                    checkLive.dispatchEvent(new Event('change', { bubbles: true }));
                    const estado = checkLive.checked ? 'Conectado (En Vivo)' : 'Desconectado';
                    showShortcutToast('8', `Telemetría FDSN: ${estado}`, '●');
                }
                break;
            }
            case '9': {
                e.preventDefault();
                interactionTelemetry.record('keyboard', 'Fallas Geológicas', { key: '9' });
                const checkFallas = document.getElementById('check-fallas');
                if (checkFallas) {
                    openAccordionForElement(checkFallas);
                    checkFallas.checked = !checkFallas.checked;
                    checkFallas.dispatchEvent(new Event('change', { bubbles: true }));
                    const estado = checkFallas.checked ? 'Visibles' : 'Ocultas';
                    showShortcutToast('9', `Fallas Geológicas: ${estado}`, '⚡');
                }
                break;
            }
            case '0': {
                e.preventDefault();
                interactionTelemetry.record('keyboard', 'Restablecer Todo', { key: '0' });
                const btnHome = document.getElementById('btn-home');
                if (btnHome) {
                    triggerProgrammaticClick(btnHome);
                    showShortcutToast('0', 'Restablecer Todo', '🔄');
                }
                break;
            }

            // ================================================================
            // CONTROL DE ZOOM CARTOGRÁFICO DIRECTO CON TECLAS + / -
            // ================================================================
            case '+':
            case '=': {
                e.preventDefault();
                zoomMapWithKey(0.4);
                interactionTelemetry.record('keyboard', 'Acercar Zoom (+)', { key: '+' });
                showShortcutToast('+', 'Acercar Zoom', '🔍');
                break;
            }
            case '-':
            case '_': {
                e.preventDefault();
                zoomMapWithKey(-0.4);
                interactionTelemetry.record('keyboard', 'Alejar Zoom (-)', { key: '-' });
                showShortcutToast('-', 'Alejar Zoom', '🔎');
                break;
            }

            // ================================================================
            // PANEL HUD OCULTO DE TELEMETRÍA UX (TECLA T — sin interferir con Espacio)
            // ================================================================
            case 't':
            case 'T': {
                e.preventDefault();
                toggleUxTelemetryHud();
                interactionTelemetry.record('keyboard', 'Conmutar HUD Telemetría UX', { key: 'T' });
                break;
            }
        }
    });
}

// Función para zoom cartográfico directo con teclado
function zoomMapWithKey(deltaZoom) {
    if (!deckgl) return;
    const vs = (deckgl.viewState && deckgl.viewState.zoom !== undefined)
        ? { ...deckgl.viewState }
        : { longitude: -77.0, latitude: 6.0, zoom: 6.5, pitch: 45, bearing: 15 };

    const currentZoom = vs.zoom || 6.5;
    vs.zoom = Math.max(4.5, Math.min(12.5, currentZoom + deltaZoom));
    vs.transitionDuration = 200;
    vs.transitionInterpolator = new deck.LinearInterpolator(['zoom']);
    deckgl.setProps({ initialViewState: vs });
}

// Control interactivo del Panel HUD de Telemetría UX
function toggleUxTelemetryHud() {
    const hud = document.getElementById('ux-telemetry-hud');
    if (!hud) return;
    const isHidden = (hud.style.display === 'none' || !hud.style.display);
    if (isHidden) {
        updateUxTelemetryHud();
        hud.style.display = 'block';
        if (!window._telemetryHudTimer) {
            window._telemetryHudTimer = setInterval(updateUxTelemetryHud, 800);
        }
    } else {
        hud.style.display = 'none';
        if (window._telemetryHudTimer) {
            clearInterval(window._telemetryHudTimer);
            window._telemetryHudTimer = null;
        }
    }
}

function updateUxTelemetryHud() {
    const hud = document.getElementById('ux-telemetry-hud');
    if (!hud || hud.style.display === 'none') return;

    const rep = interactionTelemetry.getReport();
    const elKbPct = document.getElementById('hud-keyboard-pct');
    const elKbCnt = document.getElementById('hud-keyboard-count');
    const elPtPct = document.getElementById('hud-pointer-pct');
    const elPtCnt = document.getElementById('hud-pointer-count');
    const elBarKb = document.getElementById('hud-ratio-bar-keyboard');
    const elBarPt = document.getElementById('hud-ratio-bar-pointer');
    const elDuration = document.getElementById('hud-session-duration');
    const elTotal = document.getElementById('hud-total-events');

    if (elKbPct) elKbPct.innerText = `${rep.keyboardUsagePercent}%`;
    if (elKbCnt) elKbCnt.innerText = `${rep.keyboardEvents} eventos`;
    if (elPtPct) elPtPct.innerText = `${rep.pointerUsagePercent}%`;
    if (elPtCnt) elPtCnt.innerText = `${rep.pointerEvents} eventos`;
    if (elDuration) elDuration.innerText = `${rep.sessionDurationMinutes} min`;
    if (elTotal) elTotal.innerText = rep.totalInteractions;

    if (elBarKb && elBarPt) {
        const kbP = rep.totalInteractions > 0 ? rep.keyboardUsagePercent : 50;
        const ptP = rep.totalInteractions > 0 ? rep.pointerUsagePercent : 50;
        elBarKb.style.width = `${kbP}%`;
        elBarPt.style.width = `${ptP}%`;
    }
}

// Event Listeners para botones internos del HUD
document.addEventListener('DOMContentLoaded', () => {
    const btnCloseHud = document.getElementById('btn-close-ux-hud');
    if (btnCloseHud) btnCloseHud.addEventListener('click', () => toggleUxTelemetryHud());

    const btnExportHud = document.getElementById('btn-export-telemetry-hud');
    if (btnExportHud) btnExportHud.addEventListener('click', () => interactionTelemetry.exportReportJSON());

    const btnResetHud = document.getElementById('btn-reset-telemetry-hud');
    if (btnResetHud) {
        btnResetHud.addEventListener('click', () => {
            interactionTelemetry.keyboardEvents = 0;
            interactionTelemetry.pointerEvents = 0;
            interactionTelemetry.eventsLog = [];
            interactionTelemetry.startTime = Date.now();
            updateUxTelemetryHud();
        });
    }
});

initKeyboardShortcuts();
resetAllControlsToZero({ resetCamera: false, skipRender: true });
window.addEventListener('pageshow', (e) => {
    if (e.persisted) {
        resetAllControlsToZero({ resetCamera: true, skipRender: false });
    }
});
loadData();


