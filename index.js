import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import OpenAI from "openai";
import { gerarReview } from "./services/review.js";
import { randomUUID } from "crypto";

const processos = new Map();

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({
  storage: multer.diskStorage({
    destination: "uploads/",
    filename: (_, file, cb) => {
      if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");
      const ext = path.extname(file.originalname);
      cb(null, `${Date.now()}${ext}`);
    }
  })
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ROTAS

app.post("/upload", upload.single("audio"), async (req, res) => {
  const diarizacao = req.body?.diarizacao === "true";
  const filePath = req.file?.path;

  if (!filePath) {
    return res.status(400).json({ error: "Arquivo não enviado" });
  }

  try {
    const id = randomUUID();
    processos.set(id, {
      status: "Recebido",
      partesTotal: 0,
      partesConcluidas: 0,
      pronto: false,
      transcricao: "",
      erro: null
    });

    console.log(`🟡 Iniciando transcrição para ID: ${id}`);
    processarTranscricao(id, filePath, diarizacao);

    res.json({ id });

  } catch (err) {
    console.error("❌ Erro no /upload:", err);
    res.status(500).json({ error: "Erro interno ao processar o áudio." });
  }
});

app.get("/status/:id", (req, res) => {
  const registro = processos.get(req.params.id);

  if (!registro) {
    return res.status(404).json({ erro: "ID não encontrado" });
  }

  res.json({
    status: registro.status,
    partesTotal: registro.partesTotal,
    partesConcluidas: registro.partesConcluidas,
    pronto: registro.pronto,
    transcricao: registro.pronto ? registro.transcricao : undefined,
    erro: registro.erro,
    metrics: registro.metrics || null
  });
});

app.post("/review", async (req, res) => {
  try {
    const review = await gerarReview(req.body);
    return res.json({ review });
  } catch (err) {
    console.error("❌ Erro no review:", err);
    return res.status(500).json({ error: "Erro ao gerar review" });
  }
});

// FUNÇÕES

async function processarTranscricao(id, filePath, diarizar) {
  const registro = processos.get(id);
  const inicioTotal = Date.now();

  try {
    console.log(`🔄 Processando ID ${id}, arquivo recebido: ${filePath}`);
    
    const inicioConversao = Date.now();

    const ext = path.extname(filePath).toLowerCase();
    if (![".webm", ".wav"].includes(ext)) {
      fs.unlinkSync(filePath);
      registro.erro = "Formato inválido";
      console.warn(`⚠️ Formato inválido: ${ext}`);
      return;
    }

    let wavPath = filePath;
    if (ext !== ".wav") {
      wavPath = filePath.replace(ext, ".wav");
      console.log("🎛️ Convertendo para WAV...");
      execSync(`ffmpeg -i "${filePath}" -ar 16000 -ac 1 -f wav "${wavPath}" -y`);
      console.log(`✅ Conversão concluída: ${wavPath}`);
    } 

    const duracaoAudio = getAudioDuration(wavPath);
    const wavSizeMB = fs.statSync(wavPath).size / (1024 * 1024);

    console.log(`📏 Duração: ${duracaoAudio.toFixed(2)}s | Tamanho: ${wavSizeMB.toFixed(2)} MB`);

    registro.status = "Convertido";

    const tempoConversao = (Date.now() - inicioConversao) / 1000

    registro.metrics = {
      audio: duracaoAudio,
      conversion: tempoConversao
    };

    const inicioTranscricao = Date.now();

    if (wavSizeMB > 5) {
      console.log("🔀 Áudio grande, iniciando segmentação...");

      const partesDir = path.join(os.tmpdir(), `partes_${Date.now()}`);
      fs.mkdirSync(partesDir);

      // Divide os audio em partes de 5 minutos
      execSync(`ffmpeg -i "${wavPath}" -f segment -segment_time 300 -c copy "${partesDir}/parte_%03d.wav"`);

      const partes = fs.readdirSync(partesDir).filter(f => f.endsWith(".wav")).sort();
      registro.partesTotal = partes.length;

      console.log(`📂 Total de partes: ${partes.length}`);

      for (let i = 0; i < partes.length; i++) {
        const parte = partes[i];
        const partePath = path.join(partesDir, parte);

        registro.status = `Transcrevendo parte ${i + 1} de ${partes.length}`;
        console.log(`📝 Transcrevendo parte ${i + 1} de ${partes.length}: ${partePath}`);

        const response = await openai.audio.transcriptions.create({
          file: fs.createReadStream(partePath),
          model: "whisper-1",
          response_format: "json",
          language: "pt"
        });

        registro.transcricao += response.text + "\n";
        registro.partesConcluidas = i + 1;
      }

      fs.rmSync(partesDir, { recursive: true });
      console.log("🗑️ Segmentos removidos após transcrição.");
    } else {
      registro.status = "Transcrevendo";
      console.log("📝 Transcrevendo áudio completo (sem segmentar)");

      const response = await openai.audio.transcriptions.create({
        file: fs.createReadStream(wavPath),
        model: "whisper-1",
        response_format: "json",
        language: "pt"
      });

      registro.transcricao = response.text;
      registro.partesTotal = 1;
      registro.partesConcluidas = 1;
    }

    const tempoTotal = ((Date.now() - inicioTotal) / 1000) + tempoConversao;
    const tempoTranscricao = (Date.now() - inicioTranscricao) / 1000;

    registro.metrics = {
      ...registro.metrics,
      total: tempoTotal,
      transcription: tempoTranscricao,
      eficacia: duracaoAudio / tempoTotal
    };

    registro.status = "Concluído";
    registro.pronto = true;

    console.log(`✅ Transcrição concluída para ID ${id}`);
    console.log("📊 Métricas:", registro.metrics);

    fs.unlinkSync(filePath);
    if (wavPath !== filePath && fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
  } catch (err) {
    console.error("❌ Erro real:", err);
    registro.erro = "Erro na transcrição";
  }
}

function getAudioDuration(filePath) {
  try {
    const output = execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`
    ).toString();
    return parseFloat(output.trim());
  } catch (err) {
    console.error("Erro ao calcular duração:", err);
    return 0;
  }
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
