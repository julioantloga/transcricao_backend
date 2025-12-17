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
import pool from "./db.js";
import dotenv from "dotenv";
dotenv.config();

const UPLOAD_DIR = process.env.UPLOAD_DIR || "uploads";

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}


console.log("OPENAI_API_KEY:", process.env.OPENAI_API_KEY?.slice(0, 8) + "...");
console.log("DATABASE_URL:", process.env.DATABASE_URL?.split("@")[1]?.split("/")[0] || "não definida");

const processos = new Map();

// Tempo máximo de cada segmento de áudio em segundos
const TEMPO_SEGMENTO = 500; // 5 minutos

const app = express();
app.use(cors());
app.use(express.json());
app.use("/uploads", express.static(UPLOAD_DIR));

// ROTA DE LOGIN (autenticação simples)
app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "Usuário e senha obrigatórios" });
  }

  try {
    const result = await pool.query(
      `SELECT id FROM public.users WHERE username = $1 AND password = $2`,
      [username, password]
    );

    if (result.rowCount === 0) {
      return res.status(401).json({ error: "Credenciais inválidas" });
    }

    const user = result.rows[0];
    return res.json({ userId: user.id });
  } catch (err) {
    console.error("Erro no login:", err);
    return res.status(500).json({ error: "Erro interno ao autenticar" });
  }
});


