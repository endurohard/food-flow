FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Expose SIP and API ports
EXPOSE 3009
EXPOSE 5060/udp
EXPOSE 5700-5750/udp

# Start the service
CMD ["npm", "start"]
