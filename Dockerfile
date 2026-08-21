FROM mcr.microsoft.com/playwright:v1.55.0-noble

WORKDIR /app

COPY package.json ./
COPY package-lock.json* ./

RUN npm install

COPY index.js ./
COPY src ./src
COPY data ./data

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV DATABASE_PATH=/app/data/v2.sqlite

CMD ["node", "index.js"]
