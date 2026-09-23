# ==============================================================================
# SismoChocó — Contenedor Docker para Despliegue en Producción
# ==============================================================================
FROM python:3.11-slim

# Evitar prompts interactivos y optimizar buffer de python
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    TZ=America/Bogota \
    PORT=8000

# Directorio de trabajo en el contenedor
WORKDIR /app

# Instalar dependencias del sistema mínimas requeridas
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copiar manifiesto de dependencias e instalarlas
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# Copiar el código fuente y artefactos web
COPY . .

# Exponer el puerto de servicio
EXPOSE 8000

# Healthcheck interno del contenedor
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:${PORT}/api/health || exit 1

# Ejecutar el servidor con Uvicorn de forma optimizada
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT}"]
