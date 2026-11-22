ARG BUILD_FROM
FROM $BUILD_FROM

RUN apk add --no-cache python3 tzdata

ENV TZ=Europe/Amsterdam
COPY app /app
WORKDIR /app

CMD ["python3", "-u", "/app/main.py"]
