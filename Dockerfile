# Combined runtime: Node.js runs your existing app; Python/Pandas
# handles the Net Profit Margin calculation as a subprocess.
FROM node:20-slim

# Install Python and pip
RUN apt-get update && \
    apt-get install -y python3 python3-pip python3-venv --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies in a virtual environment (Debian 12+ requires
# this rather than a bare "pip install" system-wide)
COPY requirements.txt ./
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
RUN pip install --no-cache-dir -r requirements.txt

# Install Node dependencies
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy the rest of the app (server.js, public/, calculate_margin.py, schema.sql, etc.)
COPY . .

# Render sets $PORT at runtime; your server.js should already listen on
# process.env.PORT as it does today.
EXPOSE 10000

CMD ["node", "server.js"]
