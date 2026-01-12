// backend/services/jobChat.js
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
