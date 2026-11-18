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

    // Pin de Ubicación y Halo de Amplificación Dinámica NSR-10 para Municipio Seleccionado
    if (selectedNsrMunicipio && selectedNsrMunicipio.lat) {
        const sueloSel = document.getElementById('nsr-suelo-select');
        const usoSel = document.getElementById('nsr-grupo-uso-select');
        const curSuelo = sueloSel ? sueloSel.value : (selectedNsrMunicipio.suelo_defecto || 'E');
        const curI = usoSel ? parseFloat(usoSel.value) : 1.0;
        const curFactors = getFactoresSitioNSR10(selectedNsrMunicipio.aa, selectedNsrMunicipio.av, curSuelo);
        const curSaMax = 2.5 * selectedNsrMunicipio.aa * curFactors.Fa * curI;
        const curPga = (curFactors.Fa * selectedNsrMunicipio.aa).toFixed(2);

        const SOIL_COLORS_RGB = {
            'A': [50, 215, 75],   // Roca Competente
            'B': [56, 189, 248],  // Roca Media
            'C': [255, 214, 10],  // Suelos Muy Densos / Roca Blanda
            'D': [255, 159, 10],  // Suelos Rígidos
            'E': [255, 69, 58],   // Suelos Blandos
            'F': [191, 90, 242]   // Suelos Especiales / Licuables
        };
        const baseSoilRgb = SOIL_COLORS_RGB[curSuelo] || [255, 69, 58];
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
        // Halo de área de influencia directa territorial (30 km de radio de monitoreo sismotectónico)
        layers.push(new deck.ScatterplotLayer({
            id: 'pot-municipio-influence-radius',
            data: [{ pos: [selectedPotMunicipio.lng, selectedPotMunicipio.lat] }],
            getPosition: d => [d.pos[0], d.pos[1], 5],
            radiusUnits: 'meters',
            getRadius: 30000,
            getFillColor: [50, 215, 75, 40],
            stroked: true,
            getLineColor: [50, 215, 75, 200],
            lineWidthMinPixels: 1.5,
            pickable: false,
            updateTriggers: {
                getPosition: [selectedPotMunicipio.lng, selectedPotMunicipio.lat]
            }
        }));

        // Pin de cabecera municipal POT
        layers.push(new deck.ScatterplotLayer({
            id: 'pot-municipio-pin',
            data: [{ pos: [selectedPotMunicipio.lng, selectedPotMunicipio.lat], m: selectedPotMunicipio }],
            getPosition: d => [d.pos[0], d.pos[1], 100],
            radiusUnits: 'pixels',
            getRadius: 15,
            getFillColor: [50, 215, 75, 230],
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

const modalData = {
    'guia': `
        <div style="display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid rgba(148,163,184,0.22); padding-bottom:14px; margin-bottom:18px;">
            <div style="display:flex; align-items:center; gap:12px;">
                <div style="width:42px; height:42px; border-radius:12px; background:linear-gradient(135deg, #0A84FF, #0056B3); display:flex; align-items:center; justify-content:center; font-size:var(--fs-lg); color:#FFFFFF;">
                    🗺️
                </div>
                <div>
                    <h2 style="margin:0; font-size:var(--fs-lg); font-weight:700;">¿Cómo usar SismoChocó?</h2>
                    <span style="font-size:var(--fs-xs); color:#0284C7; font-weight:600;">Guía rápida y sencilla para explorar la plataforma</span>
                </div>
            </div>
        </div>

        <p style="font-size:var(--fs-base); line-height:1.6; margin-bottom:16px;">
            <strong>SismoChocó</strong> es un mapa interactivo para entender dónde y por qué tiembla en el departamento del Chocó, qué municipios tienen mayor nivel de amenaza y qué precauciones deben tenerse en cuenta al construir o planificar el territorio.
        </p>

        <div style="background: rgba(10,132,255,0.12); border: 1.5px solid #0A84FF; border-radius: 14px; padding: 14px 16px; margin-bottom: 14px; display: flex; align-items: flex-start; gap: 14px;">
            <div style="flex-shrink:0; width: 32px; height: 32px; line-height: 32px; text-align: center; background: #0A84FF; color: #FFFFFF; border-radius: 50%; font-size: var(--fs-md); font-weight: bold;">
                ?
            </div>
            <div>
                <h4 style="margin: 0 0 4px 0; font-size: var(--fs-base); font-weight: 700;">Botones azules de ayuda (?) en cada sección</h4>
                <p style="margin: 0; font-size: var(--fs-sm); line-height: 1.5;">
                    Si en algún momento no entiendes qué hace un filtro, un color o una gráfica, toca el botón azul <strong>(?)</strong> que está a su lado. Se abrirá una explicación corta, en palabras cotidianas, con pasos claros sobre qué tocar y cómo leer el resultado.
                </p>
            </div>
        </div>

        <div style="background: rgba(245,158,11,0.12); border: 1.5px solid #F59E0B; border-radius: 14px; padding: 14px 16px; margin-bottom: 16px; display: flex; align-items: flex-start; gap: 14px;">
            <div style="flex-shrink:0; width: 32px; height: 32px; line-height: 32px; text-align: center; background: #F59E0B; color: #FFFFFF; border-radius: 50%; font-size: var(--fs-md); font-weight: bold;">
                ↺
            </div>
            <div>
                <h4 style="margin: 0 0 4px 0; font-size: var(--fs-base); font-weight: 700;">¿Cómo deshacer cambios o limpiar el mapa?</h4>
                <p style="margin: 0 0 8px 0; font-size: var(--fs-sm); line-height: 1.5;">
                    Puedes volver atrás en cualquier momento usando los botones circulares de flecha (<strong>↺ Restablecer</strong>) que aparecen junto a cada título o en la esquina derecha de la barra superior:
                </p>
                <ul style="margin: 0; padding-left: 18px; font-size: var(--fs-sm); line-height: 1.5;">
                    <li style="margin-bottom: 4px;"><strong>En Visualización Espacial:</strong> apaga los puntos, manchas de calor o torres 3D y deja el mapa limpio.</li>
                    <li style="margin-bottom: 4px;"><strong>En Filtros:</strong> vuelve a mostrar todos los sismos desde 1993 hasta hoy, de cualquier tamaño y profundidad.</li>
                    <li style="margin-bottom: 4px;"><strong>En Capas Avanzadas:</strong> apaga todas las capas adicionales (fallas, sismos en vivo, mapas de amenaza, vías y hospitales).</li>
                    <li><strong>Botón ⌂ en la barra superior:</strong> reinicia toda la plataforma y devuelve la cámara al mapa completo del Chocó.</li>
                </ul>
            </div>
        </div>

        <div style="background:rgba(148,163,184,0.08); border:1px solid rgba(148,163,184,0.22); border-radius:14px; padding:16px; margin-bottom:16px;">
            <h3 style="color:#0284C7; font-size:var(--fs-md); margin:0 0 10px 0;">1. Elige lo que quieres consultar (3 pestañas arriba)</h3>
            <div style="display:grid; grid-template-columns:1fr; gap:10px;">
                <div style="background:rgba(10,132,255,0.08); border-left:3px solid #0A84FF; padding:10px 12px; border-radius:6px;">
                    <strong>🌋 Sismo Geología:</strong>
                    <div style="font-size:var(--fs-sm); line-height:1.45; margin-top:3px;">
                        Para ver dónde han ocurrido los temblores históricos, qué tan profundos son, por dónde pasan las fallas geológicas, simular terremotos fuertes o consultar sismos recientes.
                    </div>
                </div>
                <div style="background:rgba(16,185,129,0.08); border-left:3px solid #10B981; padding:10px 12px; border-radius:6px;">
                    <strong>🏗️ Diseño Estructural:</strong>
                    <div style="font-size:var(--fs-sm); line-height:1.45; margin-top:3px;">
                        Para seleccionar un municipio y saber qué tanta fuerza sísmica exige la norma colombiana (NSR-10) al construir viviendas, colegios u hospitales según el tipo de terreno.
                    </div>
                </div>
                <div style="background:rgba(245,158,11,0.08); border-left:3px solid #F59E0B; padding:10px 12px; border-radius:6px;">
                    <strong>🏛️ Gestión Territorial:</strong>
                    <div style="font-size:var(--fs-sm); line-height:1.45; margin-top:3px;">
                        Para revisar el diagnóstico municipal orientado al Plan de Ordenamiento Territorial (POT), ver carreteras, ríos, hospitales y puertos, y descargar un resumen en PDF.
                    </div>
                </div>
            </div>
        </div>

        <div style="background:rgba(148,163,184,0.08); border:1px solid rgba(148,163,184,0.22); border-radius:14px; padding:16px; margin-bottom:16px;">
            <h3 style="color:#0284C7; font-size:var(--fs-md); margin:0 0 10px 0;">2. Cómo moverte por el mapa</h3>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; font-size:var(--fs-sm);">
                <div style="background:rgba(148,163,184,0.06); padding:8px 10px; border-radius:8px;">
                    <strong>🖱️ Clic izquierdo y arrastrar:</strong><br>Mover el mapa hacia cualquier lado.
                </div>
                <div style="background:rgba(148,163,184,0.06); padding:8px 10px; border-radius:8px;">
                    <strong>🔄 Clic derecho y arrastrar:</strong><br>Inclinar y girar el mapa para verlo en 3D.
                </div>
                <div style="background:rgba(148,163,184,0.06); padding:8px 10px; border-radius:8px;">
                    <strong>🔍 Rueda del ratón:</strong><br>Acercar o alejar la vista.
                </div>
                <div style="background:rgba(148,163,184,0.06); padding:8px 10px; border-radius:8px;">
                    <strong>☀️ Botón Claro:</strong><br>Cambia entre fondo oscuro y fondo claro para leer con mayor comodidad.
                </div>
            </div>
        </div>

        <div style="background:rgba(16,185,129,0.10); border:1px solid #10B981; border-radius:14px; padding:14px 16px; margin-bottom:18px;">
            <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px; margin-bottom:8px;">
                <h3 style="color:#059669; font-size:var(--fs-md); margin:0;">3. Atajos rápidos (si usas computador)</h3>
            </div>
            <p style="font-size:var(--fs-sm); line-height:1.5; margin:0 0 10px 0;">
                Con las teclas numéricas y las flechas puedes cambiar de vista sin buscar botones:
            </p>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; font-size:var(--fs-xs); margin-bottom:10px;">
                <div style="background:rgba(148,163,184,0.08); padding:6px 8px; border-radius:6px;"><kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> : Cambiar entre las 3 pestañas principales</div>
                <div style="background:rgba(148,163,184,0.08); padding:6px 8px; border-radius:6px;"><kbd>4</kbd> <kbd>5</kbd> <kbd>6</kbd> : Cambiar entre Puntos, Calor y Torres 3D</div>
                <div style="background:rgba(148,163,184,0.08); padding:6px 8px; border-radius:6px;"><kbd>7</kbd> Corte lateral · <kbd>8</kbd> Sismos recientes · <kbd>9</kbd> Fallas</div>
                <div style="background:rgba(148,163,184,0.08); padding:6px 8px; border-radius:6px;"><kbd>0</kbd> Restablecer todo · <kbd>↑ ↓ ← →</kbd> Mover · <kbd>+ / -</kbd> Zoom</div>
            </div>
            <p style="font-size:var(--fs-xs); margin:0; color:var(--text-tertiary);">
                Si inclinas el mapa manteniendo <kbd>Shift</kbd> + <kbd>↑ ↓ ← →</kbd>, puedes ver mejor las vistas en 3D.
            </p>
        </div>

        <div style="display:flex; justify-content:center;">
            <button id="btn-entendido-guia" style="background:linear-gradient(135deg, #0052CC, #003E99); color:#FFFFFF; border:none; border-radius:12px; padding:12px 28px; font-size:var(--fs-base); font-weight:600; cursor:pointer; box-shadow:0 6px 18px rgba(0,82,204,0.35);">
                ¡Entendido, explorar el mapa!
            </button>
        </div>
    `,
    'vis_espacial': `
        <h2 style="margin-top:0; color:#0A84FF; font-size:var(--fs-xl); border-bottom:1px solid rgba(148,163,184,0.22); padding-bottom:12px; margin-bottom:16px;">Formas de ver los sismos en el mapa</h2>
        <p style="font-size:var(--fs-base); line-height:1.6; margin-bottom:14px;">
            Esta sección te deja elegir cómo dibujar los temblores en el mapa. Todos los modos usan los mismos sismos, solo cambia la forma de mostrarlos para que sea más fácil entenderlos:
        </p>
        <div style="display:flex; flex-direction:column; gap:10px; font-size:var(--fs-sm); margin-bottom:14px;">
            <div style="background:rgba(10,132,255,0.08); border-left:3px solid #0A84FF; padding:10px 12px; border-radius:6px;">
                <strong>⚪ Puntos (uno por uno):</strong> Muestra cada temblor como un círculo separado. Sirve para revisar dónde ocurrió exactamente cada sismo y pasar el ratón encima para ver su fecha y tamaño.
            </div>
            <div style="background:rgba(244,63,94,0.08); border-left:3px solid #F43F5E; padding:10px 12px; border-radius:6px;">
                <strong>🔥 Calor (manchas de color):</strong> Junta los puntos en manchas suaves para ver rápido en qué partes del Chocó se concentra más actividad sísmica.
            </div>
            <div style="background:rgba(16,185,129,0.08); border-left:3px solid #10B981; padding:10px 12px; border-radius:6px;">
                <strong>🔷 Hexbins (torres 3D):</strong> Divide el mapa en celdas como un panal y levanta torres más altas donde ha temblado más veces.
            </div>
        </div>
        <div style="background:rgba(245,158,11,0.12); border:1.5px solid #F59E0B; border-radius:12px; padding:12px 14px;">
            <strong style="font-size:var(--fs-sm);">¿Cómo usar y cómo limpiar?</strong>
            <ul style="margin:6px 0 0 0; padding-left:18px; font-size:var(--fs-sm); line-height:1.45;">
                <li><strong>Uso:</strong> Toca uno de los tres botones (Puntos, Calor o Hexbins) para activar esa vista. Si quieres encender más de uno al tiempo no es necesario: cambia libremente entre ellos.</li>
                <li><strong>Limpiar:</strong> Presiona el botón circular de flecha (<strong>↺</strong>) junto al título <em>Visualización Espacial</em> para apagar los puntos, el calor y las torres y dejar el mapa despejado.</li>
            </ul>
        </div>
    `,
    'filtros_parametricos': `
        <h2 style="margin-top:0; color:#0A84FF; font-size:var(--fs-xl); border-bottom:1px solid rgba(148,163,184,0.22); padding-bottom:12px; margin-bottom:16px;">Filtros para elegir qué sismos ver</h2>
        <p style="font-size:var(--fs-base); line-height:1.6; margin-bottom:14px;">
            Como hay miles de temblores registrados, estas tres barras te permiten mostrar solo los que te interesa analizar:
        </p>
        <ul style="margin:0 0 14px 0; padding-left:18px; font-size:var(--fs-sm); line-height:1.55;">
            <li style="margin-bottom:8px;"><strong>Magnitud (M):</strong> Oculta los temblores muy pequeños para quedarte solo con los que se sintieron fuerte (por ejemplo, de 5.0 en adelante).</li>
            <li style="margin-bottom:8px;"><strong>Profundidad Máxima:</strong> Separa los temblores que ocurren cerca de la superficie (los más cercanos a pueblos y viviendas) de los que ocurren muy profundo bajo tierra.</li>
            <li><strong>Año y botón ▶ Reproducir:</strong> Elige desde qué año quieres ver los registros (desde 1993 hasta 2026) o pulsa <em>▶ Reproducir</em> para ver una película año por año de cómo han ocurrido los sismos.</li>
        </ul>
        <div style="background:rgba(245,158,11,0.12); border:1.5px solid #F59E0B; border-radius:12px; padding:12px 14px;">
            <strong style="font-size:var(--fs-sm);">¿Cómo usar y volver a ver todos los sismos?</strong>
            <ul style="margin:6px 0 0 0; padding-left:18px; font-size:var(--fs-sm); line-height:1.45;">
                <li><strong>Uso:</strong> Mueve cualquiera de las tres barras hacia la derecha o la izquierda; el mapa y los conteos cambian al instante.</li>
                <li><strong>Restablecer:</strong> Presiona el botón <strong>↺</strong> junto al título <em>Filtros Paramétricos</em> para volver a mostrar el 100 % de los sismos (Magnitud 0.0, Profundidad 250 km y Año 1993).</li>
            </ul>
        </div>
    `,
    'capas_avanzadas': `
        <h2 style="margin-top:0; color:#0A84FF; font-size:var(--fs-xl); border-bottom:1px solid rgba(148,163,184,0.22); padding-bottom:12px; margin-bottom:16px;">Capas de información extra sobre el mapa</h2>
        <p style="font-size:var(--fs-base); line-height:1.6; margin-bottom:14px;">
            Cada interruptor de esta lista enciende o apaga una capa adicional encima del mapa del Chocó. Puedes activar solo la que necesites para no llenar demasiado la pantalla:
        </p>
        <ul style="margin:0 0 14px 0; padding-left:18px; font-size:var(--fs-sm); line-height:1.5;">
            <li style="margin-bottom:6px;"><strong>Sismos de Alta Precisión:</strong> Oculta registros cuya ubicación fue estimada con poca exactitud y deja solo los mejor medidos.</li>
            <li style="margin-bottom:6px;"><strong>Fallas Geológicas:</strong> Dibuja las principales fracturas del terreno donde nacen muchos terremotos y te deja consultar una por una.</li>
            <li style="margin-bottom:6px;"><strong>Zonas donde se agrupan sismos (IA):</strong> Resalta con colores grupos de muchos temblores ocurridos cerca entre sí.</li>
            <li style="margin-bottom:6px;"><strong>Telemetría FDSN Live:</strong> Consulta temblores recientes reportados en los últimos días por redes internacionales.</li>
            <li><strong>Modelo SGC Oficial (OGC):</strong> Pinta el mapa oficial de amenaza sísmica de Colombia y te explica qué significa cada color al pasar el ratón.</li>
        </ul>
        <div style="background:rgba(245,158,11,0.12); border:1.5px solid #F59E0B; border-radius:12px; padding:12px 14px;">
            <strong style="font-size:var(--fs-sm);">¿Cómo usar y apagar todo rápido?</strong>
            <ul style="margin:6px 0 0 0; padding-left:18px; font-size:var(--fs-sm); line-height:1.45;">
                <li><strong>Uso:</strong> Activa cualquier interruptor para ver su información; cada uno tiene al lado un botón <strong>(?)</strong> por si necesitas más detalle.</li>
                <li><strong>Apagar todo:</strong> Presiona el botón <strong>↺</strong> junto a <em>Capas Avanzadas</em> para apagar todas estas capas de una sola vez.</li>
            </ul>
        </div>
    `,
    'rtd': `
        <h2 style="margin-top:0; color:#0A84FF; font-size:var(--fs-xl); border-bottom:1px solid rgba(148,163,184,0.22); padding-bottom:12px; margin-bottom:16px;">¿Qué significa "RtD"? (Sobre este proyecto)</h2>
        <p style="font-size:var(--fs-base); line-height:1.6; margin-bottom:12px;">
            Las siglas <strong>RtD</strong> significan <em>Investigación a través del Diseño</em> (en inglés, <em>Research through Design</em>). Es la forma en que se creó esta herramienta: en lugar de dejar los datos sísmicos en tablas difíciles de entender, se diseñó un mapa visual interactivo para probar cómo las personas comprenden mejor el riesgo en su territorio.
        </p>
        <div style="background: rgba(10,132,255,0.10); border-left: 3px solid #0A84FF; padding: 12px 14px; border-radius: 6px; margin-bottom: 14px; font-size: var(--fs-sm); line-height: 1.5;">
            <strong>Proyecto académico:</strong> Maestría en Diseño y Creación Interactiva — Universidad de Caldas.<br>
            <strong>Propósito práctico:</strong> Que ciudadanía, planificadores municipales e ingenieros puedan explorar en pocos clics dónde tiembla, qué tan fuerte puede sacudirse cada municipio y qué cuidados exige la ley.
        </div>
        <div style="background:rgba(245,158,11,0.12); border:1.5px solid #F59E0B; border-radius:12px; padding:12px 14px;">
            <strong style="font-size:var(--fs-sm);">¿Cómo navegar este proyecto?</strong>
            <p style="margin:6px 0 0 0; font-size:var(--fs-sm); line-height:1.45;">
                Cierra esta ventana con la <strong>✕</strong> (o tocando fuera del cuadro) para volver al mapa. Si deseas una explicación paso a paso de los controles, pulsa el botón azul <strong>(?)</strong> que está justo al lado de este botón <strong>RtD</strong>.
            </p>
        </div>
    `,
    'magnitud': `
        <h2 style="margin-top:0; color:#0A84FF; font-size:var(--fs-xl); border-bottom:1px solid rgba(148,163,184,0.22); padding-bottom:12px; margin-bottom:16px;">Magnitud: ¿qué tan fuerte fue el temblor?</h2>
        <p style="font-size:var(--fs-base); line-height:1.55; margin-bottom:10px;">
            Esta barra oculta los temblores más pequeños para que en el mapa solo queden los que alcanzan o superan el tamaño que tú elijas (desde <strong>0.0</strong> hasta <strong>8.0</strong>).
        </p>
        <ul style="font-size:var(--fs-sm); line-height:1.55; margin:0 0 14px 0; padding-left:18px;">
            <li style="margin-bottom:6px;"><strong>Menor a 4.0:</strong> Temblores leves, muchas veces solo los detectan los equipos o se sienten suave en pisos altos.</li>
            <li style="margin-bottom:6px;"><strong>Entre 4.0 y 5.9:</strong> Se sienten claro en casas y edificios; pueden mover objetos y causar grietas leves si el suelo es blando.</li>
            <li><strong>6.0 o más:</strong> Terremotos fuertes con capacidad de causar daños graves. Cada punto que sube en esta escala libera muchísima más energía que el anterior.</li>
        </ul>
        <div style="background:rgba(245,158,11,0.12); border:1.5px solid #F59E0B; border-radius:12px; padding:12px 14px;">
            <strong style="font-size:var(--fs-sm);">¿Cómo usarlo y volver atrás?</strong>
            <ul style="margin:6px 0 0 0; padding-left:18px; font-size:var(--fs-sm); line-height:1.45;">
                <li><strong>Uso:</strong> Arrastra el punto azul hacia la derecha (por ejemplo hasta 5.0) para dejar visibles únicamente los sismos fuertes.</li>
                <li><strong>Restablecer:</strong> Mueve la barra de nuevo hacia la izquierda hasta 0.0 o toca <strong>↺</strong> junto a <em>Filtros Paramétricos</em>.</li>
            </ul>
        </div>
    `,
    'anio': `
        <h2 style="margin-top:0; color:#0A84FF; font-size:var(--fs-xl); border-bottom:1px solid rgba(148,163,184,0.22); padding-bottom:12px; margin-bottom:16px;">Año de inicio y reproducción en el tiempo</h2>
        <p style="font-size:var(--fs-base); line-height:1.55; margin-bottom:10px;">
            Te permite elegir desde qué año quieres consultar el historial de temblores en el Chocó (entre <strong>1993</strong> y <strong>2026</strong>).
        </p>
        <p style="font-size:var(--fs-sm); line-height:1.55; margin-bottom:14px;">
            También puedes pulsar el botón azul <strong>▶ Reproducir</strong> para que los años avancen solos automáticamente, mostrando cómo se ha movido la actividad sísmica a lo largo del tiempo.
        </p>
        <div style="background:rgba(245,158,11,0.12); border:1.5px solid #F59E0B; border-radius:12px; padding:12px 14px;">
            <strong style="font-size:var(--fs-sm);">¿Cómo usarlo y volver al historial completo?</strong>
            <ul style="margin:6px 0 0 0; padding-left:18px; font-size:var(--fs-sm); line-height:1.45;">
                <li><strong>Uso:</strong> Mueve la barra al año deseado o presiona <em>▶ Reproducir</em> (y vuelve a presionarlo para pausar).</li>
                <li><strong>Restablecer:</strong> Regresa la barra al año 1993 o toca <strong>↺</strong> en la cabecera de <em>Filtros Paramétricos</em>.</li>
            </ul>
        </div>
    `,
    'puntos': `
        <h2 style="margin-top:0; color:#0A84FF; font-size:var(--fs-xl); border-bottom:1px solid rgba(148,163,184,0.22); padding-bottom:12px; margin-bottom:16px;">Eventos Individuales (Ver cada sismo como un punto)</h2>
        <p style="font-size:var(--fs-base); line-height:1.55; margin-bottom:12px;">
            Dibuja cada temblor registrado como un círculo en el lugar exacto donde ocurrió. Pasa el ratón por encima de cualquier punto para ver su fecha, tamaño y municipio más cercano.
        </p>
        <ul style="font-size:var(--fs-sm); line-height:1.55; margin:0 0 14px 0; padding-left:18px;">
            <li style="margin-bottom:6px;"><strong>Tamaño del círculo:</strong> Cuanto más grande es el círculo, más fuerte fue el sismo.</li>
            <li><strong>Color del círculo (profundidad):</strong> Naranja significa sismo poco profundo (menos de 30 km bajo el suelo), rosado es profundidad media (30 a 70 km) y morado es muy profundo (más de 70 km).</li>
        </ul>
        <div style="background:rgba(245,158,11,0.12); border:1.5px solid #F59E0B; border-radius:12px; padding:12px 14px;">
            <strong style="font-size:var(--fs-sm);">¿Cómo activar o quitar los puntos?</strong>
            <p style="margin:6px 0 0 0; font-size:var(--fs-sm); line-height:1.45;">
                Toca <strong>⚪ Puntos</strong> para verlos, cambia a Calor o Hexbins cuando quieras otra vista, o pulsa <strong>↺</strong> en <em>Visualización Espacial</em> para limpiar el mapa.
            </p>
        </div>
    `,
    'calor': `
        <h2 style="margin-top:0; color:#FF2D55; font-size:var(--fs-xl); border-bottom:1px solid rgba(148,163,184,0.22); padding-bottom:12px; margin-bottom:16px;">Mapa de Calor (¿Dónde tiembla más seguido?)</h2>
        <p style="font-size:var(--fs-base); line-height:1.55; margin-bottom:12px;">
            En lugar de dibujar miles de puntos encima uno del otro, esta vista pinta manchas de color sobre las zonas donde se han juntado más sismos fuertes o frecuentes.
        </p>
        <p style="font-size:var(--fs-sm); line-height:1.55; margin-bottom:14px;">
            Los tonos suaves indican actividad baja; los tonos rojos o amarillos intensos señalan los sectores donde la tierra ha liberado más energía a lo largo de los años.
        </p>
        <div style="background:rgba(245,158,11,0.12); border:1.5px solid #F59E0B; border-radius:12px; padding:12px 14px;">
            <strong style="font-size:var(--fs-sm);">¿Cómo usar y quitar el mapa de calor?</strong>
            <p style="margin:6px 0 0 0; font-size:var(--fs-sm); line-height:1.45;">
                Presiona <strong>🔥 Calor</strong> para encenderlo. Si quieres volver a ver los puntos uno por uno, toca <strong>⚪ Puntos</strong>, o presiona <strong>↺</strong> en <em>Visualización Espacial</em> para apagar la capa.
            </p>
        </div>
    `,
    'hex': `
        <h2 style="margin-top:0; color:#10B981; font-size:var(--fs-xl); border-bottom:1px solid rgba(148,163,184,0.22); padding-bottom:12px; margin-bottom:16px;">Hexbins 3D (Torres de cantidad de sismos)</h2>
        <p style="font-size:var(--fs-base); line-height:1.55; margin-bottom:12px;">
            Divide el departamento en zonas hexagonales (como un panal de abejas) y levanta columnas en 3D para comparar rápidamente dónde ha temblado más:
        </p>
        <ul style="font-size:var(--fs-sm); line-height:1.55; margin:0 0 14px 0; padding-left:18px;">
            <li style="margin-bottom:6px;"><strong>Altura de la torre:</strong> Entre más alta es la columna, más sismos han ocurrido en esa zona.</li>
            <li><strong>Color de la torre:</strong> Muestra qué tan intensos han sido los temblores dentro de ese sector.</li>
        </ul>
        <p style="font-size:var(--fs-xs); color:var(--text-tertiary); margin-bottom:14px;">
            Consejo: inclina el mapa arrastrando con el clic derecho del ratón para notar mejor la altura de las torres.
        </p>
        <div style="background:rgba(245,158,11,0.12); border:1.5px solid #F59E0B; border-radius:12px; padding:12px 14px;">
            <strong style="font-size:var(--fs-sm);">¿Cómo activar o quitar las torres?</strong>
            <p style="margin:6px 0 0 0; font-size:var(--fs-sm); line-height:1.45;">
                Presiona <strong>🔷 Hexbins</strong> para mostrarlas y toca <strong>↺</strong> junto a <em>Visualización Espacial</em> si deseas retirarlas del mapa.
            </p>
        </div>
    `,
    'grafico': `
        <h2 style="margin-top:0; color:#0A84FF; font-size:var(--fs-xl); border-bottom:1px solid rgba(148,163,184,0.22); padding-bottom:12px; margin-bottom:16px;">Gráfica: ¿Cuántos sismos grandes vs. pequeños ocurren?</h2>
        <p style="font-size:var(--fs-base); line-height:1.55; margin-bottom:12px;">
            En la naturaleza casi siempre ocurren <strong>muchos temblores pequeños y muy pocos terremotos grandes</strong>. Esta gráfica resume esa relación con los sismos visibles en pantalla:
        </p>
        <div style="background: rgba(10,132,255,0.10); border-left: 3px solid #0A84FF; padding: 10px 14px; border-radius: 6px; margin-bottom: 12px; font-size: var(--fs-sm); line-height: 1.5;">
            <strong>¿Qué indica el número "b ="?</strong><br>
            Compara la proporción entre sismos pequeños y grandes. Un valor cercano a 1.0 suele considerarse equilibrado; valores más bajos indican una mayor proporción relativa de sismos medianos o grandes en la muestra seleccionada.
        </div>
        <ul style="font-size:var(--fs-sm); line-height:1.55; margin:0 0 14px 0; padding-left:18px;">
            <li style="margin-bottom:6px;"><strong>Hacia la derecha:</strong> Tamaño del sismo (magnitud).</li>
            <li style="margin-bottom:6px;"><strong>Hacia arriba:</strong> Cuántos temblores de ese tamaño o mayores se han registrado.</li>
            <li><strong>Debajo de la gráfica:</strong> Muestra un estimado orientativo de cada cuántos años suele repetirse un sismo de magnitud 5, 6 o 7 según el catálogo filtrado.</li>
        </ul>
        <div style="background:rgba(245,158,11,0.12); border:1.5px solid #F59E0B; border-radius:12px; padding:12px 14px;">
            <strong style="font-size:var(--fs-sm);">Atajo útil y cómo restablecer:</strong>
            <p style="margin:6px 0 0 0; font-size:var(--fs-sm); line-height:1.45;">
                Puedes hacer clic sobre cualquier punto de la línea para filtrar el mapa desde esa magnitud. Para volver al rango completo, toca <strong>↺</strong> en <em>Filtros Paramétricos</em>.
            </p>
        </div>
    `,
    'calidad': `
        <h2 style="margin-top:0; color:#0A84FF; font-size:var(--fs-xl); border-bottom:1px solid rgba(148,163,184,0.22); padding-bottom:12px; margin-bottom:16px;">Sismos de Alta Precisión (Filtrar solo los mejor medidos)</h2>
        <p style="font-size:var(--fs-base); line-height:1.55; margin-bottom:10px;">
            Cuando un temblor ocurre muy lejos de los sensores o solo lo captan pocas estaciones, su posición exacta en el mapa puede tener algo de margen de error.
        </p>
        <p style="font-size:var(--fs-sm); line-height:1.55; margin-bottom:14px;">
            Al encender este interruptor, la plataforma <strong>oculta los sismos con ubicación aproximada</strong> y deja únicamente aquellos verificados por varias estaciones alrededor del epicentro con bajo margen de error.
        </p>
        <div style="background:rgba(245,158,11,0.12); border:1.5px solid #F59E0B; border-radius:12px; padding:12px 14px;">
            <strong style="font-size:var(--fs-sm);">¿Cómo usarlo y volver a ver todos?</strong>
            <p style="margin:6px 0 0 0; font-size:var(--fs-sm); line-height:1.45;">
                Enciende el interruptor cuando necesites ubicar sismos con mayor certeza. Para volver a ver todo el historial completo, apaga el interruptor o presiona <strong>↺</strong> en <em>Capas Avanzadas</em>.
            </p>
        </div>
    `,
    'fallas': `
        <h2 style="margin-top:0; color:#F59E0B; font-size:var(--fs-xl); border-bottom:1px solid rgba(148,163,184,0.22); padding-bottom:12px; margin-bottom:16px;">Fallas Geológicas (Fracturas del terreno)</h2>
        <p style="font-size:var(--fs-base); line-height:1.55; margin-bottom:12px;">
            Las fallas geológicas son grandes grietas profundas en la corteza terrestre donde los bloques de roca se empujan o se deslizan entre sí. Cuando una falla se destraba de golpe, produce un sismo.
        </p>
        <h3 style="font-size:var(--fs-md); margin:0 0 8px 0;">¿Qué significan los colores de las líneas?</h3>
        <ul style="font-size:var(--fs-sm); line-height:1.55; margin:0 0 14px 0; padding-left:18px;">
            <li style="margin-bottom:6px;"><strong style="color:#0284C7;">Azul claro:</strong> Zona del océano donde la placa del Pacífico se hunde debajo del continente colombiano.</li>
            <li style="margin-bottom:6px;"><strong style="color:#D97706;">Amarillo / Ámbar:</strong> Fracturas donde un bloque de terreno se desliza de lado frente al otro (como la Falla de Murindó).</li>
            <li><strong style="color:#DC2626;">Rojo:</strong> Fracturas donde un bloque empuja y monta sobre el otro, levantando montañas y serranías.</li>
        </ul>
        <div style="background:rgba(245,158,11,0.12); border:1.5px solid #F59E0B; border-radius:12px; padding:12px 14px;">
            <strong style="font-size:var(--fs-sm);">¿Cómo consultarlas?</strong>
            <p style="margin:6px 0 0 0; font-size:var(--fs-sm); line-height:1.45;">
                Al encender el interruptor aparece un menú para elegir cualquiera de las 11 fallas, acercar la cámara hacia ella, ver una ficha explicativa y activar una franja de 5 km a cada lado. Apágalo cuando quieras limpiar el mapa.
            </p>
        </div>
    `,
    'ml': `
        <h2 style="margin-top:0; color:#C084FC; font-size:var(--fs-xl); border-bottom:1px solid rgba(148,163,184,0.22); padding-bottom:12px; margin-bottom:16px;">Zonas donde se agrupan muchos sismos (Enjambres)</h2>
        <p style="font-size:var(--fs-base); line-height:1.55; margin-bottom:10px;">
            A veces ocurren decenas de temblores casi en el mismo sitio (lo que se conoce como un <em>enjambre sísmico</em> o serie de réplicas tras un sismo principal).
        </p>
        <p style="font-size:var(--fs-sm); line-height:1.55; margin-bottom:14px;">
            Al activar esta opción, un análisis automático agrupa esos focos cercanos y los pinta con distintos colores para distinguir fácilmente qué sectores acumulan más eventos juntos.
        </p>
        <div style="background:rgba(245,158,11,0.12); border:1.5px solid #F59E0B; border-radius:12px; padding:12px 14px;">
            <strong style="font-size:var(--fs-sm);">¿Cómo activarlo y desactivarlo?</strong>
            <p style="margin:6px 0 0 0; font-size:var(--fs-sm); line-height:1.45;">
                Activa el interruptor <em>Zonas Anómalas (IA DBSCAN)</em> y pasa el ratón sobre los grupos coloreados para ver a qué sector pertenecen. Apágalo o presiona <strong>↺</strong> para quitarlos.
            </p>
        </div>
    `,
    'sgc': `
        <h2 style="margin-top:0; color:#10B981; font-size:var(--fs-xl); border-bottom:1px solid rgba(148,163,184,0.22); padding-bottom:12px; margin-bottom:16px;">Sismos recientes en tiempo real (Telemetría FDSN Live)</h2>
        <p style="font-size:var(--fs-base); line-height:1.55; margin-bottom:10px;">
            Conecta el mapa por internet con reportes sísmicos internacionales (<strong>EMSC</strong> y <strong>USGS</strong>) para mostrar los temblores de magnitud ≥ 3.5 ocurridos durante los <strong>últimos 14 días</strong> en la región.
        </p>
        <p style="font-size:var(--fs-sm); line-height:1.55; margin-bottom:14px;">
            Aparecen como anillos verdes brillantes sobre el mapa. Al lado del interruptor verás una etiqueta que te indica claramente si los datos llegaron en vivo desde internet o si se están mostrando desde la copia guardada en el equipo por falta de conexión.
        </p>
        <div style="background:rgba(245,158,11,0.12); border:1.5px solid #F59E0B; border-radius:12px; padding:12px 14px;">
            <strong style="font-size:var(--fs-sm);">¿Cómo consultar un evento reciente?</strong>
            <p style="margin:6px 0 0 0; font-size:var(--fs-sm); line-height:1.45;">
                Activa el interruptor y pasa el ratón sobre cualquiera de los anillos verdes para ver cuándo ocurrió (por ejemplo, si fue hoy o hace pocos días), su tamaño y municipio cercano. Para contraste oficial en Colombia, visita <a href="https://sismo.sgc.gov.co/" target="_blank" rel="noopener noreferrer" style="color:#0284C7;">sismo.sgc.gov.co</a>.
            </p>
        </div>
    `,
    'sgc_wms': `
        <h2 style="margin-top:0; color:#0284C7; font-size:var(--fs-xl); border-bottom:1px solid rgba(148,163,184,0.22); padding-bottom:12px; margin-bottom:16px;">Mapa Oficial de Amenaza Sísmica de Colombia (SGC)</h2>
        <p style="font-size:var(--fs-base); line-height:1.55; margin-bottom:12px;">
            Esta capa trae directamente las imágenes oficiales del <strong>Servicio Geológico Colombiano (SGC)</strong> para mostrar con qué fuerza máxima se espera que tiemble la roca firme en cada lugar del país (referencia a 475 años usada en las normas de construcción).
        </p>
        <h3 style="font-size:var(--fs-md); margin:0 0 8px 0;">¿Qué significan los colores sobre el mapa?</h3>
        <ul style="font-size:var(--fs-sm); line-height:1.55; margin:0 0 14px 0; padding-left:18px;">
            <li style="margin-bottom:5px;"><strong>Verde oscuro a verde claro:</strong> Amenaza baja (sacudida esperada leve en roca firme).</li>
            <li style="margin-bottom:5px;"><strong>Amarillo pálido:</strong> Amenaza intermedia (sacudida moderada; en suelos blandos puede sentirse más fuerte).</li>
            <li style="margin-bottom:5px;"><strong>Durazno a naranja claro:</strong> Amenaza alta (exige construcción sismorresistente estricta).</li>
            <li><strong>Naranja intenso a rojo:</strong> Amenaza muy alta (típica de la costa Pacífica y sectores críticos del Chocó).</li>
        </ul>
        <div style="background:rgba(16,185,129,0.10); border:1px solid #10B981; border-radius:12px; padding:12px 14px; margin-bottom:12px;">
            <strong style="font-size:var(--fs-sm);">Dos formas fáciles de leer un lugar:</strong>
            <ul style="margin:6px 0 0 0; padding-left:18px; font-size:var(--fs-sm); line-height:1.45;">
                <li><strong>Pasa el ratón por encima de cualquier color:</strong> Verás de inmediato un cuadro con el nivel de amenaza y qué implica en palabras sencillas.</li>
                <li><strong>Haz clic sobre el mapa (o en "Consultar cabecera"):</strong> Obtendrás los números exactos oficiales del SGC para ese punto.</li>
            </ul>
        </div>
    `,
    'benioff': `
        <h2 style="margin-top:0; color:#0284C7; font-size:var(--fs-xl); border-bottom:1px solid rgba(148,163,184,0.22); padding-bottom:12px; margin-bottom:16px;">Corte 3D del Subsuelo (¿Por qué hay sismos a distintas profundidades?)</h2>
        <p style="font-size:var(--fs-base); line-height:1.55; margin-bottom:12px;">
            Bajo el océano Pacífico hay una gran placa de roca marina (la <strong>Placa de Nazca</strong>) que se está deslizando lentamente por debajo de Colombia. Esta vista inclina el mapa de lado para que puedas mirar debajo del suelo como si cortaras una tajada de la Tierra:
        </p>
        <ul style="font-size:var(--fs-sm); line-height:1.55; margin:0 0 14px 0; padding-left:18px;">
            <li style="margin-bottom:6px;"><strong>En la costa (Bahía Solano, Nuquí):</strong> Los sismos nacen más cerca de la superficie (0 a 30 km).</li>
            <li style="margin-bottom:6px;"><strong>Hacia el centro (Quibdó y Valle del Atrato):</strong> La placa ya va bajando, así que los temblores ocurren más hondo (40 a 80 km).</li>
            <li><strong>Hacia la cordillera:</strong> La placa llega a más de 100 km de profundidad.</li>
        </ul>
        <div style="background:rgba(245,158,11,0.12); border:1.5px solid #F59E0B; border-radius:12px; padding:12px 14px;">
            <strong style="font-size:var(--fs-sm);">¿Cómo usarlo y volver a la vista normal?</strong>
            <ul style="margin:6px 0 0 0; padding-left:18px; font-size:var(--fs-sm); line-height:1.45;">
                <li><strong>Uso:</strong> Pulsa <em>📐 Activar Perfil Benioff</em>; luego puedes elegir el sector (Murindó, Quibdó o San Juan) y ajustar qué tanto se estira la profundidad (0.5x a 3.0x).</li>
                <li><strong>Volver a la vista normal:</strong> Presiona de nuevo el mismo botón o toca <strong>↺</strong> en <em>Visualización Espacial</em>.</li>
            </ul>
        </div>
    `,
    'nsr10_info': `
        <h2 style="margin-top:0; color:#10B981; font-size:var(--fs-xl); border-bottom:1px solid rgba(148,163,184,0.22); padding-bottom:12px; margin-bottom:16px;">Norma Colombiana de Construcción Segura (NSR-10)</h2>
        <p style="font-size:var(--fs-base); line-height:1.55; margin-bottom:12px;">
            La <strong>NSR-10</strong> es el reglamento obligatorio en Colombia que dice qué tan fuertes deben construirse las casas, colegios, puentes y hospitales para que no colapsen durante un terremoto.
        </p>
        <h3 style="font-size:var(--fs-md); margin:0 0 8px 0;">¿Qué ves en estos campos en términos sencillos?</h3>
        <ul style="font-size:var(--fs-sm); line-height:1.55; margin:0 0 14px 0; padding-left:18px;">
            <li style="margin-bottom:6px;"><strong>Municipio:</strong> Cada municipio tiene asignada una fuerza base de sacudida según qué tan cerca esté de fallas y zonas sísmicas (en casi todo el Chocó es <em>Alta</em>).</li>
            <li style="margin-bottom:6px;"><strong>Tipo de suelo (A hasta F):</strong> No es igual construir sobre roca dura (A) que sobre barro o rellenos junto a un río (E o F), donde la sacudida se amplifica como si fuera gelatina.</li>
            <li><strong>Grupo de uso:</strong> Exige mayor resistencia a edificaciones indispensables después de una emergencia, como hospitales (Grupo IV) o escuelas y sedes de gobierno (Grupo III).</li>
        </ul>
        <div style="background:rgba(245,158,11,0.12); border:1.5px solid #F59E0B; border-radius:12px; padding:12px 14px;">
            <strong style="font-size:var(--fs-sm);">¿Cómo consultarlo?</strong>
            <p style="margin:6px 0 0 0; font-size:var(--fs-sm); line-height:1.45;">
                Elige tu municipio, el tipo de terreno y el uso de la construcción. El mapa ubicará el municipio y los números se actualizarán solos. Si quieres reiniciar todo, pulsa <strong>⌂</strong> arriba a la derecha.
            </p>
        </div>
    `,
    'geotecnia_info': `
        <h2 style="margin-top:0; color:#0284C7; font-size:var(--fs-xl); border-bottom:1px solid rgba(148,163,184,0.22); padding-bottom:12px; margin-bottom:16px;">El suelo del lugar y el peligro de licuación</h2>
        <p style="font-size:var(--fs-base); line-height:1.55; margin-bottom:12px;">
            La seguridad de una casa no depende solo de sus columnas y ladrillos, sino también de la tierra sobre la que se apoya. En muchas cabeceras del Chocó cerca de ríos (Atrato, San Juan, Baudó) o del mar hay suelos húmedos y blandos.
        </p>
        <div style="background:rgba(10,132,255,0.08); border-left:3px solid #0A84FF; padding:10px 14px; border-radius:6px; margin-bottom:12px; font-size:var(--fs-sm); line-height:1.5;">
            <strong>¿Qué es la "licuación" del suelo?</strong><br>
            Cuando un terreno arenoso y empapado de agua recibe un terremoto fuerte, el suelo puede perder firmeza por unos segundos y comportarse parecido a una arena movediza, haciendo que viviendas o postes se inclinen o se hundan.
        </div>
        <div style="background:rgba(245,158,11,0.12); border:1.5px solid #F59E0B; border-radius:12px; padding:12px 14px;">
            <strong style="font-size:var(--fs-sm);">¿Cómo usar esta tarjeta?</strong>
            <p style="margin:6px 0 0 0; font-size:var(--fs-sm); line-height:1.45;">
                Al cambiar el <em>Tipo de Suelo</em> arriba (entre A roca firme, el estándar E suelo blando, o F suelos especiales), esta tarjeta te advierte cuánto se amplifica el temblor y qué estudios de terreno previos son recomendables antes de construir.
            </p>
        </div>
    `,
    'pot_info': `
        <h2 style="margin-top:0; color:#F59E0B; font-size:var(--fs-xl); border-bottom:1px solid rgba(148,163,184,0.22); padding-bottom:12px; margin-bottom:16px;">Diagnóstico Municipal para Ordenamiento Territorial (POT)</h2>
        <p style="font-size:var(--fs-base); line-height:1.55; margin-bottom:12px;">
            Un <strong>POT (Plan de Ordenamiento Territorial)</strong> es la regla del municipio que define en qué zonas es seguro construir barrios, escuelas u hospitales y dónde conviene evitar urbanizaciones por peligro sísmico o inundación.
        </p>
        <ul style="font-size:var(--fs-sm); line-height:1.55; margin:0 0 14px 0; padding-left:18px;">
            <li style="margin-bottom:6px;"><strong>Filtro de prioridad territorial:</strong> Te ayuda a listar primero los municipios según su nivel de alerta sísmica o su acceso (fluvial, costero o por carretera), útil para priorizar apoyos y logística de emergencia.</li>
            <li style="margin-bottom:6px;"><strong>Conteo de eventos cercanos:</strong> Resume cuántos temblores históricos han ocurrido en los alrededores del municipio seleccionado.</li>
            <li><strong>Ficha Técnica en PDF:</strong> Crea un resumen organizado listo para imprimir o guardar como apoyo orientador en reuniones de planeación municipal.</li>
        </ul>
        <div style="background:rgba(245,158,11,0.12); border:1.5px solid #F59E0B; border-radius:12px; padding:12px 14px;">
            <strong style="font-size:var(--fs-sm);">¿Cómo usarlo?</strong>
            <p style="margin:6px 0 0 0; font-size:var(--fs-sm); line-height:1.45;">
                Selecciona un municipio en la lista, revisa su nivel de prioridad en la parte inferior y presiona <em>📄 Ficha Técnica Territorial (PDF / Imprimir)</em> si necesitas el documento descargable.
            </p>
        </div>
    `,
    'espectro_info': `
        <h2 style="margin-top:0; color:#0A84FF; font-size:var(--fs-xl); border-bottom:1px solid rgba(148,163,184,0.22); padding-bottom:12px; margin-bottom:16px;">Gráfica de Fuerza para Construir Edificios (Espectro NSR-10)</h2>
        <p style="font-size:var(--fs-base); line-height:1.55; margin-bottom:12px;">
            Durante un terremoto no todas las construcciones vibran igual: una casa de 1 o 2 pisos se mueve muy rápido (hacia la izquierda de la gráfica), mientras que un edificio alto se balancea más lento (hacia la derecha).
        </p>
        <ul style="font-size:var(--fs-sm); line-height:1.55; margin:0 0 14px 0; padding-left:18px;">
            <li style="margin-bottom:6px;"><strong>Línea gris punteada:</strong> Muestra cuánta fuerza llegaría si la construcción estuviera directamente sobre roca sólida.</li>
            <li style="margin-bottom:6px;"><strong>Curva azul rellena:</strong> Muestra cuánta fuerza real recibe la edificación con el tipo de suelo y grupo de uso que seleccionaste (si el suelo es blando, la curva sube bastante).</li>
            <li><strong>Botón Exportar CSV:</strong> Descarga los números de esta curva en un archivo de tabla para que ingenieros calculistas los carguen en sus programas de diseño estructural.</li>
        </ul>
        <div style="background:rgba(245,158,11,0.12); border:1.5px solid #F59E0B; border-radius:12px; padding:12px 14px;">
            <strong style="font-size:var(--fs-sm);">¿Cómo probar cambios?</strong>
            <p style="margin:6px 0 0 0; font-size:var(--fs-sm); line-height:1.45;">
                Cambia entre <em>Perfil A (Roca)</em> y <em>Perfil E (Suelo blando)</em> arriba y observa cómo crece la curva azul para entender por qué un suelo blando exige estructuras más reforzadas.
            </p>
        </div>
    `,
    'shakemap_info': `
        <h2 style="margin-top:0; color:#ff453a; font-size:var(--fs-xl); border-bottom:1px solid rgba(148,163,184,0.22); padding-bottom:12px; margin-bottom:16px;">Simulador de Terremotos (ShakeMap)</h2>
        <p style="font-size:var(--fs-base); line-height:1.55; margin-bottom:12px;">
            Te permite simular cómo viajaría el temblor por el Chocó si ocurriera hoy alguno de cinco escenarios históricos o posibles:
        </p>
        <ul style="font-size:var(--fs-sm); line-height:1.5; margin:0 0 12px 0; padding-left:18px;">
            <li style="margin-bottom:5px;"><strong>Zonas de color en el mapa:</strong> Muestran dónde la sacudida sería más violenta (rojo cerca de la fractura) y dónde iría perdiendo fuerza al alejarse (amarillo o verde).</li>
            <li style="margin-bottom:5px;"><strong>Anillo azul (primera onda):</strong> Es la sacudida inicial rápida que avisa que empezó el temblor.</li>
            <li><strong>Anillo rojo (onda fuerte):</strong> Llega segundos después y es la que genera el movimiento más intenso en viviendas y edificios.</li>
        </ul>
        <div style="background:rgba(148,163,184,0.08); border:1px solid rgba(148,163,184,0.22); border-radius:10px; padding:10px 12px; margin-bottom:12px; font-size:var(--fs-xs); line-height:1.45;">
            <strong>Escenarios incluidos:</strong> Sismo de referencia de 2026 (Mw 7.4), Falla Murindó 1992 (Mw 7.3), Megaterremoto en la costa del Pacífico (Mw 8.2), Falla Atrato – Quibdó (Mw 6.8) y Falla Bahía Solano 1970 (Mw 7.0).
        </div>
        <div style="background:rgba(245,158,11,0.12); border:1.5px solid #F59E0B; border-radius:12px; padding:12px 14px;">
            <strong style="font-size:var(--fs-sm);">¿Cómo simular y cómo limpiar?</strong>
            <ul style="margin:6px 0 0 0; padding-left:18px; font-size:var(--fs-sm); line-height:1.45;">
                <li><strong>Simular:</strong> Elige un escenario de la lista y toca <em>⚡ Simular Ruptura Sísmica</em>. Verás avanzar las ondas y el tiempo estimado de llegada a Quibdó e Istmina.</li>
                <li><strong>Limpiar:</strong> Presiona el botón <strong>🧹 Limpiar</strong> que aparece al lado para quitar la simulación y dejar el mapa normal.</li>
            </ul>
        </div>
    `,
    'profundidad': `
        <h2 style="margin-top:0; color:#c084fc; font-size:var(--fs-xl); border-bottom:1px solid rgba(148,163,184,0.22); padding-bottom:12px; margin-bottom:16px;">Profundidad Máxima: ¿Qué tan hondo ocurrió el sismo?</h2>
        <p style="font-size:var(--fs-base); line-height:1.55; margin-bottom:12px;">
            No todos los terremotos nacen a la misma profundidad bajo el suelo. Entre más cerca esté de la superficie, más fuerte suele sentirse justo encima:
        </p>
        <ul style="font-size:var(--fs-sm); line-height:1.55; margin:0 0 14px 0; padding-left:18px;">
            <li style="margin-bottom:6px;"><strong style="color:#EA580C;">Menos de 30 km (Superficiales):</strong> Ocurren en la capa superior de la tierra y suelen sentirse con mayor sacudida cerca del epicentro.</li>
            <li style="margin-bottom:6px;"><strong style="color:#E11D48;">30 a 70 km (Intermedios):</strong> Se producen donde las grandes placas tectónicas rozan entre sí.</li>
            <li><strong style="color:#9333EA;">Más de 70 km (Profundos):</strong> Ocurren muy adentro bajo las montañas; aunque se sienten en áreas amplias, su energía llega más repartida a la superficie.</li>
        </ul>
        <div style="background:rgba(245,158,11,0.12); border:1.5px solid #F59E0B; border-radius:12px; padding:12px 14px;">
            <strong style="font-size:var(--fs-sm);">¿Cómo usar esta barra y restablecer?</strong>
            <ul style="margin:6px 0 0 0; padding-left:18px; font-size:var(--fs-sm); line-height:1.45;">
                <li><strong>Uso:</strong> Arrastra la barra entre <strong>10 km</strong> y <strong>250 km</strong> (por ejemplo a 30 km) para aislar solo los sismos superficiales.</li>
                <li><strong>Restablecer:</strong> Llévala de vuelta hasta 250 km o pulsa <strong>↺</strong> en <em>Filtros Paramétricos</em>.</li>
            </ul>
        </div>
    `,
    'infra_info': `
        <h2 style="margin-top:0; color:#0284C7; font-size:var(--fs-xl); border-bottom:1px solid rgba(148,163,184,0.22); padding-bottom:12px; margin-bottom:16px;">Infraestructura Crítica y Líneas Vitales</h2>
        <p style="font-size:var(--fs-base); line-height:1.55; margin-bottom:12px;">
            Muestra sobre el mapa los caminos, ríos, pistas aéreas, puertos y hospitales esenciales para atender una emergencia o evitar que un municipio quede incomunicado tras un terremoto:
        </p>
        <ul style="font-size:var(--fs-sm); line-height:1.55; margin:0 0 14px 0; padding-left:18px;">
            <li style="margin-bottom:5px;"><strong style="color:#F59E0B;">🛣️ Red Vial Primaria:</strong> Carreteras principales que conectan al Chocó y pueden sufrir derrumbes tras un sismo.</li>
            <li style="margin-bottom:5px;"><strong style="color:#0284C7;">🚢 Corredor Fluvial:</strong> Ríos navegables clave para llevar ayudas cuando fallan las vías terrestres.</li>
            <li style="margin-bottom:5px;"><strong style="color:#0D9488;">⛵ Ruta Marítima:</strong> Conexión por mar entre municipios costeros del Pacífico.</li>
            <li style="margin-bottom:5px;"><strong style="color:#2563EB;">✈️ Terminal Aéreo:</strong> Aeropuertos y pistas vitales para puentes aéreos de emergencia.</li>
            <li style="margin-bottom:5px;"><strong style="color:#E11D48;">🏥 Centro Asistencial:</strong> Hospitales y centros de salud que deben seguir funcionando tras un sismo.</li>
            <li><strong style="color:#9333EA;">⚓ Muelle / Puerto:</strong> Puertos y embarcaderos para carga y abastecimiento.</li>
        </ul>
        <div style="background:rgba(245,158,11,0.12); border:1.5px solid #F59E0B; border-radius:12px; padding:12px 14px;">
            <strong style="font-size:var(--fs-sm);">¿Cómo ver los nombres y cómo quitarla?</strong>
            <p style="margin:6px 0 0 0; font-size:var(--fs-sm); line-height:1.45;">
                Activa el interruptor y pasa el ratón por encima de cualquier línea o punto de color para ver el nombre de la vía, río, aeropuerto u hospital. Apaga el interruptor cuando quieras limpiar el mapa.
            </p>
        </div>
    `
};

const INFO_MODAL_ACCENTS = {
    nsr10_info: '#047857',
    espectro_info: '#047857',
    geotecnia_info: '#047857',
    pot_info: '#B45309',
    infra_info: '#B45309'
};

const INFO_MODAL_PROFILE_CLASSES = {
    nsr10_info: 'modal-ctx-nsr',
    espectro_info: 'modal-ctx-nsr',
    geotecnia_info: 'modal-ctx-nsr',
    pot_info: 'modal-ctx-pot',
    infra_info: 'modal-ctx-pot'
};

if (infoModal && closeInfoModal) {
    const infoModalDialog = infoModal.querySelector(':scope > div');
    const applyModalContextBorder = (key) => {
        if (!infoModalDialog) return;
        const accent = INFO_MODAL_ACCENTS[key] || '#0052CC';
        infoModalDialog.style.borderTop = `4px solid ${accent}`;
        infoModal.classList.remove('modal-ctx-sismo', 'modal-ctx-nsr', 'modal-ctx-pot');
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
        if (e.target && e.target.id === 'btn-entendido-guia') {
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
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-bottom:14px;">
            <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:10px; padding:12px;">
                <h4 style="margin:0 0 8px 0; font-size:var(--fs-xs); color:#38bdf8; text-transform:uppercase; letter-spacing:0.04em;">1. Localización y Capacidad Institucional</h4>
                <p style="margin:0 0 4px 0; font-size:var(--fs-xs);"><strong>Municipio:</strong> ${escapeHtml(m.nombre)} (${escapeHtml(m.departamento)})</p>
                <p style="margin:0 0 4px 0; font-size:var(--fs-xs);"><strong>Categoría Ley 617/2000:</strong> ${escapeHtml(m.categoria_ley617 || 'Referencia')}</p>
                <p style="margin:0 0 4px 0; font-size:var(--fs-xs);"><strong>Población de Referencia:</strong> ${(m.poblacion || 0).toLocaleString()} habitantes</p>
                <p style="margin:0 0 4px 0; font-size:var(--fs-xs);"><strong>Conectividad:</strong> ${escapeHtml(m.acceso_principal || 'Consultar red')}</p>
                <p style="margin:0; font-size:var(--fs-xs);"><strong>Coordenadas Cabecera:</strong> Lat ${m.lat.toFixed(4)}°, Lon ${m.lng.toFixed(4)}°</p>
            </div>

            <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:10px; padding:12px;">
                <h4 style="margin:0 0 8px 0; font-size:var(--fs-xs); color:#38bdf8; text-transform:uppercase; letter-spacing:0.04em;">2. Parámetros Oficiales NSR-10</h4>
                <p style="margin:0 0 4px 0; font-size:var(--fs-xs);"><strong>Zona de Amenaza Sísmica:</strong> <span class="status-pill critico">🔴 ${escapeHtml(m.zona)}</span></p>
                <p style="margin:0 0 4px 0; font-size:var(--fs-xs);"><strong>Coeficientes de Aceleración:</strong> Aa = ${m.aa.toFixed(2)} g | Av = ${m.av.toFixed(2)} g</p>
                <p style="margin:0 0 4px 0; font-size:var(--fs-xs);"><strong>Perfil de Suelo Referencial:</strong> Tipo ${escapeHtml(m.suelo_defecto || 'E')} (Fa=${factors.Fa}, Fv=${factors.Fv})</p>
                <p style="margin:0; font-size:var(--fs-xs);"><strong>PGA Esperado en Superficie:</strong> <strong style="color:#38bdf8;">${pgaDiseno} g</strong></p>
            </div>
        </div>

        <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:10px; padding:12px; margin-bottom:14px;">
            <h4 style="margin:0 0 8px 0; font-size:var(--fs-xs); color:#38bdf8; text-transform:uppercase; letter-spacing:0.04em;">3. Contexto Sismotectónico y Exposición de Líneas Vitales</h4>
            <p style="margin:0 0 5px 0; font-size:var(--fs-xs);"><strong>Geología Local:</strong> ${escapeHtml(m.geologia)}</p>
            <p style="margin:0 0 5px 0; font-size:var(--fs-xs);"><strong>Sismos Instrumentales en 50 km:</strong> ${sismos50km} eventos (Magnitud máx: ${maxMag50km > 0 ? maxMag50km.toFixed(1) : 's/d'})</p>
            <p style="margin:0 0 5px 0; font-size:var(--fs-xs);"><strong>Eventos Históricos de Referencia:</strong> ${escapeHtml(m.ultimo_destructor)}</p>
            <p style="margin:0 0 5px 0; font-size:var(--fs-xs);"><strong>Fallas Cartografiadas Próximas:</strong> ${fallasCercanas.length > 0 ? fallasCercanas.map(f => `${escapeHtml(f.nombre)} (${f.dist} km)`).join(', ') : 'Sin trazas dentro de 75 km en capa local'}</p>
            <p style="margin:0; font-size:var(--fs-xs);"><strong>Infraestructura Crítica en 45 km:</strong> ${nearbyInfra.length > 0 ? nearbyInfra.slice(0, 6).map(i => `${escapeHtml(i.nombre)} (${i.distKm} km)`).join('; ') : 'Sin nodos mapeados en 45 km — verificar red local REPS/DIMAR'}</p>
        </div>

        <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:10px; padding:12px; margin-bottom:14px;">
            <h4 style="margin:0 0 8px 0; font-size:var(--fs-xs); color:#ff7b72; text-transform:uppercase; letter-spacing:0.04em;">4. Matriz Cualitativa de Fenómenos Concomitantes</h4>
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
                        <td>${licLabel}</td>
                        <td>Indicador cualitativo regional; exige ensayos SPT/CPT y nivel freático en estudios geotécnicos de detalle (NSR-10 Título H).</td>
                    </tr>
                    <tr>
                        <td><strong>Exposición a Tsunami</strong></td>
                        <td>${m.costero_pacifico ? '🔴 LITORAL PACÍFICO EXPUESTO' : '🟢 INTERIOR (No costero)'}</td>
                        <td>${m.costero_pacifico ? 'Verificar cartografía oficial de inundación por tsunami (DIMAR / SGC / UNGRD) y rutas hacia cota segura.' : 'Sin exposición directa a oleaje tsunamigénico.'}</td>
                    </tr>
                    <tr>
                        <td><strong>Inestabilidad de Laderas</strong></td>
                        <td>🟠 ALTA / VARIABLE</td>
                        <td>Susceptibilidad potencial a bloqueos viales y fluviales por saturación hídrica cosísmica.</td>
                    </tr>
                </tbody>
            </table>
        </div>

        <div style="background:rgba(10,132,255,0.08); border:1px solid rgba(10,132,255,0.25); border-radius:10px; padding:12px;">
            <h4 style="margin:0 0 8px 0; font-size:var(--fs-xs); color:#70b5ff; text-transform:uppercase; letter-spacing:0.04em;">5. Lineamientos Técnicos Orientadores (No Vinculantes)</h4>
            <ol style="margin:0; padding-left:18px; font-size:var(--fs-xs); color:var(--text-secondary); line-height:1.5;">
                <li style="margin-bottom:4px;">${directrizTerritorial}</li>
                <li style="margin-bottom:4px;"><strong>Articulación Decreto 1807 de 2014 (Dec. 1077/2015):</strong> Esta ficha constituye un insumo orientador preliminar y no reemplaza los Estudios Básicos ni Detallados ni las competencias de asistencia técnica de CODECHOCÓ.</li>
                <li style="margin-bottom:4px;"><strong>Enfoque Territorial y Étnico (Ley 70/1993):</strong> Toda delimitación de suelos de protección o reasentamiento en consejos comunitarios y resguardos requiere cartografía IGAC/ANT y consulta previa (Convenio 169 OIT).</li>
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


