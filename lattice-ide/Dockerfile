# Lattice worker image (CPU base; dry run unless an engine is installed and LATTICE_EXEC=1).
#
#   docker build -t lattice-worker:1.0.0 lattice-ide/
#   docker run --rm -p 127.0.0.1:8787:8787 -v lattice-runs:/data \
#       -e LATTICE_TOKEN=... -e LATTICE_REGION=US lattice-worker:1.0.0
#
# This image contains NO model weights and never downloads any at build time.
# Engines and weights are the operator's responsibility: install the engine packages you
# licensed in a derived image, accept each license with your own Hugging Face account, and
# let jobs fetch weights at run time with the per-job X-HF-Token.
#
# Environment (all optional; see deploy/worker.env.example):
#   LATTICE_DRY_RUN  deliberately left UNSET here. Without LATTICE_EXEC=1 every job is a dry
#                    run anyway, so this image is safe to start as-is. Set LATTICE_DRY_RUN=1 to
#                    force dry runs even after engines are installed.
#   LATTICE_EXEC=1   allow real engine subprocesses (needs an engine installed in the image).
#   LATTICE_TOKEN, LATTICE_USERS, LATTICE_REGION, LATTICE_GPU_USD_HR, LATTICE_*_CMD, LATTICE_*_MODULE.
#   Host, port and runs dir are fixed by CMD flags below (flags win over LATTICE_HOST/PORT/RUNS).
#
# GPU variant (documentation only; not built in CI): to run real engines, start from a CUDA
# runtime image that matches your driver and the engine's requirements, e.g.
#   FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04
#   RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg \
#       && rm -rf /var/lib/apt/lists/*
# then copy the same files, install your licensed engine packages (NOT weights), keep the
# non-root USER, and run with `docker run --gpus all ...` (NVIDIA Container Toolkit).

FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# ffmpeg: Bridge keyframe extraction (the worker falls back to a copy if it is missing).
# --build-arg WITH_FFMPEG=0 skips it (smaller image, or builders without apt access).
ARG WITH_FFMPEG=1
RUN if [ "$WITH_FFMPEG" = "1" ]; then \
        apt-get update \
        && apt-get install -y --no-install-recommends ffmpeg \
        && rm -rf /var/lib/apt/lists/*; \
    fi

RUN groupadd --system --gid 10001 lattice \
    && useradd --system --uid 10001 --gid lattice --home-dir /data --no-create-home \
       --shell /usr/sbin/nologin lattice \
    && mkdir -p /data/runs \
    && chown -R lattice:lattice /data

WORKDIR /app

# Worker, exporters, batch client, docs/notices, and the PWA static files (served by a
# reverse proxy such as deploy/Caddyfile; the worker itself does not serve them).
# users.p[y]: optional multi-user helper; the bracket glob lets the build pass without it.
COPY worker.py batch.py users.p[y] LICENSE NOTICE README.md DEPLOY.md ./
COPY exporters/*.py ./exporters/
COPY index.html styles.css app.js sw.js manifest.json icon.svg ./pwa/

USER lattice

VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["python3", "-c", "import json,sys,urllib.request as u; r=u.urlopen('http://127.0.0.1:8787/health', timeout=4); sys.exit(0 if json.load(r).get('ok') else 1)"]

CMD ["python3", "worker.py", "--host", "0.0.0.0", "--port", "8787", "--runs", "/data/runs"]
