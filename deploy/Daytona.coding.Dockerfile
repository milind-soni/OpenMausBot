FROM daytonaio/sandbox:0.8.0
# Root here is confined to this one account's Daytona computer, never the
# shared NATION backend. The container host rejects non-root user namespaces.
# Codex still enforces workspace-write, read-only mounts and network denial.
USER root
ENV PATH="/usr/local/bin:/usr/local/share/nvm/current/bin:/usr/bin:/bin"
COPY install-isolated-coding.sh /opt/install-isolated-coding.sh
RUN sed -i 's/\r$//' /opt/install-isolated-coding.sh && sh /opt/install-isolated-coding.sh
