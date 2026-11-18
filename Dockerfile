FROM apify/actor-node:22

COPY package*.json ./

RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" \
    && node --version \
    && echo "NPM version:" \
    && npm --version \
    && rm -r ~/.npm

COPY . ./

# Address lookups run on a small pool of threads. A few domains that do not answer would hold up every other lookup,
# so the pool is larger than the default of four.
ENV UV_THREADPOOL_SIZE=24

CMD npm start --silent
