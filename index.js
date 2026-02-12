import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import OpenAI from "openai";

//SERVICES
import { gerarReview } from "./services/review.js";
import { handleJobChat } from "./services/jobChat.js";
import { generateEmbedding } from "./services/embeddings.js";
import { upsertCandidateDocument } from "./services/candidateDocuments.js";


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


/* ######## ROTAS ######## */

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

// LISTAR TODOS OS CANDIDATOS
app.get("/candidates", async (req, res) => {
  const { user_id } = req.query;

  try {
    const tenantId = await getTenantIdByUserId(user_id);

    const result = await pool.query(
      `
      SELECT id, name, resume_transcript
      FROM public.candidates
      WHERE tenant_id = $1
      ORDER BY name ASC
      `,
      [tenantId]
    );

    res.json({ candidates: result.rows });
  } catch (err) {
    console.error("Erro ao listar candidatos:", err);
    res.status(500).json({ error: "Erro ao buscar candidatos" });
  }
});

// CADASTRA CANDIDATOS
app.post("/candidates", async (req, res) => {
  const { user_id, name, resume_transcript } = req.body;

  try {
    const tenantId = await getTenantIdByUserId(user_id);

    const result = await pool.query(
      `
      INSERT INTO public.candidates (
        tenant_id,
        user_id,
        name,
        resume_transcript
      )
      VALUES ($1,$2,$3,$4)
      RETURNING *
      `,
      [
        tenantId,
        Number(user_id),
        name,
        resume_transcript
      ]
    );

    const candidate = result.rows[0];

    /* ============================================================
       Criar / atualizar candidate_documents (currículo)
       ============================================================ */
    if (resume_transcript && resume_transcript.trim()) {
      await upsertCandidateDocument({
        candidate_id: candidate.id,
        tenant_id: tenantId,
        category: "resume",
        content: resume_transcript
      });
    }

    res.json({ candidate });
  } catch (err) {
    console.error("Erro ao criar candidato:", err);
    res.status(500).json({ error: "Erro ao criar candidato" });
  }
});

// EDITA CANDIDATOS
app.patch("/candidates/:id", async (req, res) => {
  const { id } = req.params;
  const { user_id, name, resume_transcript } = req.body;

  try {
    const tenantId = await getTenantIdByUserId(user_id);

    const result = await pool.query(
      `
      UPDATE public.candidates
      SET
        name = $1,
        resume_transcript = $2,
        updated_at = NOW()
      WHERE id = $3
        AND tenant_id = $4
      RETURNING *
      `,
      [
        name,
        resume_transcript,
        Number(id),
        tenantId
      ]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "Candidato não encontrado" });
    }

    const candidate = result.rows[0];

    /* ============================================================
       Atualizar embedding do currículo
       ============================================================ */
    if (resume_transcript && resume_transcript.trim()) {
      await upsertCandidateDocument({
        candidate_id: candidate.id,
        tenant_id: tenantId,
        category: "resume",
        content: resume_transcript
      });
    }

    res.json({ candidate });
  } catch (err) {
    console.error("Erro ao atualizar candidato:", err);
    res.status(500).json({ error: "Erro ao atualizar candidato" });
  }
});

// BUSCA CANDIDATOS
app.get("/candidates/:id", async (req, res) => {
  const { id } = req.params;
  const { user_id } = req.query;

  try {
    const tenantId = await getTenantIdByUserId(user_id);

    const result = await pool.query(
      `
      SELECT *
      FROM public.candidates
      WHERE id = $1
        AND tenant_id = $2
      `,
      [Number(id), tenantId]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "Candidato não encontrado" });
    }

    res.json({ candidate: result.rows[0] });
  } catch (err) {
    console.error("Erro ao buscar candidato:", err);
    res.status(500).json({ error: "Erro ao buscar candidato" });
  }
});

// DELETA CANDIDATOS
app.delete("/candidates/:id", async (req, res) => {
  const { id } = req.params;
  const { user_id } = req.query;

  try {
    const tenantId = await getTenantIdByUserId(user_id);

    const result = await pool.query(
      `
      DELETE FROM public.candidates
      WHERE id = $1
        AND tenant_id = $2
      `,
      [Number(id), tenantId]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "Candidato não encontrado" });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Erro ao deletar candidato:", err);
    res.status(500).json({ error: "Erro ao deletar candidato" });
  }
});

// LISTAR HISTÓRICO DO CHAT DA VAGA
app.get("/jobs/:id/chat/messages", async (req, res) => {
  try {
    const { id: jobId } = req.params;
    const { user_id, limit } = req.query;

    if (!user_id) {
      return res.status(400).json({ error: "user_id é obrigatório" });
    }

    const tenantId = await getTenantIdByUserId(user_id);

    // 1️⃣ Validar se a vaga pertence ao tenant
    const jobCheck = await pool.query(
      `
      SELECT id
      FROM public.jobs
      WHERE id = $1
        AND tenant_id = $2
      `,
      [Number(jobId), tenantId]
    );

    if (!jobCheck.rowCount) {
      return res.status(404).json({ error: "Vaga não encontrada" });
    }

    // 2️⃣ Buscar histórico SOMENTE do usuário
    const safeLimit = Math.min(Number(limit) || 50, 200);

    const result = await pool.query(
      `
      SELECT role, content, created_at
      FROM public.job_chat_messages
      WHERE job_id = $1
        AND user_id = $2
      ORDER BY id ASC
      LIMIT $3
      `,
      [Number(jobId), Number(user_id), safeLimit]
    );

    return res.json({ messages: result.rows });
  } catch (err) {
    console.error("Erro ao listar histórico do chat:", err);
    return res.status(500).json({ error: "Erro ao listar histórico do chat" });
  }
});

