# cache-bust-1
# Stage 1: Build Rust binary
FROM rust:1.80-slim as rust-builder
WORKDIR /app
COPY bpmn-parser/Cargo.toml bpmn-parser/Cargo.lock ./bpmn-parser/
# Create a dummy main.rs to cache dependencies
RUN mkdir -p bpmn-parser/src && echo "fn main() {}" > bpmn-parser/src/main.rs
RUN cd bpmn-parser && cargo build --release
RUN rm -f bpmn-parser/src/main.rs bpmn-parser/target/release/deps/ogb*
COPY bpmn-parser/Cargo.toml ./bpmn-parser/
RUN cd bpmn-parser && cargo build --release

# Stage 2: Build Web UI
FROM node:20-slim as web-builder
WORKDIR /app/bpmn-ui/web
COPY bpmn-ui/web/package.json bpmn-ui/web/package-lock.json ./
RUN npm ci
COPY bpmn-ui/web/ ./
RUN npm run build

# Stage 3: Runner
FROM node:20-slim as runner
WORKDIR /app

# Copy the built Rust binary (it compiles to ogb on Linux)
COPY --from=rust-builder /app/bpmn-parser/target/release/ogb /app/bpmn-parser/target/release/ogb

# Copy web dist
COPY --from=web-builder /app/bpmn-ui/web/dist /app/bpmn-ui/web/dist

# Install server dependencies
WORKDIR /app/bpmn-ui/server
COPY bpmn-ui/server/package.json bpmn-ui/server/package-lock.json ./
RUN npm ci

# Copy server code
COPY bpmn-ui/server/src ./src

# Expose Express server port
EXPOSE 5175

# Run the server
CMD ["node", "src/index.js"]
