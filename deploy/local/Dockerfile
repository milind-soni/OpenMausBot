ARG BASE_IMAGE=ghcr.io/milind-soni/openmausbot:latest@sha256:5af74ed3254dae9a0cfeb0a1ba5bf86ea7bba8641be427d35f05f5b769edbf4e
FROM ${BASE_IMAGE}
USER root
ARG ENGINES="@anthropic-ai/claude-code@2.1.263 @openai/codex@0.153.4"
RUN if [ -n "$ENGINES" ]; then npm install -g $ENGINES; fi
USER maus
