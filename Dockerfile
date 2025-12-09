# Usar uma imagem oficial do Node em Linux (necessário para ffmpeg)
FROM node:20-alpine

# Instala FFmpeg e FFprobe (necessário para seu execSync)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Define o diretório de trabalho
WORKDIR /app

# Copia apenas package.json primeiro (cache otimizado)
COPY package*.json ./

# Instala dependências
RUN npm install

# Copia o restante do código
COPY . .

EXPOSE 8080

# Comando de inicialização do seu backend
CMD ["npm", "start"]