// CHAT DA VAGA (RAG + histórico persistido)
app.post("/jobs/:id/chat", async (req, res) => {
  const jobId = Number(req.params.id);
  const { user_id, question } = req.body;

  try {
    if (!jobId || !user_id || !question) {
      return res.status(400).json({ error: "Parâmetros inválidos" });
    }

    const tenantId = await getTenantIdByUserId(user_id);

    // 1️⃣ Validar se a vaga pertence ao tenant
    const jobCheck = await pool.query(
      `
      SELECT id
      FROM public.jobs
      WHERE id = $1
        AND tenant_id = $2
      `,
      [jobId, tenantId]
    );

    if (!jobCheck.rowCount) {
      return res.status(404).json({ error: "Vaga não encontrada" });
    }

    // 2️⃣ Executar chat (RAG por tenant)
    const answer = await handleJobChat({
      jobId,
      tenantId,
      userId: Number(user_id),
      question: String(question)
    });

    return res.json({ answer });
  } catch (err) {
    console.error("Erro no chat da vaga:", err);
    return res.status(500).json({ error: "Erro interno ao consultar o chat" });
  }
});

// LISTAR VAGAS
app.get("/jobs", async (req, res) => {
  const { user_id } = req.query;

  try {
    const tenantId = await getTenantIdByUserId(user_id);

    const result = await pool.query(
      `
      SELECT *
      FROM public.jobs
      WHERE tenant_id = $1
      ORDER BY id DESC
      `,
      [tenantId]
    );

    res.json({ jobs: result.rows });
  } catch (err) {
    console.error("Erro ao listar vagas:", err);
    res.status(500).json({ error: "Erro ao listar vagas" });
  }
});

// BUSCAR VAGA
app.get("/jobs/:id", async (req, res) => {
  const { id } = req.params;

  try {
    // 1️⃣ Buscar vaga
    const jobResult = await pool.query(
      `SELECT * FROM public.jobs WHERE id = $1`,
      [id]
    );

    if (!jobResult.rowCount) {
      return res.status(404).json({ error: "Vaga não encontrada" });
    }

    const job = jobResult.rows[0];

    // 2️⃣ Buscar tipos de entrevista vinculados
    const typesResult = await pool.query(
      `
      SELECT it.id, it.name, it.category
      FROM public.job_interview_types jit
      JOIN public.interview_types it
        ON it.id = jit.interview_type_id
      WHERE jit.job_id = $1
      ORDER BY it.name ASC
      `,
      [id]
    );

    res.json({
      job,
      interview_types: typesResult.rows
    });

  } catch (err) {
    console.error("Erro ao buscar vaga:", err);
    res.status(500).json({ error: "Erro ao buscar vaga" });
  }
});

// BUSCAR ENTREVISTAS DE UMA VAGA
app.get("/jobs/:id/interviews", async (req, res) => {
  const { id } = req.params;
  const { user_id } = req.query;

  try {
    const tenantId = await getTenantIdByUserId(user_id);

    const result = await pool.query(
      `
      SELECT
        ir.id,
        ir.job_id,
        ir.candidate_name,
        ir.interview_type_id,
        ir.created_at,
        j.name AS job_title,
        it.name AS interview_type_name,
        it.category AS interview_type_category
      FROM public.interview_reviews ir
      JOIN public.jobs j
        ON j.id = ir.job_id
      LEFT JOIN public.interview_types it
        ON it.id = ir.interview_type_id
      WHERE ir.job_id = $1
        AND ir.tenant_id = $2
      ORDER BY ir.created_at DESC
      `,
      [Number(id), tenantId]
    );

    res.json({ interviews: result.rows });
  } catch (err) {
    console.error("Erro ao buscar entrevistas da vaga:", err);
    res.status(500).json({ error: "Erro ao buscar entrevistas da vaga" });
  }
});

// CRIAR VAGA 
app.post("/jobs", async (req, res) => {
  const {
    user_id,
    name,
    job_description,
    job_responsibilities,
    interview_type_ids = [],
    new_interview_type = null
  } = req.body;

  if (!user_id || !name) {
    return res.status(400).json({ error: "user_id e name são obrigatórios" });
  }

  const client = await pool.connect();

  try {
    const tenantId = await getTenantIdByUserId(user_id);

    await client.query("BEGIN");

    // 1) Criar vaga
    const jobResult = await client.query(
      `
      INSERT INTO public.jobs (
        tenant_id,
        user_id,
        name,
        job_description,
        job_responsibilities
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
      `,
      [
        tenantId,
        Number(user_id),
        name,
        job_description,
        job_responsibilities
      ]
    );

    const job = jobResult.rows[0];

    // Copia defensiva dos ids recebidos
    const finalInterviewTypeIds = Array.isArray(interview_type_ids)
      ? [...interview_type_ids]
      : [];

    let createdInterviewType = null;

    // 2) Se veio "new_interview_type", criar tipo + competências
    if (new_interview_type) {
      const { name: typeName, category: typeCategory, competencies } = new_interview_type;

      if (!typeName || !typeCategory) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "new_interview_type precisa de name e category"
        });
      }

      // 2.1) Criar tipo
      const typeResult = await client.query(
        `
        INSERT INTO public.interview_types (
          tenant_id,
          user_id,
          name,
          category
        )
        VALUES ($1, $2, $3, $4)
        RETURNING *
        `,
        [tenantId, Number(user_id), typeName, typeCategory]
      );

      createdInterviewType = typeResult.rows[0];

      // 2.2) Criar competências do tipo (se houver)
      if (Array.isArray(competencies) && competencies.length) {
        for (const comp of competencies) {
          await client.query(
            `
            INSERT INTO public.competencies (
              interview_type_id,
              name,
              description,
              insuficiente,
              abaixo_do_esperado,
              dentro_expectativas,
              excepcional
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7)
            `,
            [
              createdInterviewType.id,
              comp?.name || "",
              comp?.description || "",
              comp?.insuficiente || "",
              comp?.abaixo_do_esperado || "",
              comp?.dentro_expectativas || "",
              comp?.excepcional || ""
            ]
          );
        }
      }

      // 2.3) Garantir vínculo do tipo recém-criado
      finalInterviewTypeIds.push(createdInterviewType.id);
    }

    // 3) Validar que todos os interview_type_ids pertencem ao tenant
    const uniqueTypeIds = [...new Set(finalInterviewTypeIds.map(Number).filter(Boolean))];

    if (uniqueTypeIds.length) {
      const checkTypes = await client.query(
        `
        SELECT id
        FROM public.interview_types
        WHERE tenant_id = $1
          AND id = ANY($2::int[])
        `,
        [tenantId, uniqueTypeIds]
      );

      if (checkTypes.rowCount !== uniqueTypeIds.length) {
        await client.query("ROLLBACK");
        return res.status(403).json({
          error: "Um ou mais tipos de entrevista são inválidos ou fora do seu tenant"
        });
      }

      // 4) Criar vínculos vaga ↔ tipos
      for (const typeId of uniqueTypeIds) {
        await client.query(
          `
          INSERT INTO public.job_interview_types (job_id, interview_type_id)
          VALUES ($1, $2)
          ON CONFLICT DO NOTHING
          `,
          [job.id, typeId]
        );
      }
    }

    await client.query("COMMIT");

    return res.json({
      job,
      created_interview_type: createdInterviewType
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Erro ao criar vaga (com tipos):", err);
    return res.status(500).json({ error: "Erro ao criar vaga" });
  } finally {
    client.release();
  }
});