const upload = multer({
  storage: multer.diskStorage({
    destination: (_, __, cb) => {
      cb(null, UPLOAD_DIR);
    },
    filename: (_, file, cb) => {
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
  const interviewId = req.body?.interview_id;
  const filePath = req.file?.path;
  const ext = path.extname(filePath).toLowerCase();
  const baseName = path.basename(filePath, ext);
  const finalWavFilename = `${baseName}.wav`;

  if (!filePath) {
    return res.status(400).json({ error: "Arquivo não enviado" });
  }

  if (!interviewId) {
    return res.status(400).json({ error: "interview_id é obrigatório" });
  }

  try {
    const id = randomUUID();
    processos.set(id, {
      interviewId,
      status: "Recebido",
      partesTotal: 0,
      partesConcluidas: 0,
      pronto: false,
      transcricao: "",
      erro: null
    });

    console.log(`🟡 Iniciando transcrição para ID: ${id}`);
    processarTranscricao(id, filePath, diarizacao);

    res.json({
      id,
      filename: finalWavFilename
    });


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

    const {
      id,
      transcript,
      user_id,
      interview_type_id,
      job_title,
      job_description,
      notes,
      interview_roadmap,
      job_responsibilities,
      company_values,
      metrics,
      audio_path
    } = req.body;

    let InterviewTypeSchema = "";

    if (interview_type_id && interview_type_id !== "none") {
      InterviewTypeSchema = await getInterviewTypeSchema(interview_type_id);
    } else {
      InterviewTypeSchema = "none";
      }
          
    const review = await gerarReview({
      transcript,
      job_description,
      notes,
      interview_roadmap,
      job_responsibilities,
      job_title,
      InterviewTypeSchema
    });

    const truncate = (value) => {
      if (typeof value === "string") return value.slice(0, 20) + "...";
      if (typeof value === "object") return JSON.stringify(value).slice(0, 20) + "...";
      return value === null ? null : String(value).slice(0, 20) + "...";
    };
    
    if (id) {
      // tentativa de atualizar
      const updateResult = await pool.query(
        `UPDATE public.interview_reviews
         SET
           audio_path = $1,
           metrics = $2,
           job_title = $3,
           transcript = $4,
           job_description = $5,
           job_responsibilities = $6,
           interview_roadmap = $7,
           company_values = $8,
           recruiter_notes = $9,
           final_review = $10,
           created_at = NOW(),
           user_id = $12,
           interview_type_id = $13,
           manual_review = $14
         WHERE id = $11`,
        [
          audio_path || null,
          metrics || null,
          job_title,
          transcript,
          job_description,
          job_responsibilities,
          interview_roadmap,
          company_values,
          notes,
          review,
          id,
          user_id,
          interview_type_id || null,
          null
        ]
      );

      if (updateResult.rowCount === 0) {
        // id não existe → inserir nova
        throw new Error("ID não encontrado para update, criando novo");
      }
    } else {
      // inserção nova
      await pool.query(
        `INSERT INTO public.interview_reviews (
          audio_path,
          metrics,
          job_title,
          transcript,
          job_description,
          job_responsibilities,
          interview_roadmap,
          company_values,
          recruiter_notes,
          final_review,
          user_id,
          interview_type_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          audio_path || null,
          metrics || null,
          job_title,
          transcript,
          job_description,
          job_responsibilities,
          interview_roadmap,
          company_values,
          notes,
          review,
          user_id,
          interview_type_id
        ]
      );
    }

    return res.json({ review });
  } catch (err) {
    console.error("❌ Erro no review:", err);
    return res.status(500).json({ error: "Erro ao gerar review" });
  }
});

// Rota para listar todas as entrevistas
app.get("/interviews", async (req, res) => {
  
  const userId = req.query.user_id;
  
  try {
    const result = await pool.query(
      `SELECT
      ir.id,
      ir.job_title,
      ir.created_at,
      it.name AS interview_type_name
    FROM public.interview_reviews ir
    LEFT JOIN public.interview_types it
      ON it.id = ir.interview_type_id
    WHERE ir.user_id = $1
    ORDER BY ir.created_at DESC`, [userId]
    );
    return res.json({ interviews: result.rows });
  } catch (err) {
    console.error("Erro ao buscar entrevistas:", err);
    return res.status(500).json({ error: "Erro interno" });
  }
});

// Rota para buscar uma entrevista por id
app.get("/interviews/:id", async (req, res) => {
  const { id } = req.params;
  
  try {
    const result = await pool.query(
      `SELECT * FROM public.interview_reviews WHERE id = $1`,
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Vaga não encontrada" });
    }
    return res.json({ interview: result.rows[0] });
  } catch (err) {
    console.error("Erro ao buscar entrevista:", err);
    return res.status(500).json({ error: "Erro interno" });
  }
});

app.patch("/interviews/:id/manual_review", async (req, res) => {
  const { id } = req.params;
  const { manual_review } = req.body;

  try {
    const result = await pool.query(
      `UPDATE public.interview_reviews
       SET manual_review = $1
       WHERE id = $2`,
      [manual_review, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Entrevista não encontrada" });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("Erro ao salvar parecer manual:", err);
    return res.status(500).json({ error: "Erro interno ao salvar parecer" });
  }
});

app.patch("/interviews/:id/review_feedback", async (req, res) => {
  const { id } = req.params;
  const { review_feedback } = req.body;

  if (!["positivo", "negativo"].includes(review_feedback)) {
    return res.status(400).json({ error: "Feedback inválido" });
  }

  try {
    const result = await pool.query(
      `UPDATE public.interview_reviews
       SET review_feedback = $1
       WHERE id = $2`,
      [review_feedback, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Entrevista não encontrada" });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("Erro ao salvar feedback:", err);
    return res.status(500).json({ error: "Erro interno ao salvar feedback" });
  }
});

app.post("/interview_types", async (req, res) => {
  const { user_id, name } = req.body;
  if (!user_id || !name) {
    return res.status(400).json({ error: "Campos obrigatórios: user_id, name" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO public.interview_types (user_id, name) VALUES ($1, $2) RETURNING *`,
      [user_id, name]
    );
    res.json({ type: result.rows[0] });
  } catch (err) {
    console.error("Erro ao criar tipo:", err);
    res.status(500).json({ error: "Erro interno" });
  }
});


app.get("/interview_types", async (req, res) => {
  const userId = req.query.user_id;
  if (!userId) return res.status(400).json({ error: "user_id é obrigatório" });

  try {
    const result = await pool.query(
      `SELECT * FROM public.interview_types WHERE user_id = $1 ORDER BY id DESC`,
      [userId]
    );
    res.json({ types: result.rows });
  } catch (err) {
    console.error("Erro ao listar tipos:", err);
    res.status(500).json({ error: "Erro interno" });
  }
});

app.get("/interview_types/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const typeRes = await pool.query(
      `SELECT * FROM public.interview_types WHERE id = $1`,
      [id]
    );

    const compRes = await pool.query(
      `SELECT * FROM public.competencies WHERE interview_type_id = $1 ORDER BY id`,
      [id]
    );

    if (typeRes.rowCount === 0)
      return res.status(404).json({ error: "Tipo não encontrado" });

    res.json({
      type: typeRes.rows[0],
      competencies: compRes.rows
    });

  } catch (err) {
    console.error("Erro ao buscar tipo:", err);
    res.status(500).json({ error: "Erro interno" });
  }
});

app.patch("/interview_types/:id", async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;

  try {
    const result = await pool.query(
      `UPDATE public.interview_types SET name = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [name, id]
    );

    if (result.rowCount === 0)
      return res.status(404).json({ error: "Tipo não encontrado" });

    res.json({ type: result.rows[0] });
  } catch (err) {
    console.error("Erro ao atualizar tipo:", err);
    res.status(500).json({ error: "Erro interno" });
  }
});

app.post("/interview_types/:typeId/competencies", async (req, res) => {
  const { typeId } = req.params;
  const {
    name,
    description,
    insuficiente,
    abaixo_do_esperado,
    dentro_expectativas,
    excepcional
  } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO public.competencies 
       (interview_type_id,name,description,insuficiente,abaixo_do_esperado,dentro_expectativas,excepcional)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        typeId,
        name,
        description,
        insuficiente,
        abaixo_do_esperado,
        dentro_expectativas,
        excepcional
      ]
    );

    res.json({ competency: result.rows[0] });
  } catch (err) {
    console.error("Erro ao criar competência:", err);
    res.status(500).json({ error: "Erro interno" });
  }
});

app.patch("/competencies/:id", async (req, res) => {
  const { id } = req.params;
  const {
    name,
    description,
    insuficiente,
    abaixo_do_esperado,
    dentro_expectativas,
    excepcional
  } = req.body;

  try {
    const result = await pool.query(
      `UPDATE public.competencies
       SET name=$1, description=$2, insuficiente=$3,
           abaixo_do_esperado=$4, dentro_expectativas=$5, excepcional=$6,
           updated_at=NOW()
       WHERE id=$7 RETURNING *`,
      [
        name,
        description,
        insuficiente,
        abaixo_do_esperado,
        dentro_expectativas,
        excepcional,
        id
      ]
    );

    if (result.rowCount === 0)
      return res.status(404).json({ error: "Competência não encontrada" });

    res.json({ competency: result.rows[0] });
  } catch (err) {
    console.error("Erro ao atualizar competência:", err);
    res.status(500).json({ error: "Erro interno" });
  }
});

app.delete("/competencies/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query(`DELETE FROM public.competencies WHERE id=$1`, [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error("Erro ao deletar competência:", err);
    res.status(500).json({ error: "Erro interno" });
  }
});

app.patch("/interviews/:id/audio_path", async (req, res) => {
  const { id } = req.params;
  const { audio_path } = req.body;

  try {
    await pool.query(
      `UPDATE public.interview_reviews SET audio_path = $1 WHERE id = $2`,
      [audio_path, id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("Erro ao salvar audio_path:", err);
    res.status(500).json({ error: "Erro interno ao salvar caminho do áudio" });
  }
});

app.post("/interviews/create", async (req, res) => {
  const { user_id } = req.body;

  if (!user_id) {
    return res.status(400).json({ error: "user_id é obrigatório" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO public.interview_reviews (user_id, created_at)
       VALUES ($1, NOW())
       RETURNING id`,
      [user_id]
    );

    return res.json({ id: result.rows[0].id });
  } catch (err) {
    console.error("Erro ao criar entrevista:", err);
    return res.status(500).json({ error: "Erro interno ao criar entrevista" });
  }
});

