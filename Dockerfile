# ✅ Usa Node 20 com suporte à API File do OpenAI
FROM node:20-bullseye

# ✅ Instala somente os pacotes necessários (ffmpeg e ffprobe)
RUN apt-get update && apt-get install -y \
  ffmpeg \
  && rm -rf /var/lib/apt/lists/*

# ✅ Define diretório de trabalho
WORKDIR /app

# ✅ Copia apenas os arquivos de dependências (para cache eficiente)
COPY package*.json ./

# ✅ Instala dependências (sem cache de dev)
RUN npm install --omit=dev

# ✅ Copia todo o restante do código
COPY . .

# ✅ Garante que a pasta de uploads existe
RUN mkdir -p uploads

# ✅ Define variáveis de ambiente seguras e fallback
ENV PORT=8080
ENV NODE_ENV=production

# ✅ Expõe a porta usada pela aplicação
EXPOSE 8080

# ✅ Usa comando mais direto e eficiente
CMD node index.js