// ATUALIZAR VAGA
app.patch("/jobs/:id", async (req, res) => {
  const { id } = req.params;
  const {
    name,
    job_description,
    job_responsibilities,
    interview_type_ids = []
  } = req.body;

  try {
    // 1️⃣ Atualizar dados da vaga
    const result = await pool.query(
      `
      UPDATE public.jobs
      SET
        name = $1,
        job_description = $2,
        job_responsibilities = $3,
        updated_at = NOW()
      WHERE id = $4
      RETURNING *
      `,
      [name, job_description, job_responsibilities, id]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "Vaga não encontrada" });
    }

    // 2️⃣ Remover vínculos antigos
    await pool.query(
      `DELETE FROM public.job_interview_types WHERE job_id = $1`,
      [id]
    );

    // 3️⃣ Criar novos vínculos
    for (const typeId of interview_type_ids) {
      await pool.query(
        `
        INSERT INTO public.job_interview_types (job_id, interview_type_id)
        VALUES ($1, $2)
        ON CONFLICT DO NOTHING
        `,
        [id, typeId]
      );
    }

    res.json({ job: result.rows[0] });

  } catch (err) {
    console.error("Erro ao atualizar vaga:", err);
    res.status(500).json({ error: "Erro ao atualizar vaga" });
  }
});

// DELETAR VAGA
app.delete("/jobs/:id", async (req, res) => {
  const { id } = req.params;
  const { user_id } = req.query;

  try {
    const tenantId = await getTenantIdByUserId(user_id);

    const result = await pool.query(
      `
      DELETE FROM public.jobs
      WHERE id = $1
        AND tenant_id = $2
      `,
      [Number(id), tenantId]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "Vaga não encontrada" });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Erro ao deletar vaga:", err);
    res.status(500).json({ error: "Erro ao deletar vaga" });
  }
});

// LISTAR ROTEIROS
app.get("/interview_scripts", async (req, res) => {
  const { user_id } = req.query;

  try {
    const tenantId = await getTenantIdByUserId(user_id);

    const result = await pool.query(
      `
      SELECT *
      FROM public.interview_scripts
      WHERE tenant_id = $1
      ORDER BY id DESC
      `,
      [tenantId]
    );

    res.json({ scripts: result.rows });
  } catch (err) {
    console.error("Erro ao listar roteiros:", err);
    res.status(500).json({ error: "Erro ao listar roteiros" });
  }
});

// BUSCAR ROTEIRO
app.get("/interview_scripts/:id", async (req, res) => {
  const { id } = req.params;
  const { user_id } = req.query;

  try {
    const tenantId = await getTenantIdByUserId(user_id);

    const result = await pool.query(
      `
      SELECT *
      FROM public.interview_scripts
      WHERE id = $1
        AND tenant_id = $2
      `,
      [Number(id), tenantId]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "Roteiro não encontrado" });
    }

    res.json({ script: result.rows[0] });
  } catch (err) {
    console.error("Erro ao buscar roteiro:", err);
    res.status(500).json({ error: "Erro ao buscar roteiro" });
  }
});

// CRIAR ROTEIRO
app.post("/interview_scripts", async (req, res) => {
  const { user_id, name, interview_script } = req.body;

  try {
    const tenantId = await getTenantIdByUserId(user_id);

    const result = await pool.query(
      `
      INSERT INTO public.interview_scripts (
        tenant_id,
        user_id,
        name,
        interview_script
      )
      VALUES ($1, $2, $3, $4)
      RETURNING *
      `,
      [
        tenantId,
        Number(user_id),
        name,
        interview_script
      ]
    );

    res.json({ script: result.rows[0] });
  } catch (err) {
    console.error("Erro ao criar roteiro:", err);
    res.status(500).json({ error: "Erro ao criar roteiro" });
  }
});

// ATUALIZAR ROTEIRO
app.patch("/interview_scripts/:id", async (req, res) => {
  const { id } = req.params;
  const { user_id, name, interview_script } = req.body;

  try {
    const tenantId = await getTenantIdByUserId(user_id);

    const result = await pool.query(
      `
      UPDATE public.interview_scripts
      SET
        name = $1,
        interview_script = $2,
        updated_at = NOW()
      WHERE id = $3
        AND tenant_id = $4
      RETURNING *
      `,
      [
        name,
        interview_script,
        Number(id),
        tenantId
      ]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "Roteiro não encontrado" });
    }

    res.json({ script: result.rows[0] });
  } catch (err) {
    console.error("Erro ao atualizar roteiro:", err);
    res.status(500).json({ error: "Erro ao atualizar roteiro" });
  }
});

