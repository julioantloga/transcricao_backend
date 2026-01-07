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
