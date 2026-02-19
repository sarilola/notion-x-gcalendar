# node.js version
FROM node:20-slim

# working dir
WORKDIR /usr/src/app

# dependencies
COPY package*.json ./
RUN npm install

# copy all the files (script)
COPY . .

# necessary tools
RUN npm install -g ts-node typescript

# execute the script
CMD ["npx", "ts-node", "--compiler-options", "{\"module\": \"commonjs\", \"esModuleInterop\": true}", "sync.ts"]