// DELETAR ROTEIRO DE ENTREVISTA
app.delete("/interview_scripts/:id", async (req, res) => {
  const { id } = req.params;
  const { user_id } = req.query;

  try {
    const tenantId = await getTenantIdByUserId(user_id);

    const result = await pool.query(
      `
      DELETE FROM public.interview_scripts
      WHERE id = $1
        AND tenant_id = $2
      `,
      [Number(id), tenantId]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "Roteiro não encontrado" });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Erro ao deletar roteiro:", err);
    res.status(500).json({ error: "Erro ao deletar roteiro" });
  }
});

// FAZ UPLOAD DO AUDIO
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

// LOADING DA TRANSCRIÇÃO
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

// GERA PARECER
app.post("/review", async (req, res) => {
  try {
    const {
      id,
      transcript,
      user_id,
      interview_type_id,
      candidate_id,
      candidate_name,
      job_id,
      interview_script_id,
      job_title,
      job_description,
      notes,
      interview_roadmap,
      job_responsibilities,
      company_values,
      metrics,
      audio_path
    } = req.body;

    // ------------------------------------------------------------------
    // 1️⃣ Tipo de entrevista / categoria
    // ------------------------------------------------------------------
    let InterviewTypeSchema = "";
    let category = null;

    if (interview_type_id && interview_type_id !== "none") {
      InterviewTypeSchema = await getInterviewTypeSchema(interview_type_id);
      category = InterviewTypeSchema?.category || null;
    } else {
      InterviewTypeSchema = "none";
    }

    // ------------------------------------------------------------------
    // 2️⃣ Gerar parecer
    // ------------------------------------------------------------------
    const review = await gerarReview({
      transcript,
      job_description,
      notes,
      interview_roadmap,
      job_responsibilities,
      job_title,
      InterviewTypeSchema,
      candidate_name
    });

    // ------------------------------------------------------------------
    // 3️⃣ Criar ou atualizar interview_reviews
    // ------------------------------------------------------------------
    let interviewId = id;

    if (id) {
      const updateResult = await pool.query(
        `
        UPDATE public.interview_reviews
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
          manual_review = $14,
          job_id = $15,
          interview_script_id = $16,
          candidate_name = $17,
          candidate_id = $18,
          category = $19
        WHERE id = $11
        RETURNING id
        `,
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
          null,
          job_id || null,
          interview_script_id || null,
          candidate_name || null,
          candidate_id || null,
          category || null
        ]
      );

      if (!updateResult.rowCount) {
        throw new Error("ID não encontrado para update");
      }

      interviewId = updateResult.rows[0].id;
    } else {
      const insertResult = await pool.query(
        `
        INSERT INTO public.interview_reviews (
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
          interview_type_id,
          job_id,
          interview_script_id,
          candidate_id,
          candidate_name,
          category
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
        RETURNING id
        `,
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
          interview_type_id,
          job_id || null,
          interview_script_id || null,
          candidate_name || null,
          candidate_id || null,
          category
        ]
      );

      interviewId = insertResult.rows[0].id;
    }

    // ------------------------------------------------------------------
    // 4️⃣ Criar / atualizar documento embedado da entrevista
    // ------------------------------------------------------------------
    await upsertCandidateDocument({
      candidate_id,
      job_id,
      category,
      source_id: interviewId,
      content: review
    });

    return res.json({ review });
  } catch (err) {
    console.error("❌ Erro no review:", err);
    return res.status(500).json({ error: "Erro ao gerar review" });
  }
});

