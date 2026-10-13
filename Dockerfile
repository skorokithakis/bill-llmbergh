FROM node:22

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

CMD ["node", "--experimental-strip-types", "src/main.ts"]
