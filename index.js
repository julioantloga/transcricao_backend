import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import OpenAI from "openai";
import { gerarReview } from "./services/review.js";

const app = express();
app.use(cors());
app.use(express.json());

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`Servidor rodando na porta ${port}`));

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

const PORT = process.env.PORT || 3333;

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
