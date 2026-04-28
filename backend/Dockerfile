# Single-service container for the FastAPI backend.
# Built by Railway via the railway.json builder=DOCKERFILE setting.
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Install system deps the avantis-trader-sdk pulls in (web3, eth-account
# transitively need build tooling on slim images).
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential gcc \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . .

# Railway provides $PORT at runtime; default to 8000 for local docker run.
ENV PORT=8000
EXPOSE 8000

# Exec form with sh -c so $PORT actually expands at runtime — without
# the shell wrapper, Docker (or Railway's startCommand) passes "$PORT"
# as a literal string and uvicorn errors with "not a valid integer".
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT}"]