// LISTAR ENTREVISTAS
app.get("/interviews", async (req, res) => {
  
  const userId = req.query.user_id;
  
  try {
    const result = await pool.query(
      `SELECT
      ir.id,
      ir.job_title,
      ir.candidate_name,
      ir.created_at,
      it.name AS interview_type_name,
      it.category AS interview_type_category
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

// BUSCA ENTREVISTA
app.get("/interviews/:id", async (req, res) => {
  const { id } = req.params;
  const { user_id } = req.query;

  if (!user_id) {
    return res.status(400).json({ error: "user_id é obrigatório" });
  }

  try {
    const tenantId = await getTenantIdByUserId(user_id);

    const result = await pool.query(
      `
      SELECT
        ir.id,
        ir.transcript,
        ir.metrics,
        ir.manual_review,
        ir.final_review,
        ir.review_feedback,
        ir.audio_path,

        ir.candidate_id,
        ir.job_id,
        ir.interview_type_id,

        -- recruiter_notes é a fonte de company_values e notes
        ir.recruiter_notes AS recruiter_notes,
        ir.recruiter_notes AS company_values,

        c.name AS candidate_name,

        j.name AS job_title,
        j.job_description,
        j.job_responsibilities,

        -- Fallback inteligente do roteiro
        COALESCE(
          NULLIF(ir.interview_roadmap, ''),
          s.interview_script
        ) AS interview_roadmap

      FROM public.interview_reviews ir

      LEFT JOIN public.candidates c
        ON c.id = ir.candidate_id
       AND c.tenant_id = ir.tenant_id

      LEFT JOIN public.jobs j
        ON j.id = ir.job_id
       AND j.tenant_id = ir.tenant_id

      LEFT JOIN public.interview_types it
        ON it.id = ir.interview_type_id
       AND it.tenant_id = ir.tenant_id

      LEFT JOIN public.interview_scripts s
        ON s.id = it.interview_script_id
       AND s.tenant_id = ir.tenant_id

      WHERE ir.id = $1
        AND ir.tenant_id = $2
      `,
      [id, tenantId] // id é UUID → NÃO usar Number()
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "Entrevista não encontrada" });
    }

    return res.json({ interview: result.rows[0] });
  } catch (err) {
    console.error("Erro ao buscar entrevista:", err);
    return res.status(500).json({ error: "Erro ao buscar entrevista" });
  }
});


// SALVA AUDIO DA ENTREVISTA
app.patch("/interviews/:id/audio_path", async (req, res) => {
  const { id } = req.params;
  const { audio_path, user_id } = req.body;

  try {
    const tenantId = await getTenantIdByUserId(user_id);

    const result = await pool.query(
      `
      UPDATE public.interview_reviews
      SET audio_path = $1
      WHERE id = $2
        AND tenant_id = $3
      `,
      [audio_path, Number(id), tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Entrevista não encontrada" });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Erro ao salvar audio_path:", err);
    res.status(500).json({ error: "Erro interno ao salvar caminho do áudio" });
  }
});

// CRIAR ENTREVISTA
app.post("/interviews/create", async (req, res) => {
  const { user_id } = req.body;

  try {
    const tenantId = await getTenantIdByUserId(user_id);

    const result = await pool.query(
      `
      INSERT INTO public.interview_reviews (
        tenant_id,
        user_id,
        created_at
      )
      VALUES ($1,$2,NOW())
      RETURNING id
      `,
      [tenantId, Number(user_id)]
    );

    res.json({ id: result.rows[0].id });
  } catch (err) {
    console.error("Erro ao criar entrevista:", err);
    res.status(500).json({ error: "Erro ao criar entrevista" });
  }
});

// ATUALIZA ENTREVISTA E PARECER
app.patch("/interviews/:id/manual_review", async (req, res) => {
  const { id } = req.params;
  const { manual_review, user_id } = req.body;

  try {
    // --------------------------------------------------
    // 1️⃣ Resolver tenant do usuário
    // --------------------------------------------------
    const tenantId = await getTenantIdByUserId(user_id);

    // --------------------------------------------------
    // 2️⃣ Atualizar parecer validando tenant
    // --------------------------------------------------
    const result = await pool.query(
      `
      UPDATE public.interview_reviews
      SET
        manual_review = $1,
        final_review = $1,
        created_at = NOW()
      WHERE id = $2
        AND tenant_id = $3
      RETURNING
        id,
        candidate_id,
        job_id,
        category
      `,
      [manual_review, Number(id), tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Entrevista não encontrada" });
    }

    const interview = result.rows[0];

    // --------------------------------------------------
    // 3️⃣ Atualizar documento embedado da entrevista
    // --------------------------------------------------
    await upsertCandidateDocument({
      candidate_id: interview.candidate_id,
      job_id: interview.job_id,
      category: interview.category,
      source_id: interview.id,
      content: manual_review
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error("Erro ao salvar parecer manual:", err);
    return res.status(500).json({ error: "Erro interno ao salvar parecer" });
  }
});

// FEEDBACK DO ENTREVISTA E PARECER
app.patch("/interviews/:id/review_feedback", async (req, res) => {
  const { id } = req.params;
  const { review_feedback, user_id } = req.body;

  if (!["positivo", "negativo"].includes(review_feedback)) {
    return res.status(400).json({ error: "Feedback inválido" });
  }

  try {
    const tenantId = await getTenantIdByUserId(user_id);

    const result = await pool.query(
      `
      UPDATE public.interview_reviews
      SET review_feedback = $1
      WHERE id = $2
        AND tenant_id = $3
      `,
      [review_feedback, Number(id), tenantId]
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

// ADICIONA TIPO DE ENTREVISTA
app.post("/interview_types", async (req, res) => {
  const { user_id, name, category, interview_script_id } = req.body;

  if (!user_id || !name || !category) {
    return res.status(400).json({ error: "Parâmetros obrigatórios ausentes" });
  }

  try {
    const tenantId = await getTenantIdByUserId(user_id);

    const result = await pool.query(
      `
      INSERT INTO public.interview_types (
        user_id,
        name,
        category,
        tenant_id,
        interview_script_id
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
      `,
      [
        Number(user_id),
        name,
        category,
        tenantId,
        interview_script_id || null
      ]
    );

    res.json({ type: result.rows[0] });
  } catch (err) {
    console.error("Erro ao criar tipo de entrevista:", err);
    res.status(500).json({ error: "Erro ao criar tipo de entrevista" });
  }
});

// PEGA TODOS OS TIPOS DE ENTREVISTA
app.get("/interview_types", async (req, res) => {
  const { user_id } = req.query;

  try {
    const tenantId = await getTenantIdByUserId(user_id);

    const result = await pool.query(
      `
      SELECT
        id,
        name,
        category,
        interview_script_id
      FROM interview_types
      WHERE tenant_id = $1
      ORDER BY name
      `,
      [tenantId]
    );

    res.json({ types: result.rows });
  } catch (err) {
    console.error("Erro ao listar tipos de entrevista:", err);
    res.status(500).json({ error: "Erro ao listar tipos de entrevista" });
  }
});

// BUSCA TIPOS DE ENTREVISTA
app.get("/interview_types/:id", async (req, res) => {
  const { id } = req.params;
  const { user_id } = req.query;

  try {
    const tenantId = await getTenantIdByUserId(user_id);

    // 1️⃣ Buscar tipo validando tenant
    const typeResult = await pool.query(
      `
      SELECT *
      FROM public.interview_types
      WHERE id = $1
        AND tenant_id = $2
      `,
      [Number(id), tenantId]
    );

    if (!typeResult.rowCount) {
      return res.status(404).json({ error: "Tipo de entrevista não encontrado" });
    }

    // 2️⃣ Buscar competências do tipo
    const competenciesResult = await pool.query(
      `
      SELECT *
      FROM public.competencies
      WHERE interview_type_id = $1
      ORDER BY id ASC
      `,
      [Number(id)]
    );

    res.json({
      type: typeResult.rows[0],
      competencies: competenciesResult.rows
    });
  } catch (err) {
    console.error("Erro ao buscar tipo de entrevista:", err);
    res.status(500).json({ error: "Erro ao buscar tipo de entrevista" });
  }
});

// LISTAR TIPOS DE ENTREVISTA DE UMA VAGA
app.get("/jobs/:id/interview_types", async (req, res) => {
  const { id: jobId } = req.params;
  const { user_id } = req.query;

  if (!user_id) {
    return res.status(400).json({ error: "user_id é obrigatório" });
  }

  if (!jobId || Number.isNaN(Number(jobId))) {
    return res.status(400).json({ error: "job_id inválido" });
  }

  try {
    const tenantId = await getTenantIdByUserId(user_id);

    const result = await pool.query(
      `
      SELECT
        it.id,
        it.name,
        it.category,
        it.interview_script_id,
        s.interview_script
      FROM public.job_interview_types jit
      INNER JOIN public.interview_types it
        ON it.id = jit.interview_type_id
      LEFT JOIN public.interview_scripts s
        ON s.id = it.interview_script_id
       AND s.tenant_id = it.tenant_id
      WHERE jit.job_id = $1
        AND it.tenant_id = $2
      ORDER BY it.name ASC
      `,
      [Number(jobId), tenantId]
    );

    return res.json({ types: result.rows });
  } catch (err) {
    console.error("Erro ao listar tipos da vaga:", err);
    return res.status(500).json({ error: "Erro ao listar tipos da vaga" });
  }
});

// ATUALIZA TIPO DE ENTREVISTA
app.patch("/interview_types/:id", async (req, res) => {
  const { id } = req.params;
  const { user_id, name, category, interview_script_id } = req.body;

  if (!user_id || !id) {
    return res.status(400).json({ error: "user_id e id são obrigatórios" });
  }

  try {
    const tenantId = await getTenantIdByUserId(user_id);

    const result = await pool.query(
      `
      UPDATE public.interview_types
      SET
        name = $1,
        category = $2,
        interview_script_id = $3,
        updated_at = NOW()
      WHERE id = $4
        AND tenant_id = $5
      RETURNING *
      `,
      [
        name,
        category,
        interview_script_id || null,
        Number(id),
        tenantId
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        error: "Tipo de entrevista não encontrado ou sem permissão"
      });
    }

    res.json({ type: result.rows[0] });

  } catch (err) {
    console.error("Erro ao atualizar tipo de entrevista:", err);
    res.status(500).json({ error: "Erro ao atualizar tipo de entrevista" });
  }
});

// DELETAR TIPO DE ENTREVISTA
app.delete("/interview_types/:id", async (req, res) => {
  const { id } = req.params;
  const { user_id } = req.query;

  try {
    const tenantId = await getTenantIdByUserId(user_id);

    const result = await pool.query(
      `
      DELETE FROM public.interview_types
      WHERE id = $1
        AND tenant_id = $2
      `,
      [Number(id), tenantId]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "Tipo de entrevista não encontrado" });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Erro ao deletar tipo de entrevista:", err);
    res.status(500).json({ error: "Erro ao deletar tipo de entrevista" });
  }
});

// CADASTRA COMPETENCIA
app.post("/interview_types/:typeId/competencies", async (req, res) => {
  const { typeId } = req.params;
  const { user_id } = req.body;

  const {
    name,
    description,
    insuficiente,
    abaixo_do_esperado,
    dentro_expectativas,
    excepcional
  } = req.body;

  try {
    // 1️⃣ Resolver tenant do usuário
    const tenantId = await getTenantIdByUserId(user_id);

    // 2️⃣ Validar se o tipo pertence ao tenant
    const typeCheck = await pool.query(
      `
      SELECT id
      FROM public.interview_types
      WHERE id = $1
        AND tenant_id = $2
      `,
      [Number(typeId), tenantId]
    );

    if (!typeCheck.rowCount) {
      return res.status(403).json({
        error: "Tipo de entrevista inválido ou fora do seu tenant"
      });
    }

    // 3️⃣ Criar competência
    const result = await pool.query(
      `
      INSERT INTO public.competencies
      (
        interview_type_id,
        name,
        description,
        insuficiente,
        abaixo_do_esperado,
        dentro_expectativas,
        excepcional
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING *
      `,
      [
        Number(typeId),
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

// EDITA COMPETÊNCIA 
app.patch("/competencies/:id", async (req, res) => {
  const { id } = req.params;
  const { user_id } = req.body;

  const {
    name,
    description,
    insuficiente,
    abaixo_do_esperado,
    dentro_expectativas,
    excepcional
  } = req.body;

  try {
    const tenantId = await getTenantIdByUserId(user_id);

    // 1️⃣ Validar se a competência pertence ao tenant
    const check = await pool.query(
      `
      SELECT c.id
      FROM public.competencies c
      JOIN public.interview_types it
        ON it.id = c.interview_type_id
      WHERE c.id = $1
        AND it.tenant_id = $2
      `,
      [Number(id), tenantId]
    );

    if (!check.rowCount) {
      return res.status(403).json({
        error: "Competência não encontrada ou fora do seu tenant"
      });
    }

    // 2️⃣ Atualizar competência
    const result = await pool.query(
      `
      UPDATE public.competencies
      SET
        name = $1,
        description = $2,
        insuficiente = $3,
        abaixo_do_esperado = $4,
        dentro_expectativas = $5,
        excepcional = $6,
        updated_at = NOW()
      WHERE id = $7
      RETURNING *
      `,
      [
        name,
        description,
        insuficiente,
        abaixo_do_esperado,
        dentro_expectativas,
        excepcional,
        Number(id)
      ]
    );

    res.json({ competency: result.rows[0] });
  } catch (err) {
    console.error("Erro ao atualizar competência:", err);
    res.status(500).json({ error: "Erro interno" });
  }
});

// DELETAR COMPETÊNCIAS
app.delete("/competencies/:id", async (req, res) => {
  const { id } = req.params;
  const { user_id } = req.query;

  try {
    const tenantId = await getTenantIdByUserId(user_id);

    // 1️⃣ Validar se a competência pertence ao tenant
    const check = await pool.query(
      `
      SELECT c.id
      FROM public.competencies c
      JOIN public.interview_types it
        ON it.id = c.interview_type_id
      WHERE c.id = $1
        AND it.tenant_id = $2
      `,
      [Number(id), tenantId]
    );

    if (!check.rowCount) {
      return res.status(403).json({
        error: "Competência não encontrada ou fora do seu tenant"
      });
    }

    // 2️⃣ Deletar competência
    await pool.query(
      `
      DELETE FROM public.competencies
      WHERE id = $1
      `,
      [Number(id)]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("Erro ao deletar competência:", err);
    res.status(500).json({ error: "Erro interno" });
  }
});

// SUGERE COMPETÊNCIAS
app.post("/interview_types/:id/suggest_competencies", async (req, res) => {
  const interviewTypeId = Number(req.params.id);
  const {
    user_id,
    job_id,
    job_context,
    interview_type_name,
    category
  } = req.body;

  // -------------------------------------------------------------------------
  // Validações básicas
  // -------------------------------------------------------------------------
  if (!user_id) {
    return res.status(400).json({
      error: "user_id é obrigatório"
    });
  }

  if (!job_id && !job_context) {
    return res.status(400).json({
      error: "Informe job_id OU job_context"
    });
  }

  try {
    // -----------------------------------------------------------------------
    // 1️⃣ Resolver TIPO DE ENTREVISTA
    // -----------------------------------------------------------------------
    let interviewType;

    // 🔹 MODO INLINE (tipo ainda não existe)
    if (interviewTypeId === 0 && job_context) {
      if (!interview_type_name || !category) {
        return res.status(400).json({
          error: "interview_type_name e category são obrigatórios no modo inline"
        });
      }

      interviewType = {
        name: interview_type_name,
        category
      };

    // 🔹 MODO NORMAL (tipo já existe)
    } else {
      if (!interviewTypeId) {
        return res.status(400).json({
          error: "interview_type_id inválido"
        });
      }

      const typeResult = await pool.query(
        `
        SELECT id, name, category
        FROM public.interview_types
        WHERE id = $1 AND user_id = $2
        `,
        [interviewTypeId, user_id]
      );

      if (!typeResult.rowCount) {
        return res.status(404).json({
          error: "Tipo de entrevista não encontrado"
        });
      }

      interviewType = typeResult.rows[0];
    }

    // -----------------------------------------------------------------------
    // 2️⃣ Resolver CONTEXTO DA VAGA
    // -----------------------------------------------------------------------
    let job;

    // 🔹 MODO NORMAL — vaga existente
    if (job_id) {
      const jobResult = await pool.query(
        `
        SELECT id, name, job_description, job_responsibilities
        FROM public.jobs
        WHERE id = $1 AND user_id = $2
        `,
        [job_id, user_id]
      );

      if (!jobResult.rowCount) {
        return res.status(404).json({
          error: "Vaga não encontrada"
        });
      }

      job = jobResult.rows[0];

      // ---------------------------------------------------------------------
      // Validar vínculo vaga ↔ tipo (somente se tipo existir)
      // ---------------------------------------------------------------------
      if (interviewTypeId !== 0) {
        const linkResult = await pool.query(
          `
          SELECT 1
          FROM public.job_interview_types
          WHERE job_id = $1 AND interview_type_id = $2
          `,
          [job_id, interviewTypeId]
        );

        if (!linkResult.rowCount) {
          return res.status(400).json({
            error: "Esta vaga não está vinculada a este tipo de entrevista"
          });
        }
      }

    // 🔹 MODO INLINE — vaga em criação
    } else {
      if (!job_context?.name) {
        return res.status(400).json({
          error: "job_context.name é obrigatório"
        });
      }

      job = {
        name: job_context.name,
        job_description: job_context.job_description || "Não informado",
        job_responsibilities: job_context.job_responsibilities || "Não informado"
      };
    }

    // -----------------------------------------------------------------------
    // 3️⃣ Prompt da IA (único, reutilizado)
    // -----------------------------------------------------------------------
    const prompt = `
Você é um especialista sênior em recrutamento e seleção.

Seu objetivo é sugerir competências que devem ser avaliadas em uma entrevista,
com base na vaga e no tipo de entrevista.

CONTEXTO DA VAGA:
Nome da vaga: ${job.name}
Descrição da vaga: ${job.job_description}
Responsabilidades: ${job.job_responsibilities}

INSTRUÇÕES:
- Sugira de 4 a 6 competências.
- Os nomes devem ser curtos e claros.
- As competências devem ser coerentes com a categoria da entrevista.
- NÃO descreva níveis de avaliação.
- NÃO gere textos longos.
- NÃO use markdown.
- Responda EXCLUSIVAMENTE em JSON válido.

FORMATO DE SAÍDA:
{
  "competencies": [
    {
      "name": "Nome da competência",
      "reason": "Justificativa objetiva (1 ou 2 frases)"
    }
  ]
}
`;

    // -----------------------------------------------------------------------
    // 4️⃣ Chamada OpenAI
    // -----------------------------------------------------------------------
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.6,
      messages: [
        {
          role: "system",
          content: "Você sugere competências profissionais (culturais, comportamentais e técnicas) para entrevistas de processo seletivo."
        },
        {
          role: "user",
          content: prompt
        }
      ]
    });

    const raw = completion.choices[0].message.content;

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.error("Resposta inválida da IA:", raw);
      return res.status(500).json({
        error: "Falha ao interpretar resposta da IA"
      });
    }

    // -----------------------------------------------------------------------
    // 5️⃣ Resposta final
    // -----------------------------------------------------------------------
    return res.json({
      ok: true,
      competencies: parsed.competencies || []
    });

  } catch (err) {
    console.error("Erro ao sugerir competências:", err);
    return res.status(500).json({
      error: "Erro interno ao sugerir competências"
    });
  }
});

// GERAR TEXTOS DA COMPETÊNCIA
app.post("/interview_types/competencies/generate_texts", async (req, res) => {
  const {
    user_id,
    competency_name,
    interview_type_name,
    job_context = {}
  } = req.body;

  if (!user_id || !interview_type_name || !competency_name) {
    return res.status(400).json({
      error: "Parâmetros obrigatórios: user_id, interview_type_name, category, competency_name"
    });
  }

  const {
    name: job_name = "",
    job_description = "",
    job_responsibilities = ""
  } = job_context;

  try {

    const prompt = `
      PAPEL:
      Você é um especialista sênior em recrutamento e seleção com ampla experiência em entrevistas estruturadas e avaliação por competências.

      OBJETIVO:
      Gerar uma régua de avaliação técnica ou comportamental altamente estruturada, específica para a vaga informada e adequada para classificação futura baseada na transcrição da entrevista.

      IMPORTANTE:
      Essa régua será utilizada posteriormente por outro sistema (humano ou IA) para classificar o nível do candidato com base exclusivamente nas evidências presentes na transcrição da entrevista.

      FORMATO DE SAÍDA (OBRIGATÓRIO):
      Responda EXCLUSIVAMENTE em JSON válido:

      {
        "description": "texto",
        "insuficiente": "texto",
        "abaixo_do_esperado": "texto",
        "dentro_expectativas": "texto",
        "excepcional": "texto"
      }

      REGRAS TÉCNICAS:

      - Não utilize markdown.
      - Não inclua comentários ou qualquer texto fora do JSON.
      - Use português do Brasil.
      - Cada campo deve ter entre 2 e 4 frases curtas e objetivas.
      - Utilize o contexto da vaga para tornar a régua específica.
      - Caso o contexto seja insuficiente, utilize apenas o nome da competência sem inventar cenários inexistentes.
      - A diferenciação entre níveis deve ser progressiva e clara.

      CONTEXTO DA VAGA:

      NOME DA VAGA:
      """
      ${job_name || interview_type_name}
      """

      DESCRIÇÃO DA VAGA:
      """
      ${job_description || "Não informado"}
      """

      RESPONSABILIDADES:
      """
      ${job_responsibilities || "Não informado"}
      """

      COMPETÊNCIA A SER AVALIADA:
      """
      ${competency_name}
      """

      PRINCÍPIO DE CONSTRUÇÃO DA RÉGUA:

      A progressão entre os níveis deve considerar obrigatoriamente:

      1. Presença ou ausência de exemplos concretos.
      2. Profundidade e estrutura do relato.
      3. Grau de autonomia demonstrado.
      4. Complexidade do contexto descrito.
      5. Impacto e resultado evidenciado.
      6. Consistência das evidências ao longo da entrevista.

      Cada nível deve evoluir de forma clara nesses critérios.

      REGRAS DE CONTEÚDO:

      description:
      - Defina a competência aplicada especificamente a esta vaga.
      - Relacione diretamente com responsabilidades e entregas esperadas.
      - Explique o impacto prático dessa competência no desempenho do cargo.

      insuficiente:
      - Ausência de exemplos concretos na entrevista.
      - Respostas genéricas, teóricas ou desconectadas da prática.
      - Incapacidade de explicar aplicação real da competência.
      - Nenhuma evidência de impacto ou resultado.
      - Dependência excessiva de terceiros nas situações descritas.

      abaixo_do_esperado:
      - Exemplos superficiais ou pouco estruturados.
      - Aplicação restrita a contextos simples ou pouco relevantes.
      - Baixa clareza sobre resultados alcançados.
      - Demonstra autonomia limitada.
      - Impacto pouco significativo ou mal explicado.

      dentro_expectativas:
      - Exemplos concretos e contextualizados.
      - Aplicação consistente da competência nas responsabilidades descritas.
      - Demonstra autonomia adequada ao nível da vaga.
      - Conecta ações a resultados objetivos.
      - Evidências compatíveis com as exigências do cargo.

      excepcional:
      - Múltiplos exemplos estruturados e bem contextualizados.
      - Alto grau de autonomia e protagonismo.
      - Demonstra aplicação em contextos complexos ou estratégicos.
      - Evidencia impacto mensurável, melhoria de resultados ou geração de valor.
      - Vai além das responsabilidades esperadas para o cargo.

      IMPORTANTE:

      - Descreva comportamentos observáveis em entrevista.
      - Evite julgamentos psicológicos ou subjetivos.
      - Não repita textos entre os níveis.
      - Diferencie claramente cada nível da escala.
      - A régua deve permitir classificação objetiva baseada apenas na transcrição.
      `;


    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.7,
      messages: [
        {
          role: "system",
          content: "Você gera textos estruturados e objetivos para avaliação de competências com base no contexto de uma vaga."
        },
        { role: "user", content: prompt }
      ]
    });

    const raw = completion.choices[0].message.content;

    let parsed;

    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.error("Resposta inválida da IA:", raw);
      return res.status(500).json({
        error: "Falha ao interpretar resposta da IA"
      });
    }

    return res.json({ ok: true, texts: parsed });

  } catch (err) {
    console.error("Erro ao gerar textos da competência:", err);
    return res.status(500).json({
      error: "Erro interno ao gerar textos da competência"
    });
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
    `SELECT name, category FROM public.interview_types WHERE id = $1`,
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
    category: typeRes.rows[0].category,
    competences: compRes.rows
  };
}

async function getTenantIdByUserId(userId) {
  if (!userId) {
    throw new Error("user_id é obrigatório");
  }

  const result = await pool.query(
    `
    SELECT tenant_id
    FROM public.users
    WHERE id = $1
    `,
    [Number(userId)]
  );

  if (!result.rowCount) {
    throw new Error("Usuário inválido");
  }

  return result.rows[0].tenant_id;
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
