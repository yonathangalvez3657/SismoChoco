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
        OQ_API: `${httpProto}//${host}/api/openquake_mock`,
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
const OQ_API = ENDPOINTS.OQ_API;
const MUNICIPIOS_API = ENDPOINTS.MUNICIPIOS_API;
const INFRA_API = ENDPOINTS.INFRA_API;

let mapData = { features: [] };
let sgcData = { features: [] };
let mlData = { features: [] };
let oqData = { features: [] };
let infraData = null;
let faultData = null;
let municipiosData = [];
let nsrEspectroChart = null;

let viewMode = 'none'; 
let currentMag = 0.0;
let currentTime = 1993;
let currentMaxDepth = 150.0;
let highQualityOnly = false;
let showFaults = false;
let showInfra = false;
let selectedFaultId = null;
let faultKinematicFilter = 'all';
let showFaultBuffer = false;
let showLiveSGC = false;
let showML = false;
let showOQ = false;

// Variables de Estado (NSR-10, POT, Benioff, ShakeMap, Time-Lapse)
let currentProfile = 'sismologia';
let isBenioffMode = false;
let benioffExaggeration = 1.5;
let benioffSector = 'all';
let selectedNsrMunicipio = null;
let selectedPotMunicipio = null;

// ShakeMap Simulado
let isSimulatorActive = false;
let activeShakemapScenario = 'murindo_73';
let currentShakemapData = null;

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

const deckgl = new deck.DeckGL({
    container: 'map-container',
    mapStyle: currentMapStyle,
    glOptions: { preserveDrawingBuffer: true }, // Requerido para capturar Canvas en PDF
    initialViewState: { longitude: -77.0, latitude: 6.0, zoom: 6.5, pitch: 45, bearing: 15 },
    controller: { dragRotate: true },
    layers: [],
    getCursor: ({isDragging}) => isDragging ? 'grabbing' : 'default'
});

const ctx = document.getElementById('gr-chart').getContext('2d');
Chart.defaults.color = '#94a3b8';
Chart.defaults.font.family = 'Inter';

// ============================================================================
// LEY DE GUTENBERG-RICHTER: Log10(N) = a - b * Mw
// ============================================================================
function calculateBValue(labels, dataLog) {
    // Estimación por Mínimos Cuadrados para sismos >= 3.0 (magnitud de completitud)
    let validPts = [];
    for (let i = 0; i < labels.length; i++) {
        if (labels[i] >= 3.0 && dataLog[i] > 0) {
            validPts.push({ x: labels[i], y: dataLog[i] });
        }
    }
    if (validPts.length < 3) return null;

    let n = validPts.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    validPts.forEach(p => {
        sumX += p.x;
        sumY += p.y;
        sumXY += p.x * p.y;
        sumX2 += p.x * p.x;
    });

    let denom = (n * sumX2 - sumX * sumX);
    if (denom === 0) return null;
    
    let slope = (n * sumXY - sumX * sumY) / denom;
    return Math.abs(slope); // b = -pendiente
}

