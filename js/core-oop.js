/**
 * ============================================================================
 * SismoChocó — Arquitectura Orientada a Objetos (OOP) y Patrones de Diseño
 * Maestría en Diseño y Creación Interactiva — Universidad de Caldas
 * ============================================================================
 * Patrones implementados:
 * 1. Singleton: StateManager (Fuente única de verdad reactiva).
 * 2. Strategy Pattern: SeismicHazardEngine & AttenuationModels (Cálculos matemáticos).
 * 3. Factory Pattern: MapLayerFactory (Construcción desacoplada de capas Deck.gl).
 * 4. Observer Pattern: EventBus (Desacoplamiento de eventos de UI y sincronización).
 */

// ============================================================================
// 1. PATRÓN OBSERVER: Bus de Eventos Desacoplado
// ============================================================================
class EventBus {
    constructor() {
        this.listeners = new Map();
    }

    on(event, callback) {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, []);
        }
        this.listeners.get(event).push(callback);
        return () => this.off(event, callback);
    }

    off(event, callback) {
        if (!this.listeners.has(event)) return;
        const filtered = this.listeners.get(event).filter(cb => cb !== callback);
        this.listeners.set(event, filtered);
    }

    emit(event, data) {
        if (!this.listeners.has(event)) return;
        this.listeners.get(event).forEach(callback => {
            try {
                callback(data);
            } catch (err) {
                console.error(`[EventBus] Error ejecutando callback para "${event}":`, err);
            }
        });
    }
}

// ============================================================================
// 2. PATRÓN SINGLETON: Gestor de Estado Centralizado (StateManager)
// ============================================================================
class AppStateManager {
    constructor() {
        if (AppStateManager._instance) {
            return AppStateManager._instance;
        }

        this.eventBus = new EventBus();
        this.state = {
            viewMode: 'none',
            currentProfile: 'sismologia',
            currentMag: 0.0,
            currentTime: 1993,
            currentMaxDepth: 150.0,
            highQualityOnly: false,
            showFaults: false,
            showInfra: false,
            selectedFaultId: null,
            faultKinematicFilter: 'all',
            showFaultBuffer: false,
            isBenioffMode: false,
            benioffExaggeration: 1.5,
            benioffSector: 'all',
            isSimulatorActive: false,
            activeShakemapScenario: 'murindo_73',
            selectedNsrMunicipio: null,
            selectedPotMunicipio: null,
            totalEventos: 0,
            eventosFiltrados: 0
        };

        AppStateManager._instance = this;
    }

    static getInstance() {
        if (!AppStateManager._instance) {
            AppStateManager._instance = new AppStateManager();
        }
        return AppStateManager._instance;
    }

    get(key) {
        return this.state[key];
    }

    getAll() {
        return { ...this.state };
    }

    set(key, value) {
        const prev = this.state[key];
        if (prev !== value) {
            this.state[key] = value;
            this.eventBus.emit(`change:${key}`, { key, value, prev });
            this.eventBus.emit('state:change', { key, value, prev, state: this.getAll() });
        }
    }

    update(partialState) {
        Object.keys(partialState).forEach(key => {
            this.set(key, partialState[key]);
        });
    }

    subscribe(key, callback) {
        return this.eventBus.on(`change:${key}`, callback);
    }

    subscribeAll(callback) {
        return this.eventBus.on('state:change', callback);
    }
}

// ============================================================================
// 3. PATRÓN STRATEGY: Modelo Matemático de Atenuación y Amenaza (GMPE)
// ============================================================================
class AttenuationStrategy {
    calculateIntensity(distanceKm, magnitudeMw, depthKm) {
        throw new Error("El método calculateIntensity debe ser implementado por la estrategia concreta.");
    }
}

class CampbellBozorgniaGMPE extends AttenuationStrategy {
    /**
     * Modelo simplificado GMPE Campbell-Bozorgnia para aceleración espectral Sa y MMI
     */
    calculateIntensity(distanceKm, magnitudeMw, depthKm = 15) {
        const hypoDist = Math.sqrt(distanceKm * distanceKm + depthKm * depthKm);
        // Aproximación logarítmica de decaimiento geométrico y anelástico
        const lnPga = -0.15 + 0.52 * magnitudeMw - 1.15 * Math.log(hypoDist + 5);
        const pgaG = Math.max(0.01, Math.min(1.5, Math.exp(lnPga)));

        let mmi = 'IV';
        if (pgaG >= 0.50) mmi = 'VIII - IX';
        else if (pgaG >= 0.25) mmi = 'VII';
        else if (pgaG >= 0.10) mmi = 'V - VI';

        return { pgaG: parseFloat(pgaG.toFixed(3)), mmi };
    }
}

class GutenbergRichterCalculator {
    /**
     * Calcula la pendiente de recurrencia sísmica (b-value) por mínimos cuadrados
     */
    static computeBValue(labels, dataLog, completenessMag = 3.0) {
        const validPts = [];
        for (let i = 0; i < labels.length; i++) {
            if (labels[i] >= completenessMag && dataLog[i] > 0) {
                validPts.push({ x: labels[i], y: dataLog[i] });
            }
        }
        if (validPts.length < 3) return null;

        const n = validPts.length;
        let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
        validPts.forEach(p => {
            sumX += p.x;
            sumY += p.y;
            sumXY += p.x * p.y;
            sumX2 += p.x * p.x;
        });

        const denom = (n * sumX2 - sumX * sumX);
        if (denom === 0) return null;

        const slope = (n * sumXY - sumX * sumY) / denom;
        return Math.abs(slope);
    }
}

// ============================================================================
// 4. PATRÓN FACTORY: Fábrica Desacoplada de Capas Deck.gl (MapLayerFactory)
// ============================================================================
class MapLayerFactory {
    static createScatterplotLayer({ id, data, getPosition, getRadius, getFillColor, getLineColor, lineWidth = 1, pickable = true, updateTriggers = {}, onHover = null }) {
        return new deck.ScatterplotLayer({
            id,
            data,
            getPosition,
            getRadius,
            getFillColor,
            getLineColor,
            stroked: !!getLineColor,
            lineWidthMinPixels: lineWidth,
            pickable,
            updateTriggers,
            onHover
        });
    }

    static createPathLayer({ id, data, getPath, getColor, getWidth, widthUnits = 'pixels', pickable = true, onHover = null }) {
        return new deck.PathLayer({
            id,
            data,
            getPath,
            getColor,
            getWidth,
            widthUnits,
            pickable,
            autoHighlight: true,
            highlightColor: [255, 255, 255, 240],
            onHover
        });
    }
}

// Exportación global para integración modular
window.SismoChocoOOP = {
    EventBus,
    AppStateManager,
    AttenuationStrategy,
    CampbellBozorgniaGMPE,
    GutenbergRichterCalculator,
    MapLayerFactory
};
