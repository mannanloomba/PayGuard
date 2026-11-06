FROM node:22-slim AS frontend-build

WORKDIR /app

COPY package.json package-lock.json index.html postcss.config.js tailwind.config.js tsconfig*.json vite.config.ts ./
COPY src ./src

RUN npm ci
RUN npm run build

FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PAYGUARD_DATABASE_PATH=/tmp/payguard-demo.sqlite3 \
    DEMO_MODE=false

RUN apt-get update \
    && apt-get install -y --no-install-recommends tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY backend backend
COPY --from=frontend-build /app/dist dist

EXPOSE 10000

CMD ["sh", "-c", "uvicorn main:app --app-dir backend --host 0.0.0.0 --port ${PORT:-10000}"]
