FROM mcr.microsoft.com/playwright:v1.58.2-noble

ENV BUN_INSTALL=/root/.bun
ENV PATH="${BUN_INSTALL}/bin:${PATH}"
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends unzip \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

EXPOSE 38819

CMD ["bun", "run", "server"]
