import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import OpenAI from "openai";
import { gerarReview } from "./services/review.js";
import { randomUUID } from "crypto"; // no topo

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


//ROTAS

app.post("/transcribe", upload.single("audio"), async (req, res) => {
  const inicioTotal = Date.now();
  const diarizar = req.body?.diarizacao === "true";
  const filePath = req.file?.path;

  if (!filePath) {
    return res.status(400).json({ error: "Arquivo não enviado" });
  }

  try {
    const ext = path.extname(filePath).toLowerCase();
    if (![".webm", ".wav"].includes(ext)) {
      fs.unlinkSync(filePath);
      return res.status(400).json({ error: "Formato de áudio não suportado." });
    }

    let wavPath = filePath;
    let tempoConversao = 0;

    if (ext !== ".wav") {
      const inicioConversao = Date.now();
      wavPath = filePath.replace(ext, ".wav");
      execSync(`ffmpeg -i "${filePath}" -ar 16000 -ac 1 -f wav "${wavPath}" -y`);
      tempoConversao = (Date.now() - inicioConversao) / 1000;
    }

    const duracaoAudio = getAudioDuration(wavPath);
    const wavSizeMB = fs.statSync(wavPath).size / (1024 * 1024);
    let transcricaoFinal = "";

    const inicioTranscricao = Date.now();

    if (wavSizeMB > 25) {
      const partesDir = path.join(os.tmpdir(), `partes_${Date.now()}`);
      fs.mkdirSync(partesDir);
      execSync(`ffmpeg -i "${wavPath}" -f segment -segment_time 480 -c copy "${partesDir}/parte_%03d.wav"`);

      const arquivosPartes = fs.readdirSync(partesDir).filter(f => f.endsWith(".wav")).sort();
      for (const parte of arquivosPartes) {
        const partePath = path.join(partesDir, parte);
        const response = await openai.audio.transcriptions.create({
          file: fs.createReadStream(partePath),
          model: "whisper-1",
          response_format: "json",
          language: "pt"
        });
        transcricaoFinal += response.text + "\n";
      }

      arquivosPartes.forEach(p => fs.unlinkSync(path.join(partesDir, p)));
      fs.rmdirSync(partesDir);
    } else {
      const response = await openai.audio.transcriptions.create({
        file: fs.createReadStream(wavPath),
        model: "whisper-1",
        response_format: "json",
        language: "pt"
      });
      transcricaoFinal = response.text;
    }

    const tempoTranscricao = (Date.now() - inicioTranscricao) / 1000;
    const tempoTotal = (Date.now() - inicioTotal) / 1000;
    const eficiencia = duracaoAudio / tempoTotal;

    if (filePath !== wavPath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);

    return res.json({
      metrics: {
        audio: duracaoAudio,
        converter: tempoConversao,
        transcription: tempoTranscricao,
        total: tempoTotal,
        eficacia: eficiencia
      },
      text: transcricaoFinal.trim()
    });

  } catch (err) {
    console.error("❌ Erro real:", err);
    return res.status(500).json({ error: "Erro ao processar áudio" });
  }
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

app.post("/upload", upload.single("audio"), async (req, res) => {
  const diarizacao = req.body?.diarizacao === "true";
  const filePath = req.file?.path;

  if (!filePath) {
    return res.status(400).json({ error: "Arquivo não enviado" });
  }

  const id = randomUUID();
  processos.set(id, {
    status: "Recebido",
    partesTotal: 0,
    partesConcluidas: 0,
    pronto: false,
    transcricao: "",
    erro: null
  });

  // Transcrição em background
  processarTranscricao(id, filePath, diarizacao);

  res.json({ id });
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


//FUNÇÕES

async function processarTranscricao(id, filePath, diarizar) {
  const registro = processos.get(id);
  const inicioTotal = Date.now();

  try {
    const ext = path.extname(filePath).toLowerCase();
    if (![".webm", ".wav"].includes(ext)) {
      fs.unlinkSync(filePath);
      registro.erro = "Formato inválido";
      return;
    }

    let wavPath = filePath;
    if (ext !== ".wav") {
      wavPath = filePath.replace(ext, ".wav");
      execSync(`ffmpeg -i "${filePath}" -ar 16000 -ac 1 -f wav "${wavPath}" -y`);
    }

    const duracaoAudio = getAudioDuration(wavPath);
    const wavSizeMB = fs.statSync(wavPath).size / (1024 * 1024);

    registro.status = "Convertido";
    registro.metrics = { audio: duracaoAudio };
    const inicioTranscricao = Date.now();

    if (wavSizeMB > 25) {
      const partesDir = path.join(os.tmpdir(), `partes_${Date.now()}`);
      fs.mkdirSync(partesDir);
      execSync(`ffmpeg -i "${wavPath}" -f segment -segment_time 480 -c copy "${partesDir}/parte_%03d.wav"`);

      const partes = fs.readdirSync(partesDir).filter(f => f.endsWith(".wav")).sort();
      registro.partesTotal = partes.length;

      for (let i = 0; i < partes.length; i++) {
        const parte = partes[i];
        registro.status = `Transcrevendo parte ${i + 1} de ${partes.length}`;
        const partePath = path.join(partesDir, parte);

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
    } else {
      registro.status = "Transcrevendo";
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

    const tempoTotal = (Date.now() - inicioTotal) / 1000;
    const tempoTranscricao = (Date.now() - inicioTranscricao) / 1000;

    registro.metrics = {
      ...registro.metrics,
      total: tempoTotal,
      transcription: tempoTranscricao,
      eficacia: duracaoAudio / tempoTotal
    };

    registro.status = "Concluído";
    registro.pronto = true;

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