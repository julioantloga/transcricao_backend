# ✅ Usa Node 20 LTS com suporte a File API (essencial para o openai SDK moderno)
FROM node:20-bullseye

# ✅ Instala FFmpeg via apt
RUN apt-get update && apt-get install -y \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Diretório de trabalho
WORKDIR /app

# Copia package.json e lock
COPY package*.json ./

# Instala as dependências
RUN npm install

# Copia o restante do código
COPY . .

# Expõe a porta padrão (Railway irá usar process.env.PORT)
EXPOSE 8080

# Força a variável de porta padrão (para fallback)
ENV PORT=8080

# ✅ Define ponto de entrada
CMD ["npm", "start"]
