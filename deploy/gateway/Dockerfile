FROM python:3.13.13-slim-bookworm
WORKDIR /gateway
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && useradd --create-home --uid 1001 gateway
COPY config.yaml .
USER gateway
ENV LITELLM_LOCAL_MODEL_COST_MAP=True \
    DO_NOT_TRACK=True \
    LITELLM_TELEMETRY=False
CMD ["litellm", "--config", "/gateway/config.yaml", "--host", "127.0.0.1", "--port", "4000"]
