# Desk ATS for the hiring demo: the fake staffing CRM the bots work in (UI, API, and the MCP server they call), plus the
# Recruiting Desk template and the script that builds it inside OpenMausBot. It runs in the OpenMausBot container's
# network namespace (compose.yaml), so both sides reach each other on 127.0.0.1 and the ATS is never public.
FROM node:24-slim
WORKDIR /app
COPY ats/package.json ats/package-lock.json ats/
RUN cd ats && npm ci --omit=dev && npm cache clean --force
COPY ats/src ats/src
COPY ats/public ats/public
COPY ats/data/seed.json ats/data/seed.json
COPY ats/config.example.json ats/
COPY template template
ENV NODE_ENV=production
CMD ["node", "ats/src/server.ts"]
