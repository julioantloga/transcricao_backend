/* =============================================================================
   FILE: backfillCandidateDocuments.js
   RESPONSABILIDADE: Backfill de documentos (currículos e entrevistas)
   ============================================================================= */

import { generateEmbedding } from "../services/embeddings.js";
import dotenv from "dotenv";
import pool from "../db.js";

dotenv.config();

async function backfill() {
  console.log("🚀 Iniciando backfill de candidate_documents");

  /* ========================================================================
     1️⃣ CURRÍCULOS
     ======================================================================== */
  const candidates = await pool.query(`
    SELECT id, resume_transcript
    FROM public.candidates
    WHERE resume_transcript IS NOT NULL
      AND resume_transcript <> ''
  `);

  for (const c of candidates.rows) {
    const exists = await pool.query(
      `
      SELECT 1
      FROM public.candidate_documents
      WHERE candidate_id = $1
        AND category = 'resume'
        AND source_id IS NULL
      `,
      [c.id]
    );

    if (exists.rowCount) continue;

    console.log(`📄 Gerando embedding do currículo (candidate_id=${c.id})`);

    const embedding = await generateEmbedding(c.resume_transcript);

    await pool.query(
      `
      INSERT INTO public.candidate_documents (
        candidate_id,
        category,
        source_id,
        content,
        embedding
      )
      VALUES ($1, 'resume', NULL, $2, $3)
      `,
      [c.id, c.resume_transcript, embedding]
    );
  }

  /* ========================================================================
     2️⃣ ENTREVISTAS
     ======================================================================== */
  const interviews = await pool.query(`
    SELECT
      id,
      candidate_id,
      job_id,
      category,
      final_review
    FROM public.interview_reviews
    WHERE final_review IS NOT NULL
      AND candidate_id IS NOT NULL
  `);

  for (const ir of interviews.rows) {
    const exists = await pool.query(
      `
      SELECT 1
      FROM public.candidate_documents
      WHERE source_id = $1
      `,
      [ir.id]
    );

    if (exists.rowCount) continue;

    console.log(`🧠 Gerando embedding da entrevista (id=${ir.id})`);

    const embedding = await generateEmbedding(ir.final_review);

    await pool.query(
      `
      INSERT INTO public.candidate_documents (
        candidate_id,
        job_id,
        category,
        source_id,
        content,
        embedding
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        ir.candidate_id,
        ir.job_id,
        ir.category,
        ir.id,
        ir.final_review,
        embedding
      ]
    );
  }

  console.log("✅ Backfill concluído com sucesso");
  process.exit(0);
}

backfill().catch(err => {
  console.error("❌ Erro no backfill:", err);
  process.exit(1);
});


/* =============================================================================
   FILE: candidateDocuments.js
   RESPONSABILIDADE: Upsert idempotente de documentos embedados
   ============================================================================= */

import pool from "../db.js";
import { generateEmbedding } from "./embeddings.js";

export async function upsertCandidateDocument({
  candidate_id,
  job_id = null,
  category = null,
  source_id = null,
  content
}) {
  if (!candidate_id || !content || !content.trim()) {
    return;
  }

  const embedding = await generateEmbedding(content);

  let exists;

  if (source_id) {
    exists = await pool.query(
      `
      SELECT id
      FROM public.candidate_documents
      WHERE source_id = $1
      `,
      [String(source_id)]
    );
  } else {
    exists = await pool.query(
      `
      SELECT id
      FROM public.candidate_documents
      WHERE candidate_id = $1
        AND category = $2
        AND source_id IS NULL
      `,
      [candidate_id, category]
    );
  }

  if (exists.rowCount) {
    await pool.query(
      `
      UPDATE public.candidate_documents
      SET
        candidate_id = $1,
        job_id = $2,
        category = $3,
        content = $4,
        embedding = $5,
        created_at = NOW()
      WHERE id = $6
      `,
      [
        candidate_id,
        job_id,
        category,
        content,
        embedding,
        exists.rows[0].id
      ]
    );
  } else {
    await pool.query(
      `
      INSERT INTO public.candidate_documents (
        candidate_id,
        job_id,
        category,
        source_id,
        content,
        embedding
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        candidate_id,
        job_id,
        category,
        source_id ? String(source_id) : null,
        content,
        embedding
      ]
    );
  }
}


/* =============================================================================
   FILE: embeddings.js
   RESPONSABILIDADE: Geração de embeddings e similaridade vetorial
   ============================================================================= */

import OpenAI from "openai";
import dotenv from "dotenv";
dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

export async function generateEmbedding(text) {
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text
  });

  return response.data[0].embedding;
}

export function cosineSimilarity(a, b) {
  let dot = 0.0;
  let normA = 0.0;
  let normB = 0.0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}


/* =============================================================================
FILE: jobChat.js
RESPONSABILIDADE: Chat RAG sobre candidatos por vaga
============================================================================= */

import OpenAI from "openai";
import dotenv from "dotenv";
import pool from "../db.js";
import { generateEmbedding, cosineSimilarity } from "./embeddings.js";

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// SIMPLES: sempre as 4 últimas mensagens (user+assistant)
const HISTORY_LIMIT = 4;
const TOP_K = 20;

async function getLastMessages({ jobId, userId }) {
  const result = await pool.query(
    `
    SELECT role, content
    FROM public.job_chat_messages
    WHERE job_id = $1 AND user_id = $2
    ORDER BY id DESC
    LIMIT $3
    `,
    [jobId, userId, HISTORY_LIMIT]
  );

  // veio DESC; devolvemos em ordem cronológica
  return result.rows.reverse().map(r => ({
    role: r.role,
    content: r.content
  }));
}

