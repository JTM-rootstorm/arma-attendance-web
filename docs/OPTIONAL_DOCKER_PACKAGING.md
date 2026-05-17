# Optional Docker Packaging

Docker is optional and is not the default deployment path for `arma-attendance-web`.

The supported production path remains:

```text
Debian 13 LXC + Node.js 24 + pnpm + PostgreSQL + systemd + existing reverse proxy
```

Docker may become useful later for release packaging experiments, throwaway local testing, or CI smoke environments. It is not required for normal development or production deployment.

If a Docker image is added later:

- it should package the Node app only,
- it should not include PostgreSQL,
- it must require `DATABASE_URL`,
- it must expect TLS and reverse proxy behavior outside the container,
- it must not replace the systemd/LXC deployment docs,
- Docker Compose must not become required infrastructure.
