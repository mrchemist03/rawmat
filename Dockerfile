FROM node:25-trixie-slim@sha256:aabbe39553d15ede8a97cc60c9e1a97034ff772afcf696ea42b94e7f5f2ec71b AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY apps ./apps
COPY packages ./packages
RUN npm run build

FROM build AS production-dependencies
RUN npm ci --omit=dev --workspace @rawmat/server --workspace @rawmat/shared --ignore-scripts --no-audit --no-fund \
    && mkdir /data

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:39b0407357c9fadf1a9708d22088f02de21f0e1e8a688474eea2d8701e7d5693 AS node-runtime

FROM gcr.io/distroless/base-nossl-debian13:nonroot@sha256:4006ac92504be607b70de01d1f64f38288c69fcd8faa820f6d3aed266ea32ac5
# Official Node bundles TLS and compression; copy only its loaded C++ runtime dependencies.
COPY --from=node-runtime /nodejs /nodejs
COPY --from=node-runtime /usr/lib/x86_64-linux-gnu/libstdc++.so.6* /usr/lib/x86_64-linux-gnu/
COPY --from=node-runtime /usr/lib/x86_64-linux-gnu/libgcc_s.so.1 /usr/lib/x86_64-linux-gnu/
# Keep the copied Debian packages discoverable in vulnerability scans and the SBOM.
COPY --from=node-runtime /var/lib/dpkg/status.d/libstdc++6* /var/lib/dpkg/status.d/
COPY --from=node-runtime /var/lib/dpkg/status.d/libgcc-s1* /var/lib/dpkg/status.d/
COPY --from=node-runtime /var/lib/dpkg/status.d/gcc-14-base* /var/lib/dpkg/status.d/
COPY --from=node-runtime /usr/share/doc/libstdc++6 /usr/share/doc/libstdc++6
COPY --from=node-runtime /usr/share/doc/libgcc-s1 /usr/share/doc/libgcc-s1
COPY --from=node-runtime /usr/share/doc/gcc-14-base /usr/share/doc/gcc-14-base
WORKDIR /app
ENV NODE_ENV=production DATABASE_PATH=/data/rawmat.sqlite BRANDING_PATH=/app/branding

COPY --from=production-dependencies --chown=10001:10001 /data /data
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/server/migrations ./apps/server/migrations
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/node_modules/@fontsource/tajawal/LICENSE ./licenses/Tajawal-OFL.txt

USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["/nodejs/bin/node", "apps/server/dist/healthcheck.js"]
ENTRYPOINT ["/nodejs/bin/node"]
CMD ["apps/server/dist/index.js"]