function updateChart(filteredData) {
    let counts = {};
    filteredData.forEach(f => {
        let m = Math.floor(f.properties.magnitud * 10) / 10;
        counts[m] = (counts[m] || 0) + 1;
    });
    let labels = Object.keys(counts).map(Number).sort((a,b) => a-b);
    let dataLog = [];
    for(let i = 0; i < labels.length; i++) {
        let sum = 0;
        for(let j = i; j < labels.length; j++) { sum += counts[labels[j]]; }
        dataLog.push(sum > 0 ? Math.log10(sum) : 0);
    }

    // Cálculo y actualización del valor b en pantalla
    const bVal = calculateBValue(labels, dataLog);
    const bBadge = document.getElementById('b-value-badge');
    if (bBadge) {
        if (bVal !== null && !isNaN(bVal)) {
            bBadge.innerText = `b = ${bVal.toFixed(2)}`;
            bBadge.style.color = '#38bdf8';
            bBadge.style.borderColor = 'rgba(56,189,248,0.3)';
            bBadge.title = `Pendiente de Gutenberg-Richter: b = ${bVal.toFixed(2)} (Valores típicos de subducción: 0.8 - 1.1)`;
        } else {
            bBadge.innerText = 'b = --';
        }
    }

    // Cálculo y actualización de Períodos de Retorno Estimados
    const yearsSpan = Math.max(1, 2026 - currentTime + 1);
    const countM5 = filteredData.filter(f => (f.properties.magnitud || 0) >= 5.0).length;
    const countM6 = filteredData.filter(f => (f.properties.magnitud || 0) >= 6.0).length;
    const countM7 = filteredData.filter(f => (f.properties.magnitud || 0) >= 7.0).length;

    const elTr5 = document.getElementById('tr-m5');
    const elTr6 = document.getElementById('tr-m6');
    const elTr7 = document.getElementById('tr-m7');
    if (elTr5) elTr5.innerText = countM5 > 0 ? `~${(yearsSpan / countM5).toFixed(1)} a` : '> 35 a';
    if (elTr6) elTr6.innerText = countM6 > 0 ? `~${(yearsSpan / countM6).toFixed(1)} a` : '> 50 a';
    if (elTr7) elTr7.innerText = countM7 > 0 ? `~${(yearsSpan / countM7).toFixed(1)} a` : '> 80 a';

    if(chartInstance) chartInstance.destroy();
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
            responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
            scales: {
                x: { title: { display: true, text: 'Mw' }, grid: { color: 'rgba(255,255,255,0.05)' } },
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
function handleHover(info) {
    if (info.object) {
        const p = info.object.properties;
        tooltip.style.display = 'block';
        tooltip.style.left = `${info.x}px`; tooltip.style.top = `${info.y}px`;
        
        if (p.pga !== undefined) {
            tooltip.innerHTML = `<h4>Modelo de Amenaza OpenQuake</h4>
                                 <p><strong>Aceleración Pico (PGA):</strong> ${p.pga} g</p>
                                 <p><strong>Periodo de Retorno (Tr):</strong> ${p.retorno} años</p>
                                 <p style="font-size: 0.7rem; margin-top: 6px; line-height: 1.3;">Aceleración máxima del terreno esperada con un 10% de probabilidad de excedencia en 50 años (Norma NSR-10).</p>`;
        } else if (p.cluster_id !== undefined) {
            const col = getClusterColor(p.cluster_id);
            const colorHex = `rgb(${col[0]},${col[1]},${col[2]})`;
            const magTxt = p.magnitud ? `${p.magnitud.toFixed(1)} Mw` : '≥ 4.0 Mw';
            const munTxt = p.municipio ? p.municipio.replace(/_/g, ' ') : 'Chocó, Colombia';
            const profTxt = (p.profundidad !== undefined && p.profundidad !== null) ? `<p><strong>Profundidad:</strong> ${p.profundidad} km</p>` : '';
            const fechaTxt = p.fecha ? `<p><strong>Fecha:</strong> ${p.fecha}</p>` : '';
            tooltip.innerHTML = `<h4>Enjambre Sísmico (IA DBSCAN)</h4>
                                 <p><strong>Ubicación:</strong> ${munTxt}</p>
                                 <p><strong>Clúster Tectónico:</strong> <span style="color:${colorHex}; font-weight:bold; text-shadow:0 0 8px ${colorHex};">Grupo #${p.cluster_id}</span></p>
                                 <p><strong>Magnitud del Evento:</strong> ${magTxt}</p>
                                 ${profTxt}
                                 ${fechaTxt}
                                 <p style="font-size: 0.7rem; margin-top: 6px; line-height: 1.3;">Agrupación de alta densidad espacial (&gt;4.0 Mw) detectada en radio geodésico de 15 km mediante algoritmo DBSCAN sobre el catálogo sísmico.</p>`;
        } else if (p.tipo && (p.tipo === 'vial' || p.tipo === 'fluvial' || p.tipo === 'aeropuerto' || p.tipo === 'hospital')) {
            let icon = p.tipo === 'aeropuerto' ? '✈️' : (p.tipo === 'hospital' ? '🏥' : (p.tipo === 'fluvial' ? '🚢' : '🛣️'));
            let sub = p.subtipo || p.nivel || p.tipo;
            tooltip.innerHTML = `<h4>${icon} ${p.nombre}</h4>
                                 <p><strong>Categoría:</strong> ${sub}</p>
                                 ${p.ciudad ? `<p><strong>Municipio:</strong> ${p.ciudad}</p>` : ''}
                                 ${p.longitud_km ? `<p><strong>Longitud de Corredor:</strong> ${p.longitud_km} km</p>` : ''}
                                 ${p.vulnerabilidad ? `<p style="color:#ffb703;"><strong>Vulnerabilidad:</strong> ${p.vulnerabilidad}</p>` : ''}
                                 ${p.rol ? `<p><strong>Función Estratégica:</strong> ${p.rol}</p>` : ''}
                                 ${p.importancia_nsr10 ? `<p style="color:#38bdf8;"><strong>Clasificación NSR-10:</strong> ${p.importancia_nsr10}</p>` : ''}`;
        } else if (p.nombre) {
            let desc = "";
            if (p.nombre.includes("Nazca")) {
                desc = `<p style="font-size: 0.7rem; margin-top: 6px; line-height: 1.3;">Límite de colisión tectónica (Margen Convergente o Fosa) donde la placa oceánica de Nazca se subduce bajo la placa continental Sudamericana, responsable de la sismicidad más destructiva de la región.</p>`;
            }
            tooltip.innerHTML = `<h4>Estructura Geológica</h4>
                                 <p><strong>Falla:</strong> ${p.nombre.replace(' (Margen)', '')}</p>
                                 ${desc}`;
        } else {
            const depthStr = p.profundidad < 30 ? 'Superficial' : (p.profundidad < 70 ? 'Intermedio' : 'Profundo');
            const fuenteInfo = p.municipio.includes('SGC Live') ? '<span style="color:#10b981; font-weight:bold;">[SGC Live]</span> ' : '';
            let benioffExtra = '';
            if (isBenioffMode) {
                const zVisual = (p.profundidad * benioffExaggeration).toFixed(1);
                benioffExtra = `<p style="color:#38bdf8; font-size:0.72rem; margin-top:4px;">📐 <strong>Corte Benioff:</strong> Profundidad Z: -${zVisual} km (${benioffExaggeration.toFixed(2)}x)</p>`;
            }
            tooltip.innerHTML = `<h4>${p.fecha}</h4><p><strong>Mag:</strong> ${p.magnitud} Mw</p><p><strong>Profundidad:</strong> ${p.profundidad} km (${depthStr})</p><p><strong>Ubicación:</strong> ${fuenteInfo}${p.municipio}</p>${benioffExtra}`;
        }
    } else {
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

        tooltip.innerHTML = `<h4>Foco de Acumulación Sísmica</h4>
                             <p><strong>Ubicación:</strong> ${mainLocation}</p>
                             <p>Total sismos acumulados: <strong>${totalSismos} eventos</strong></p>
                             <p>Magnitud Máxima en zona: <strong>${maxMag > 0 ? maxMag.toFixed(1) : 'N/A'} Mw</strong></p>`;
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

        tooltip.innerHTML = `<h4>Agrupación Espacial 3D</h4>
                             <p><strong>Ubicación:</strong> ${mainLocation}</p>
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
        tooltip.innerHTML = `
            <h4>Concentración de Energía Sísmica 3D</h4>
            <p><strong>Ubicación:</strong> ${p.municipio || 'Chocó - Región Pacífica'}</p>
            <p><strong>Magnitud:</strong> <span style="color:#fbbf24; font-weight:bold;">${mag.toFixed(1)} Mw</span></p>
            <p><strong>Profundidad Hipocentral:</strong> ${prof.toFixed(1)} km (${estrato})</p>
            <p><strong>Energía Radiada:</strong> <span style="color:#f97316; font-weight:700;">${joules.toExponential(2)} Joules</span></p>
            <p style="font-size:0.72rem; color:var(--text-secondary); margin-top:4px; line-height:1.3;">Equivalente detonante: ≈ ${tonsTnt < 1 ? (tonsTnt * 1000).toFixed(0) + ' kg TNT' : tonsTnt.toFixed(1) + ' Toneladas TNT'}.</p>
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

        tooltip.innerHTML = `
            <h4>Agrupación Espacial 3D (Cúmulo de Subducción)</h4>
            <p><strong>Sector:</strong> ${d.municipio}</p>
            <p><strong>Profundidad Media:</strong> ${d.avgProf.toFixed(1)} km</p>
            <p><strong>Sismos Agrupados en Celda:</strong> <span style="color:#34d399; font-weight:bold;">${d.count} eventos</span></p>
            <p><strong>Rango de Magnitud:</strong> ${d.minMag.toFixed(1)} - ${d.maxMag.toFixed(1)} Mw</p>
            <p style="font-size:0.72rem; color:var(--text-secondary); margin-top:4px; line-height:1.3;">Nivel: ${nivel}. Prisma 3D anclado a la losa subducente.</p>
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
                <h4 style="margin:0; font-size:0.85rem; color:#fff;">${p.nombre}</h4>
            </div>
            <p style="margin:2px 0;"><span style="display:inline-block; padding:1px 6px; border-radius:4px; font-size:0.68rem; font-weight:bold; background:rgba(255,255,255,0.1); color:${colorBadge};">${tipoBadge}</span></p>
            <p style="margin:2px 0;"><strong>Sistema:</strong> ${p.sistema || 'Falla Activa'}</p>
            <p style="margin:2px 0;"><strong>Tasa de Desplazamiento:</strong> ${p.tasa_mm_ano || 2.0} mm/año</p>
            <p style="margin:2px 0;"><strong>Potencial Sismogénico:</strong> <span style="color:#ef4444; font-weight:bold;">${p.m_max || 7.0} Mw</span></p>
            <p style="margin:2px 0;"><strong>Longitud de Traza:</strong> ${p.longitud_km || 100} km</p>
            ${p.sismo_historico ? `<p style="margin:2px 0; color:#fbbf24; font-size:0.72rem;"><strong>Sismo Destructor:</strong> ${p.sismo_historico}</p>` : ''}
        `;
    } else {
        tooltip.style.display = 'none';
    }
}

function handleFaultClick(info) {
    if (!info.object || !info.object.properties) return;
    const p = info.object.properties;
    selectFault(p.id, true);
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

function renderLayers() {
    let layers = [];

    const filteredData = mapData.features.filter(f => {
        const p = f.properties;
        if(p.anio < currentTime) return false; // Filtra descartando sismos anteriores al año mínimo
        if(p.magnitud < currentMag) return false;
        if(p.profundidad !== undefined && p.profundidad > currentMaxDepth) return false; // Filtro de profundidad hipocentral
        if(highQualityOnly && p.gap !== undefined && (p.gap > 180 || p.rms > 1.0)) return false;

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
    updateChart(filteredData);
    window.currentFilteredData = filteredData;

    if (!showOQ) {
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
                    if (prof < 30) return [235, 150, 0, 220];   // Naranja/Ámbar (Superficial - Ajustado para fondo blanco)
                    if (prof < 70) return [255, 105, 180, 200]; // Rosa (Intermedio)
                    return [75, 0, 130, 200];                   // Índigo oscuro (Profundo)
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
    }

    if (showLiveSGC && sgcData.features.length > 0) {
        // Capa Exclusiva para SGC Live en Píxeles (Autoajustable al Zoom)
        layers.push(new deck.ScatterplotLayer({
            id: 'sgc-live-layer',
            data: sgcData.features,
            getPosition: d => [d.geometry.coordinates[0], d.geometry.coordinates[1], 10000],
            radiusUnits: 'pixels',
            getRadius: d => Math.max((d.properties.mag || d.properties.magnitud || 3.0) * 4, 14), // Tamaño directo en píxeles de pantalla
            getFillColor: [16, 185, 129, 210], // Verde Esmeralda
            stroked: true,
            getLineColor: [255, 255, 255, 255],
            lineWidthMinPixels: 2,
            pickable: true,
            onHover: handleHover
        }));
    }

    if (showOQ && oqData.features.length > 0) {
        layers.push(new deck.HeatmapLayer({
            id: 'oq-hazard',
            data: oqData.features,
            getPosition: d => d.geometry.coordinates,
            getWeight: d => d.properties.pga,
            radiusPixels: 90,
            intensity: 1.5,
            threshold: 0.1,
            colorRange: [ [255, 255, 178], [254, 204, 92], [253, 141, 60], [240, 59, 32], [189, 0, 38] ]
        }));
        layers.push(new deck.ScatterplotLayer({
            id: 'oq-hover', data: oqData.features, getPosition: d => d.geometry.coordinates, getRadius: 6000, getFillColor: [0,0,0,0], pickable: true, onHover: handleHover
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

    // CAPA 1: INFRAESTRUCTURA CRÍTICA (VÍAS PRIMARIAS, FLUVIAL, HOSPITALES, AEROPUERTOS)
    if (showInfra && infraData && infraData.features) {
        const lineasInfra = infraData.features.filter(f => f.geometry.type === 'LineString');
        const puntosInfra = infraData.features.filter(f => f.geometry.type === 'Point');

        if (lineasInfra.length > 0) {
            layers.push(new deck.PathLayer({
                id: 'infra-lineas',
                data: lineasInfra,
                getPath: d => d.geometry.coordinates,
                getWidth: d => d.properties.tipo === 'vial' ? 4 : 5,
                widthUnits: 'pixels',
                getColor: d => d.properties.tipo === 'vial' ? [255, 183, 3, 230] : [56, 189, 248, 230], // Amarillo oro (vial) / Cian claro (fluvial)
                pickable: true,
                autoHighlight: true,
                highlightColor: [255, 255, 255, 240],
                onHover: handleHover
            }));
        }

        if (puntosInfra.length > 0) {
            layers.push(new deck.ScatterplotLayer({
                id: 'infra-puntos',
                data: puntosInfra,
                getPosition: d => [d.geometry.coordinates[0], d.geometry.coordinates[1], 20],
                radiusUnits: 'pixels',
                getRadius: d => d.properties.tipo === 'hospital' ? 14 : 12,
                getFillColor: d => d.properties.tipo === 'hospital' ? [255, 45, 85, 240] : [10, 132, 255, 240], // Fucsia/Rojo (Hospital) / Azul (Aeropuerto)
                stroked: true,
                getLineColor: [255, 255, 255, 255],
                lineWidthMinPixels: 2.5,
                pickable: true,
                autoHighlight: true,
                highlightColor: [255, 255, 255, 240],
                onHover: handleHover
            }));
        }
    }

    // CAPA 2: SIMULADOR INTERACTIVO SHAKEMAP (BANDAS MMI Y EPICENTRO COSÍSMICO)
    if (isSimulatorActive && currentShakemapData) {
        // Ordenar de mayor a menor radio para que los discos externos no tapen los núcleos de mayor intensidad
        const sortedIsoseistas = [...currentShakemapData.isoseistas].sort((a, b) => b.radioM - a.radioM);

        // Anillos volumétricos concéntricos de atenuación GMPE
        layers.push(new deck.ScatterplotLayer({
            id: 'shakemap-isoseistas',
            data: sortedIsoseistas,
            getPosition: d => [currentShakemapData.epicentro[0], currentShakemapData.epicentro[1], 5],
            radiusUnits: 'meters',
            getRadius: d => d.radioM,
            getFillColor: d => d.color,
            stroked: true,
            getLineColor: d => d.borde,
            lineWidthMinPixels: 2.5,
            pickable: true,
            updateTriggers: {
                getPosition: [activeShakemapScenario],
                getRadius: [activeShakemapScenario],
                getFillColor: [activeShakemapScenario],
                getLineColor: [activeShakemapScenario]
            },
            onHover: (info) => {
                if (info.object) {
                    const obj = info.object;
                    tooltip.style.display = 'block';
                    tooltip.style.left = `${info.x}px`;
                    tooltip.style.top = `${info.y}px`;
                    tooltip.innerHTML = `<h4>💥 ShakeMap: Intensidad ${obj.mmi}</h4>
                                         <p><strong>Nivel de Daño:</strong> ${obj.label}</p>
                                         <p><strong>Aceleración Pico Estimada:</strong> ${obj.pgaRange}</p>
                                         <p><strong>Radio de Atenuación:</strong> ${Math.round(obj.radioM / 1000)} km del epicentro</p>`;
                } else {
                    tooltip.style.display = 'none';
                }
            }
        }));

        // Marcador nuclear del Epicentro Cosísmico con halo de alerta
        layers.push(new deck.ScatterplotLayer({
            id: 'shakemap-epicentro-halo',
            data: [currentShakemapData],
            getPosition: d => [d.epicentro[0], d.epicentro[1], 45],
            radiusUnits: 'pixels',
            getRadius: 36,
            getFillColor: [255, 69, 58, 70],
            stroked: true,
            getLineColor: [255, 69, 58, 200],
            lineWidthMinPixels: 2,
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
                    const d = info.object;
                    tooltip.style.display = 'block';
                    tooltip.style.left = `${info.x}px`;
                    tooltip.style.top = `${info.y}px`;
                    tooltip.innerHTML = `<h4>⚡ Epicentro: ${d.nombre}</h4>
                                         <p><strong>Magnitud de Ruptura:</strong> <strong style="color:#ff453a;">${d.mw} Mw</strong></p>
                                         <p><strong>Profundidad Focal:</strong> ${d.profundidad} km</p>
                                         <p><strong>Aceleración Epicentral (PGA):</strong> <strong style="color:#ffd60a;">${d.pgaMax} g</strong></p>
                                         <p><strong>Falla Responsable:</strong> ${d.falla}</p>`;
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
                    tooltip.style.display = 'block';
                    tooltip.style.left = `${info.x}px`;
                    tooltip.style.top = `${info.y}px`;
                    tooltip.innerHTML = `<h4>🏛️ ${m.nombre} (${m.departamento})</h4>
                                         <p><strong>Perfil de Suelo:</strong> Tipo ${obj.curSuelo} (Fa=${obj.curFactors.Fa}, Fv=${obj.curFactors.Fv})</p>
                                         <p><strong>Grupo de Uso:</strong> I = ${obj.curI.toFixed(2)}</p>
                                         <p><strong>PGA Terreno:</strong> <strong style="color:#38bdf8;">${obj.curPga} g</strong> (Aa=${m.aa.toFixed(2)}g)</p>
                                         <p><strong>Sa Máx Meseta (Diseño):</strong> <strong style="color:#ff453a;">${obj.curSaMax.toFixed(2)} g</strong></p>
                                         <p style="font-size:0.75rem; margin-top:4px; color:#A1A1A6;">${m.geologia}</p>`;
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

    // Lógica para la Leyenda Cartográfica Dinámica
    const legend = document.getElementById('map-legend');
    if (legend) {
        if (isSimulatorActive && currentShakemapData) {
            legend.style.display = 'block';
            legend.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; border-bottom:1px solid rgba(255,255,255,0.12); padding-bottom:5px;">
                    <h4 style="margin:0; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; color:#fff; font-size:0.8rem;">ShakeMap: Demanda MMI</h4>
                    <span style="font-size:0.68rem; color:#ffd60a; font-weight:600;">${currentShakemapData.mw} Mw</span>
                </div>
                <div style="display:flex; flex-direction:column; gap:5px; color:#A1A1A6; font-size:0.73rem; font-weight:500;">
                    <div style="display:flex; align-items:center; gap:8px;"><span style="display:block; width:12px; height:12px; border-radius:50%; background:rgb(255,59,48); border:1px solid #fff;"></span> <strong>MMI VIII - IX</strong> (≥ 0.50g - Severo)</div>
                    <div style="display:flex; align-items:center; gap:8px;"><span style="display:block; width:12px; height:12px; border-radius:50%; background:rgb(255,140,0); border:1px solid #ffb703;"></span> <strong>MMI VII</strong> (0.25 - 0.50g - Daño Mod.)</div>
                    <div style="display:flex; align-items:center; gap:8px;"><span style="display:block; width:12px; height:12px; border-radius:50%; background:rgb(255,214,10); border:1px solid #ffe600;"></span> <strong>MMI V - VI</strong> (0.10 - 0.25g - Fuerte)</div>
                    <div style="display:flex; align-items:center; gap:8px;"><span style="display:block; width:12px; height:12px; border-radius:50%; background:rgb(56,189,248); border:1px solid #38bdf8;"></span> <strong>MMI IV</strong> (&lt; 0.10g - Perceptible)</div>
                </div>
            `;
        } else if (viewMode === 'puntos') {
            legend.style.display = 'block';
            legend.innerHTML = `
                <h4 style="margin: 0 0 10px 0; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #F5F5F7;">Profundidad</h4>
                <div style="display: flex; flex-direction: column; gap: 6px; color: #A1A1A6; font-size: 0.75rem; font-weight: 500;">
                    <div style="display:flex; align-items:center; gap: 8px;"><span style="display:block; width:12px; height:12px; border-radius:50%; background:rgb(235,150,0);"></span> &lt; 30 km (Superficial)</div>
                    <div style="display:flex; align-items:center; gap: 8px;"><span style="display:block; width:12px; height:12px; border-radius:50%; background:rgb(255,105,180);"></span> 30 - 70 km (Intermedio)</div>
                    <div style="display:flex; align-items:center; gap: 8px;"><span style="display:block; width:12px; height:12px; border-radius:50%; background:rgb(75,0,130);"></span> &gt; 70 km (Profundo)</div>
                </div>
            `;
        } else if (viewMode === 'calor') {
            legend.style.display = 'block';
            if (isBenioffMode) {
                legend.innerHTML = `
                    <h4 style="margin: 0 0 10px 0; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #F5F5F7;">Energía Radiada 3D</h4>
                    <div style="display: flex; align-items: center; justify-content: space-between; height: 12px; border-radius: 6px; margin-bottom: 5px; background: linear-gradient(to right, rgb(101,21,110), rgb(159,42,99), rgb(212,72,66), rgb(250,193,39), rgb(255,255,220));"></div>
                    <div style="display: flex; justify-content: space-between; color: #A1A1A6; font-size: 0.75rem; font-weight: 500;">
                        <span>10¹⁰ J (M3)</span>
                        <span>10¹⁵ J (M7+)</span>
                    </div>
                `;
            } else {
                legend.innerHTML = `
                    <h4 style="margin: 0 0 10px 0; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #F5F5F7;">Densidad Térmica</h4>
                    <div style="display: flex; align-items: center; justify-content: space-between; height: 12px; border-radius: 6px; margin-bottom: 5px; background: linear-gradient(to right, rgb(0,0,4), rgb(101,21,110), rgb(159,42,99), rgb(212,72,66), rgb(250,193,39), rgb(252,253,191));"></div>
                    <div style="display: flex; justify-content: space-between; color: #A1A1A6; font-size: 0.75rem; font-weight: 500;">
                        <span>Baja</span>
                        <span>Alta</span>
                    </div>
                `;
            }
        } else if (viewMode === 'hex') {
            legend.style.display = 'block';
            if (isBenioffMode) {
                legend.innerHTML = `
                    <h4 style="margin: 0 0 10px 0; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #F5F5F7;">Cúmulos 3D (Subducción)</h4>
                    <div style="display: flex; align-items: center; justify-content: space-between; height: 12px; border-radius: 6px; margin-bottom: 5px; background: linear-gradient(to right, rgb(68,1,84), rgb(59,82,139), rgb(33,145,140), rgb(94,201,98), rgb(253,231,37));"></div>
                    <div style="display: flex; justify-content: space-between; color: #A1A1A6; font-size: 0.75rem; font-weight: 500;">
                        <span>1 Sismo</span>
                        <span>20+ Sismos</span>
                    </div>
                `;
            } else {
                legend.innerHTML = `
                    <h4 style="margin: 0 0 10px 0; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #F5F5F7;">Agrupación (8km)</h4>
                    <div style="display: flex; align-items: center; justify-content: space-between; height: 12px; border-radius: 6px; margin-bottom: 5px; background: linear-gradient(to right, rgb(68,1,84), rgb(49,104,142), rgb(53,183,121), rgb(181,222,43), rgb(253,231,37));"></div>
                    <div style="display: flex; justify-content: space-between; color: #A1A1A6; font-size: 0.75rem; font-weight: 500;">
                        <span>1 Sismo</span>
                        <span>50+ Sismos</span>
                    </div>
                `;
            }
        } else {
            legend.style.display = 'none';
        }
    }

    deckgl.setProps({ layers: layers });
}

// ============================================================================
// BOTON HOME
// ============================================================================
const btnHome = document.getElementById('btn-home');
if (btnHome) {
    btnHome.addEventListener('click', () => {
        document.getElementById('btn-reset').click();
        document.getElementById('btn-reset-vis').click();
        document.getElementById('btn-reset-capas').click();
        if (isBenioffMode) {
            toggleBenioffMode(false);
        }
        selectedNsrMunicipio = null;

        // Restablecer la cámara 3D a la vista original por defecto
        if (deckgl) {
            deckgl.setProps({
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
        }
        renderLayers();
    });
}

// ============================================================================
// RESET FILTERS
// ============================================================================
document.getElementById('btn-reset').addEventListener('click', () => {
    // Restaurar Magnitud
    document.getElementById('mag-slider').value = 0;
    currentMag = 0;
    document.getElementById('mag-val').innerText = '0.0';
    
    // Restaurar Tiempo
    document.getElementById('time-slider').value = 1993;
    currentTime = 1993;
    document.getElementById('time-val').innerText = '1993';

    // Restaurar Profundidad
    const depthSlider = document.getElementById('depth-slider');
    if (depthSlider) {
        depthSlider.value = 150;
        currentMaxDepth = 150.0;
        const depthVal = document.getElementById('depth-val');
        if (depthVal) depthVal.innerText = '150 km';
    }
    
    // Disparar Render
    renderLayers();
});

// Reset Visualización
document.getElementById('btn-reset-vis').addEventListener('click', () => {
    viewMode = 'none';
    
    const viewBtns = [document.getElementById('btn-puntos'), document.getElementById('btn-calor'), document.getElementById('btn-hex')];
    viewBtns.forEach(b => { if(b) b.classList.remove('active'); });
    
    if (isBenioffMode) {
        toggleBenioffMode(false);
    }
    
    renderLayers();
});

// Reset Capas Avanzadas
document.getElementById('btn-reset-capas').addEventListener('click', () => {
    highQualityOnly = false;
    showFaults = false;
    showInfra = false;
    selectedFaultId = null;
    showFaultBuffer = false;
    faultKinematicFilter = 'all';
    showLiveSGC = false;
    showML = false;
    showOQ = false;
    
    const checks = ['check-calidad', 'check-fallas', 'check-infra', 'check-live-sgc', 'check-ml', 'check-oq', 'check-fallas-buffer'];
    checks.forEach(id => {
        const el = document.getElementById(id);
        if(el) el.checked = false;
    });

    const fallasPanel = document.getElementById('fallas-interactive-panel');
    if (fallasPanel) fallasPanel.style.display = 'none';

    document.querySelectorAll('.falla-tipo-btn').forEach(b => {
        b.classList.remove('active');
        b.style.background = 'transparent';
        b.style.fontWeight = 'normal';
    });
    const allTipoBtn = document.querySelector('.falla-tipo-btn[data-tipo="all"]');
    if (allTipoBtn) {
        allTipoBtn.classList.add('active');
        allTipoBtn.style.background = 'rgba(255,255,255,0.15)';
        allTipoBtn.style.fontWeight = '600';
    }
    
    renderLayers();
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
            badge.innerText = '🟢 Online';
            badge.style.background = 'rgba(50, 215, 75, 0.15)';
            badge.style.color = '#32d74b';
            badge.style.borderColor = 'rgba(50, 215, 75, 0.3)';
            badge.title = 'Servidor FastAPI conectado y operativo';
        } else {
            throw new Error('Servidor retornó código ' + res.status);
        }
    } catch(e) {
        badge.innerText = '🔴 Modo Offline / Local';
        badge.style.background = 'rgba(255, 69, 58, 0.15)';
        badge.style.color = '#ff453a';
        badge.style.borderColor = 'rgba(255, 69, 58, 0.3)';
        badge.title = 'Servidor local desconectado. Usando caché offline PWA.';
    }
}

async function loadData() {
    checkServerHealth();
    try {
        const res = await fetch(API_URL);
        const progressEl = document.getElementById('loader-progress');
        
        if (!res.body) {
            // Fallback si el navegador bloquea Streams API
            mapData = await res.json();
            if(progressEl) progressEl.innerText = '100%';
        } else {
            // Configurar lector de flujo (Streams API) para barra de progreso
            const reader = res.body.getReader();
            const contentLength = +res.headers.get('Content-Length') || 3500000;
            
            let receivedLength = 0;
            let chunks = [];
            
            while(true) {
                const {done, value} = await reader.read();
                if (done) break;
                
                chunks.push(value);
                receivedLength += value.length;
                
                if(progressEl) {
                    const perc = Math.min(100, Math.round((receivedLength / contentLength) * 100));
                    progressEl.innerText = `${perc}%`;
                }
            }
            
            let chunksAll = new Uint8Array(receivedLength);
            let position = 0;
            for(let chunk of chunks) { chunksAll.set(chunk, position); position += chunk.length; }
            
            const result = new TextDecoder("utf-8").decode(chunksAll);
            mapData = JSON.parse(result);
        }
        
    } catch(e) { 
        console.error("Error API Sismos", e); 
        document.getElementById('count').innerText = "Error API"; 
    }
    
    try {
        const fRes = await fetch(ENDPOINTS.FALLAS_API); 
        faultData = await fRes.json();
    } catch(e) { console.error("Error API Fallas", e); }

    try {
        let munRes = await fetch(MUNICIPIOS_API).catch(() => null);
        if (!munRes || !munRes.ok) {
            munRes = await fetch('./data/municipios_choco_nsr10.json');
        }
        municipiosData = await munRes.json();
        initMunicipiosUI();
    } catch(e) { console.error("Error cargando municipios NSR-10", e); }

    try {
        let infraRes = await fetch(INFRA_API).catch(() => null);
        if (!infraRes || !infraRes.ok) {
            infraRes = await fetch('./data/vias_infraestructura.geojson');
        }
        infraData = await infraRes.json();
    } catch(e) { console.error("Error cargando infraestructura crítica", e); }
    
    try {
        if (deckgl) {
            deckgl.setProps({ mapStyle: BASEMAP_STYLES['voy'] });
        }
        const voyBtn = document.querySelector('.basemap-btn[data-style="voy"]');
        if (voyBtn) {
            document.querySelectorAll('.basemap-btn').forEach(b => b.classList.remove('active'));
            voyBtn.classList.add('active');
        }
        const btnPuntos = document.getElementById('btn-puntos');
        if (btnPuntos && viewMode === 'puntos') {
            btnPuntos.classList.add('active');
        }
        renderLayers();
    } catch(e) { console.error("Error renderizando capas", e); }
    
    // Fade out y remover pantalla de carga
    const loader = document.getElementById('loader-overlay');
    if(loader) {
        loader.style.opacity = '0';
        setTimeout(() => loader.remove(), 800);
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
            b.style.background = 'transparent';
            b.style.fontWeight = 'normal';
        });
        this.classList.add('active');
        this.style.background = 'rgba(255,255,255,0.15)';
        this.style.fontWeight = '600';
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

document.getElementById('check-live-sgc').addEventListener('change', e => {
    showLiveSGC = e.target.checked;
    
    if (showLiveSGC) {
        if (!liveSocket) {
            // Conectar al satélite vía WebSocket usando endpoint dinámico
            liveSocket = new WebSocket(ENDPOINTS.WS_URL);
            
            liveSocket.onmessage = (event) => {
                const incoming = JSON.parse(event.data);
                if (incoming.features && incoming.features.length > 0) {
                    // Agregar sismos al array en vivo
                    sgcData.features = [...sgcData.features, ...incoming.features];
                    // Renderizar automáticamente el mapa si la capa sigue activa
                    if (showLiveSGC) queueRender();
                }
            };
            
            liveSocket.onclose = () => { console.log("Satélite SGC Desconectado"); };
        }
    } else {
        // Desconectar satélite y limpiar memoria
        if (liveSocket) {
            liveSocket.close();
            liveSocket = null;
        }
        sgcData.features = [];
        renderLayers();
    }
});
document.getElementById('check-ml').addEventListener('change', async e => {
    showML = e.target.checked;
    if (showML && mlData.features.length === 0) {
        try { const r = await fetch(ML_API); mlData = await r.json(); } catch(e){}
    }
    renderLayers();
});
document.getElementById('check-oq').addEventListener('change', async e => {
    showOQ = e.target.checked;
    if (showOQ && oqData.features.length === 0) {
        try { const r = await fetch(OQ_API); oqData = await r.json(); } catch(e){}
    }
    renderLayers();
});

// Selector Dinámico de Mapas Base Cartográficos
document.querySelectorAll('.basemap-btn').forEach(btn => {
    btn.addEventListener('click', function() {
        document.querySelectorAll('.basemap-btn').forEach(b => b.classList.remove('active'));
        this.classList.add('active');
        const styleKey = this.getAttribute('data-style');
        if (BASEMAP_STYLES[styleKey]) {
            currentMapStyle = BASEMAP_STYLES[styleKey];
            deckgl.setProps({ mapStyle: currentMapStyle });
        }
    });
});

document.querySelectorAll('.toggle-btn').forEach(btn => {
    if (btn.id === "btn-export-csv" || btn.id === "btn-print") return;
    
    btn.addEventListener('click', function(e) {
        // Solo quitamos la clase active de los 3 botones principales
        const viewBtns = [document.getElementById('btn-puntos'), document.getElementById('btn-calor'), document.getElementById('btn-hex')];
        
        viewBtns.forEach(b => {
            if (b) {
                b.classList.remove('active');
                b.blur();
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

// Botones de Exportación
document.getElementById('btn-export-csv').addEventListener('click', () => {
    if(!window.currentFilteredData) return;
    let csv = "FECHA,LATITUD,LONGITUD,PROFUNDIDAD,MAGNITUD,MUNICIPIO\n";
    window.currentFilteredData.forEach(f => {
        const p = f.properties; const c = f.geometry.coordinates;
        csv += `${p.fecha},${c[1]},${c[0]},${p.profundidad},${p.magnitud},"${p.municipio}"\n`;
    });
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'sismos_filtrados.csv'; a.click();
});

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
        if (showLiveSGC) activeCapas.push('SGC Live');
        if (showML) activeCapas.push('Zonas Anómalas (IA)');
        if (showOQ) activeCapas.push('Amenaza OpenQuake');
        
        const countStr = window.currentFilteredData ? window.currentFilteredData.length.toLocaleString() : '0';
        printFilters.innerText = `Ventana: ${currentTime}-2026 | Magnitud: ≥ ${currentMag.toFixed(1)} Mw | Muestra: ${countStr} eventos | Modo: ${visModeNames[viewMode] || viewMode}${activeCapas.length > 0 ? ' | Capas: ' + activeCapas.join(', ') : ''}`;
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
        <h2 style="margin-top:0; color:#0A84FF; font-size:1.4rem; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:15px; margin-bottom:20px;">Guía de Uso de la Plataforma</h2>
        <p style="color:var(--text-secondary); font-size:0.95rem; line-height:1.6; margin-bottom:15px;">Bienvenido a la <strong>Plataforma interactiva basada en Research through Design para la visualización analítica de la acumulación de tensión sísmica en el departamento del Chocó</strong> (Universidad de Caldas — Maestría en Diseño y Creación Interactiva).</p>
        
        <h3 style="color:#F5F5F7; font-size:1.05rem; margin-top:15px; margin-bottom:8px;">1. Enfoque Research through Design (RtD)</h3>
        <p style="color:var(--text-secondary); font-size:0.9rem; line-height:1.5; margin-bottom:15px;">Esta plataforma no opera únicamente como un visor cartográfico, sino como un <em>artefacto generador de conocimiento</em>. A través de la interacción paramétrica en tiempo real, el usuario formula y valida hipótesis espaciales sobre la acumulación de deformación elástica en la zona de subducción del Pacífico y fallas corticales activas.</p>

        <h3 style="color:#F5F5F7; font-size:1.05rem; margin-top:15px; margin-bottom:8px;">2. Navegación en el Espacio Geoespacial 3D</h3>
        <ul style="color:var(--text-secondary); font-size:0.9rem; line-height:1.5; margin-bottom:15px; padding-left:20px;">
            <li><strong>Clic izquierdo + Arrastrar:</strong> Desplazar el mapa (Panorámica).</li>
            <li><strong>Clic derecho (o Ctrl + Clic) + Arrastrar:</strong> Orbitar e inclinar la perspectiva 3D (Pitch & Bearing).</li>
            <li><strong>Rueda del ratón:</strong> Acercar o alejar el zoom.</li>
            <li><strong>Botón Restablecer (⌂):</strong> Retorna la cámara a la vista cenital departamental y restaura filtros.</li>
        </ul>

        <h3 style="color:#F5F5F7; font-size:1.05rem; margin-top:15px; margin-bottom:8px;">3. Capas Analíticas y Modelado Estadístico</h3>
        <ul style="color:var(--text-secondary); font-size:0.9rem; line-height:1.5; margin-bottom:15px; padding-left:20px;">
            <li><strong>Eventos Individuales (Scatter 3D):</strong> Esferas codificadas por magnitud y profundidad focal hipocentral.</li>
            <li><strong>Concentración de Deformación (Heatmap):</strong> Densidad kernel de energía liberada en la corteza.</li>
            <li><strong>Agrupación Hexagonal 3D:</strong> Binning espacial volumétrico de densidad de sismicidad.</li>
            <li><strong>Ley Gutenberg-Richter:</strong> Estimación paramétrica del valor <em>b</em> y periodos de retorno sísmico.</li>
            <li><strong>Agrupamiento DBSCAN (IA):</strong> Detección de enjambres sísmicos y réplicas sin supervisión.</li>
            <li><strong>Perfil Benioff 3D:</strong> Proyección ortogonal de la losa oceánica subducida de Nazca (buzamiento ~32° Este).</li>
        </ul>
    `,
    'rtd': `
        <h2 style="margin-top:0; color:#0A84FF; font-size:1.4rem; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:15px; margin-bottom:20px;">Investigación a través del Diseño (Research through Design - RtD)</h2>
        <p style="color:var(--text-secondary); font-size:0.95rem; line-height:1.6; margin-bottom:12px;">El marco metodológico de esta investigación se fundamenta en <strong>Research through Design (RtD)</strong> (Zimmerman, Forlizzi & Evenson, 2007; Gaver, 2012), donde el proceso iterativo de diseño y construcción del artefacto digital interactivo constituye el medio epistemológico primario para generar conocimiento transferible.</p>
        <div style="background: rgba(10,132,255,0.08); border-left: 3px solid #0A84FF; padding: 12px 14px; border-radius: 6px; margin: 14px 0; color: #e2e8f0; font-size: 0.9rem; line-height: 1.5;">
            <strong>Línea Institucional:</strong> <em>Gestión y Transmisión del Conocimiento</em><br>
            <strong>Temática de Investigación:</strong> <em>Presentación de Información Compleja</em><br>
            <strong>Programa:</strong> Maestría en Diseño y Creación Interactiva — Universidad de Caldas
        </div>
        <h3 style="color:#F5F5F7; font-size:1.05rem; margin-top:15px; margin-bottom:8px;">Triangulación Visual Analytics:</h3>
        <p style="color:var(--text-secondary); font-size:0.9rem; line-height:1.5;">Siguiendo el mantra de Thomas & Cook (2005) y Shneiderman (1996), la plataforma articula el razonamiento analítico asistido por interfaces interactivas: <em>"Overview first, zoom and filter, then details-on-demand"</em>, reduciendo la carga cognitiva intrínseca ante volúmenes masivos de datos sismotectónicos.</p>
    `,
    'magnitud': `
        <h2 style="margin-top:0; color:#0A84FF; font-size:1.4rem; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:15px; margin-bottom:20px;">Magnitud (Mw)</h2>
        <p style="color:var(--text-secondary); font-size:0.95rem; line-height:1.5; margin-bottom:10px;">Filtra los sismos según la energía total liberada en su hipocentro.</p>
        <p style="color:var(--text-secondary); font-size:0.95rem; line-height:1.5;">En sismología moderna se usa la <strong>Escala de Magnitud de Momento (Mw)</strong>, que es mucho más precisa que la antigua escala de Richter. Es una escala logarítmica: un sismo de Mw 5.0 no es un 20% más fuerte que uno de 4.0... en realidad libera <strong>32 veces más energía destructiva</strong>.</p>
    `,
    'anio': `
        <h2 style="margin-top:0; color:#0A84FF; font-size:1.4rem; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:15px; margin-bottom:20px;">Ventana de Tiempo</h2>
        <p style="color:var(--text-secondary); font-size:0.95rem; line-height:1.5; margin-bottom:10px;">Permite analizar la sismicidad partiendo desde un año en específico (de 1993 a 2026).</p>
        <p style="color:var(--text-secondary); font-size:0.95rem; line-height:1.5;">Al mover el deslizador, tanto el mapa 3D como las estadísticas se actualizarán instantáneamente para revelar cómo se ha comportado, acumulado y migrado la tensión tectónica a lo largo de las últimas décadas en el Chocó.</p>
    `,
    'puntos': `
        <h2 style="margin-top:0; color:#0A84FF; font-size:1.4rem; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:15px; margin-bottom:20px;">Eventos Individuales (Scatter)</h2>
        <p style="color:var(--text-secondary); font-size:0.95rem; line-height:1.5; margin-bottom:10px;">Cada sismo registrado en el catálogo se dibuja como una esfera exacta en el espacio tridimensional del subsuelo.</p>
        <ul style="color:var(--text-secondary); font-size:0.95rem; line-height:1.5; margin-bottom:10px;">
            <li style="margin-bottom:6px;"><strong>El tamaño y color:</strong> Son directamente proporcionales a la Magnitud (Mw) del sismo.</li>
            <li><strong>La altura:</strong> Indica su profundidad bajo tierra (hipocentro), permitiendo ver perfiles de subducción (zonas de Benioff).</li>
        </ul>
    `,
    'calor': `
        <h2 style="margin-top:0; color:#0A84FF; font-size:1.4rem; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:15px; margin-bottom:20px;">Concentración de Energía (Heatmap)</h2>
        <p style="color:var(--text-secondary); font-size:0.95rem; line-height:1.5; margin-bottom:10px;">Difumina matemáticamente los puntos individuales para formar un mapa térmico continuo sobre la superficie.</p>
        <p style="color:var(--text-secondary); font-size:0.95rem; line-height:1.5;">Muestra visualmente de rojo a amarillo las zonas donde la corteza terrestre está sometida a mayor estrés sísmico acumulado a lo largo de los años. Es una herramienta fundamental para identificar zonas de alto riesgo inminente de ruptura o fallas ciegas.</p>
    `,
    'hex': `
        <h2 style="margin-top:0; color:#0A84FF; font-size:1.4rem; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:15px; margin-bottom:20px;">Agrupación Espacial (Hexbins 3D)</h2>
        <p style="color:var(--text-secondary); font-size:0.95rem; line-height:1.5; margin-bottom:10px;">Agrupa los sismos en prismas hexagonales volumétricos en 3D (similar a un panal de abejas).</p>
        <ul style="color:var(--text-secondary); font-size:0.95rem; line-height:1.5; margin-bottom:10px;">
            <li style="margin-bottom:6px;"><strong>La altura del hexágono:</strong> Indica la cantidad de sismos (frecuencia estadística) que han ocurrido dentro de ese polígono de 5km cuadrados.</li>
            <li><strong>El color:</strong> Indica la magnitud de la energía en esa celda.</li>
        </ul>
    `,
    'grafico': `
        <h2 style="margin-top:0; color:#0A84FF; font-size:1.4rem; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:15px; margin-bottom:20px;">Frecuencia y Tamaño de los Sismos (Ley Gutenberg-Richter)</h2>
        <p style="color:var(--text-secondary); font-size:0.95rem; line-height:1.5; margin-bottom:10px;">Esta curva estadística explica una regla universal de la naturaleza en el Chocó: <strong>por cada terremoto grande, ocurren decenas de sismos moderados y cientos de temblores pequeños</strong>.</p>
        <div style="background: rgba(10,132,255,0.08); border-left: 3px solid #0A84FF; padding: 10px 14px; border-radius: 6px; margin: 12px 0; color: #e2e8f0; font-size: 0.9rem; line-height: 1.5;">
            <strong>¿Qué significa el valor "b" en pantalla?</strong><br>
            Es el termómetro de acumulación de energía tectónica. Un valor cercano a 1.0 es el equilibrio natural. Si baja de 0.8, indica que la falla está "trabada" acumulando energía que podría liberarse en un sismo fuerte.
        </div>
        <ul style="color:var(--text-secondary); font-size:0.95rem; line-height:1.5; margin-bottom:15px; padding-left:20px;">
            <li style="margin-bottom:8px;"><strong>Eje horizontal:</strong> Magnitud del temblor (energía liberada).</li>
            <li style="margin-bottom:8px;"><strong>Eje vertical:</strong> Cuántos sismos iguales o mayores han ocurrido históricamente.</li>
            <li><strong>Tiempo de retorno estimado:</strong> Abajo de la gráfica puedes consultar cada cuántos años se repite estadísticamente un sismo de magnitud 5, 6 o 7 en la región.</li>
        </ul>
        <p style="color:var(--text-secondary); font-size:0.9rem; line-height:1.5;"><strong>Consejo de uso:</strong> Puedes hacer clic sobre cualquier punto de la curva para filtrar de inmediato el mapa 3D y ver solo los sismos a partir de esa magnitud.</p>
    `,
    'calidad': `
        <h2 style="margin-top:0; color:#0A84FF; font-size:1.4rem; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:15px; margin-bottom:20px;">Filtro de Sismos con Máxima Confiabilidad</h2>
        <h3 style="color:#F5F5F7; font-size:1.1rem; margin-bottom:8px;">¿Para qué sirve este filtro?</h3>
        <p style="color:var(--text-secondary); font-size:0.95rem; line-height:1.5; margin-bottom:10px;">En ocasiones, las estaciones sismológicas captan señales lejanas o con pocas antenas receptoras, lo que puede provocar que la ubicación calculada en el mapa tenga margen de error.</p>
        <p style="color:var(--text-secondary); font-size:0.95rem; line-height:1.5; margin-bottom:10px;">Al activar este interruptor, el sistema <strong>oculta los registros con incertidumbre</strong> y deja visibles únicamente los sismos que fueron verificados por múltiples sismógrafos con precisión milimétrica en su epicentro y profundidad.</p>
        <div style="background: rgba(255,255,255,0.05); padding: 10px 14px; border-radius: 8px; color: var(--text-secondary); font-size: 0.85rem; line-height: 1.4;">
            Ideal para ingenieros, investigadores y tomadores de decisiones que requieran datos rigurosamente certificados para estudios de suelo o diseño estructural.
        </div>
    `,
    'fallas': `
        <h2 style="margin-top:0; color:#0A84FF; font-size:1.4rem; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:15px; margin-bottom:20px;">Fallas Geológicas y Tectónica Regional</h2>
        <h3 style="color:#F5F5F7; font-size:1.1rem; margin-bottom:8px;">¿Qué estás observando en el mapa?</h3>
        <p style="color:var(--text-secondary); font-size:0.95rem; line-height:1.5; margin-bottom:10px;">Las líneas luminosas representan las <strong>11 fracturas principales de la corteza terrestre</strong> en el Chocó y el Pacífico colombiano, identificadas por el Servicio Geológico Colombiano (SGC).</p>
        
        <h3 style="color:#F5F5F7; font-size:1.05rem; margin-top:15px; margin-bottom:8px;">Código de colores para orientarte:</h3>
        <ul style="color:var(--text-secondary); font-size:0.9rem; line-height:1.5; margin-bottom:15px; padding-left:20px;">
            <li><strong style="color:#38bdf8;">Cian (Azul claro):</strong> Fosa marina de subducción (choque frontal donde la Placa de Nazca se mete bajo el continente).</li>
            <li><strong style="color:#fbbf24;">Ámbar (Amarillo):</strong> Fallas de rumbo o desgarre (bloques de roca que se deslizan horizontalmente uno contra otro, como la Falla Murindó).</li>
            <li><strong style="color:#f87171;">Rojo:</strong> Fallas inversas y de cabalgamiento (empujes compresivos que levantan cordilleras y serranías).</li>
        </ul>

        <h3 style="color:#F5F5F7; font-size:1.05rem; margin-top:15px; margin-bottom:8px;">Cómo interactuar con las fallas:</h3>
        <ul style="color:var(--text-secondary); font-size:0.9rem; line-height:1.5; margin-bottom:15px; padding-left:20px;">
            <li><strong>Al tocar o seleccionar una falla:</strong> La cámara 3D vuela suavemente y se enfoca en ella con resplandor neón de alto contraste.</li>
            <li><strong>Ficha lateral en vivo:</strong> Consulta al instante la tasa anual de desplazamiento, el terremoto más fuerte que podría generar y cuántos sismos reales han ocurrido cerca de ella.</li>
            <li><strong>Zona de Retiro (5 km):</strong> Activa el switch para ver el corredor de seguridad donde la norma exige cuidados especiales en construcción.</li>
        </ul>
    `,
    'ml': `
        <h2 style="margin-top:0; color:#0A84FF; font-size:1.4rem; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:15px; margin-bottom:20px;">Detección Inteligente de Enjambres Sísmicos (IA)</h2>
        <h3 style="color:#F5F5F7; font-size:1.1rem; margin-bottom:8px;">¿Qué hace este análisis automatizado?</h3>
        <p style="color:var(--text-secondary); font-size:0.95rem; line-height:1.5; margin-bottom:10px;">La plataforma analiza miles de registros con un algoritmo de Inteligencia Artificial para encontrar agrupaciones atípicas de temblores que el ojo humano no detecta fácilmente a simple vista.</p>
        <p style="color:var(--text-secondary); font-size:0.95rem; line-height:1.5; margin-bottom:10px;"><strong>¿Por qué es importante?</strong> Cuando varios sismos ocurren muy juntos en poco tiempo y en el mismo sector, forman un "enjambre sísmico". Esto suele indicar reacomodos de fallas activas o secuencias de réplicas tras un temblor principal.</p>
    `,
    'sgc': `
        <h2 style="margin-top:0; color:#0A84FF; font-size:1.4rem; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:15px; margin-bottom:20px;">Conexión SGC Live (Monitoreo en Tiempo Real)</h2>
        <h3 style="color:#F5F5F7; font-size:1.1rem; margin-bottom:8px;">¿Qué muestra esta capa?</h3>
        <p style="color:var(--text-secondary); font-size:0.95rem; line-height:1.5; margin-bottom:10px;">Representa la recepción continua de alertas telemétricas del Servicio Geológico Colombiano a través de un canal digital en vivo.</p>
        <p style="color:var(--text-secondary); font-size:0.95rem; line-height:1.5; margin-bottom:10px;">Cada nuevo pulso se refleja en el mapa con anillos esmeralda que varían de tamaño según la magnitud del sismo detectado.</p>
        <div style="background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.3); border-radius: 8px; padding: 12px; margin-top: 12px; color: #a7f3d0; font-size: 0.85rem; line-height: 1.4;">
            <strong>Nota para el usuario:</strong> Para garantizar que siempre puedas observar el funcionamiento interactivo de la plataforma aún en momentos de calma sísmica o mantenimientos de red, el sistema emite señales telemétricas de demostración basadas en el comportamiento histórico del departamento.
        </div>
    `,
    'oq': `
        <h2 style="margin-top: 0; color: #0A84FF; font-size: 1.4rem; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 15px; margin-bottom: 20px;">Evaluación Probabilística de Amenaza Sísmica</h2>
        <h3 style="color: #F5F5F7; font-size: 1.1rem; margin-bottom: 8px;">1. ¿Qué es la Aceleración del Suelo?</h3>
        <p style="color: var(--text-secondary); font-size: 0.95rem; line-height: 1.5; margin-bottom: 15px;">A diferencia de la magnitud (que mide la energía en el foco del sismo), la aceleración mide con qué fuerza y violencia se sacude el terreno bajo nuestros pies. Es el dato fundamental que usan los ingenieros para saber qué tan resistentes deben ser las columnas y vigas de una edificación.</p>
        <h3 style="color: #F5F5F7; font-size: 1.1rem; margin-bottom: 8px;">2. ¿Qué significa el período de 475 años?</h3>
        <p style="color: var(--text-secondary); font-size: 0.95rem; line-height: 1.5; margin-bottom: 15px;">Es el estándar de seguridad exigido por las normas de construcción. No significa que un terremoto ocurra exactamente cada 475 años, sino que los edificios deben diseñarse con la fuerza suficiente para soportar el sismo más severo que tiene probabilidad de presentarse durante los 50 años de vida útil de la edificación.</p>
    `,
    'benioff': `
        <h2 style="margin-top:0; color:#0A84FF; font-size:1.4rem; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:15px; margin-bottom:20px;">Perfil 3D de la Placa Subducida (Zona de Benioff)</h2>
        <h3 style="color:#F5F5F7; font-size:1.05rem; margin-top:15px; margin-bottom:8px;">¿Qué ocurre bajo el suelo del Chocó?</h3>
        <p style="color:var(--text-secondary); font-size:0.95rem; line-height:1.6; margin-bottom:15px;">En el Océano Pacífico, frente a las costas chocoanas, la <strong>Placa de Nazca</strong> se sumerge continuamente por debajo de Colombia a una velocidad de unos 5 centímetros cada año. Esa losa marina inclinada que entra a las profundidades de la Tierra se conoce como Zona de Benioff.</p>
        
        <h3 style="color:#F5F5F7; font-size:1.05rem; margin-top:15px; margin-bottom:8px;">Distribución de la profundidad de los sismos:</h3>
        <ul style="color:var(--text-secondary); font-size:0.9rem; line-height:1.5; margin-bottom:15px; padding-left:20px;">
            <li><strong>En el mar y la costa (Bahía Solano, Nuquí):</strong> Los sismos son superficiales (entre 0 y 30 km bajo el fondo marino).</li>
            <li><strong>Hacia el interior (Quibdó y Valle del Atrato):</strong> Los sismos ocurren a profundidades intermedias (entre 40 y 80 km).</li>
            <li><strong>Bajo la Cordillera Occidental:</strong> La placa ya está muy profunda, generando sismos a más de 100 km de profundidad.</li>
        </ul>
        <p style="color:var(--text-secondary); font-size:0.95rem; line-height:1.6;"><strong>Cómo usarlo:</strong> Al pulsar el botón del perfil, la cámara se orienta de costado para que puedas ver claramente la inclinación tridimensional de la losa y cómo los sismos van haciéndose más profundos de oeste a este.</p>
    `,
    'nsr10_info': `
        <h2 style="margin-top:0; color:#0A84FF; font-size:1.4rem; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:15px; margin-bottom:20px;">Norma Colombiana de Diseño Sismorresistente (NSR-10)</h2>
        <h3 style="color:#F5F5F7; font-size:1.05rem; margin-top:15px; margin-bottom:8px;">1. ¿Por qué es obligatoria la NSR-10?</h3>
        <p style="color:var(--text-secondary); font-size:0.95rem; line-height:1.6; margin-bottom:15px;">Es la ley nacional que establece cómo deben calcularse y construirse todas las viviendas, puentes y edificios en Colombia para proteger la vida humana ante terremotos. Todo el departamento del Chocó está clasificado en <strong>Zona de Amenaza Sísmica Alta</strong>.</p>
        
        <h3 style="color:#F5F5F7; font-size:1.05rem; margin-top:15px; margin-bottom:8px;">2. Parámetros clave explicados de forma sencilla:</h3>
        <ul style="color:var(--text-secondary); font-size:0.9rem; line-height:1.5; margin-bottom:15px; padding-left:20px;">
            <li style="margin-bottom:8px;"><strong>Aceleración en roca:</strong> La fuerza básica con que se sacude la roca firme en el municipio. En la costa chocoana alcanza los niveles más altos del país.</li>
            <li style="margin-bottom:8px;"><strong>Factores de suelo:</strong> Si el suelo es blando o aluvial (como junto a los ríos), actúa como una gelatina y amplifica la sacudida, exigiendo cimientos más profundos y vigas más robustas.</li>
            <li><strong>Grupo de Uso (Importancia):</strong> A las edificaciones esenciales como hospitales, estaciones de bomberos y colegios se les exige un margen extra de resistencia para que sigan funcionando después de una emergencia.</li>
        </ul>
    `,
    'geotecnia_info': `
        <h2 style="margin-top:0; color:#0A84FF; font-size:1.4rem; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:15px; margin-bottom:20px;">Geotecnia Local y Fenómeno de Licuación</h2>
        <h3 style="color:#F5F5F7; font-size:1.05rem; margin-top:15px; margin-bottom:8px;">1. El Suelo como Soporte de la Vida</h3>
        <p style="color:var(--text-secondary); font-size:0.95rem; line-height:1.6; margin-bottom:15px;">Un edificio no colapsa solo por el movimiento del aire o la estructura; el suelo donde se apoya es determinante. En el Chocó predominan suelos formados por depósitos aluviales de ríos caudalosos (como el Atrato y el San Juan) y zonas litorales de bajamar.</p>

        <h3 style="color:#F5F5F7; font-size:1.05rem; margin-top:15px; margin-bottom:8px;">2. ¿Qué es la Licuación del Suelo?</h3>
        <p style="color:var(--text-secondary); font-size:0.95rem; line-height:1.6; margin-bottom:12px;">Es un fenómeno en el que suelos arenosos o limosos, saturados de agua, <strong>pierden totalmente su firmeza durante un temblor fuerte y se comportan momentáneamente como un líquido o arenas movedizas</strong>.</p>
        <ul style="color:var(--text-secondary); font-size:0.9rem; line-height:1.5; margin-bottom:15px; padding-left:20px;">
            <li style="margin-bottom:8px;">Las casas y postes pueden hundirse o inclinarse súbitamente aunque la estructura no se quiebre.</li>
            <li style="margin-bottom:8px;">Ocurrió de forma generalizada en el terremoto de Murindó en 1992 en toda la cuenca del Río Atrato.</li>
            <li><strong>Prevención:</strong> En zonas de amenaza alta se deben realizar estudios geotécnicos con perforaciones previas y emplear cimentaciones con pilotes que alcancen estratos firmes.</li>
        </ul>
    `,
    'pot_info': `
        <h2 style="margin-top:0; color:#0A84FF; font-size:1.4rem; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:15px; margin-bottom:20px;">Planes de Ordenamiento Territorial (POT) y Gestión del Riesgo</h2>
        <h3 style="color:#F5F5F7; font-size:1.05rem; margin-top:15px; margin-bottom:8px;">Orientación para Autoridades y Ciudadanos</h3>
        <p style="color:var(--text-secondary); font-size:0.95rem; line-height:1.6; margin-bottom:15px;">Las leyes colombianas exigen que los municipios organicen su crecimiento urbano evitando que las familias se asienten en zonas de peligro insuperable.</p>
        <h3 style="color:#F5F5F7; font-size:1.05rem; margin-top:15px; margin-bottom:8px;">Directrices clave en este módulo:</h3>
        <ul style="color:var(--text-secondary); font-size:0.9rem; line-height:1.5; margin-bottom:15px; padding-left:20px;">
            <li style="margin-bottom:8px;"><strong>Retiro de fallas activas:</strong> No construir viviendas ni infraestructura vital justo encima de las trazas de fractura geológica conocidas.</li>
            <li style="margin-bottom:8px;"><strong>Suelo firme para equipamiento comunitario:</strong> Los colegios, hospitales y alcaldías deben ubicarse en terrenos estables y fuera de zonas inundables o licuables.</li>
            <li><strong>Ficha Municipal en PDF:</strong> Puedes generar e imprimir un diagnóstico técnico completo de tu municipio listo para sustentar decisiones de planeación.</li>
        </ul>
    `,
    'espectro_info': `
        <h2 style="margin-top:0; color:#0A84FF; font-size:1.4rem; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:15px; margin-bottom:20px;">Curva de Demanda Sísmica para Construcción (Espectro NSR-10)</h2>
        <h3 style="color:#F5F5F7; font-size:1.05rem; margin-top:15px; margin-bottom:8px;">¿Qué nos dice esta gráfica?</h3>
        <p style="color:var(--text-secondary); font-size:0.95rem; line-height:1.6; margin-bottom:15px;">Indica con qué aceleración vibrará un edificio dependiendo de su altura o periodo de oscilación (un edificio bajo oscila rápido; uno alto oscila más lentamente).</p>
        
        <div style="background: rgba(56,189,248,0.08); border-left: 3px solid #38bdf8; padding: 10px 14px; border-radius: 6px; margin: 12px 0; color: #e2e8f0; font-size: 0.9rem; line-height: 1.5;">
            <strong>Meseta máxima:</strong> Es la parte más alta de la curva. Representa la sacudida máxima que los constructores deben prever al calcular el acero y concreto de las columnas.
        </div>
        <ul style="color:var(--text-secondary); font-size:0.9rem; line-height:1.5; margin-bottom:15px; padding-left:20px;">
            <li style="margin-bottom:8px;"><strong>Línea discontinua gris:</strong> Muestra el sismo de referencia en roca firme.</li>
            <li style="margin-bottom:8px;"><strong>Curva de color con relleno:</strong> Muestra la fuerza real sobre el suelo seleccionado (si el suelo es blando, la curva sube considerablemente).</li>
            <li><strong>Exportar CSV:</strong> Permite a los calculistas estructurales descargar la tabla de datos numéricos para ingresarla directamente a programas de diseño como ETABS o SAP2000.</li>
        </ul>
    `,
    'shakemap_info': `
        <h2 style="margin-top:0; color:#ff453a; font-size:1.4rem; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:15px; margin-bottom:20px;">Simulador ShakeMap de Ruptura Cosísmica</h2>
        <h3 style="color:#F5F5F7; font-size:1.05rem; margin-top:15px; margin-bottom:8px;">1. Propagación de Ondas y Atenuación (GMPE)</h3>
        <p style="color:var(--text-secondary); font-size:0.95rem; line-height:1.6; margin-bottom:12px;">El simulador calcula la atenuación geométrica e inelástica de las ondas sísmicas mediante ecuaciones de predicción de movimiento fuerte (GMPE). Conforme la distancia epicentral aumenta, la energía se disipa en anillos concéntricos clasificados por la <strong>Escala Mercalli Modificada (MMI)</strong>.</p>
        
        <h3 style="color:#F5F5F7; font-size:1.05rem; margin-top:15px; margin-bottom:8px;">2. Escenarios Sismogénicos Modelados:</h3>
        <ul style="color:var(--text-secondary); font-size:0.9rem; line-height:1.5; margin-bottom:15px; padding-left:20px;">
            <li style="margin-bottom:6px;"><strong style="color:#ff453a;">Falla Murindó (Mw 7.3):</strong> Réplica del escenario de 1992 en la cuenca baja del Atrato, con aceleraciones destructivas (PGA &gt; 0.65g) e intensidades MMI VIII-IX.</li>
            <li style="margin-bottom:6px;"><strong style="color:#38bdf8;">Subducción Nazca (Mw 8.2):</strong> Megaterremoto de contacto interplaca en la fosa del Pacífico con potencial tsunamigénico y sacudimiento de muy largo periodo.</li>
            <li style="margin-bottom:6px;"><strong style="color:#fbbf24;">Falla Atrato - Quibdó (Mw 6.8):</strong> Sismo cortical superficial directo sobre la capital departamental.</li>
            <li><strong style="color:#32d74b;">Falla Bahía Solano (Mw 7.0):</strong> Ruptura cortical costera en la serranía de Baudó.</li>
        </ul>
    `,
    'profundidad': `
        <h2 style="margin-top:0; color:#c084fc; font-size:1.4rem; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:15px; margin-bottom:20px;">Filtro de Profundidad Hipocentral</h2>
        <p style="color:var(--text-secondary); font-size:0.95rem; line-height:1.6; margin-bottom:12px;">En la tectónica del Chocó, la profundidad focal es el factor discriminante entre sismos corticales de fallas activas y sismos de subducción en la losa oceánica:</p>
        <ul style="color:var(--text-secondary); font-size:0.9rem; line-height:1.5; margin-bottom:15px; padding-left:20px;">
            <li style="margin-bottom:8px;"><strong style="color:#ff9f0a;">0 a 30 km (Superficial):</strong> Ocurren en la corteza continental y fallas activas. Liberan energía cerca de las poblaciones y causan el mayor daño a la infraestructura.</li>
            <li style="margin-bottom:8px;"><strong style="color:#ff375f;">30 a 70 km (Intermedio):</strong> Interfase de subducción interplaca entre Nazca y el bloque Panamá-Chocó.</li>
            <li><strong style="color:#bf5af2;">&gt; 70 km (Profundo / Wadati-Benioff):</strong> Deformación intraplaca en el interior de la losa fría descendente bajo la cordillera.</li>
        </ul>
    `,
    'infra_info': `
        <h2 style="margin-top:0; color:#38bdf8; font-size:1.4rem; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:15px; margin-bottom:20px;">Red de Infraestructura Crítica y Vulnerabilidad</h2>
        <p style="color:var(--text-secondary); font-size:0.95rem; line-height:1.6; margin-bottom:12px;">Superpone la red logística y asistencial de soporte vital en el departamento del Chocó para evaluar su proximidad a trazas de falla y sismos históricos:</p>
        <ul style="color:var(--text-secondary); font-size:0.9rem; line-height:1.5; margin-bottom:15px; padding-left:20px;">
            <li style="margin-bottom:8px;"><strong style="color:#ffd60a;">Corredores Viales (Rutas 60, 13 y 40):</strong> Arterias de conexión con Medellín, Pereira y el puerto de Buenaventura, con susceptibilidad crítica a deslizamientos cosísmicos.</li>
            <li style="margin-bottom:8px;"><strong style="color:#38bdf8;">Arteria Fluvial del Río Atrato:</strong> Eje navegable vital del departamento, vulnerable a licuación de orillas.</li>
            <li style="margin-bottom:8px;"><strong style="color:#0A84FF;">Aeropuertos Estratégicos:</strong> Bases indispensables para ayuda humanitaria y puentes aéreos (Quibdó, Bahía Solano, Nuquí, Condoto).</li>
            <li><strong style="color:#ff453a;">Hospitales de Referencia (NSR-10 Grupo IV):</strong> Centros asistenciales que deben permanecer 100% operativos tras un terremoto severo.</li>
        </ul>
    `
};

if (infoModal && closeInfoModal) {
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('.info-btn');
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        const key = btn.getAttribute('data-info');
        if (modalData[key] && infoContent) {
            infoContent.innerHTML = modalData[key];
            infoModal.style.display = 'flex';
            setTimeout(() => infoModal.style.opacity = '1', 10);
        }
    });

    const closeModal = () => {
        infoModal.style.opacity = '0';
        setTimeout(() => infoModal.style.display = 'none', 300);
    };

    closeInfoModal.addEventListener('click', closeModal);
    infoModal.addEventListener('click', (e) => {
        if (e.target === infoModal) closeModal();
    });
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

function initMunicipiosUI() {
    const nsrSelect = document.getElementById('nsr-municipio-select');
    const potSelect = document.getElementById('pot-municipio-select');
    if (!municipiosData || municipiosData.length === 0) return;
    
    const depts = [
        { name: 'Chocó', label: '📍 Chocó (31)' },
        { name: 'Risaralda', label: '☕ Risaralda (14)' },
        { name: 'Caldas', label: '🏔️ Caldas (10)' },
        { name: 'Valle del Cauca', label: '🌴 Valle del Cauca (12)' }
    ];
    
    if (nsrSelect) {
        nsrSelect.innerHTML = '';
        depts.forEach(d => {
            const group = document.createElement('optgroup');
            group.label = d.label;
            municipiosData.forEach((m, idx) => {
                if ((m.departamento || 'Chocó') === d.name) {
                    const opt = document.createElement('option');
                    opt.value = idx;
                    opt.textContent = `${m.nombre} (Aa = ${m.aa.toFixed(2)})`;
                    if (m.id === 'quibdo' || m.nombre.toLowerCase().includes('quibdó')) opt.selected = true;
                    group.appendChild(opt);
                }
            });
            if (group.children.length > 0) {
                nsrSelect.appendChild(group);
            }
        });
    }
    
    if (potSelect) {
        potSelect.innerHTML = '';
        depts.forEach(d => {
            const group = document.createElement('optgroup');
            group.label = d.label;
            municipiosData.forEach((m, idx) => {
                if ((m.departamento || 'Chocó') === d.name) {
                    const opt = document.createElement('option');
                    opt.value = idx;
                    opt.textContent = `${m.nombre} (${(m.poblacion || 0).toLocaleString()} hab.)`;
                    if (m.id === 'quibdo' || m.nombre.toLowerCase().includes('quibdó')) opt.selected = true;
                    group.appendChild(opt);
                }
            });
            if (group.children.length > 0) {
                potSelect.appendChild(group);
            }
        });
    }
    
    const comSelect = document.getElementById('comunidad-municipio-select');
    if (comSelect) {
        comSelect.innerHTML = '';
        depts.forEach(d => {
            const group = document.createElement('optgroup');
            group.label = d.label;
            municipiosData.forEach((m, idx) => {
                if ((m.departamento || 'Chocó') === d.name) {
                    const opt = document.createElement('option');
                    opt.value = idx;
                    opt.textContent = `${m.nombre} (${d.name})`;
                    if (m.id === 'quibdo' || m.nombre.toLowerCase().includes('quibdó')) opt.selected = true;
                    group.appendChild(opt);
                }
            });
            if (group.children.length > 0) {
                comSelect.appendChild(group);
            }
        });
    }
    
    updateNSR10Metrics();
    updatePOTMetrics();
    renderRegionalImpactMatrix();
    updateSimuladorMetrics();
    updateComunidadMetrics();
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

function calcularEspectroNSR10(Aa, Av, suelo, I = 1.0) {
    const { Fa, Fv } = getFactoresSitioNSR10(Aa, Av, suelo);

    // Ecuaciones Oficiales NSR-10 Título A.2.6
    const T0 = 0.1 * (Av * Fv) / (Aa * Fa);
    const Tc = 0.48 * (Av * Fv) / (Aa * Fa);
    const TL = 2.4 * Fv;
    const SaMax = 2.5 * Aa * Fa * I;

    const periods = [];
    const accelerations = [];

    for (let t = 0; t <= 3.001; t += 0.04) {
        const roundT = parseFloat(t.toFixed(2));
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
        periods.push(roundT);
        accelerations.push(parseFloat(Sa.toFixed(3)));
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
    // Curva de Referencia Base en Roca (Perfil B, I = 1.00)
    const specRoca = calcularEspectroNSR10(m.aa, m.av, 'B', 1.0);

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
    csvContent += `# Municipio: ${data.municipio} (${data.departamento})\r\n`;
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

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
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
            elDemandaBadge.innerText = '🔴 Demanda Extrema';
            elDemandaBadge.className = 'status-pill critico';
        } else if (spec.SaMax >= 0.85) {
            elDemandaBadge.innerText = '🟠 Demanda Severa';
            elDemandaBadge.className = 'status-pill alerta';
        } else {
            elDemandaBadge.innerText = '🟢 Demanda Moderada';
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
            desc: 'Depósitos aluviales de ríos, llanuras de inundación o bajamar. Alta amplificación por efecto gelatina (Fv = 2.60). Exige cimentaciones profundas.',
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
        const isAlta = m.licuacion_riesgo.includes('Alta') || suelo === 'F';
        const isMedia = m.licuacion_riesgo.includes('Media') || suelo === 'E';
        elLic.innerText = isAlta ? '🔴 Alta' : (isMedia ? '🟠 Media' : '🟢 Baja');
        elLic.className = 'status-pill ' + (isAlta ? 'critico' : (isMedia ? 'alerta' : 'normal'));
    }

    updateNSREspectroChart();
}

function updatePOTMetrics() {
    const sel = document.getElementById('pot-municipio-select');
    if (!sel || !municipiosData || municipiosData.length === 0) return;
    
    const idx = parseInt(sel.value) || 0;
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
    
    const elPob = document.getElementById('pot-pob-val');
    const elSismos = document.getElementById('pot-sismos-cercanos');
    const elDestructor = document.getElementById('pot-ultimo-destructor');
    const elSemaforo = document.getElementById('pot-semaforo-badge');
    
    if (elPob) elPob.innerText = m.poblacion.toLocaleString();
    if (elSismos) elSismos.innerText = `${sismos30km} (${maxMag30km > 0 ? maxMag30km.toFixed(1) + ' Mw' : 's/d'})`;
    if (elDestructor) elDestructor.innerText = m.ultimo_destructor;
    
    if (elSemaforo) {
        if (m.aa >= 0.35 || sismos30km >= 50 || m.costero_pacifico) {
            elSemaforo.className = 'status-pill critico';
            elSemaforo.innerText = '🔴 CRÍTICO';
        } else if (m.aa >= 0.25 || sismos30km >= 20) {
            elSemaforo.className = 'status-pill alerta';
            elSemaforo.innerText = '🟠 ALTO';
        } else {
            elSemaforo.className = 'status-pill normal';
            elSemaforo.innerText = '🟡 MEDIO';
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

    // Calcular fallas geológicas cercanas
    let fallasCercanas = [];
    if (faultData && faultData.features) {
        faultData.features.forEach(f => {
            const p = f.properties;
            let minDist = 999;
            if (f.geometry && f.geometry.coordinates) {
                f.geometry.coordinates.forEach(pt => {
                    const d = haversineDistanceKm(m.lat, m.lng, pt[1], pt[0]);
                    if (d < minDist) minDist = d;
                });
            }
            if (minDist <= 60) {
                fallasCercanas.push({ nombre: p.Nombre || p.NOMBRE || 'Falla Geológica Activa', dist: Math.round(minDist) });
            }
        });
    }

    const factors = getFactoresSitioNSR10(m.aa, m.av, m.suelo_defecto || 'E');
    const pgaDiseno = (factors.Fa * m.aa).toFixed(2);

    title.innerText = `Ficha Técnica Municipal de Diagnóstico Sísmico — ${m.nombre}`;
    subtitle.innerText = `Departamento de ${m.departamento} | Aplicación para POT / PBOT / EOT (Ley 388/1997 & Ley 1523/2012)`;

    body.innerHTML = `
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-bottom:14px;">
            <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:10px; padding:12px;">
                <h4 style="margin:0 0 8px 0; font-size:0.78rem; color:#38bdf8; text-transform:uppercase; letter-spacing:0.04em;">1. Localización y Demografía</h4>
                <p style="margin:0 0 4px 0; font-size:0.75rem;"><strong>Municipio:</strong> ${m.nombre}</p>
                <p style="margin:0 0 4px 0; font-size:0.75rem;"><strong>Departamento:</strong> ${m.departamento}</p>
                <p style="margin:0 0 4px 0; font-size:0.75rem;"><strong>Población Expuesta (DANE):</strong> ${m.poblacion.toLocaleString()} habitantes</p>
                <p style="margin:0; font-size:0.75rem;"><strong>Coordenadas Cabecera:</strong> Lat ${m.lat.toFixed(4)}°, Lon ${m.lng.toFixed(4)}°</p>
            </div>

            <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:10px; padding:12px;">
                <h4 style="margin:0 0 8px 0; font-size:0.78rem; color:#38bdf8; text-transform:uppercase; letter-spacing:0.04em;">2. Parámetros Oficiales NSR-10</h4>
                <p style="margin:0 0 4px 0; font-size:0.75rem;"><strong>Zona de Amenaza Sísmica:</strong> <span class="status-pill critico">🔴 ${m.zona}</span></p>
                <p style="margin:0 0 4px 0; font-size:0.75rem;"><strong>Coeficientes de Aceleración:</strong> Aa = ${m.aa.toFixed(2)} g | Av = ${m.av.toFixed(2)} g</p>
                <p style="margin:0 0 4px 0; font-size:0.75rem;"><strong>Perfil de Suelo Predominante:</strong> Tipo ${m.suelo_defecto || 'E'} (Fa=${factors.Fa}, Fv=${factors.Fv})</p>
                <p style="margin:0; font-size:0.75rem;"><strong>PGA Esperado en Superficie:</strong> <strong style="color:#38bdf8;">${pgaDiseno} g</strong></p>
            </div>
        </div>

        <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:10px; padding:12px; margin-bottom:14px;">
            <h4 style="margin:0 0 8px 0; font-size:0.78rem; color:#38bdf8; text-transform:uppercase; letter-spacing:0.04em;">3. Contexto Sismotectónico y Fallas Activas</h4>
            <p style="margin:0 0 5px 0; font-size:0.75rem;"><strong>Geología Local:</strong> ${m.geologia}</p>
            <p style="margin:0 0 5px 0; font-size:0.75rem;"><strong>Sismos Instrumentales en 50 km:</strong> ${sismos50km} eventos registrados (Magnitud máx: ${maxMag50km > 0 ? maxMag50km.toFixed(1) + ' Mw' : 's/d'})</p>
            <p style="margin:0 0 5px 0; font-size:0.75rem;"><strong>Eventos Históricos Destructores de Referencia:</strong> ${m.ultimo_destructor}</p>
            <p style="margin:0; font-size:0.75rem;"><strong>Fallas Geológicas Próximas:</strong> ${fallasCercanas.length > 0 ? fallasCercanas.map(f => `${f.nombre} (${f.dist} km)`).join(', ') : 'Falla Murindó / Falla Atrato a menos de 70 km'}</p>
        </div>

        <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:10px; padding:12px; margin-bottom:14px;">
            <h4 style="margin:0 0 8px 0; font-size:0.78rem; color:#ff7b72; text-transform:uppercase; letter-spacing:0.04em;">4. Matriz de Amenazas Secundarias y Concomitantes</h4>
            <table class="ficha-pot-table">
                <thead>
                    <tr>
                        <th>Fenómeno Concomitante</th>
                        <th>Nivel de Susceptibilidad</th>
                        <th>Impacto Esperado en el Municipio</th>
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <td><strong>Licuación de Suelos</strong></td>
                        <td>${m.licuacion_riesgo.includes('Alta') ? '🔴 ALTA' : '🟠 MEDIA'}</td>
                        <td>Pérdida de soporte en llanuras aluviales de ríos, asentamientos diferenciales severos en obras viales y viviendas palafíticas.</td>
                    </tr>
                    <tr>
                        <td><strong>Amenaza de Tsunami</strong></td>
                        <td>${m.costero_pacifico ? '🔴 ZONA COSTERA EXPUESTA' : '🟢 NO APLICA (Interior)'}</td>
                        <td>${m.costero_pacifico ? 'Evacuación inmediata obligatoria a cota superior a 15 msnm ante sismo fuerte sentido en playa.' : 'Sin exposición a inundación por maremoto.'}</td>
                    </tr>
                    <tr>
                        <td><strong>Movimientos en Masa Cosísmicos</strong></td>
                        <td>🟠 ALTA (Laderas Saturadas)</td>
                        <td>Deslizamientos y bloqueos de vías estratégicas de abastecimiento terrestre y fluvial debido a pluviosidad extrema en cordillera.</td>
                    </tr>
                </tbody>
            </table>
        </div>

        <div style="background:rgba(10,132,255,0.08); border:1px solid rgba(10,132,255,0.25); border-radius:10px; padding:12px;">
            <h4 style="margin:0 0 8px 0; font-size:0.78rem; color:#70b5ff; text-transform:uppercase; letter-spacing:0.04em;">5. Directrices Vinculantes para el POT / PBOT / EOT Municipal</h4>
            <ol style="margin:0; padding-left:18px; font-size:0.74rem; color:var(--text-secondary); line-height:1.5;">
                <li style="margin-bottom:4px;"><strong>Franjas de Restricción a Fallas:</strong> Establecer retiros de mínimo <strong>100 metros</strong> a cada lado de la traza de fallas activas cartografiadas, prohibiendo la edificación de uso indispensable (escuelas, hospitales).</li>
                <li style="margin-bottom:4px;"><strong>Estudios Geotécnicos de Detalle:</strong> En zonas de llanura aluvial y bajamar, condicionar licencias de urbanismo a estudios de microzonificación y verificación de licuabilidad de arenas (Título H de la NSR-10).</li>
                <li style="margin-bottom:4px;"><strong>Infraestructura Hospitalaria y de Rescate:</strong> Obligatoriedad de cumplimiento de Coeficiente de Importancia I = 1.50 y evaluación de vulnerabilidad sísmica hospitalaria.</li>
                <li><strong>Rutas de Evacuación y Albergues:</strong> Señalización de corredores de evacuación y verificación de que los albergues no se sitúen en zonas inundables ni de licuación.</li>
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
            targetPanel.style.display = 'block';
        }
        
        if (profile === 'nsr10') {
            updateNSR10Metrics();
        } else if (profile === 'alcaldia') {
            updatePOTMetrics();
        }
        queueRender();
    });
});

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

const btnPotPrint = document.getElementById('btn-pot-print');
if (btnPotPrint) {
    btnPotPrint.addEventListener('click', () => {
        openFichaPOTModal();
    });
}

// Controles del Modal de Ficha Técnica POT
const btnFichaPrintAction = document.getElementById('btn-ficha-print-action');
if (btnFichaPrintAction) {
    btnFichaPrintAction.addEventListener('click', () => {
        document.body.classList.add('printing-ficha');
        window.print();
        setTimeout(() => {
            document.body.classList.remove('printing-ficha');
        }, 1000);
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

function toggleBenioffMode(forceState) {
    const newState = (forceState !== undefined) ? forceState : !isBenioffMode;
    isBenioffMode = newState;

    const btn = document.getElementById('btn-benioff');
    const btnText = document.getElementById('btn-benioff-text');
    const controls = document.getElementById('benioff-controls');

    if (isBenioffMode) {
        if (btn) {
            btn.classList.add('active');
            btn.style.background = '#0A84FF';
            btn.style.color = '#ffffff';
            btn.style.borderColor = '#0A84FF';
            btn.style.boxShadow = '0 0 14px rgba(10,132,255,0.5)';
        }
        if (btnText) btnText.innerHTML = '↺ Restaurar Vista 3D';
        if (controls) controls.style.display = 'flex';

        // Si no había ningún modo activo, activar 'puntos' por defecto
        if (viewMode === 'none') {
            viewMode = 'puntos';
            const btnPuntos = document.getElementById('btn-puntos');
            if (btnPuntos) btnPuntos.classList.add('active');
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
        if (btnText) btnText.innerHTML = '📐 Activar Perfil Benioff';
        if (controls) controls.style.display = 'none';

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

    queueRender();
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
            lblDepth.innerText = currentMaxDepth >= 150 ? '150 km (Todos)' : `≤ ${currentMaxDepth.toFixed(0)} km`;
        }
        queueRender();
    });
}

// ============================================================================
// MÓDULO 2: CONTROLADOR DE CAPA VECTORIAL INFRAESTRUCTURA CRÍTICA
// ============================================================================
const checkInfra = document.getElementById('check-infra');
if (checkInfra) {
    checkInfra.addEventListener('change', async (e) => {
        showInfra = e.target.checked;
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
        btnTimelapsePlay.style.background = '#0A84FF';
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
    'murindo_73': {
        nombre: 'Falla Murindó (Sismo Histórico 1992)',
        mw: 7.3,
        profundidad: 15,
        epicentro: [-76.75, 6.95], // [lng, lat]
        falla: 'Falla de Murindó (Rumbo Dextral)',
        pgaMax: '0.68 g',
        radioDestrKm: 48,
        isoseistas: [
            { mmi: 'VIII - IX', label: 'Daño Severo / Ruptura', pgaRange: '≥ 0.50 g', radioM: 48000, color: [255, 59, 48, 160], borde: [255, 255, 255, 230] },
            { mmi: 'VII', label: 'Daño Moderado a Estructuras', pgaRange: '0.25 - 0.50 g', radioM: 85000, color: [255, 140, 0, 110], borde: [255, 180, 0, 200] },
            { mmi: 'VI', label: 'Fuerte / Fisuras en Mampostería', pgaRange: '0.12 - 0.25 g', radioM: 135000, color: [255, 214, 10, 75], borde: [255, 230, 80, 170] },
            { mmi: 'IV - V', label: 'Moderado / Sentido Ampliamente', pgaRange: '0.04 - 0.12 g', radioM: 210000, color: [56, 189, 248, 45], borde: [56, 189, 248, 140] }
        ]
    },
    'subduccion_82': {
        nombre: 'Megaterremoto de Subducción Nazca (Fosa del Pacífico)',
        mw: 8.2,
        profundidad: 25,
        epicentro: [-78.20, 5.50],
        falla: 'Zona de Subducción Placa de Nazca',
        pgaMax: '0.85 g',
        radioDestrKm: 95,
        isoseistas: [
            { mmi: 'IX - X', label: 'Devastador / Tsunami Costero', pgaRange: '≥ 0.65 g', radioM: 95000, color: [220, 38, 38, 170], borde: [255, 255, 255, 240] },
            { mmi: 'VII - VIII', label: 'Daño Severo en Litoral Pacífico', pgaRange: '0.35 - 0.65 g', radioM: 170000, color: [249, 115, 22, 120], borde: [255, 160, 0, 200] },
            { mmi: 'VI', label: 'Fuerte en Toda la Cuenca Atrato', pgaRange: '0.15 - 0.35 g', radioM: 260000, color: [250, 204, 21, 80], borde: [255, 230, 80, 170] },
            { mmi: 'IV - V', label: 'Perceptible en Cordillera Occidental', pgaRange: '0.05 - 0.15 g', radioM: 380000, color: [56, 189, 248, 45], borde: [56, 189, 248, 140] }
        ]
    },
    'atrato_68': {
        nombre: 'Falla Atrato - Quibdó (Sismo Cortical Urbano)',
        mw: 6.8,
        profundidad: 12,
        epicentro: [-76.66, 5.70],
        falla: 'Falla Atrato - Uramita',
        pgaMax: '0.62 g',
        radioDestrKm: 32,
        isoseistas: [
            { mmi: 'VIII', label: 'Daño Severo / Licuación Atrato', pgaRange: '≥ 0.45 g', radioM: 32000, color: [255, 59, 48, 170], borde: [255, 255, 255, 240] },
            { mmi: 'VII', label: 'Daño Moderado en Cabeceras', pgaRange: '0.20 - 0.45 g', radioM: 65000, color: [255, 140, 0, 120], borde: [255, 180, 0, 200] },
            { mmi: 'V - VI', label: 'Fuerte Sacudimiento Municipal', pgaRange: '0.08 - 0.20 g', radioM: 110000, color: [255, 214, 10, 75], borde: [255, 230, 80, 170] },
            { mmi: 'IV', label: 'Perceptible en Región Central', pgaRange: '0.03 - 0.08 g', radioM: 175000, color: [56, 189, 248, 45], borde: [56, 189, 248, 140] }
        ]
    },
    'bahia_solano_70': {
        nombre: 'Falla Bahía Solano (Costa Pacífica)',
        mw: 7.0,
        profundidad: 18,
        epicentro: [-77.40, 6.22],
        falla: 'Falla de Bahía Solano',
        pgaMax: '0.64 g',
        radioDestrKm: 38,
        isoseistas: [
            { mmi: 'VIII', label: 'Daño Severo en Costa y Serranía', pgaRange: '≥ 0.48 g', radioM: 38000, color: [255, 59, 48, 170], borde: [255, 255, 255, 240] },
            { mmi: 'VII', label: 'Fuerte en Bahía Solano y Nuquí', pgaRange: '0.22 - 0.48 g', radioM: 78000, color: [255, 140, 0, 120], borde: [255, 180, 0, 200] },
            { mmi: 'V - VI', label: 'Perceptible en Valle del Atrato', pgaRange: '0.09 - 0.22 g', radioM: 130000, color: [255, 214, 10, 75], borde: [255, 230, 80, 170] },
            { mmi: 'IV', label: 'Perceptible en Cordillera', pgaRange: '0.03 - 0.09 g', radioM: 200000, color: [56, 189, 248, 45], borde: [56, 189, 248, 140] }
        ]
    }
};

const selectShakemap = document.getElementById('select-shakemap-escenario');
const btnToggleShakemap = document.getElementById('btn-toggle-shakemap');
const btnClearShakemap = document.getElementById('btn-clear-shakemap');
const shakemapText = document.getElementById('btn-shakemap-text');
const shakemapImpactBox = document.getElementById('shakemap-impact-box');

function activateShakemap(scenarioKey) {
    const scenario = SHAKEMAP_SCENARIOS[scenarioKey];
    if (!scenario) return;

    activeShakemapScenario = scenarioKey;
    isSimulatorActive = true;
    currentShakemapData = scenario;

    if (shakemapText) shakemapText.innerHTML = '🔄 Recalcular Escenario';
    if (btnClearShakemap) btnClearShakemap.style.display = 'inline-flex';
    if (btnToggleShakemap) {
        btnToggleShakemap.style.background = '#ff453a';
        btnToggleShakemap.style.color = '#fff';
    }

    if (shakemapImpactBox) {
        shakemapImpactBox.style.display = 'block';
        const lblEpi = document.getElementById('shakemap-epicentro-label');
        const lblPga = document.getElementById('shakemap-pga-max');
        const lblRad = document.getElementById('shakemap-radio-destr');
        const badgeMmi = document.getElementById('shakemap-mmi-max');

        if (lblEpi) lblEpi.innerText = `Epicentro: ${scenario.nombre.split('(')[0].trim()}`;
        if (lblPga) lblPga.innerText = scenario.pgaMax;
        if (lblRad) lblRad.innerText = `~${scenario.radioDestrKm} km`;
        if (badgeMmi) badgeMmi.innerText = scenario.isoseistas[0].mmi;

        // Cuantificación de impacto sobre líneas vitales e infraestructura crítica
        const hospCountEl = document.getElementById('shakemap-impact-hosp');
        const aeroCountEl = document.getElementById('shakemap-impact-aero');
        const viasCountEl = document.getElementById('shakemap-impact-vias');

        if (infraData && infraData.features) {
            // Radio crítico de daño severo/moderado (Isoseista VII: Sa >= 0.25g)
            const isoSevera = scenario.isoseistas.find(iso => iso.mmi.includes('VII')) || scenario.isoseistas[1] || scenario.isoseistas[0];
            const radioKm = isoSevera ? (isoSevera.radioM / 1000) : scenario.radioDestrKm;

            let hospExpuestos = 0;
            let aeroExpuestos = 0;
            let viasExpuestas = new Set();

            infraData.features.forEach(f => {
                if (f.geometry.type === 'Point') {
                    const d = haversineDistanceKm(scenario.epicentro[1], scenario.epicentro[0], f.geometry.coordinates[1], f.geometry.coordinates[0]);
                    if (d <= radioKm) {
                        if (f.properties.tipo === 'hospital') hospExpuestos++;
                        if (f.properties.tipo === 'aeropuerto') aeroExpuestos++;
                    }
                } else if (f.geometry.type === 'LineString') {
                    const hit = f.geometry.coordinates.some(pt => {
                        const d = haversineDistanceKm(scenario.epicentro[1], scenario.epicentro[0], pt[1], pt[0]);
                        return d <= radioKm;
                    });
                    if (hit) {
                        viasExpuestas.add(f.properties.nombre ? f.properties.nombre.split(':')[0].trim() : 'Eje');
                    }
                }
            });

            if (hospCountEl) hospCountEl.innerText = `${hospExpuestos} expuestos`;
            if (aeroCountEl) aeroCountEl.innerText = `${aeroExpuestos} expuestos`;
            if (viasCountEl) {
                const viasArr = Array.from(viasExpuestas);
                viasCountEl.innerText = viasArr.length > 0 ? `${viasArr.length} tramos (${viasArr.slice(0, 2).join(', ')})` : 'Sin interrupciones críticas';
            }
        }
    }

    // Cámara vuela hacia el epicentro simulado
    if (deckgl && scenario.epicentro) {
        deckgl.setProps({
            initialViewState: {
                longitude: scenario.epicentro[0],
                latitude: scenario.epicentro[1],
                zoom: scenario.mw >= 8.0 ? 6.8 : 7.6,
                pitch: 45,
                bearing: 15,
                transitionDuration: 1400,
                transitionInterpolator: new deck.FlyToInterpolator()
            }
        });
    }

    renderLayers();
}

function deactivateShakemap() {
    isSimulatorActive = false;
    currentShakemapData = null;

    if (shakemapText) shakemapText.innerHTML = '💥 Simular Escenario';
    if (btnClearShakemap) btnClearShakemap.style.display = 'none';
    if (btnToggleShakemap) {
        btnToggleShakemap.style.background = 'rgba(255,59,48,0.15)';
        btnToggleShakemap.style.color = '#ff453a';
    }
    if (shakemapImpactBox) shakemapImpactBox.style.display = 'none';

    renderLayers();
}

if (btnToggleShakemap && selectShakemap) {
    btnToggleShakemap.addEventListener('click', () => {
        activateShakemap(selectShakemap.value);
    });
    selectShakemap.addEventListener('change', () => {
        if (isSimulatorActive) {
            activateShakemap(selectShakemap.value);
        }
    });
}

if (btnClearShakemap) {
    btnClearShakemap.addEventListener('click', () => {
        deactivateShakemap();
    });
}

loadData();

