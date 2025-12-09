# ✅ Node 20 LTS com suporte à API File usada pelo SDK OpenAI
FROM node:20-bullseye

# ✅ Instala ffmpeg e ffprobe via apt
RUN apt-get update && apt-get install -y \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Diretório de trabalho
WORKDIR /app

# Copia apenas os arquivos de dependências primeiro (para cache eficiente)
COPY package*.json ./

# Instala dependências
RUN npm install

# Copia o restante do código
COPY . .

# ✅ Garante que a pasta de uploads existe (evita erro se faltar mkdir)
RUN mkdir -p uploads

# ✅ Expõe a porta que Railway usará (vem de process.env.PORT)
EXPOSE 8080

# ✅ Define variável de ambiente de fallback (boa prática)
ENV PORT=8080

# ✅ Inicia a aplicação
CMD ["npm", "start"]
