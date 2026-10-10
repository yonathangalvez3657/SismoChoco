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

// ShakeMap Simulado y Cinemática de Frentes de Onda
let isSimulatorActive = false;
let activeShakemapScenario = 'murindo_73';
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
        } else if (p.fuente && (p.fuente.includes('SGC') || p.fuente.includes('Telemétrica') || p.fuente.includes('USGS') || p.fuente.includes('EMSC'))) {
            const depthStr = p.profundidad < 30 ? 'Superficial' : (p.profundidad < 70 ? 'Intermedio' : 'Profundo');
            const magVal = (p.mag !== undefined ? p.mag : p.magnitud) || 0;
            const tiempoBadge = p.esHoy
                ? `<span style="background:rgba(16,185,129,0.25); color:#34d399; border:1px solid #10b981; border-radius:4px; padding:1px 6px; font-size:0.68rem; font-weight:700;">● HOY (${p.diffHours || 0}h)</span>`
                : `<span style="background:rgba(148,163,184,0.15); color:#cbd5e1; border:1px solid #64748b; border-radius:4px; padding:1px 6px; font-size:0.68rem;">Reciente (${p.diffHours ? Math.round(p.diffHours/24) + 'd atrás' : 'Telemétrico'})</span>`;

            tooltip.innerHTML = `<h4 style="color:#34d399; display:flex; align-items:center; justify-content:space-between; gap:6px;">
                                    <span style="display:flex; align-items:center; gap:6px;">
                                        <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:#10b981; box-shadow:0 0 8px #10b981;"></span>
                                        📡 SGC Live: ${p.fecha}
                                    </span>
                                    ${tiempoBadge}
                                 </h4>
                                 <p><strong>Magnitud:</strong> <span style="color:#ffd60a; font-weight:bold;">${magVal} Mw</span></p>
                                 <p><strong>Profundidad Hipocentral:</strong> ${p.profundidad} km (${depthStr})</p>
                                 <p><strong>Ubicación:</strong> ${p.municipio}</p>
                                 <p style="color:#a7f3d0; font-size:0.72rem; margin-top:4px;"><strong>Red:</strong> ${p.fuente}</p>
                                 ${p.rms ? `<p style="color:#94a3b8; font-size:0.7rem;">RMS: ${p.rms}s | Gap: ${p.gap}°</p>` : ''}`;
        } else {
            const depthStr = p.profundidad < 30 ? 'Superficial' : (p.profundidad < 70 ? 'Intermedio' : 'Profundo');
            const fuenteInfo = (p.municipio && p.municipio.includes('SGC Live')) ? '<span style="color:#10b981; font-weight:bold;">[SGC Live]</span> ' : '';
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

    if (!showOQ && !showLiveSGC) {
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
        // Capa Exclusiva para SGC Live en Píxeles (Autoajustable al Zoom, Anillos Neón Telemétricos)
        // Se diferencia cromáticamente entre sismos de hoy (<24h) y sismos recientes de días previos
        layers.push(new deck.ScatterplotLayer({
            id: 'sgc-live-layer-halo',
            data: sgcData.features,
            getPosition: d => [d.geometry.coordinates[0], d.geometry.coordinates[1], 15000],
            radiusUnits: 'pixels',
            getRadius: d => Math.max((d.properties.mag || d.properties.magnitud || 3.0) * 6, 22),
            getFillColor: d => d.properties.esHoy ? [16, 185, 129, 90] : [13, 148, 136, 40], // Halo esmeralda vibrante si es hoy; cian translúcido si es anterior
            stroked: true,
            getLineColor: d => d.properties.esHoy ? [52, 211, 153, 230] : [20, 184, 166, 140],
            lineWidthMinPixels: 2,
            pickable: false
        }));

        layers.push(new deck.ScatterplotLayer({
            id: 'sgc-live-layer-core',
            data: sgcData.features,
            getPosition: d => [d.geometry.coordinates[0], d.geometry.coordinates[1], 16000],
            radiusUnits: 'pixels',
            getRadius: d => Math.max((d.properties.mag || d.properties.magnitud || 3.0) * 3, 10),
            getFillColor: d => d.properties.esHoy ? [16, 185, 129, 240] : [15, 118, 110, 190], // Núcleo esmeralda puro vs teal
            stroked: true,
            getLineColor: d => d.properties.esHoy ? [255, 255, 255, 255] : [204, 251, 241, 180],
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
                    tooltip.style.display = 'block';
                    tooltip.style.left = `${info.x}px`;
                    tooltip.style.top = `${info.y}px`;
                    tooltip.innerHTML = `<h4>⚡ Plano de Ruptura Activo</h4>
                                         <p><strong>Estructura:</strong> ${info.object.nombre}</p>
                                         <p><strong>Longitud de Ruptura Estimada:</strong> ${currentShakemapData.faultLengthKm || 45} km</p>
                                         <p><strong>Profundidad Sismogénica:</strong> ${info.object.prof} km</p>`;
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
                    const obj = info.object;
                    tooltip.style.display = 'block';
                    tooltip.style.left = `${info.x}px`;
                    tooltip.style.top = `${info.y}px`;
                    tooltip.innerHTML = `<h4>💥 ShakeMap: Intensidad ${obj.mmi}</h4>
                                         <p><strong>Nivel de Daño:</strong> ${obj.label}</p>
                                         <p><strong>Aceleración Pico Estimada:</strong> ${obj.pgaRange}</p>
                                         <p><strong>Campo Lobular GMPE:</strong> ~${obj.radioKm} km del plano de ruptura</p>`;
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
                        tooltip.style.display = 'block';
                        tooltip.style.left = `${info.x}px`;
                        tooltip.style.top = `${info.y}px`;
                        tooltip.innerHTML = `<h4>🔵 Frente de Onda P (Compresional)</h4>
                                             <p><strong>Velocidad Media:</strong> ${WAVE_VEL_P_KMS} km/s</p>
                                             <p><strong>Radio de Propagación:</strong> ${info.object.distKm} km</p>
                                             <p><strong>Tiempo Cosísmico:</strong> t = ${info.object.tSec} s</p>`;
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
                        tooltip.style.display = 'block';
                        tooltip.style.left = `${info.x}px`;
                        tooltip.style.top = `${info.y}px`;
                        tooltip.innerHTML = `<h4>🔴 Frente de Onda S (Cizallante)</h4>
                                             <p><strong>Velocidad Media:</strong> ${WAVE_VEL_S_KMS} km/s</p>
                                             <p><strong>Tren Destructor:</strong> ${info.object.distKm} km del foco</p>
                                             <p><strong>Tiempo Cosísmico:</strong> t = ${info.object.tSec} s</p>`;
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
                    const d = info.object;
                    tooltip.style.display = 'block';
                    tooltip.style.left = `${info.x}px`;
                    tooltip.style.top = `${info.y}px`;
                    tooltip.innerHTML = `<h4>⚡ Epicentro de Ruptura: ${d.nombre}</h4>
                                         <p><strong>Magnitud de Momento:</strong> <strong style="color:#ff453a;">${d.mw} Mw</strong></p>
                                         <p><strong>Profundidad Focal:</strong> ${d.profundidad} km</p>
                                         <p><strong>Aceleración Epicentral (PGA):</strong> <strong style="color:#ffd60a;">${d.pgaMax}</strong></p>
                                         <p><strong>Rumbo de Ruptura:</strong> N${d.strikeDeg || 0}°E (${d.faultLengthKm || 45} km)</p>
                                         <p><strong>Falla Activa:</strong> ${d.falla}</p>`;
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
                    tooltip.style.display = 'block';
                    tooltip.style.left = `${info.x}px`;
                    tooltip.style.top = `${info.y}px`;
                    tooltip.innerHTML = `<h4>🏛️ ${m.nombre} (${m.departamento}) — POT</h4>
                                         <p><strong>Población Expuesta:</strong> ${(m.poblacion || 0).toLocaleString()} hab.</p>
                                         <p><strong>Aceleración Aa:</strong> <strong style="color:#ffd60a;">${m.aa} g</strong></p>
                                         <p><strong>Radio de Análisis:</strong> 30 km circundantes</p>
                                         <p style="font-size:0.75rem; margin-top:4px; color:#A1A1A6;">${m.geologia || ''}</p>`;
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
        } else if (showInfra) {
            legend.style.display = 'block';
            legend.innerHTML = `
                <h4 style="margin: 0 0 10px 0; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #F5F5F7;">Líneas Vitales</h4>
                <div style="display: flex; flex-direction: column; gap: 7px; color: #A1A1A6; font-size: 0.74rem; font-weight: 500;">
                    <div style="display:flex; align-items:center; gap: 8px;">
                        <span style="display:inline-block; width:16px; height:4px; border-radius:2px; background:#FFB703;"></span>
                        <span>🛣️ <strong style="color:#FFB703;">Red Vial Primaria</strong></span>
                    </div>
                    <div style="display:flex; align-items:center; gap: 8px;">
                        <span style="display:inline-block; width:16px; height:5px; border-radius:2px; background:#38BDF8;"></span>
                        <span>🚢 <strong style="color:#38BDF8;">Corredor Fluvial</strong></span>
                    </div>
                    <div style="display:flex; align-items:center; gap: 8px;">
                        <span style="display:inline-block; width:10px; height:10px; border-radius:50%; background:#0A84FF; border:1.5px solid #fff;"></span>
                        <span>✈️ <strong style="color:#60A5FA;">Terminal Aéreo</strong></span>
                    </div>
                    <div style="display:flex; align-items:center; gap: 8px;">
                        <span style="display:inline-block; width:11px; height:11px; border-radius:50%; background:#FF2D55; border:1.5px solid #fff;"></span>
                        <span>🏥 <strong style="color:#FF6482;">Centro Asistencial</strong></span>
                    </div>
                </div>
            `;
        } else {
            legend.style.display = 'none';
        }

        // Si hay una capa sismica activa y ademas estan visibles las lineas vitales, concatenar sub-leyenda compacta
        if (showInfra && (viewMode !== 'none' || (isSimulatorActive && currentShakemapData))) {
            legend.innerHTML += `
                <div style="margin-top: 10px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.12);">
                    <div style="font-size: 0.68rem; font-weight: 700; text-transform: uppercase; color: #38bdf8; margin-bottom: 5px;">Líneas Vitales</div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 5px; font-size: 0.67rem; color: #D1D5DB;">
                        <div style="display:flex; align-items:center; gap:5px;"><span style="width:12px; height:3px; background:#FFB703; display:inline-block; border-radius:1px;"></span> 🛣️ Vías</div>
                        <div style="display:flex; align-items:center; gap:5px;"><span style="width:12px; height:4px; background:#38BDF8; display:inline-block; border-radius:1px;"></span> 🚢 Fluvial</div>
                        <div style="display:flex; align-items:center; gap:5px;"><span style="width:8px; height:8px; border-radius:50%; background:#0A84FF; border:1px solid #fff; display:inline-block;"></span> ✈️ Aéreo</div>
                        <div style="display:flex; align-items:center; gap:5px;"><span style="width:8px; height:8px; border-radius:50%; background:#FF2D55; border:1px solid #fff; display:inline-block;"></span> 🏥 Salud</div>
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

    const infraConvenciones = document.getElementById('infra-convenciones');
    if (infraConvenciones) infraConvenciones.style.display = 'none';

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

    if (liveSocket) {
        liveSocket.close();
        liveSocket = null;
    }
    if (livePollingInterval) {
        clearInterval(livePollingInterval);
        livePollingInterval = null;
    }
    sgcData.features = [];
    const sgcBadge = document.getElementById('sgc-live-status-badge');
    const sgcSubtext = document.getElementById('sgc-live-subtext');
    if (sgcBadge) sgcBadge.style.display = 'none';
    if (isSimulatorActive) {
        deactivateShakemap();
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
        // 1. Intento primario: Endpoint de telemetría del servidor local/nube
        const resp = await fetch(ENDPOINTS.SGC_API, { cache: 'no-store' });
        if (resp.ok) {
            const data = await resp.json();
            if (data.features && data.features.length > 0) {
                sgcData.features = data.features;
                updateSgcLiveBadge(data.features.length, 'FastAPI / SGC Live');
                if (showLiveSGC) queueRender();
                return;
            }
        }
    } catch (err) {
        console.warn("Backend local no disponible para SGC Live. Conectando directo a feed telemétrico satelital...", err);
    }

    // 2. Consulta directa a la API FDSN oficial de USGS (eventos telemétricos en tiempo real en la región)
    try {
        // Ventana telemétrica: últimos 7 días con prioridad a las últimas 24-48 horas
        const dNow = new Date();
        const dStart = new Date(dNow.getTime() - (7 * 24 * 60 * 60 * 1000));
        const startIso = dStart.toISOString().split('T')[0];
        const usgsUrl = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&minlatitude=3.0&maxlatitude=8.8&minlongitude=-78.5&maxlongitude=-74.5&starttime=${startIso}&limit=30`;
        const usgsResp = await fetch(usgsUrl, { cache: 'no-store' });
        if (usgsResp.ok) {
            const usgsData = await usgsResp.json();
            if (usgsData.features && usgsData.features.length > 0) {
                const nowMs = Date.now();
                const parsedFeatures = usgsData.features.map(item => {
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

                    // Identificación de municipio más cercano si existen datos municipales
                    let nearestName = p.place || 'Chocó / Pacífico';
                    if (municipiosData && municipiosData.length > 0) {
                        let minDist = Infinity;
                        for (const m of municipiosData) {
                            const dLat = (lat - m.lat) * (Math.PI / 180);
                            const dLon = (lon - m.lng) * (Math.PI / 180);
                            const a = Math.sin(dLat/2)*Math.sin(dLat/2) + Math.cos(lat*Math.PI/180)*Math.cos(m.lat*Math.PI/180)*Math.sin(dLon/2)*Math.sin(dLon/2);
                            const distKm = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
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
                            fuente: diffHours <= 24 ? "SGC / USGS Live (Últimas 24h)" : "SGC / USGS Telemétrico",
                            rms: p.rms || 0.0,
                            gap: p.gap || 0.0
                        }
                    };
                });

                sgcData.features = parsedFeatures;
                const rec24h = parsedFeatures.filter(f => f.properties.esHoy).length;
                const sourceLabel = rec24h > 0 ? `USGS/SGC Live (${rec24h} de hoy)` : 'USGS/SGC Reciente';
                updateSgcLiveBadge(parsedFeatures.length, sourceLabel);
                if (showLiveSGC) queueRender();
                return;
            }
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
            updateSgcLiveBadge(recientes.length, 'Catálogo Local');
            if (showLiveSGC) queueRender();
        }
    }
}

function updateSgcLiveBadge(count, sourceName) {
    const badge = document.getElementById('sgc-live-status-badge');
    const subtext = document.getElementById('sgc-live-subtext');
    if (badge) {
        badge.style.display = 'inline-block';
        badge.innerText = `● EN VIVO (${count})`;
        badge.style.color = '#34d399';
        badge.style.borderColor = 'rgba(52,211,153,0.4)';
        badge.style.background = 'rgba(52,211,153,0.15)';
    }
    if (subtext) {
        subtext.innerHTML = `<span style="color:#34d399;">● Conectado a ${sourceName}</span> (${count} eventos)`;
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

    if (descEl) descEl.innerHTML = `<strong>${p.municipio || 'Chocó / Pacífico'}</strong> detectado por red telemétrica oficial.`;
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
                        updateSgcLiveBadge(sgcData.features.length, 'WebSocket SGC');
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
        if (subtext) subtext.innerText = 'Alertas de sismicidad telemétrica';

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
        <div style="display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid rgba(255,255,255,0.12); padding-bottom:16px; margin-bottom:20px;">
            <div style="display:flex; align-items:center; gap:12px;">
                <div style="width:42px; height:42px; border-radius:12px; background:linear-gradient(135deg, #0A84FF, #0056B3); display:flex; align-items:center; justify-content:center; font-size:1.35rem; box-shadow:0 4px 14px rgba(10,132,255,0.45);">
                    🗺️
                </div>
                <div>
                    <h2 style="margin:0; color:#FFFFFF; font-size:1.35rem; font-weight:700; letter-spacing:-0.02em;">Guía de Uso de la Plataforma</h2>
                    <span style="font-size:0.75rem; color:#38BDF8; font-weight:600; text-transform:uppercase; letter-spacing:0.06em;">Investigación a través del Diseño (RtD) — U. de Caldas</span>
                </div>
            </div>
        </div>

        <p style="color:#D1D5DB; font-size:0.92rem; line-height:1.6; margin-bottom:18px;">
            Bienvenido a <strong>SismoChocó</strong>, plataforma interactiva de <em>Visual Analytics</em> concebida para explorar y comprender la <strong>acumulación de tensión sísmica, la subducción de la Placa de Nazca y las fallas geológicas activas</strong> en el departamento del Chocó a partir de datos oficiales del Servicio Geológico Colombiano (SGC).
        </p>

        <!-- CALLOUT DESTACADO: BOTONES DE AYUDA Y ORIENTACIÓN (?) -->
        <div style="background: linear-gradient(135deg, rgba(10,132,255,0.16), rgba(0,113,227,0.08)); border: 1.5px solid #0A84FF; border-radius: 14px; padding: 14px 16px; margin-bottom: 14px; box-shadow: 0 4px 18px rgba(10,132,255,0.22); display: flex; align-items: flex-start; gap: 14px;">
            <div style="flex-shrink:0; width: 34px; height: 34px; line-height: 34px; text-align: center; background: #0A84FF; color: white; border-radius: 50%; font-size: 1.15rem; font-weight: bold; box-shadow: 0 2px 10px rgba(10,132,255,0.6);">
                ?
            </div>
            <div>
                <h4 style="margin: 0 0 4px 0; color: #FFFFFF; font-size: 0.96rem; font-weight: 700; display: flex; align-items: center; gap: 6px;">
                    <span>💡 Botones de Ayuda Contextual en Cada Sección</span>
                </h4>
                <p style="margin: 0; color: #E0E7FF; font-size: 0.86rem; line-height: 1.5;">
                    Cada tarjeta, gráfico, filtro o módulo cuenta con un botón circular azul de ayuda (<span style="display:inline-block; width:18px; height:18px; line-height:18px; text-align:center; background:#0A84FF; color:white; border-radius:50%; font-size:0.75rem; font-weight:bold; vertical-align:middle;">?</span>). <strong>Púlsalo en cualquier momento</strong> para abrir una explicación detallada en palabras sencillas que te orientará sobre <em>cómo interpretar los datos técnicos y comprender a fondo su funcionamiento</em>.
                </p>
            </div>
        </div>

        <!-- CALLOUT DESTACADO: BOTONES RESTABLECER (RETIRAR CAMBIOS DE VISUALIZACIÓN) -->
        <div style="background: linear-gradient(135deg, rgba(255,149,0,0.16), rgba(255,107,0,0.08)); border: 1.5px solid #FF9500; border-radius: 14px; padding: 14px 16px; margin-bottom: 18px; box-shadow: 0 4px 18px rgba(255,149,0,0.22); display: flex; align-items: flex-start; gap: 14px;">
            <div style="flex-shrink:0; width: 34px; height: 34px; line-height: 34px; text-align: center; background: #FF9500; color: white; border-radius: 50%; font-size: 1.15rem; font-weight: bold; box-shadow: 0 2px 10px rgba(255,149,0,0.6);">
                🔄
            </div>
            <div>
                <h4 style="margin: 0 0 4px 0; color: #FFFFFF; font-size: 0.96rem; font-weight: 700; display: flex; align-items: center; gap: 6px;">
                    <span>🔄 Botones Restablecer: Retirar Cambios de Visualización y Filtros</span>
                </h4>
                <p style="margin: 0 0 8px 0; color: #FFE8CC; font-size: 0.86rem; line-height: 1.5;">
                    En cualquier momento puedes <strong>deshacer y retirar los cambios de visualización aplicados</strong> presionando los botones circulares de restablecimiento (<span style="display:inline-block; padding:1px 6px; background:rgba(255,255,255,0.15); border-radius:4px; font-weight:bold;">🔄</span>) situados en la cabecera de cada módulo o en la barra superior:
                </p>
                <ul style="margin: 0; padding-left: 18px; color: #FFF; font-size: 0.82rem; line-height: 1.45;">
                    <li style="margin-bottom: 4px;"><strong>🔄 Restablecer Visualización Espacial:</strong> Retira de inmediato la capa visual activa (apaga Puntos 3D, Mapa de Calor o Hexbins volumétricos) y desactiva el corte Benioff para dejar el mapa completamente limpio.</li>
                    <li style="margin-bottom: 4px;"><strong>🔄 Restablecer Filtros Paramétricos:</strong> Regresa los deslizadores a sus valores predeterminados (Magnitud $\ge 0.0$ Mw, Profundidad máxima $150$ km y Año $1993$), volviendo a mostrar el 100% de los sismos del catálogo.</li>
                    <li style="margin-bottom: 4px;"><strong>🔄 Restablecer Capas Avanzadas:</strong> Desmarca y apaga simultáneamente todos los interruptores activos (Fallas geológicas, Sismos de alta precisión, IA enjambres DBSCAN, SGC Live, OpenQuake e Infraestructura Crítica con sus convenciones).</li>
                    <li style="margin-bottom: 4px;"><strong>🧹 Limpiar Escenario ShakeMap:</strong> Dentro del simulador determinista de ruptura, retira las isoseistas y ondas de aceleración del mapa 3D.</li>
                    <li><strong>⌂ Restablecer Todo (Barra Superior):</strong> Ejecuta una restauración integral del sistema en cascada y regresa la cámara 3D a la vista cenital completa del departamento del Chocó.</li>
                </ul>
            </div>
        </div>

        <!-- SECCIÓN 1: MODOS DE ANÁLISIS -->
        <div style="background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); border-radius:14px; padding:16px; margin-bottom:16px;">
            <h3 style="color:#38BDF8; font-size:1.02rem; margin:0 0 10px 0; display:flex; align-items:center; gap:8px;">
                <span>🎯</span> 1. Tres Modos Especializados de Trabajo
            </h3>
            <p style="color:#9CA3AF; font-size:0.86rem; line-height:1.5; margin:0 0 12px 0;">
                En el panel superior izquierdo puedes alternar entre tres perfiles adaptados a tu rol técnico:
            </p>
            <div style="display:grid; grid-template-columns:1fr; gap:10px;">
                <div style="background:rgba(10,132,255,0.08); border-left:3px solid #0A84FF; padding:10px 12px; border-radius:6px;">
                    <strong style="color:#60A5FA; font-size:0.88rem;">🌋 Sismo-Geología:</strong>
                    <div style="color:#E5E7EB; font-size:0.82rem; line-height:1.4; margin-top:3px;">
                        Análisis sismotectónico regional de recurrencia con la ley de <strong>Gutenberg-Richter</strong> (cálculo dinámico del valor <em>b</em> y periodos de retorno), corte 3D del <strong>plano de subducción de Wadati-Benioff</strong>, trazo de fallas activas y detección de enjambres con inteligencia artificial (DBSCAN).
                    </div>
                </div>
                <div style="background:rgba(16,185,129,0.08); border-left:3px solid #10B981; padding:10px 12px; border-radius:6px;">
                    <strong style="color:#34D399; font-size:0.88rem;">🏗️ Diseño Estructural:</strong>
                    <div style="color:#E5E7EB; font-size:0.82rem; line-height:1.4; margin-top:3px;">
                        Selecciona entre los 67 municipios del Chocó y el Eje Cafetero, perfil de suelo (A a F) y grupo de uso bajo la norma NSR-10 para generar el <strong>Espectro Elástico de Diseño sísmico (Sa vs. Periodo T)</strong> con exportación directa a formato CSV para software estructural (ETABS / SAP2000).
                    </div>
                </div>
                <div style="background:rgba(245,158,11,0.08); border-left:3px solid #F59E0B; padding:10px 12px; border-radius:6px;">
                    <strong style="color:#FBBF24; font-size:0.88rem;">🏛️ Gestión Territorial:</strong>
                    <div style="color:#E5E7EB; font-size:0.82rem; line-height:1.4; margin-top:3px;">
                        Semáforo de peligro sísmico municipal para ordenamiento territorial (POT), análisis de población expuesta, corredores de retiro de 100 m respecto a fallas activas (Ley 388 de 1997), vulnerabilidad de infraestructura crítica y descarga de la <strong>Ficha Técnica Ejecutiva en PDF</strong>.
                    </div>
                </div>
            </div>
        </div>

        <!-- SECCIÓN 2: NAVEGACIÓN 3D -->
        <div style="background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); border-radius:14px; padding:16px; margin-bottom:16px;">
            <h3 style="color:#38BDF8; font-size:1.02rem; margin:0 0 10px 0; display:flex; align-items:center; gap:8px;">
                <span>🌐</span> 2. Navegación en el Mapa Tridimensional (GPU WebGL)
            </h3>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; font-size:0.84rem; color:#D1D5DB;">
                <div style="background:rgba(255,255,255,0.03); padding:8px 10px; border-radius:8px;">
                    <strong style="color:#FFF;">🖱️ Clic Izquierdo + Arrastrar:</strong><br>Desplazar la cámara (paneo geográfico).
                </div>
                <div style="background:rgba(255,255,255,0.03); padding:8px 10px; border-radius:8px;">
                    <strong style="color:#FFF;">🔄 Clic Derecho (o Ctrl + Clic):</strong><br>Orbitar e inclinar la perspectiva 3D (Pitch / Bearing).
                </div>
                <div style="background:rgba(255,255,255,0.03); padding:8px 10px; border-radius:8px;">
                    <strong style="color:#FFF;">🔍 Rueda del Ratón / Pellizco:</strong><br>Acercar o alejar el nivel de detalle (Zoom).
                </div>
                <div style="background:rgba(255,255,255,0.03); padding:8px 10px; border-radius:8px;">
                    <strong style="color:#FFF;">⌂ Botón Restablecer Todo:</strong><br>Regresar la vista cenital a la escala completa del Chocó y restaurar valores.
                </div>
            </div>
        </div>

        <!-- SECCIÓN 3: CORTE 3D BENIOFF -->
        <div style="background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); border-radius:14px; padding:16px; margin-bottom:16px;">
            <h3 style="color:#38BDF8; font-size:1.02rem; margin:0 0 10px 0; display:flex; align-items:center; gap:8px;">
                <span>📉</span> 3. Corte Transversal 3D (Subducción de Nazca)
            </h3>
            <p style="color:#D1D5DB; font-size:0.86rem; line-height:1.5; margin:0 0 10px 0;">
                Activa el botón <strong>"Corte 3D Benioff"</strong> para seccionar la litosfera del Pacífico. Permite examinar la losa oceánica que subduce a 32° hacia el Este bajo Colombia:
            </p>
            <ul style="color:#9CA3AF; font-size:0.83rem; line-height:1.5; margin:0; padding-left:18px;">
                <li><strong>Exageración Vertical (0.5x a 3.0x):</strong> Realza visualmente la profundidad hipocentral en el subsuelo.</li>
                <li><strong>Sectores Latitudinales:</strong> Inspecciona el corte Norte (Murindó), Centro (Quibdó) o Sur (San Juan).</li>
                <li><strong>Retirar Corte:</strong> Presiona de nuevo el botón para apagar el modo o pulsa 🔄 Restablecer Visualización.</li>
            </ul>
        </div>

        <!-- SECCIÓN 4: SIMULADOR SHAKEMAP -->
        <div style="background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); border-radius:14px; padding:16px; margin-bottom:20px;">
            <h3 style="color:#38BDF8; font-size:1.02rem; margin:0 0 10px 0; display:flex; align-items:center; gap:8px;">
                <span>⚡</span> 4. Simulador ShakeMap de Ruptura
            </h3>
            <p style="color:#D1D5DB; font-size:0.86rem; line-height:1.5; margin:0 0 8px 0;">
                Modela escenarios históricos o potenciales de gran destructividad (Murindó Mw 7.3, Megaterremoto de Subducción Mw 8.2 o sismo cortical directo sobre Quibdó Mw 6.8), calculando en tiempo real las ondas de sacudida y la intensidad Mercalli Modificada (MMI).
            </p>
            <p style="color:#FFE8CC; font-size:0.82rem; margin:0; line-height:1.4;">
                <em>🧹 Limpieza: Puedes retirar la simulación en cualquier momento usando el botón <strong>🧹 Limpiar</strong> junto al disparador de ruptura.</em>
            </p>
        </div>

        <!-- SECCIÓN 5: ATAJOS DE TECLADO (ACCESIBILIDAD Y CONTROL OPERATIVO RÁPIDO) -->
        <div style="background:linear-gradient(135deg, rgba(16,185,129,0.12), rgba(6,78,59,0.2)); border:1.5px solid #10b981; border-radius:14px; padding:16px; margin-bottom:20px; box-shadow:0 4px 18px rgba(16,185,129,0.2);">
            <h3 style="color:#34d399; font-size:1.02rem; margin:0 0 10px 0; display:flex; align-items:center; gap:8px;">
                <span>⌨️</span> 5. Atajos de Teclado y Control Espacial (Navegación Rápida)
            </h3>
            <p style="color:#E2E8F0; font-size:0.86rem; line-height:1.5; margin:0 0 12px 0;">
                Puedes controlar y conmutar las principales funciones analíticas directamente con las teclas del teclado:
            </p>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; font-size:0.82rem; margin-bottom:12px;">
                <div style="background:rgba(0,0,0,0.35); padding:8px 10px; border-radius:8px; border:1px solid rgba(255,255,255,0.08); display:flex; align-items:center; gap:8px;">
                    <kbd style="background:#1e293b; color:#38bdf8; border:1px solid #38bdf8; border-radius:4px; padding:2px 7px; font-weight:700; font-size:0.85rem; font-family:monospace;">1</kbd>
                    <span>Perfil: <strong>Sismo-Geología</strong></span>
                </div>
                <div style="background:rgba(0,0,0,0.35); padding:8px 10px; border-radius:8px; border:1px solid rgba(255,255,255,0.08); display:flex; align-items:center; gap:8px;">
                    <kbd style="background:#1e293b; color:#38bdf8; border:1px solid #38bdf8; border-radius:4px; padding:2px 7px; font-weight:700; font-size:0.85rem; font-family:monospace;">2</kbd>
                    <span>Perfil: <strong>Diseño Estructural</strong></span>
                </div>
                <div style="background:rgba(0,0,0,0.35); padding:8px 10px; border-radius:8px; border:1px solid rgba(255,255,255,0.08); display:flex; align-items:center; gap:8px;">
                    <kbd style="background:#1e293b; color:#38bdf8; border:1px solid #38bdf8; border-radius:4px; padding:2px 7px; font-weight:700; font-size:0.85rem; font-family:monospace;">3</kbd>
                    <span>Perfil: <strong>Gestión Territorial</strong></span>
                </div>
                <div style="background:rgba(0,0,0,0.35); padding:8px 10px; border-radius:8px; border:1px solid rgba(255,255,255,0.08); display:flex; align-items:center; gap:8px;">
                    <kbd style="background:#1e293b; color:#fbbf24; border:1px solid #fbbf24; border-radius:4px; padding:2px 7px; font-weight:700; font-size:0.85rem; font-family:monospace;">4</kbd>
                    <span>Visualización: <strong>Eventos 3D</strong></span>
                </div>
                <div style="background:rgba(0,0,0,0.35); padding:8px 10px; border-radius:8px; border:1px solid rgba(255,255,255,0.08); display:flex; align-items:center; gap:8px;">
                    <kbd style="background:#1e293b; color:#fbbf24; border:1px solid #fbbf24; border-radius:4px; padding:2px 7px; font-weight:700; font-size:0.85rem; font-family:monospace;">5</kbd>
                    <span>Visualización: <strong>Mapa de Calor</strong></span>
                </div>
                <div style="background:rgba(0,0,0,0.35); padding:8px 10px; border-radius:8px; border:1px solid rgba(255,255,255,0.08); display:flex; align-items:center; gap:8px;">
                    <kbd style="background:#1e293b; color:#fbbf24; border:1px solid #fbbf24; border-radius:4px; padding:2px 7px; font-weight:700; font-size:0.85rem; font-family:monospace;">6</kbd>
                    <span>Visualización: <strong>Hexbins 3D</strong></span>
                </div>
                <div style="background:rgba(0,0,0,0.35); padding:8px 10px; border-radius:8px; border:1px solid rgba(255,255,255,0.08); display:flex; align-items:center; gap:8px;">
                    <kbd style="background:#1e293b; color:#f43f5e; border:1px solid #f43f5e; border-radius:4px; padding:2px 7px; font-weight:700; font-size:0.85rem; font-family:monospace;">7</kbd>
                    <span>Corte: <strong>Perfil 3D Benioff</strong></span>
                </div>
                <div style="background:rgba(0,0,0,0.35); padding:8px 10px; border-radius:8px; border:1px solid rgba(255,255,255,0.08); display:flex; align-items:center; gap:8px;">
                    <kbd style="background:#1e293b; color:#34d399; border:1px solid #34d399; border-radius:4px; padding:2px 7px; font-weight:700; font-size:0.85rem; font-family:monospace;">8</kbd>
                    <span>Capa: <strong>Conexión SGC Live</strong></span>
                </div>
                <div style="background:rgba(0,0,0,0.35); padding:8px 10px; border-radius:8px; border:1px solid rgba(255,255,255,0.08); display:flex; align-items:center; gap:8px;">
                    <kbd style="background:#1e293b; color:#f59e0b; border:1px solid #f59e0b; border-radius:4px; padding:2px 7px; font-weight:700; font-size:0.85rem; font-family:monospace;">9</kbd>
                    <span>Capa: <strong>Fallas Geológicas</strong></span>
                </div>
                <div style="background:rgba(0,0,0,0.35); padding:8px 10px; border-radius:8px; border:1px solid rgba(255,255,255,0.08); display:flex; align-items:center; gap:8px;">
                    <kbd style="background:#1e293b; color:#a855f7; border:1px solid #a855f7; border-radius:4px; padding:2px 7px; font-weight:700; font-size:0.85rem; font-family:monospace;">0</kbd>
                    <span>Acción: <strong>Restablecer Todo</strong></span>
                </div>
            </div>

            <!-- Navegación con Teclas de Flecha y Zoom -->
            <div style="background:rgba(0,0,0,0.4); border:1px solid rgba(56,189,248,0.3); border-radius:10px; padding:10px 12px; margin-bottom:8px;">
                <strong style="color:#38bdf8; font-size:0.82rem; display:block; margin-bottom:6px;">🧭 Navegación Espacial del Mapa con Teclado:</strong>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; font-size:0.78rem; color:#cbd5e1;">
                    <div><kbd style="background:#1e293b; color:#fff; border:1px solid #64748b; border-radius:4px; padding:1px 6px;">↑</kbd> <kbd style="background:#1e293b; color:#fff; border:1px solid #64748b; border-radius:4px; padding:1px 6px;">↓</kbd> <kbd style="background:#1e293b; color:#fff; border:1px solid #64748b; border-radius:4px; padding:1px 6px;">←</kbd> <kbd style="background:#1e293b; color:#fff; border:1px solid #64748b; border-radius:4px; padding:1px 6px;">→</kbd> : Desplazar mapa (N, S, O, E)</div>
                    <div><kbd style="background:#1e293b; color:#38bdf8; border:1px solid #38bdf8; border-radius:4px; padding:1px 6px;">+</kbd> / <kbd style="background:#1e293b; color:#38bdf8; border:1px solid #38bdf8; border-radius:4px; padding:1px 6px;">-</kbd> : Acercar / Alejar Zoom directo</div>
                    <div><kbd style="background:#1e293b; color:#facc15; border:1px solid #facc15; border-radius:4px; padding:1px 6px;">⇧ Shift</kbd> + <kbd style="background:#1e293b; color:#fff; border:1px solid #64748b; border-radius:4px; padding:1px 6px;">↑</kbd> <kbd style="background:#1e293b; color:#fff; border:1px solid #64748b; border-radius:4px; padding:1px 6px;">↓</kbd> : Inclinar cámara 3D (Pitch)</div>
                    <div><kbd style="background:#1e293b; color:#facc15; border:1px solid #facc15; border-radius:4px; padding:1px 6px;">⇧ Shift</kbd> + <kbd style="background:#1e293b; color:#fff; border:1px solid #64748b; border-radius:4px; padding:1px 6px;">←</kbd> <kbd style="background:#1e293b; color:#fff; border:1px solid #64748b; border-radius:4px; padding:1px 6px;">→</kbd> : Rotar ángulo azimutal (Bearing)</div>
                </div>
            </div>

            <p style="color:#94A3B8; font-size:0.75rem; margin:10px 0 0 0; line-height:1.4;">
                <em>Nota: Los atajos se desactivan automáticamente al escribir dentro de cajas de búsqueda o campos de texto.</em>
            </p>
        </div>

        <div style="display:flex; justify-content:center;">
            <button id="btn-entendido-guia" style="background:linear-gradient(135deg, #0A84FF, #0066CC); color:#FFFFFF; border:none; border-radius:12px; padding:12px 28px; font-size:0.95rem; font-weight:600; cursor:pointer; box-shadow:0 6px 18px rgba(10,132,255,0.45); transition:all 0.2s ease;">
                ¡Entendido, Explorar la Plataforma!
            </button>
        </div>
    `,
    'vis_espacial': `
        <div style="display:flex; align-items:center; gap:12px; border-bottom:1px solid rgba(255,255,255,0.12); padding-bottom:14px; margin-bottom:18px;">
            <div style="width:38px; height:38px; border-radius:10px; background:linear-gradient(135deg, #0A84FF, #0056B3); display:flex; align-items:center; justify-content:center; font-size:1.25rem;">
                🌐
            </div>
            <div>
                <h2 style="margin:0; color:#FFFFFF; font-size:1.3rem; font-weight:700;">Instrucciones: Visualización Espacial</h2>
                <span style="font-size:0.75rem; color:#38BDF8; font-weight:600; text-transform:uppercase;">Renderizado Tridimensional WebGL (Deck.gl)</span>
            </div>
        </div>

        <p style="color:#D1D5DB; font-size:0.92rem; line-height:1.6; margin-bottom:14px;">
            Este módulo transforma los registros tabulares del catálogo sísmico en representaciones visuales espaciales tridimensionales aceleradas por tarjeta gráfica (GPU).
        </p>

        <div style="background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); border-radius:12px; padding:14px; margin-bottom:14px;">
            <h3 style="color:#38BDF8; font-size:0.98rem; margin:0 0 10px 0;">🎯 Modos de Representación Disponibles:</h3>
            <div style="display:flex; flex-direction:column; gap:10px; font-size:0.85rem; color:#E5E7EB;">
                <div style="background:rgba(10,132,255,0.08); border-left:3px solid #0A84FF; padding:8px 12px; border-radius:6px;">
                    <strong style="color:#60A5FA;">1. Eventos Individuales (Scatter 3D):</strong> Dibuja cada temblor como una esfera precisa. Su tamaño escala con la magnitud del sismo y su color discrimina la profundidad hipocentral (Naranja: superficial &lt;30 km, Rosa: intermedio 30-70 km, Morado: profundo &gt;70 km).
                </div>
                <div style="background:rgba(255,45,85,0.08); border-left:3px solid #FF2D55; padding:8px 12px; border-radius:6px;">
                    <strong style="color:#FF6482;">2. Concentración de Energía (Heatmap):</strong> Interpola matemáticamente la densidad acumulada de energía sísmica, revelando zonas de mayor estrés tectónico y fricción en la corteza.
                </div>
                <div style="background:rgba(16,185,129,0.08); border-left:3px solid #10B981; padding:8px 12px; border-radius:6px;">
                    <strong style="color:#34D399;">3. Agrupación Espacial (Hexbins 3D):</strong> Agrupa eventos en columnas hexagonales de 8 km. La altura del prisma representa la cantidad de sismos registrados y el color su intensidad.
                </div>
            </div>
        </div>

        <!-- REGLA EXPLICITA DE RETIRAR CAMBIOS -->
        <div style="background:rgba(255,149,0,0.12); border:1.5px solid #FF9500; border-radius:12px; padding:12px 14px; margin-bottom:14px;">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                <span style="font-size:1.1rem;">🔄</span>
                <strong style="color:#FFD60A; font-size:0.9rem;">¿Cómo retirar o cambiar la visualización?</strong>
            </div>
            <p style="margin:0; color:#FFF; font-size:0.83rem; line-height:1.45;">
                Para <strong>retirar la visualización activa</strong> y limpiar el mapa, presiona el botón <span style="display:inline-block; padding:1px 6px; background:rgba(255,255,255,0.2); border-radius:4px; font-weight:bold;">🔄</span> situado en la esquina derecha del título <em>Visualización Espacial</em>. Esto desactivará de inmediato el modo seleccionado y apagará el corte Benioff sin alterar tus filtros numéricos.
            </p>
        </div>

        <p style="color:#9CA3AF; font-size:0.8rem; margin:0; line-height:1.4;">
            <em>💡 Tip: También puedes alternar libremente entre los tres botones para comparar cómo cambia la percepción espacial de la sismicidad.</em>
        </p>
    `,
    'filtros_parametricos': `
        <div style="display:flex; align-items:center; gap:12px; border-bottom:1px solid rgba(255,255,255,0.12); padding-bottom:14px; margin-bottom:18px;">
            <div style="width:38px; height:38px; border-radius:10px; background:linear-gradient(135deg, #0A84FF, #0056B3); display:flex; align-items:center; justify-content:center; font-size:1.25rem;">
                ⚙️
            </div>
            <div>
                <h2 style="margin:0; color:#FFFFFF; font-size:1.3rem; font-weight:700;">Instrucciones: Filtros Paramétricos</h2>
                <span style="font-size:0.75rem; color:#38BDF8; font-weight:600; text-transform:uppercase;">Segmentación Analítica Multivariable</span>
            </div>
        </div>

        <p style="color:#D1D5DB; font-size:0.92rem; line-height:1.6; margin-bottom:14px;">
            Los filtros paramétricos te permiten aislar eventos sísmicos específicos y observar cómo varía la sismicidad según umbrales de energía, profundidad de falla y periodos históricos.
        </p>

        <div style="background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); border-radius:12px; padding:14px; margin-bottom:14px;">
            <h3 style="color:#38BDF8; font-size:0.98rem; margin:0 0 10px 0;">🎛️ Controles del Módulo:</h3>
            <ul style="margin:0; padding-left:18px; color:#E5E7EB; font-size:0.84rem; line-height:1.5;">
                <li style="margin-bottom:8px;"><strong>Deslizador de Magnitud (Mw):</strong> Arrastra para definir el límite inferior de magnitud. Al subir a $\ge 5.0$, se aíslan los sismos con potencial de causar daños estructurales.</li>
                <li style="margin-bottom:8px;"><strong>Profundidad Hipocentral (km):</strong> Permite acotar el rango vertical del subsuelo (sismos superficiales $&lt;30$ km asociados a fallas activas, frente a sismos profundos de subducción en la Placa de Nazca).</li>
                <li style="margin-bottom:8px;"><strong>Ventana de Tiempo y Time-Lapse:</strong> Modifica el año inicial de corte (1993 a 2026) o presiona <strong>▶ Reproducir</strong> para presenciar la animación histórica cronológica año por año.</li>
                <li><strong>Interacción con el Gráfico Gutenberg-Richter:</strong> Al hacer clic en cualquier barra del histograma de magnitudes, el filtro se ajusta automáticamente a ese valor.</li>
            </ul>
        </div>

        <!-- REGLA EXPLICITA DE RETIRAR CAMBIOS -->
        <div style="background:rgba(255,149,0,0.12); border:1.5px solid #FF9500; border-radius:12px; padding:12px 14px; margin-bottom:14px;">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                <span style="font-size:1.1rem;">🔄</span>
                <strong style="color:#FFD60A; font-size:0.9rem;">¿Cómo retirar o restablecer los filtros?</strong>
            </div>
            <p style="margin:0; color:#FFF; font-size:0.83rem; line-height:1.45;">
                Para <strong>retirar todos los filtros paramétricos aplicados</strong> y volver a visualizar la totalidad del catálogo histórico, presiona el botón <span style="display:inline-block; padding:1px 6px; background:rgba(255,255,255,0.2); border-radius:4px; font-weight:bold;">🔄</span> ubicado a la derecha del título <em>Filtros Paramétricos</em>. Al pulsarlo, la magnitud vuelve a 0.0 Mw, la profundidad a 150 km y el año a 1993 en un instante.
            </p>
        </div>
    `,
    'capas_avanzadas': `
        <div style="display:flex; align-items:center; gap:12px; border-bottom:1px solid rgba(255,255,255,0.12); padding-bottom:14px; margin-bottom:18px;">
            <div style="width:38px; height:38px; border-radius:10px; background:linear-gradient(135deg, #0A84FF, #0056B3); display:flex; align-items:center; justify-content:center; font-size:1.25rem;">
                📚
            </div>
            <div>
                <h2 style="margin:0; color:#FFFFFF; font-size:1.3rem; font-weight:700;">Instrucciones: Capas Avanzadas</h2>
                <span style="font-size:0.75rem; color:#38BDF8; font-weight:600; text-transform:uppercase;">Superposición Geoespacial Multifuente</span>
            </div>
        </div>

        <p style="color:#D1D5DB; font-size:0.92rem; line-height:1.6; margin-bottom:14px;">
            Las capas avanzadas permiten cruzar el catálogo sísmico con trazas tectónicas oficiales, modelos probabilísticos de amenaza y redes de soporte vital territorial.
        </p>

        <div style="background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); border-radius:12px; padding:14px; margin-bottom:14px;">
            <h3 style="color:#38BDF8; font-size:0.98rem; margin:0 0 10px 0;">⚡ Interruptores Disponibles:</h3>
            <ul style="margin:0; padding-left:18px; color:#E5E7EB; font-size:0.84rem; line-height:1.5;">
                <li style="margin-bottom:6px;"><strong>Sismos de Alta Precisión:</strong> Filtra y oculta registros con incertidumbre geométrica instrumental (GAP &gt; 180° y RMS &gt; 1.0s).</li>
                <li style="margin-bottom:6px;"><strong>Fallas Geológicas:</strong> Proyecta trazas activas con clasificación cinemática, ficha interactiva y zona de amortiguamiento normativo (buffer de 5 km).</li>
                <li style="margin-bottom:6px;"><strong>Enjambres Sísmicos (IA DBSCAN):</strong> Algoritmo no supervisado que agrupa sismos con alta densidad espaciotemporal.</li>
                <li style="margin-bottom:6px;"><strong>SGC Live:</strong> Monitoreo telemétrico continuo con pulsos de ondas en tiempo real.</li>
                <li><strong>Amenaza OpenQuake (PGA):</strong> Proyecta la aceleración sísmica esperada para un periodo de retorno de 475 años.</li>
            </ul>
        </div>

        <!-- REGLA EXPLICITA DE RETIRAR CAMBIOS -->
        <div style="background:rgba(255,149,0,0.12); border:1.5px solid #FF9500; border-radius:12px; padding:12px 14px; margin-bottom:14px;">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                <span style="font-size:1.1rem;">🔄</span>
                <strong style="color:#FFD60A; font-size:0.9rem;">¿Cómo retirar o apagar las capas activas?</strong>
            </div>
            <p style="margin:0; color:#FFF; font-size:0.83rem; line-height:1.45;">
                Para <strong>retirar y apagar todas las capas avanzadas</strong> en un solo paso, presiona el botón <span style="display:inline-block; padding:1px 6px; background:rgba(255,255,255,0.2); border-radius:4px; font-weight:bold;">🔄</span> situado a la derecha del título <em>Capas Avanzadas</em>. Se desmarcarán todos los interruptores activos, se cerrará el panel lateral de fallas y se limpiará el lienzo sin reiniciar el resto de tus preferencias.
            </p>
        </div>
    `,    'rtd': `
        <h2 style="margin-top:0; color:#0A84FF; font-size:1.4rem; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:15px; margin-bottom:20px;">Investigación a través del Diseño (Research through Design - RtD)</h2>
        <p style="color:var(--text-secondary); font-size:0.95rem; line-height:1.6; margin-bottom:12px;">El marco metodológico de esta investigación se fundamenta en <strong>Research through Design (RtD)</strong> (Zimmerman, Forlizzi & Evenson, 2007; Gaver, 2012), donde el proceso iterativo de diseño y construcción del artefacto digital interactivo constituye el medio epistemológico primario para generar conocimiento transferible.</p>
        <div style="background: rgba(10,132,255,0.08); border-left: 3px solid #0A84FF; padding: 12px 14px; border-radius: 6px; margin: 14px 0; color: #e2e8f0; font-size: 0.9rem; line-height: 1.5;">
            <strong>Línea Institucional:</strong> <em>Gestión y Transmisión del Conocimiento</em><br>
            <strong>Temática de Investigación:</strong> <em>Presentación de Información Compleja</em><br>
            <strong>Programa:</strong> Maestría en Diseño y Creación Interactiva — Universidad de Caldas
        </div>
        <h3 style="color:#F5F5F7; font-size:1.05rem; margin-top:15px; margin-bottom:8px;">Triangulación Visual Analytics:</h3>
        <p style="color:var(--text-secondary); font-size:0.9rem; line-height:1.5;">Siguiendo el mantra de Thomas & Cook (2005) y Shneiderman (1996), la plataforma articula el razonamiento analítico asistido por interfaces interactivas: <em>"Overview first, zoom and filter, then details-on-demand"</em>, reduciendo la carga cognitiva intrínseca ante volúmenes masivos de datos sismotectónicos.</p>

        <!-- INSTRUCCIONES DE USO Y RESTABLECIMIENTO -->
        <div style="background:rgba(255,149,0,0.12); border:1.5px solid #FF9500; border-radius:12px; padding:12px 14px; margin-top:14px;">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                <span style="font-size:1.1rem;">🔄</span>
                <strong style="color:#FFD60A; font-size:0.88rem;">Instrucciones de Uso y Restablecimiento:</strong>
            </div>
            <ul style="margin:6px 0 0 0; padding-left:18px; color:#FFF; font-size:0.82rem; line-height:1.45;">
                <li><strong>Uso:</strong> Este panel es de consulta epistemológica y metodológica del proyecto de maestría. Puedes cerrar la ventana con el botón de la esquina superior derecha o haciendo clic fuera del diálogo.</li>
                <li><strong>Restablecimiento:</strong> Para regresar cualquier visualización activa o filtro al estado de referencia inicial del sistema, puedes presionar el botón <em>⌂ Restablecer Todo</em> en la barra de herramientas superior.</li>
            </ul>
        </div>
    `,
    'magnitud': `
        <h2 style="margin-top:0; color:#0A84FF; font-size:1.4rem; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:15px; margin-bottom:20px;">Magnitud (Mw)</h2>
        <p style="color:var(--text-secondary); font-size:0.95rem; line-height:1.5; margin-bottom:10px;">Filtra los sismos según la energía total liberada en su hipocentro.</p>
        <p style="color:var(--text-secondary); font-size:0.95rem; line-height:1.5;">En sismología moderna se usa la <strong>Escala de Magnitud de Momento (Mw)</strong>, que es mucho más precisa que la antigua escala de Richter. Es una escala logarítmica: un sismo de Mw 5.0 no es un 20% más fuerte que uno de 4.0... en realidad libera <strong>32 veces más energía destructiva</strong>.</p>

        <!-- INSTRUCCIONES DE USO Y RESTABLECIMIENTO -->
        <div style="background:rgba(255,149,0,0.12); border:1.5px solid #FF9500; border-radius:12px; padding:12px 14px; margin-top:14px;">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                <span style="font-size:1.1rem;">🔄</span>
                <strong style="color:#FFD60A; font-size:0.88rem;">Instrucciones de Uso y Restablecimiento:</strong>
            </div>
            <ul style="margin:6px 0 0 0; padding-left:18px; color:#FFF; font-size:0.82rem; line-height:1.45;">
                <li><strong>Uso:</strong> Arrastra el deslizador horizontal para definir el umbral mínimo de energía sísmica (de 2.0 a 7.5 Mw). El mapa 3D y las métricas se filtrarán en tiempo real.</li>
                <li><strong>Restablecer:</strong> Presiona el botón <em>🔄 Restablecer Filtros</em> ubicado inmediatamente en la cabecera de la sección de filtros para regresar la magnitud al valor base (2.0 Mw).</li>
            </ul>
        </div>
    `,
    'anio': `
        <h2 style="margin-top:0; color:#0A84FF; font-size:1.4rem; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:15px; margin-bottom:20px;">Ventana de Tiempo</h2>
        <p style="color:var(--text-secondary); font-size:0.95rem; line-height:1.5; margin-bottom:10px;">Permite analizar la sismicidad partiendo desde un año en específico (de 1993 a 2026).</p>
        <p style="color:var(--text-secondary); font-size:0.95rem; line-height:1.5;">Al mover el deslizador, tanto el mapa 3D como las estadísticas se actualizarán instantáneamente para revelar cómo se ha comportado, acumulado y migrado la tensión tectónica a lo largo de las últimas décadas en el Chocó.</p>

        <!-- INSTRUCCIONES DE USO Y RESTABLECIMIENTO -->
        <div style="background:rgba(255,149,0,0.12); border:1.5px solid #FF9500; border-radius:12px; padding:12px 14px; margin-top:14px;">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                <span style="font-size:1.1rem;">🔄</span>
                <strong style="color:#FFD60A; font-size:0.88rem;">Instrucciones de Uso y Restablecimiento:</strong>
            </div>
            <ul style="margin:6px 0 0 0; padding-left:18px; color:#FFF; font-size:0.82rem; line-height:1.45;">
                <li><strong>Uso:</strong> Desplaza el cursor de la barra para fijar el año de inicio del catálogo histórico analizado.</li>
                <li><strong>Restablecer:</strong> Presiona el botón <em>🔄 Restablecer Filtros</em> en la sección de filtros para reiniciar la ventana temporal al registro histórico completo (año 1993).</li>
            </ul>
        </div>
    `,
    'puntos': `
        <h2 style="margin-top:0; color:#0A84FF; font-size:1.4rem; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:15px; margin-bottom:20px;">Eventos Individuales (Scatter)</h2>
        <p style="color:var(--text-secondary); font-size:0.95rem; line-height:1.5; margin-bottom:10px;">Cada sismo registrado en el catálogo se dibuja como una esfera exacta en el espacio tridimensional del subsuelo.</p>
        <ul style="color:var(--text-secondary); font-size:0.95rem; line-height:1.5; margin-bottom:10px;">
            <li style="margin-bottom:6px;"><strong>El tamaño y color:</strong> Son directamente proporcionales a la Magnitud (Mw) del sismo.</li>
            <li><strong>La altura:</strong> Indica su profundidad bajo tierra (hipocentro), permitiendo ver perfiles de subducción (zonas de Benioff).</li>
        </ul>

        <!-- INSTRUCCIONES DE USO Y RESTABLECIMIENTO -->
        <div style="background:rgba(255,149,0,0.12); border:1.5px solid #FF9500; border-radius:12px; padding:12px 14px; margin-top:14px;">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                <span style="font-size:1.1rem;">🔄</span>
                <strong style="color:#FFD60A; font-size:0.88rem;">Instrucciones de Uso y Restablecimiento:</strong>
            </div>
            <ul style="margin:6px 0 0 0; padding-left:18px; color:#FFF; font-size:0.82rem; line-height:1.45;">
                <li><strong>Uso:</strong> Presiona el botón <em>⚪ Puntos</em> para visualizar cada sismo como una esfera tridimensional georreferenciada.</li>
                <li><strong>Restablecer:</strong> Presiona el botón <em>🔄 Restablecer Visualización</em> en la cabecera de Modos de Visualización para regresar la vista al modo predeterminado de eventos individuales con vista cenital.</li>
            </ul>
        </div>
    `,
    'calor': `
        <h2 style="margin-top:0; color:#0A84FF; font-size:1.4rem; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:15px; margin-bottom:20px;">Concentración de Energía (Heatmap)</h2>
        <p style="color:var(--text-secondary); font-size:0.95rem; line-height:1.5; margin-bottom:10px;">Difumina matemáticamente los puntos individuales para formar un mapa térmico continuo sobre la superficie.</p>
        <p style="color:var(--text-secondary); font-size:0.95rem; line-height:1.5;">Muestra visualmente de rojo a amarillo las zonas donde la corteza terrestre está sometida a mayor estrés sísmico acumulado a lo largo de los años. Es una herramienta fundamental para identificar zonas de alto riesgo inminente de ruptura o fallas ciegas.</p>

        <!-- INSTRUCCIONES DE USO Y RESTABLECIMIENTO -->
        <div style="background:rgba(255,149,0,0.12); border:1.5px solid #FF9500; border-radius:12px; padding:12px 14px; margin-top:14px;">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                <span style="font-size:1.1rem;">🔄</span>
                <strong style="color:#FFD60A; font-size:0.88rem;">Instrucciones de Uso y Restablecimiento:</strong>
            </div>
            <ul style="margin:6px 0 0 0; padding-left:18px; color:#FFF; font-size:0.82rem; line-height:1.45;">
                <li><strong>Uso:</strong> Presiona el botón <em>🔥 Calor</em> para renderizar la densidad e intensidad de energía liberada como una superficie continua de calor.</li>
                <li><strong>Restablecer:</strong> Presiona el botón <em>🔄 Restablecer Visualización</em> para desactivar el mapa de calor y retornar a la vista de esferas individuales.</li>
            </ul>
        </div>
    `,
    'hex': `
        <h2 style="margin-top:0; color:#0A84FF; font-size:1.4rem; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:15px; margin-bottom:20px;">Agrupación Espacial (Hexbins 3D)</h2>
        <p style="color:var(--text-secondary); font-size:0.95rem; line-height:1.5; margin-bottom:10px;">Agrupa los sismos en prismas hexagonales volumétricos en 3D (similar a un panal de abejas).</p>
        <ul style="color:var(--text-secondary); font-size:0.95rem; line-height:1.5; margin-bottom:10px;">
            <li style="margin-bottom:6px;"><strong>La altura del hexágono:</strong> Indica la cantidad de sismos (frecuencia estadística) que han ocurrido dentro de ese polígono de 5km cuadrados.</li>
            <li><strong>El color:</strong> Indica la magnitud de la energía en esa celda.</li>
        </ul>

        <!-- INSTRUCCIONES DE USO Y RESTABLECIMIENTO -->
        <div style="background:rgba(255,149,0,0.12); border:1.5px solid #FF9500; border-radius:12px; padding:12px 14px; margin-top:14px;">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                <span style="font-size:1.1rem;">🔄</span>
                <strong style="color:#FFD60A; font-size:0.88rem;">Instrucciones de Uso y Restablecimiento:</strong>
            </div>
            <ul style="margin:6px 0 0 0; padding-left:18px; color:#FFF; font-size:0.82rem; line-height:1.45;">
                <li><strong>Uso:</strong> Presiona el botón <em>🔷 Hexbins</em> para proyectar la agregación hexagonal volumétrica sobre el mapa.</li>
                <li><strong>Restablecer:</strong> Presiona el botón <em>🔄 Restablecer Visualización</em> para remover los prismas hexagonales y restablecer la capa base.</li>
            </ul>
        </div>
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

        <!-- INSTRUCCIONES DE USO Y RESTABLECIMIENTO -->
        <div style="background:rgba(255,149,0,0.12); border:1.5px solid #FF9500; border-radius:12px; padding:12px 14px; margin-top:14px;">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                <span style="font-size:1.1rem;">🔄</span>
                <strong style="color:#FFD60A; font-size:0.88rem;">Instrucciones de Uso y Restablecimiento:</strong>
            </div>
            <ul style="margin:6px 0 0 0; padding-left:18px; color:#FFF; font-size:0.82rem; line-height:1.45;">
                <li><strong>Uso:</strong> Haz clic en cualquier punto o segmento de la gráfica para aplicar un filtro de magnitud rápido sobre la escena 3D.</li>
                <li><strong>Restablecer:</strong> Presiona el botón <em>🔄 Restablecer Filtros</em> en la sección superior para restablecer el rango completo de magnitud en el gráfico y en el mapa.</li>
            </ul>
        </div>
    `,
    'calidad': `
        <h2 style="margin-top:0; color:#0A84FF; font-size:1.4rem; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:15px; margin-bottom:20px;">Filtro de Sismos con Máxima Confiabilidad</h2>
        <h3 style="color:#F5F5F7; font-size:1.1rem; margin-bottom:8px;">¿Para qué sirve este filtro?</h3>
        <p style="color:var(--text-secondary); font-size:0.95rem; line-height:1.5; margin-bottom:10px;">En ocasiones, las estaciones sismológicas captan señales lejanas o con pocas antenas receptoras, lo que puede provocar que la ubicación calculada en el mapa tenga margen de error.</p>
        <p style="color:var(--text-secondary); font-size:0.95rem; line-height:1.5; margin-bottom:10px;">Al activar este interruptor, el sistema <strong>oculta los registros con incertidumbre</strong> y deja visibles únicamente los sismos que fueron verificados por múltiples sismógrafos con precisión milimétrica en su epicentro y profundidad.</p>
        <div style="background: rgba(255,255,255,0.05); padding: 10px 14px; border-radius: 8px; color: var(--text-secondary); font-size: 0.85rem; line-height: 1.4;">
            Ideal para ingenieros, investigadores y tomadores de decisiones que requieran datos rigurosamente certificados para estudios de suelo o diseño estructural.
        </div>

        <!-- INSTRUCCIONES DE USO Y RESTABLECIMIENTO -->
        <div style="background:rgba(255,149,0,0.12); border:1.5px solid #FF9500; border-radius:12px; padding:12px 14px; margin-top:14px;">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                <span style="font-size:1.1rem;">🔄</span>
                <strong style="color:#FFD60A; font-size:0.88rem;">Instrucciones de Uso y Restablecimiento:</strong>
            </div>
            <ul style="margin:6px 0 0 0; padding-left:18px; color:#FFF; font-size:0.82rem; line-height:1.45;">
                <li><strong>Uso:</strong> Activa el interruptor para discriminar eventos con alta calidad instrumental (Gap azimuthal &lt; 180° y RMS &lt; 0.5s).</li>
                <li><strong>Restablecer:</strong> Apaga el interruptor directamente o presiona el botón <em>🔄 Restablecer Capas</em> en la sección de Capas Avanzadas para reintegrar todos los registros sismológicos.</li>
            </ul>
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

        <!-- INSTRUCCIONES DE USO Y RESTABLECIMIENTO -->
        <div style="background:rgba(255,149,0,0.12); border:1.5px solid #FF9500; border-radius:12px; padding:12px 14px; margin-top:14px;">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                <span style="font-size:1.1rem;">🔄</span>
                <strong style="color:#FFD60A; font-size:0.88rem;">Instrucciones de Uso y Restablecimiento:</strong>
            </div>
            <ul style="margin:6px 0 0 0; padding-left:18px; color:#FFF; font-size:0.82rem; line-height:1.45;">
                <li><strong>Uso:</strong> Activa el interruptor <em>Trazas de Fallas SGC</em> o selecciona una falla del listado para resaltar su geometría en 3D.</li>
                <li><strong>Restablecer:</strong> Presiona el botón <em>🔄 Restablecer Capas</em> en la sección de Capas Avanzadas para desactivar las fallas, ocultar el corredor de retiro y cerrar el panel lateral de detalles.</li>
            </ul>
        </div>
    `,
    'ml': `
        <h2 style="margin-top:0; color:#0A84FF; font-size:1.4rem; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:15px; margin-bottom:20px;">Detección Inteligente de Enjambres Sísmicos (IA)</h2>
        <h3 style="color:#F5F5F7; font-size:1.1rem; margin-bottom:8px;">¿Qué hace este análisis automatizado?</h3>
        <p style="color:var(--text-secondary); font-size:0.95rem; line-height:1.5; margin-bottom:10px;">La plataforma analiza miles de registros con un algoritmo de Inteligencia Artificial para encontrar agrupaciones atípicas de temblores que el ojo humano no detecta fácilmente a simple vista.</p>
        <p style="color:var(--text-secondary); font-size:0.95rem; line-height:1.5; margin-bottom:10px;"><strong>¿Por qué es importante?</strong> Cuando varios sismos ocurren muy juntos en poco tiempo y en el mismo sector, forman un "enjambre sísmico". Esto suele indicar reacomodos de fallas activas o secuencias de réplicas tras un temblor principal.</p>

        <!-- INSTRUCCIONES DE USO Y RESTABLECIMIENTO -->
        <div style="background:rgba(255,149,0,0.12); border:1.5px solid #FF9500; border-radius:12px; padding:12px 14px; margin-top:14px;">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                <span style="font-size:1.1rem;">🔄</span>
                <strong style="color:#FFD60A; font-size:0.88rem;">Instrucciones de Uso y Restablecimiento:</strong>
            </div>
            <ul style="margin:6px 0 0 0; padding-left:18px; color:#FFF; font-size:0.82rem; line-height:1.45;">
                <li><strong>Uso:</strong> Activa el interruptor <em>Clusters DBSCAN (IA)</em> para calcular y colorear agrupaciones espacio-temporales densas.</li>
                <li><strong>Restablecer:</strong> Apaga el interruptor o presiona el botón <em>🔄 Restablecer Capas</em> en Capas Avanzadas para retirar la clasificación por enjambres.</li>
            </ul>
        </div>
    `,
    'sgc': `
        <h2 style="margin-top:0; color:#0A84FF; font-size:1.4rem; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:15px; margin-bottom:20px;">Conexión SGC Live (Monitoreo Telemétrico en Tiempo Real)</h2>
        <h3 style="color:#F5F5F7; font-size:1.1rem; margin-bottom:8px;">¿Qué muestra esta capa?</h3>
        <p style="color:var(--text-secondary); font-size:0.95rem; line-height:1.5; margin-bottom:10px;">Establece un enlace telemétrico directo con las redes sismológicas oficiales (Servicio Geológico Colombiano y feeds FDSN internacionales de USGS/EMSC) para capturar los eventos sísmicos ocurridos recientemente en el Chocó y el Pacífico colombiano.</p>
        <p style="color:var(--text-secondary); font-size:0.95rem; line-height:1.5; margin-bottom:10px;">Cada evento se representa mediante <strong>anillos concéntricos verde esmeralda con núcleo brillante</strong> que destacan sobre la cartografía base y se autoajustan a la escala visual de pantalla.</p>
        <div style="background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.3); border-radius: 8px; padding: 12px; margin-top: 12px; color: #a7f3d0; font-size: 0.85rem; line-height: 1.4;">
            <strong>Arquitectura de Red Resiliente:</strong> El sistema opera con sondeo continuo cada 45 segundos y canal WebSockets en vivo. Si el servidor local está desconectado, el navegador enlaza automáticamente con los servidores telemétricos FDSN satelitales en vivo con georreferenciación municipal calculada.
        </div>

        <!-- INSTRUCCIONES DE USO Y RESTABLECIMIENTO -->
        <div style="background:rgba(255,149,0,0.12); border:1.5px solid #FF9500; border-radius:12px; padding:12px 14px; margin-top:14px;">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                <span style="font-size:1.1rem;">🔄</span>
                <strong style="color:#FFD60A; font-size:0.88rem;">Instrucciones de Uso y Restablecimiento:</strong>
            </div>
            <ul style="margin:6px 0 0 0; padding-left:18px; color:#FFF; font-size:0.82rem; line-height:1.45;">
                <li><strong>Uso:</strong> Activa el interruptor <em>Conexión SGC Live</em>. El distintivo superior indicará <code>● EN VIVO (n)</code> mostrando el número de sismos detectados y sus anillos de sacudida.</li>
                <li><strong>Restablecer:</strong> Apaga el interruptor directamente o presiona el botón <em>🔄 Restablecer Capas</em> en Capas Avanzadas para desconectar el flujo telemétrico y retirar los marcadores del mapa.</li>
            </ul>
        </div>
    `,
    'oq': `
        <h2 style="margin-top: 0; color: #0A84FF; font-size: 1.4rem; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 15px; margin-bottom: 20px;">Evaluación Probabilística de Amenaza Sísmica</h2>
        <h3 style="color: #F5F5F7; font-size: 1.1rem; margin-bottom: 8px;">1. ¿Qué es la Aceleración del Suelo?</h3>
        <p style="color: var(--text-secondary); font-size: 0.95rem; line-height: 1.5; margin-bottom: 15px;">A diferencia de la magnitud (que mide la energía en el foco del sismo), la aceleración mide con qué fuerza y violencia se sacude el terreno bajo nuestros pies. Es el dato fundamental que usan los ingenieros para saber qué tan resistentes deben ser las columnas y vigas de una edificación.</p>
        <h3 style="color: #F5F5F7; font-size: 1.1rem; margin-bottom: 8px;">2. ¿Qué significa el período de 475 años?</h3>
        <p style="color: var(--text-secondary); font-size: 0.95rem; line-height: 1.5; margin-bottom: 15px;">Es el estándar de seguridad exigido por las normas de construcción. No significa que un terremoto ocurra exactamente cada 475 años, sino que los edificios deben diseñarse con la fuerza suficiente para soportar el sismo más severo que tiene probabilidad de presentarse durante los 50 años de vida útil de la edificación.</p>

        <!-- INSTRUCCIONES DE USO Y RESTABLECIMIENTO -->
        <div style="background:rgba(255,149,0,0.12); border:1.5px solid #FF9500; border-radius:12px; padding:12px 14px; margin-top:14px;">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                <span style="font-size:1.1rem;">🔄</span>
                <strong style="color:#FFD60A; font-size:0.88rem;">Instrucciones de Uso y Restablecimiento:</strong>
            </div>
            <ul style="margin:6px 0 0 0; padding-left:18px; color:#FFF; font-size:0.82rem; line-height:1.45;">
                <li><strong>Uso:</strong> Activa el interruptor <em>Amenaza SGC (PGA 475a)</em> para proyectar la malla continua de isolíneas y aceleración esperada en roca.</li>
                <li><strong>Restablecer:</strong> Apaga el interruptor o presiona el botón <em>🔄 Restablecer Capas</em> para ocultar la malla de amenaza sísmica.</li>
            </ul>
        </div>
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
        
        <!-- INSTRUCCIONES DE USO Y RESTABLECIMIENTO -->
        <div style="background:rgba(255,149,0,0.12); border:1.5px solid #FF9500; border-radius:12px; padding:12px 14px; margin-top:14px;">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                <span style="font-size:1.1rem;">🔄</span>
                <strong style="color:#FFD60A; font-size:0.88rem;">Instrucciones de Uso y Restablecimiento:</strong>
            </div>
            <ul style="margin:6px 0 0 0; padding-left:18px; color:#FFF; font-size:0.82rem; line-height:1.45;">
                <li><strong>Activar:</strong> Presiona el botón <em>📐 Activar Perfil Benioff</em>. La cámara 3D se colocará de perfil (vista Oeste → Este).</li>
                <li><strong>Ajustar:</strong> Modifica la exageración vertical (0.5x a 3.0x) o cambia de trinchera latitudinal (Murindó, Quibdó, San Juan).</li>
                <li><strong>Desactivar / Restablecer:</strong> Vuelve a presionar el botón <em>📐 Desactivar Perfil Benioff</em> o presiona el botón <em>🔄 Restablecer Visualización</em> para regresar a la vista cenital horizontal y retirar el corte.</li>
            </ul>
        </div>
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

        <!-- INSTRUCCIONES DE USO Y RESTABLECIMIENTO -->
        <div style="background:rgba(255,149,0,0.12); border:1.5px solid #FF9500; border-radius:12px; padding:12px 14px; margin-top:14px;">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                <span style="font-size:1.1rem;">🔄</span>
                <strong style="color:#FFD60A; font-size:0.88rem;">Instrucciones de Uso y Restablecimiento:</strong>
            </div>
            <ul style="margin:6px 0 0 0; padding-left:18px; color:#FFF; font-size:0.82rem; line-height:1.45;">
                <li><strong>Uso:</strong> Selecciona un municipio del departamento para consultar sus coeficientes sismorresistentes ($A_a$, $A_v$, $A_e$, $A_d$).</li>
                <li><strong>Restablecer:</strong> Para regresar a la selección por defecto (Quibdó), vuelve a seleccionarlo en el menú desplegable o presiona el botón general <em>⌂ Restablecer Todo</em>.</li>
            </ul>
        </div>
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

        <!-- INSTRUCCIONES DE USO Y RESTABLECIMIENTO -->
        <div style="background:rgba(255,149,0,0.12); border:1.5px solid #FF9500; border-radius:12px; padding:12px 14px; margin-top:14px;">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                <span style="font-size:1.1rem;">🔄</span>
                <strong style="color:#FFD60A; font-size:0.88rem;">Instrucciones de Uso y Restablecimiento:</strong>
            </div>
            <ul style="margin:6px 0 0 0; padding-left:18px; color:#FFF; font-size:0.82rem; line-height:1.45;">
                <li><strong>Uso:</strong> Cambia el tipo de perfil de suelo (Tipo A: Roca competente hasta Tipo E: Arcillas blandas/aluvión) para verificar su factor de amplificación sísmica.</li>
                <li><strong>Restablecer:</strong> Para regresar al suelo de referencia estándar (Suelo Tipo D), cámbialo en la lista desplegable o pulsa <em>⌂ Restablecer Todo</em>.</li>
            </ul>
        </div>
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

        <!-- INSTRUCCIONES DE USO Y RESTABLECIMIENTO -->
        <div style="background:rgba(255,149,0,0.12); border:1.5px solid #FF9500; border-radius:12px; padding:12px 14px; margin-top:14px;">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                <span style="font-size:1.1rem;">🔄</span>
                <strong style="color:#FFD60A; font-size:0.88rem;">Instrucciones de Uso y Restablecimiento:</strong>
            </div>
            <ul style="margin:6px 0 0 0; padding-left:18px; color:#FFF; font-size:0.82rem; line-height:1.45;">
                <li><strong>Uso:</strong> Selecciona el municipio objetivo y presiona <em>📄 Generar Ficha Municipal POT (PDF)</em> para compilar el reporte oficial de ordenamiento territorial.</li>
                <li><strong>Restablecer:</strong> Las descargas de reportes no alteran los parámetros visuales del mapa; para restablecer la selección municipal inicial, presiona <em>⌂ Restablecer Todo</em>.</li>
            </ul>
        </div>
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

        <!-- INSTRUCCIONES DE USO Y RESTABLECIMIENTO -->
        <div style="background:rgba(255,149,0,0.12); border:1.5px solid #FF9500; border-radius:12px; padding:12px 14px; margin-top:14px;">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                <span style="font-size:1.1rem;">🔄</span>
                <strong style="color:#FFD60A; font-size:0.88rem;">Instrucciones de Uso y Restablecimiento:</strong>
            </div>
            <ul style="margin:6px 0 0 0; padding-left:18px; color:#FFF; font-size:0.82rem; line-height:1.45;">
                <li><strong>Uso:</strong> Cambia el municipio, tipo de suelo o grupo de uso para recalcular el espectro elástico de diseño en tiempo real.</li>
                <li><strong>Restablecer:</strong> Para volver al espectro basal (Quibdó, Suelo D, Grupo I), puedes reajustar los selectores o utilizar el botón maestro <em>⌂ Restablecer Todo</em>.</li>
            </ul>
        </div>
    `,
    'shakemap_info': `
        <div style="display:flex; align-items:center; gap:12px; border-bottom:1px solid rgba(255,255,255,0.12); padding-bottom:14px; margin-bottom:18px;">
            <div style="width:38px; height:38px; border-radius:10px; background:linear-gradient(135deg, #ff453a, #b91c1c); display:flex; align-items:center; justify-content:center; font-size:1.25rem;">
                ⚡
            </div>
            <div>
                <h2 style="margin:0; color:#FFFFFF; font-size:1.3rem; font-weight:700;">Simulador ShakeMap: Ruptura Cosísmica</h2>
                <span style="font-size:0.75rem; color:#ff453a; font-weight:600; text-transform:uppercase;">Falla Finita Lobular &amp; Propagación Cinemática P/S</span>
            </div>
        </div>

        <h3 style="color:#F5F5F7; font-size:1.05rem; margin-top:0; margin-bottom:8px;">1. Integración de Estado del Arte: Cinemática y Falla Finita</h3>
        <p style="color:var(--text-secondary); font-size:0.92rem; line-height:1.6; margin-bottom:12px;">
            En sismos mayores ($M_w \ge 6.8$), la energía no se libera en un punto geométrico sino a lo largo de un <strong>plano de falla con longitud finita</strong>. Esta plataforma integra dos componentes complementarios:
        </p>
        <ul style="color:var(--text-secondary); font-size:0.86rem; line-height:1.5; margin-bottom:14px; padding-left:20px;">
            <li style="margin-bottom:6px;"><strong style="color:#ff453a;">Plano de Ruptura 3D y Huella Lobular ($R_{\text{jb}}$):</strong> Proyección superficial rectangular del plano de falla y curvas de nivel elípticas orientadas según el rumbo (<em>strike</em>) tectónico regional, modelando la concentración de daño longitudinal.</li>
            <li style="margin-bottom:6px;"><strong style="color:#38bdf8;">Frente Onda P (Compresional, $V_p \approx 6.0\text{ km/s}$):</strong> Anillo celeste rápido de primer arribo. Activa los sistemas de alerta temprana antes del impacto severo.</li>
            <li><strong style="color:#ffd60a;">Frente Onda S (Cizallante, $V_s \approx 3.5\text{ km/s}$):</strong> Anillo anaranjado/rojo de alta energía que transporta las máximas aceleraciones destructivas y causa el daño estructural.</li>
        </ul>

        <h3 style="color:#F5F5F7; font-size:1.05rem; margin-top:14px; margin-bottom:8px;">2. Escenarios Deterministas Disponibles:</h3>
        <ul style="color:var(--text-secondary); font-size:0.86rem; line-height:1.5; margin-bottom:14px; padding-left:20px;">
            <li style="margin-bottom:6px;"><strong style="color:#ff453a;">Falla Murindó (Mw 7.3):</strong> Réplica del evento de 1992 con traza de 65 km, aceleraciones $PGA \ge 0.68\text{ g}$ e intensidades $MMI\text{ VIII-IX}$.</li>
            <li style="margin-bottom:6px;"><strong style="color:#38bdf8;">Subducción Nazca (Mw 8.2):</strong> Megaterremoto de contacto interplaca de 140 km con afectación en toda la fosa pacífica.</li>
            <li style="margin-bottom:6px;"><strong style="color:#fbbf24;">Falla Atrato - Quibdó (Mw 6.8):</strong> Sismo cortical superficial directo con arribo de onda destructora a la capital en menos de 5 segundos.</li>
            <li><strong style="color:#32d74b;">Falla Bahía Solano (Mw 7.0):</strong> Ruptura costera en la Serranía de Baudó orientada N15W.</li>
        </ul>

        <!-- INSTRUCCIONES DE USO Y LIMPIEZA -->
        <div style="background:rgba(255,149,0,0.12); border:1.5px solid #FF9500; border-radius:12px; padding:12px 14px; margin-top:14px;">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                <span style="font-size:1.1rem;">🧹</span>
                <strong style="color:#FFD60A; font-size:0.88rem;">Instrucciones de Simulación y Limpieza:</strong>
            </div>
            <ul style="margin:6px 0 0 0; padding-left:18px; color:#FFF; font-size:0.82rem; line-height:1.45;">
                <li><strong>Simular:</strong> Elige un escenario y pulsa <em>⚡ Simular Ruptura Sísmica</em>. Las ondas $P$ y $S$ comenzarán su avance y el cronómetro medirá el tiempo de arribo a Quibdó e Istmina.</li>
                <li><strong>Pausar / Reiniciar Ondas:</strong> Usa los controles cinemáticos (<em>▶ Propagar Ondas</em> / <em>↺ Reiniciar</em>) para estudiar en detalle el frente de onda.</li>
                <li><strong>Limpiar Simulación:</strong> Presiona el botón <em>🧹 Limpiar</em> para retirar de inmediato las isoseistas, las ondas y el plano de ruptura.</li>
            </ul>
        </div>
    `,
    'profundidad': `
        <h2 style="margin-top:0; color:#c084fc; font-size:1.4rem; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:15px; margin-bottom:20px;">Filtro de Profundidad Hipocentral</h2>
        <p style="color:var(--text-secondary); font-size:0.95rem; line-height:1.6; margin-bottom:12px;">En la tectónica del Chocó, la profundidad focal es el factor discriminante entre sismos corticales de fallas activas y sismos de subducción en la losa oceánica:</p>
        <ul style="color:var(--text-secondary); font-size:0.9rem; line-height:1.5; margin-bottom:15px; padding-left:20px;">
            <li style="margin-bottom:8px;"><strong style="color:#ff9f0a;">0 a 30 km (Superficial):</strong> Ocurren en la corteza continental y fallas activas. Liberan energía cerca de las poblaciones y causan el mayor daño a la infraestructura.</li>
            <li style="margin-bottom:8px;"><strong style="color:#ff375f;">30 a 70 km (Intermedio):</strong> Interfase de subducción interplaca entre Nazca y el bloque Panamá-Chocó.</li>
            <li><strong style="color:#bf5af2;">&gt; 70 km (Profundo / Wadati-Benioff):</strong> Deformación intraplaca en el interior de la losa fría descendente bajo la cordillera.</li>
        </ul>

        <!-- INSTRUCCIONES DE USO Y RESTABLECIMIENTO -->
        <div style="background:rgba(255,149,0,0.12); border:1.5px solid #FF9500; border-radius:12px; padding:12px 14px; margin-top:14px;">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                <span style="font-size:1.1rem;">🔄</span>
                <strong style="color:#FFD60A; font-size:0.88rem;">Instrucciones de Uso y Restablecimiento:</strong>
            </div>
            <ul style="margin:6px 0 0 0; padding-left:18px; color:#FFF; font-size:0.82rem; line-height:1.45;">
                <li><strong>Uso:</strong> Ajusta el control deslizante para aislar sismos según su profundidad focal en kilómetros (de 0 a 150 km).</li>
                <li><strong>Restablecer:</strong> Presiona el botón <em>🔄 Restablecer Filtros</em> en la sección de Filtros Paramétricos para reincorporar todas las profundidades focales en la vista 3D.</li>
            </ul>
        </div>
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

        <!-- INSTRUCCIONES DE USO Y RESTABLECIMIENTO -->
        <div style="background:rgba(255,149,0,0.12); border:1.5px solid #FF9500; border-radius:12px; padding:12px 14px; margin-top:14px;">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                <span style="font-size:1.1rem;">🔄</span>
                <strong style="color:#FFD60A; font-size:0.88rem;">Instrucciones de Uso y Restablecimiento:</strong>
            </div>
            <ul style="margin:6px 0 0 0; padding-left:18px; color:#FFF; font-size:0.82rem; line-height:1.45;">
                <li><strong>Uso:</strong> Activa el interruptor <em>Visualizar Red de Infraestructura Crítica</em> para proyectar las capas vectoriales y la tabla de convenciones de soporte vital.</li>
                <li><strong>Restablecer:</strong> Apaga el interruptor o presiona el botón <em>🔄 Restablecer Capas</em> en Capas Avanzadas para retirar completamente las líneas viales, corredores fluviales, aeropuertos y hospitales del lienzo 3D.</li>
            </ul>
        </div>
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
        setTimeout(() => { infoModal.style.display = 'none'; }, 300);
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
        setTimeout(() => {
            if (infoModal && infoContent && modalData['guia']) {
                infoContent.innerHTML = modalData['guia'];
                infoModal.style.display = 'flex';
                requestAnimationFrame(() => {
                    infoModal.style.opacity = '1';
                });
            }
        }, 700);
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
    'palmar_74': {
        nombre: 'Sismo 10 de Agosto (San José del Palmar - Losa Benioff)',
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
            { mmi: 'VII - VIII', label: 'Fuerte Epicentral / Losa Benioff', pgaRange: '0.30 - 0.42 g', radioM: 28000, color: [255, 59, 48, 170], borde: [255, 255, 255, 240] },
            { mmi: 'VI', label: 'Sentido con Alarma en Chocó y Eje Cafetero', pgaRange: '0.15 - 0.30 g', radioM: 80000, color: [255, 140, 0, 125], borde: [255, 180, 0, 200] },
            { mmi: 'V', label: 'Ampliamente Sentido en Cuenca del San Juan', pgaRange: '0.06 - 0.15 g', radioM: 160000, color: [255, 214, 10, 80], borde: [255, 230, 80, 170] },
            { mmi: 'IV', label: 'Perceptible en Valle del Cauca y Antioquia', pgaRange: '0.02 - 0.06 g', radioM: 280000, color: [56, 189, 248, 55], borde: [56, 189, 248, 160] },
            { mmi: 'II - III', label: 'Débil / Sentido en Pisos Altos (Costa Caribe, Sucre, Córdoba, Bogotá)', pgaRange: '< 0.02 g', radioM: 580000, color: [30, 64, 175, 30], borde: [96, 165, 250, 120] }
        ]
    },
    'murindo_73': {
        nombre: 'Falla Murindó (Sismo Histórico 1992)',
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

// Coordenadas geográficas de referencia de centros urbanos de Chocó
const COORDS_QUIBDO = [-76.658, 5.692];
const COORDS_ISTMINA = [-76.683, 5.161];

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
        shakemapTimerLabel.innerText = `t = ${waveAnimTimeSec.toFixed(1)} s`;
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
    renderLayers();

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
    renderLayers();
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

function deactivateShakemap() {
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

    renderLayers();
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
            font-family: 'Inter', sans-serif;
            font-size: 0.82rem;
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
        <span style="display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; border-radius:6px; background:#0284c7; color:#fff; font-weight:700; font-family:monospace; font-size:0.85rem; border:1px solid #38bdf8;">${keyChar}</span>
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

// Escuchador global de interacción con puntero/ratón para telemetría
window.addEventListener('click', (e) => {
    const target = e.target;
    const tag = (target && target.tagName) ? target.tagName : '';
    const id = target ? (target.id || target.className || tag) : '';
    interactionTelemetry.record('pointer', 'click', { targetId: id, tagName: tag });
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
        // Ignorar si el usuario está interactuando con campos de formulario editables
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
            case '1': {
                e.preventDefault();
                interactionTelemetry.record('keyboard', 'Perfil: Sismo-Geología', { key: '1' });
                const tab1 = document.querySelector('.profile-tab[data-profile="sismologia"]');
                if (tab1) {
                    tab1.click();
                    showShortcutToast('1', 'Perfil: Sismo-Geología', '🌋');
                }
                break;
            }
            case '2': {
                e.preventDefault();
                interactionTelemetry.record('keyboard', 'Perfil: Diseño Estructural', { key: '2' });
                const tab2 = document.querySelector('.profile-tab[data-profile="nsr10"]');
                if (tab2) {
                    tab2.click();
                    showShortcutToast('2', 'Perfil: Diseño Estructural', '🏗️');
                }
                break;
            }
            case '3': {
                e.preventDefault();
                interactionTelemetry.record('keyboard', 'Perfil: Gestión Territorial', { key: '3' });
                const tab3 = document.querySelector('.profile-tab[data-profile="alcaldia"]');
                if (tab3) {
                    tab3.click();
                    showShortcutToast('3', 'Perfil: Gestión Territorial', '🏛️');
                }
                break;
            }
            case '4': {
                e.preventDefault();
                interactionTelemetry.record('keyboard', 'Visualización: Eventos 3D', { key: '4' });
                const btnPuntos = document.getElementById('btn-puntos');
                if (btnPuntos) {
                    btnPuntos.click();
                    showShortcutToast('4', 'Visualización: Eventos 3D', '⚪');
                }
                break;
            }
            case '5': {
                e.preventDefault();
                interactionTelemetry.record('keyboard', 'Visualización: Mapa de Calor', { key: '5' });
                const btnCalor = document.getElementById('btn-calor');
                if (btnCalor) {
                    btnCalor.click();
                    showShortcutToast('5', 'Visualización: Mapa de Calor', '🔥');
                }
                break;
            }
            case '6': {
                e.preventDefault();
                interactionTelemetry.record('keyboard', 'Visualización: Hexbins 3D', { key: '6' });
                const btnHex = document.getElementById('btn-hex');
                if (btnHex) {
                    btnHex.click();
                    showShortcutToast('6', 'Visualización: Hexbins 3D', '🔷');
                }
                break;
            }
            case '7': {
                e.preventDefault();
                interactionTelemetry.record('keyboard', 'Corte Benioff 3D', { key: '7' });
                const btnBenioff = document.getElementById('btn-benioff');
                if (btnBenioff) {
                    btnBenioff.click();
                    const estado = isBenioffMode ? 'Activado' : 'Desactivado';
                    showShortcutToast('7', `Corte Benioff 3D: ${estado}`, '📐');
                }
                break;
            }
            case '8': {
                e.preventDefault();
                interactionTelemetry.record('keyboard', 'SGC Live', { key: '8' });
                const checkLive = document.getElementById('check-live-sgc');
                if (checkLive) {
                    checkLive.checked = !checkLive.checked;
                    checkLive.dispatchEvent(new Event('change', { bubbles: true }));
                    const estado = checkLive.checked ? 'Conectado (En Vivo)' : 'Desconectado';
                    showShortcutToast('8', `SGC Live: ${estado}`, '📡');
                }
                break;
            }
            case '9': {
                e.preventDefault();
                interactionTelemetry.record('keyboard', 'Fallas Geológicas', { key: '9' });
                const checkFallas = document.getElementById('check-fallas');
                if (checkFallas) {
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
                    btnHome.click();
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
            // PANEL HUD OCULTO DE TELEMETRÍA UX (TECLA ESPACIO)
            // ================================================================
            case ' ':
            case 'Spacebar': {
                e.preventDefault();
                toggleUxTelemetryHud();
                interactionTelemetry.record('keyboard', 'Conmutar HUD Telemetría UX', { key: 'Space' });
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
loadData();


