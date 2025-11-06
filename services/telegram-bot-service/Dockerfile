FROM node:18-alpine

WORKDIR /app

# Install dependencies for Sharp and Tesseract
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    tesseract-ocr \
    tesseract-ocr-data-rus

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

EXPOSE 3007

CMD ["npm", "start"]
