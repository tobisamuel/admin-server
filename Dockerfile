# Use the official Bun image
# Alpine version is used for a smaller footprint
FROM oven/bun:alpine AS base
WORKDIR /usr/src/app

# Add build argument for NODE_ENV
ARG NODE_ENV=development

# Install dependencies into temp directory
# This will cache them and speed up future builds
FROM base AS install
RUN mkdir -p /temp/dev
COPY package.json bun.lock /temp/dev/
RUN cd /temp/dev && bun install --frozen-lockfile

# Install with --production (exclude devDependencies)
RUN mkdir -p /temp/prod
COPY package.json bun.lock /temp/prod/
RUN cd /temp/prod && bun install --frozen-lockfile --production

# Copy node_modules from temp directory
# then copy all (non-ignored) project files into the image
FROM base AS prerelease
COPY --from=install /temp/dev/node_modules node_modules
COPY . .

# Set environment
ENV NODE_ENV=${NODE_ENV}

# Copy production dependencies and source code into final image
FROM base AS release
COPY --from=install /temp/prod/node_modules node_modules
COPY --from=prerelease /usr/src/app/index.ts .
COPY --from=prerelease /usr/src/app/src ./src
COPY --from=prerelease /usr/src/app/tsconfig.json .
COPY --from=prerelease /usr/src/app/package.json .

# Set environment
ENV NODE_ENV=${NODE_ENV}

# Run the app
USER bun
EXPOSE 3001
# Use environment variables from the host
ENV PORT=3001
# Note: In production, you should set MONGODB_URI and AERO_API_KEY as environment variables
# during container runtime rather than baking them into the image

ENTRYPOINT ["bun", "run", "index.ts"] 
