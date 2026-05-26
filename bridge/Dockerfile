FROM swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/node:22-slim-linuxarm64

# Use China mirrors for faster builds
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources

# Install git (needed for marketplace git clone), psmisc (fuser, needed by --force), Python,
# build-essential (needed for native module compilation), and Docker CLI (needed for agent sandbox containers via mounted docker.sock)
RUN apt-get update && apt-get install -y git psmisc python3 build-essential curl gnupg && \
    install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://mirrors.aliyun.com/docker-ce/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://mirrors.aliyun.com/docker-ce/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list && \
    apt-get update && apt-get install -y docker-ce-cli && \
    rm -rf /var/lib/apt/lists/*

# ============ 新增：配置 git 使用 HTTPS 代替 SSH（解决 GitHub 权限问题）============
RUN git config --global url."https://github.com/".insteadOf ssh://git@github.com/ && \
    git config --global url."https://github.com/".insteadOf git@github.com:

# Install openclaw globally (default 2026.3.8, override via build-arg)
ARG OPENCLAW_VERSION=2026.3.8
RUN npm config set registry https://registry.npmmirror.com && \
    npm install -g openclaw@${OPENCLAW_VERSION}

# Install bridge dependencies
WORKDIR /app
COPY package.json ./
RUN npm install --registry https://registry.npmmirror.com

# Build bridge TypeScript
COPY tsconfig.json ./
COPY *.ts ./
COPY routes/ ./routes/
RUN npx tsc --version && npx tsc

# Copy platform built-in skills
COPY skills/ ./skills/

# Copy local plugins (if exists)
COPY plugins/ ./plugins/

# Remove dev dependencies after build
RUN npm prune --omit=dev

# Entry point
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 18080 18789

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "dist/start.js"]
