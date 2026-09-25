# SismoChocó: Plataforma de Visualización Analítica de Tensión Sísmica

[![Python](https://img.shields.io/badge/Python-3.11-3776AB?logo=python&logoColor=white)](https://python.org)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.111.0-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com)
[![Deck.gl](https://img.shields.io/badge/Deck.gl-8.9-000000?logo=uber&logoColor=white)](https://deck.gl)
[![MapLibre GL](https://img.shields.io/badge/MapLibre_GL-3.6-2E7D32?logo=maplibre&logoColor=white)](https://maplibre.org)
[![PWA](https://img.shields.io/badge/PWA-Ready-5A0FC8?logo=pwa&logoColor=white)](https://web.dev/progressive-web-apps/)
[![Despliegue en Render](https://img.shields.io/badge/Deploy-Render-46E3B7?logo=render&logoColor=white)](https://sismochoco.onrender.com/)

Plataforma interactiva orientada a la visualización analítica de la sismicidad histórica, la deformación cortical y la acumulación de tensión sismotectónica en el departamento del **Chocó, Colombia** (1993–2026).

Desarrollada en el marco de la investigación de maestría en **Diseño y Creación Interactiva** de la **Universidad de Caldas**, bajo el enfoque metodológico **Research through Design (RtD)** y la línea de *Gestión y Transmisión del Conocimiento / Presentación de Información Compleja*.

🌐 **Enlace en producción:** [https://sismochoco.onrender.com/](https://sismochoco.onrender.com/)

---

## 📌 Propósito del Proyecto

El Chocó se sitúa en una de las zonas de mayor complejidad geodinámica de América Latina, donde confluyen la subducción de la Placa de Nazca bajo el Bloque Norandino, la interacción con la Placa del Caribe y el sistema de fallas de rumbo del Istmo de Panamá. 

A pesar de esta exposición, los registros sismológicos suelen quedar restringidos a tablas técnicas o repositorios poco accesibles para la toma de decisiones territoriales. **SismoChocó** articula el diseño de interacción, la visualización científica de datos y la cartografía georreferenciada para:

1. Facilitar la comprensión espacial y en profundidad (3D) de la sismicidad intraplaca y de subducción.
2. Traducir parámetros sismológicos complejos (Ley de Gutenberg-Richter, valor $b$, densidad DBSCAN, cortes de Benioff) en representaciones visuales intuitivas.
3. Vincular los datos sismotectónicos con la gestión del riesgo local, la norma sismorresistente **NSR-10** y las directrices de los Planes de Ordenamiento Territorial (**POT / PBOT / EOT**).

---

## 🚀 Características Principales

### 1. Visualización Cartográfica 3D y Espacio-Temporal
- **Motor Deck.gl + MapLibre GL**: Renderizado de alto rendimiento para miles de eventos sísmicos con aceleración por hardware WebGL.
- **Topografía y Estilos de Mapa Base**: Modos de visualización pensados en el usuario: *Relieve Topográfico* (análisis fisiográfico) y *Modo Oscuro* (máximo contraste para clusters de sismos).
- **Corte Transversal 3D (Zona de Benioff)**: Proyección tridimensional interactiva que grafica la geometría de subducción de la Placa de Nazca entre 0 y 140 km de profundidad.
- **Filtros Temporales y de Magnitud**: Línea de tiempo interactiva (1993–2026), filtrado por rango de profundidad focal y magnitud ($M_w / M_L$).

### 2. Módulos Multidisciplinares Bento Box
Diseño de interfaz bento dividido en tres perspectivas especializadas:
- 🌋 **Geología & Sismología**: Ajuste dinámico de la **Ley de Gutenberg-Richter** ($\log_{10} N = a - bM$), estimación del valor $b$ en tiempo real y cálculo de períodos de retorno mediante procesos de Poisson ($M \ge 5.0, 6.0, 7.0$).
- 🏗️ **Ingeniería Civil & NSR-10**: Espectros de aceleración elástica ($S_a$ vs. $T$), categorización de aceleración pico efectiva ($A_a, A_v$) y coeficientes de sitio según el tipo de suelo (A a E) de los 30 municipios del departamento.
- 🏛️ **Alcaldía & POT**: Fichas técnicas municipales autogeneradas con diagnóstico sísmico local, alertas de amenaza y función de exportación e impresión directa en formato PDF para los comités de gestión del riesgo.

### 3. Integración en Vivo y Modo Offline (PWA)
- **Sincronización en Tiempo Real**: Conexión con catálogo sísmico georreferenciado (USGS, EMSC y SGC) sincronizado y normalizado a hora legal colombiana (UTC-5 / `America/Bogota`).
- **Progressive Web App**: Instalable en dispositivos de escritorio y móviles con caché local (`sw.js`) para visualización de catálogo e infraestructura crítica aún sin conexión a internet.
- **Diseño Centrado en el Usuario**: Detección adaptativa de dispositivos; sugerencia inteligente de uso en computador (PC) o pantalla horizontal en tablets para optimizar la inspección de gráficos 3D y paneles analíticos.

---

## 🏗️ Arquitectura de Software

El sistema combina un frontend estructurado con patrones de diseño de software y un backend analítico basado en microservicios:

```
app/
├── index.html                           # Interfaz Bento UI, metadatos SEO/OpenGraph y Schema.org
├── css/
│   └── styles.css                       # Diseño responsivo, variables CSS, animaciones y glassmorphism
├── js/
│   ├── core-oop.js                      # Arquitectura Orientada a Objetos (Singleton, Strategy, Factory, Observer)
│   └── main.js                          # Orquestación de mapa 3D (Deck.gl/MapLibre), charts y eventos
├── data/
│   ├── fallas.geojson                   # Trazas de fallas geológicas activas (SGC)
│   ├── municipios_choco_nsr10.json      # Parámetros sísmicos municipales NSR-10 (Aa, Av, Zona)
│   ├── oq_resultados.geojson            # Modelado de amenaza OpenQuake
│   └── vias_infraestructura.geojson     # Red de infraestructura vial y conectividad departamental
├── main.py                              # Backend FastAPI (APIs REST, CORS, Cabeceras OWASP, Healthcheck)
├── sync_catalogo.py                     # Script de ingesta y deduplicación sísmica automática
├── Dockerfile                           # Contenedor de producción con Python 3.11-slim
├── sw.js                                # Service Worker con estrategia de caché offline
├── manifest.json                        # Manifiesto PWA para instalación de escritorio/móvil
└── requirements.txt                     # Dependencias Python (FastAPI, Uvicorn, Scikit-learn, etc.)
```

### Patrones de Software Implementados (`core-oop.js`):
- **Singleton**: Controladores únicos de estado (`AppState`, `EventManager`).
- **Strategy**: Estrategias intercambiables de cálculo estadístico (Gutenberg-Richter lineal, estimador de máxima verosimilitud de Aki-Utsu).
- **Factory**: Creación dinámica de capas Deck.gl (ScatterplotLayer, LineLayer, HexagonLayer).
- **Observer / Pub-Sub**: Desacoplamiento entre filtros de UI, actualización del catálogo sísmico y redibujado de la leyenda cartográfica.

---

## 🛠️ Instalación y Ejecución Local

### Prerrequisitos
- Python 3.10+ instalado.
- Git.

### 1. Clonar el repositorio
```bash
git clone https://github.com/yonathangalvez3657/SismoChoco.git
cd SismoChoco
```

### 2. Configurar entorno virtual e instalar dependencias
```bash
python3 -m venv venv
source venv/bin/activate    # En Windows: venv\Scripts\activate
pip install -r requirements.txt
```

### 3. Configurar variables de entorno (Opcional)
Copia la plantilla de ejemplo y ajusta las variables según sea necesario:
```bash
cp .env.example .env
```

### 4. Iniciar servidor de desarrollo
```bash
uvicorn main:app --reload --port 8000
```
Abre tu navegador en: [http://localhost:8000](http://localhost:8000)

---

## 🐳 Despliegue con Docker

Para construir y levantar el contenedor de producción localmente:

```bash
docker build -t sismochoco:latest .
docker run -d -p 8000:8000 --name sismochoco-app sismochoco:latest
```

Verificación del estado de salud:
```bash
curl http://localhost:8000/api/health
```

---

## 🔬 Metadatos y Datos Abiertos

- **Catálogo Sísmico**: Recopilado y procesado a partir de fuentes públicas oficiales: Servicio Geológico Colombiano (SGC), United States Geological Survey (USGS) y European-Mediterranean Seismological Centre (EMSC).
- **Infraestructura y Fallas**: Datos cartográficos abiertos del Instituto Geográfico Agustín Codazzi (IGAC) y el SGC.
- **Formato**: GeoJSON estructurado compatible con QGIS, ArcGIS y Mapbox.

---

## 👤 Autor e Información de Contacto

**Yonathan Andrés Gálvez Giraldo**  
Ingeniero Informático  
Magister en diseño y creación interactiva  
Universidad de Caldas, Manizales, Colombia.  
- 💼 LinkedIn: [yonathanandresgalvezgiraldo](https://www.linkedin.com/in/yonathanandresgalvezgiraldo/)  
- ✉️ Correo electrónico: [ogiraldo272@gmail.com](mailto:ogiraldo272@gmail.com)  

---

## 📄 Licencia

Este proyecto se distribuye bajo la licencia **MIT** para el código fuente y **Creative Commons Atribución 4.0 Internacional (CC BY 4.0)** para los datos derivados y documentación técnica.
