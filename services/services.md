/* backfillCandidateDocuments.js */
import { generateEmbedding } from "../services/embeddings.js";
import dotenv from "dotenv";
import pool from "../db.js";

dotenv.config();

async function backfill() {
  console.log("🚀 Iniciando backfill de candidate_documents");

  /* ===========================================================================
  1️⃣ CURRÍCULOS
  =========================================================================== */
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

  /* ===========================================================================
  2️⃣ ENTREVISTAS
  =========================================================================== */
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



/*candidateDocuments.js*/
import pool from "../db.js";
import { generateEmbedding } from "./embeddings.js";

/**
 * Cria ou atualiza um documento embedado do candidato.
 * Estratégia idempotente:
 * - Se existir (via source_id) → UPDATE
 * - Senão → INSERT
 *
 * @param {Object} params
 * @param {number} params.candidate_id
 * @param {number|null} params.job_id
 * @param {string|null} params.category
 * @param {string|null} params.source_id  // id lógico da origem (ex: interview_reviews.id)
 * @param {string} params.content         // texto a ser embedado
 */
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

  // ------------------------------------------------------------------
  // Verifica se o documento já existe (chave lógica = source_id)
  // Para currículo: source_id = NULL + category = 'resume'
  // ------------------------------------------------------------------
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
    // UPDATE
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
    // INSERT
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


/*embeddings.js*/
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

/* Similaridade de cosseno */
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

/* jobChat.js */
import OpenAI from "openai";
import pool from "../db.js";
import dotenv from "dotenv";
import {
  generateEmbedding,
  cosineSimilarity
} from "./embeddings.js";

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

export async function handleJobChat({ jobId, userId, question }) {

  /* Embedding da pergunta */
  const questionEmbedding = await generateEmbedding(question);

  /* Buscar documentos da vaga */
  const docsResult = await pool.query(
    `
    SELECT
      cd.candidate_id,
      cd.category,
      cd.content,
      cd.embedding,
      c.name
    FROM public.candidate_documents cd
    INNER JOIN public.candidates c
      ON c.id = cd.candidate_id
    WHERE
      cd.job_id = $1
      AND c.user_id = $2
    `,
    [jobId, userId]
  );

  if (!docsResult.rows.length) {
    return "Não há dados suficientes para responder.";
  }

  /* Calcular similaridade */
  const scoredDocs = docsResult.rows.map(doc => ({
    ...doc,
    score: cosineSimilarity(questionEmbedding, doc.embedding)
  }));

  /* Top K documentos */
  const TOP_K = 20;

  const topDocs = scoredDocs
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_K);

  /* Agrupar por candidato */
  const candidateMap = {};

  for (const doc of topDocs) {
    if (!candidateMap[doc.candidate_id]) {
      candidateMap[doc.candidate_id] = {
        name: doc.name,
        docs: []
      };
    }

    candidateMap[doc.candidate_id].docs.push({
      category: doc.category,
      content: doc.content
    });
  }

  /* Montar contexto enxuto */
  let context = `ANÁLISE DE CANDIDATOS\n`;
  let systemPrompt = `Você é um analista sênior de recrutamento e seleção.
            Use exclusivamente os dados fornecidos.
            Não invente informações.
            Se não souber o que responder resonda: "Desculpe, não consigo te ajudar"
            Seja técnico, claro e direto.`;

  for (const c of Object.values(candidateMap)) {
    context += `
-------------------------
CANDIDATO: ${c.name}
`;

    for (const d of c.docs) {
      context += `
[${d.category?.toUpperCase() || "GERAL"}]
${d.content}
`;
    }
  }

  /* Chamada ao LLM */
  const completion = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content: systemPrompt
      },
      {
        role: "user",
        content: `
        CONTEXTO:
        ${context}

        PERGUNTA:
        ${question}
        `
              }
            ]
          });

          return completion.choices[0].message.content;
        }

/* review.js */
import OpenAI from "openai";
import { encoding_for_model } from "@dqbd/tiktoken";
import dotenv from "dotenv";

//importar os prompts
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

    if (!data_prompt.InterviewTypeSchema || data_prompt.InterviewTypeSchema === "none") {
      prompt = promptGeral({ data_prompt });
    } else {
      
      switch (data_prompt.InterviewTypeSchema.category) {

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
    const tokens = enc.encode(prompt);
    console.log("Total de tokens:", tokens.length);

    const resposta = await openai.chat.completions.create({
      model: "gpt-4-1106-preview",
      messages: [
        { role: "system", content: "Você é um recrutador técnico especialista." },
        { role: "user", content: prompt }
      ],
      temperature: 0.7,
      max_tokens: 3000
    });

    return resposta.choices[0]?.message?.content?.trim() || "Não foi possível gerar o parecer.";
}
