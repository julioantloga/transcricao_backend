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
