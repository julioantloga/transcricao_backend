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