app.get("/interview_types/:id/schema", async (req, res) => {
  const { id } = req.params;

  try {
    const schema = await getInterviewTypeSchema(id);
    res.json(schema);
  } catch (err) {
    console.error("Erro ao gerar schema do tipo de entrevista:", err);

    if (err.message === "Tipo de entrevista não encontrado") {
      return res.status(404).json({ error: err.message });
    }

    res.status(500).json({ error: "Erro interno ao gerar schema" });
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
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      registro.erro = "Formato inválido";
      console.warn(`⚠️ Formato inválido: ${ext}`);
      return;
    }

    const originalPath = filePath;
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
      execSync(`ffmpeg -i "${wavPath}" -f segment -segment_time ${TEMPO_SEGMENTO} -c copy "${partesDir}/parte_%03d.wav"`);

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

    try {
      await pool.query(
        `UPDATE public.interview_reviews
        SET
          transcript = $1,
          metrics = $2
        WHERE id = $3`,
        [
          registro.transcricao,
          registro.metrics,
          registro.interviewId
        ]
      );
      console.log(`💾 Transcrição salva para entrevista ID ${id}`);
    } catch (err) {
      console.error("Erro ao salvar transcrição no banco:", err);
    }

    console.log(`✅ Transcrição concluída para ID ${id}`);
    console.log("📊 Métricas:", registro.metrics);

    // remove o arquivo original (ex: .webm)
    if (originalPath !== wavPath && fs.existsSync(originalPath)) {
      fs.unlinkSync(originalPath);
    }

    // remove diretório de partes (áudio grande)
    if (typeof partesDir !== "undefined" && fs.existsSync(partesDir)) {
      fs.rmSync(partesDir, { recursive: true, force: true });
    }


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

async function getInterviewTypeSchema(interviewTypeId) {
  // Busca o tipo de entrevista
  const typeRes = await pool.query(
    `SELECT name FROM public.interview_types WHERE id = $1`,
    [interviewTypeId]
  );

  if (typeRes.rowCount === 0) {
    throw new Error("Tipo de entrevista não encontrado");
  }

  // Busca as competências
  const compRes = await pool.query(
    `SELECT
       name,
       description,
       insuficiente,
       abaixo_do_esperado,
       dentro_expectativas,
       excepcional
     FROM public.competencies
     WHERE interview_type_id = $1
     ORDER BY id`,
    [interviewTypeId]
  );

  return {
    name: typeRes.rows[0].name,
    competences: compRes.rows
  };
}


const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
