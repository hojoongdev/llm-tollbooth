FROM python:3.12-slim

WORKDIR /app

# Install deps first so this layer is cached across code changes.
COPY pyproject.toml ./
COPY loadgen ./loadgen
RUN pip install --no-cache-dir .

# Talk to the broker over the in-cluster listener by default.
ENV KAFKA_BOOTSTRAP=kafka:29092

ENTRYPOINT ["python", "-m", "loadgen"]
CMD ["--rps", "20", "--duration", "10"]
