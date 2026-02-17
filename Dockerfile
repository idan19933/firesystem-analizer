# Fire Safety Checker - Railway Dockerfile v2
# Node.js + Python for DXF rendering with ezdxf
# Fixed Hebrew text encoding issues

FROM node:20-slim

# Install Python and system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-dev \
    # Fonts for Hebrew text rendering (comprehensive)
    fonts-noto \
    fonts-noto-core \
    fonts-noto-extra \
    fonts-dejavu \
    fonts-dejavu-core \
    fonts-dejavu-extra \
    fonts-freefont-ttf \
    fontconfig \
    # Chromium dependencies for Puppeteer
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgdk-pixbuf2.0-0 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    xvfb \
    wget \
    gnupg \
    chromium \
    && rm -rf /var/lib/apt/lists/*

# Install Python packages for DXF rendering
RUN pip3 install --no-cache-dir --break-system-packages \
    ezdxf \
    matplotlib \
    Pillow \
    numpy

# Update font cache for matplotlib
RUN fc-cache -fv

# Configure matplotlib to use a font that supports Hebrew
RUN mkdir -p /root/.config/matplotlib && \
    echo "font.family: DejaVu Sans" > /root/.config/matplotlib/matplotlibrc && \
    echo "font.sans-serif: DejaVu Sans, Noto Sans, FreeSans, sans-serif" >> /root/.config/matplotlib/matplotlibrc

# Clear matplotlib font cache to pick up new fonts
RUN python3 -c "import matplotlib; matplotlib.font_manager._rebuild()" || true

# Set Puppeteer to use system Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Set Python path
ENV PYTHONUNBUFFERED=1

# Create app directory
WORKDIR /app

# Copy package files and install Node dependencies
COPY package*.json ./
RUN npm install --production

# Copy application code
COPY . .

# Create directories for temp files
RUN mkdir -p /tmp/uploads /tmp/screenshots /app/public/screenshots

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD node -e "require('http').get('http://localhost:8080/api/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# Start server
CMD ["node", "server.js"]
