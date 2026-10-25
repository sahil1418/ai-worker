# Hosted demo image (Render free tier via render.yaml, or any Docker host).
# Playwright's image ships Chromium plus its system libraries; its version must match package-lock.json.
FROM mcr.microsoft.com/playwright:v1.64.1-noble

WORKDIR /app
COPY package.json package-lock.json ./
# Browsers are already in the image, so skip the postinstall download.
RUN npm ci --ignore-scripts
COPY . .

# Run unprivileged; runs/ and workspace/output/ must be writable.
RUN mkdir -p runs workspace/output && chown -R 1000:1000 /app
USER 1000

# One public port (UI + read-only company apps); the mock company's API stays internal on 4000.
# PORT is replaced by hosts that inject their own (Render sets 10000).
# Secret to set on the host: LLM_API_KEY (optionally DEMO_PASSWORD to gate runs).
ENV PORT=7860 \
    PUBLIC_DEMO=true \
    MOCKCO_PORT=4000 \
    LOW_MEMORY=true \
    HEADLESS=true \
    APPROVAL_MODE=risky \
    MAX_CONCURRENT_RUNS=1
EXPOSE 7860
CMD ["node_modules/.bin/tsx", "src/server/index.ts"]
