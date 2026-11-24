FROM ghcr.io/home-assistant/base:latest

RUN apk add --no-cache python3 tzdata

ENV TZ=Europe/Amsterdam
COPY app /app
WORKDIR /app

LABEL \
    org.opencontainers.image.title="Veerman Home" \
    org.opencontainers.image.description="Eén app voor je huis: energie, klimaat, licht en zonwering" \
    org.opencontainers.image.source="https://github.com/veermanp0706/Veerman-home"

CMD ["python3", "-u", "/app/main.py"]
