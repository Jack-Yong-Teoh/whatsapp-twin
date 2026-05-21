FROM python:3.11-slim
WORKDIR /app
RUN mkdir -p /app/config
COPY pyproject.toml .
RUN pip install --no-cache-dir fastapi httpx uvicorn
COPY main.py .
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]