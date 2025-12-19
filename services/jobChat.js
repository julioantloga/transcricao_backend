import OpenAI from "openai";
import { encoding_for_model } from "@dqbd/tiktoken";
import dotenv from "dotenv";
import pool from "../db.js";
dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/*
Objetivo:
- Buscar entrevistas da vaga
- Resumir transcrições (quando necessário)
- Montar contexto leve para até 50 entrevistas
*/

export async function handleJobChat({ jobId, userId, question }) {
  
  // 0. Buscar dados da vaga
    const jobResult = await pool.query(
    `
    SELECT
        name,
        job_description,
        job_responsibilities
    FROM public.jobs
    WHERE id = $1 AND user_id = $2
    `,
    [jobId, userId]
    );

    if (!jobResult.rows.length) {
    return "Dados da vaga não encontrados ou acesso não autorizado.";
    }

    const job = jobResult.rows[0];
  
    // 1. Buscar entrevistas da vaga
    const result = await pool.query(
    `
    SELECT
        ir.id,
        ir.candidate_name,
        ir.transcript,
        ir.metrics,
        COALESCE(ir.manual_review, ir.final_review) AS review,
        it.name AS interview_type
    FROM public.interview_reviews ir
    LEFT JOIN public.interview_types it ON it.id = ir.interview_type_id
    WHERE ir.job_id = $1
        AND ir.user_id = $2
    ORDER BY ir.created_at DESC
    LIMIT 50
    `,
    [jobId, userId]
    );

    if (!result.rows.length) {
    return "Não há entrevistas suficientes para análise nesta vaga.";
    }

    // 2. Resumir transcrições longas
    const interviewsContext = [];

    const jobContext = `
    DADOS DA VAGA
    Nome da vaga:
    ${job.name}

    Descrição da vaga:
    ${job.job_description || "Não informada."}

    Atividades da vaga:
    ${job.job_responsibilities || "Não informadas."}
    `;

    for (const [index, row] of result.rows.entries()) {

        let transcriptResumo = "Transcrição não disponível.";
        if (row.transcript && row.transcript.length > 500) {
            const resumo = await openai.chat.completions.create({
            model: "gpt-4.1-mini",
            temperature: 0,
            messages: [
                {
                role: "system",
                content:
                    "Resuma a transcrição abaixo focando apenas em comunicação, clareza, comportamento e sinais relevantes para recrutamento."
                },
                {
                role: "user",
                content: row.transcript.slice(0, 8000)
                }
            ]
            });

            transcriptResumo = resumo.choices[0].message.content;
            } else if (row.transcript) {
                transcriptResumo = row.transcript;
            }

        interviewsContext.push(`
            ENTREVISTA ${index + 1}
            Candidato: ${row.candidate_name || "Não informado"}
            Tipo: ${row.interview_type || "não definido"}
            Métricas: ${JSON.stringify(row.metrics)}
            Parecer:
            ${row.review || "Parecer não disponível."}
            Resumo da transcrição:
            ${transcriptResumo}
        `);
    }

  // 3. Prompt final
  const completion = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content: `
            Você é um analista sênior de recrutamento e seleção.
            Use exclusivamente os dados fornecidos.
            Não invente informações.
            Para qualquer pergunta que não se refira às entrevistas da vaga responda "Desculpe, não consigo te ajudar com essa pergunta." 
            Seja técnico, claro e direto.`
      },
      {
        role: "user",
        content: `
            ${jobContext}

            ENTREVISTAS ANALISADAS
            Total: ${interviewsContext.length}

            ${interviewsContext.join("\n")}

            Pergunta do recrutador:
            ${question}
            `
      }
    ]
  });

  return completion.choices[0].message.content;
}
