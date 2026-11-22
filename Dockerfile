FROM ghcr.io/home-assistant/base:latest

RUN apk add --no-cache python3 tzdata

ENV TZ=Europe/Amsterdam
COPY app /app
WORKDIR /app

LABEL \
    org.opencontainers.image.title="Enphase energie-app" \
    org.opencontainers.image.description="Snelle app voor Enphase-zonnepanelen en -batterij met Vattenfall-prijzen" \
    org.opencontainers.image.source="https://github.com/veermanp0706/Veerman-enphase"

CMD ["python3", "-u", "/app/main.py"]
