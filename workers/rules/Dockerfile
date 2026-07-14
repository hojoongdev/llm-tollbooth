FROM python:3.12-slim

WORKDIR /app

COPY pyproject.toml ./
COPY main.py ./
RUN pip install --no-cache-dir .

ENV KAFKA_BOOTSTRAP=kafka:29092

CMD ["python", "main.py"]