async function saveMessage({ jobId, userId, role, content }) {
  const text = (content || "").trim();
  if (!text) return;

  await pool.query(
    `
    INSERT INTO public.job_chat_messages (job_id, user_id, role, content)
    VALUES ($1, $2, $3, $4)
    `,
    [jobId, userId, role, text]
  );
}

export async function handleJobChat({ jobId, tenantId, userId, question }) {
  const q = (question || "").trim();
  if (!q) return "Desculpe, não consigo te ajudar";

  // 1) Histórico curto (4)
  const history = await getLastMessages({
    jobId: Number(jobId),
    userId: Number(userId)
  });

  // 2) RAG (igual ao atual)
  const questionEmbedding = await generateEmbedding(q);

  const docsResult = await pool.query(
    `
      SELECT
        cd.candidate_id,
        cd.category,
        cd.content,
        cd.embedding,
        c.name AS candidate_name
      FROM public.candidate_documents cd
      JOIN public.candidates c
        ON c.id = cd.candidate_id
      WHERE cd.job_id = $1
        AND cd.tenant_id = $2
      `,
      [jobId, tenantId]
  );

  // Salva a pergunta mesmo se não houver docs (pra manter histórico coerente)
  await saveMessage({ jobId, userId, role: "user", content: q });

  if (!docsResult.rows.length) {
    const fallback = "Não há dados suficientes para responder.";
    await saveMessage({ jobId, userId, role: "assistant", content: fallback });
    return fallback;
  }

  const scoredDocs = docsResult.rows.map(doc => ({
    ...doc,
    score: cosineSimilarity(questionEmbedding, doc.embedding)
  }));

  const topDocs = scoredDocs
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_K);

  const candidateMap = {};
  for (const doc of topDocs) {
    if (!candidateMap[doc.candidate_id]) {
      candidateMap[doc.candidate_id] = { name: doc.name, docs: [] };
    }
    candidateMap[doc.candidate_id].docs.push({
      category: doc.category,
      content: doc.content
    });
  }

  let context = `DADOS DOS CANDIDATOS\n`;
  for (const c of Object.values(candidateMap)) {
    context += `\n-------------------------\nCANDIDATO: ${c.name}\n`;
    for (const d of c.docs) {
      context += `\n[${d.category?.toUpperCase() || "GERAL"}]\n${d.content}\n`;
    }
  }

  const systemPrompt = `
Você é um especialista sênior em recrutamento e seleção.
Seu papel é apoiar um recrutador humano, respondendo perguntas analíticas sobre os candidatos que participaram do processo seletivo.

Contexto do seu trabalho:
- Você está analisando candidatos vinculados a uma vaga específica.
- O recrutador fará perguntas comparativas, investigativas e de aprofundamento.
- Suas respostas devem ajudar na tomada de decisão do recrutador.

Regras obrigatórias:
- Utilize exclusivamente os dados fornecidos no contexto.
- Não faça suposições nem invente informações.
- Baseie conclusões apenas em evidências explícitas.
- Seja técnico, objetivo, claro e direto.
- Quando não houver dados suficientes, diga explicitamente que não é possível concluir.
`;

  // 3) Prompt: system + contexto RAG + histórico + pergunta atual
  const messages = [
    { role: "system", content: systemPrompt },

    // Contexto factual (RAG) separado
    {
      role: "system",
      content: `CONTEXTO (RAG):\n${context}`
    },

    // Histórico
    ...history,

    // Pergunta atual
    { role: "user", content: q }
  ];

  const completion = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0.2,
    messages
  });

  const answer =
    completion?.choices?.[0]?.message?.content?.trim() ||
    "Desculpe, não consigo te ajudar";

  await saveMessage({ jobId, userId, role: "assistant", content: answer });
  return answer;
}


/* =============================================================================
   FILE: review.js
   RESPONSABILIDADE: Geração de parecer de entrevista
   ============================================================================= */

import OpenAI from "openai";
import { encoding_for_model } from "@dqbd/tiktoken";
import dotenv from "dotenv";

import { promptGeral } from "./prompts/geral.js";
import { promptCultura } from "./prompts/cultura.js";
import { promptTecnica } from "./prompts/tecnica.js";
import { promptGestorLider } from "./prompts/gestor_lider.js";

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

export async function gerarReview({
  transcript,
  job_description,
  notes,
  interview_roadmap,
  job_responsibilities,
  company_values,
  job_title,
  candidate_name,
  InterviewTypeSchema
}) {
  const data_prompt = {
    transcript,
    job_description,
    job_responsibilities,
    interview_roadmap,
    company_values,
    notes,
    job_title,
    candidate_name,
    InterviewTypeSchema
  };

  let prompt = "";

  if (!InterviewTypeSchema || InterviewTypeSchema === "none") {
    prompt = promptGeral({ data_prompt });
  } else {
    switch (InterviewTypeSchema.category) {
      case "cultura":
        prompt = promptCultura({ data_prompt });
        break;
      case "tecnica":
        prompt = promptTecnica({ data_prompt });
        break;
      case "gestor_lider":
        prompt = promptGestorLider({ data_prompt });
        break;
      default:
        prompt = promptGeral({ data_prompt });
    }
  }

  const enc = encoding_for_model("gpt-4-1106-preview");
  console.log("Total de tokens:", enc.encode(prompt).length);

  const resposta = await openai.chat.completions.create({
    model: "gpt-4-1106-preview",
    messages: [
      { role: "system", content: "Você é um recrutador técnico especialista." },
      { role: "user", content: prompt }
    ],
    temperature: 0.7,
    max_tokens: 3000
  });

  return resposta.choices[0]?.message?.content?.trim()
    || "Não foi possível gerar o parecer.";
}
