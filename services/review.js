/* review.js */
import OpenAI from "openai";
import { encoding_for_model } from "@dqbd/tiktoken";
import dotenv from "dotenv";

//importar os prompts
import { promptCompleto } from "./prompts/completo.js";
import { promptSimplificado } from "./prompts/simplificado.js";

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

    prompt = promptCompleto ({ data_prompt });

    const enc = encoding_for_model("gpt-4o-2024-11-20");
    const tokens = enc.encode(prompt);
    console.log("Total de tokens:", tokens.length);

    const resposta = await openai.chat.completions.create({
      model: "gpt-4o-2024-11-20",
      messages: [
        { role: "system", content: "Você é um recrutador técnico especialista." },
        { role: "user", content: prompt }
      ],
      temperature: 0.3,
      max_tokens: 3000
    });

    return resposta.choices[0]?.message?.content?.trim() || "Não foi possível gerar o parecer.";
}