// services/review.js

import OpenAI from "openai";
import { encoding_for_model } from "@dqbd/tiktoken";
import dotenv from "dotenv";
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
  InterviewTypeSchema
  }) {
  
  let competencies = "";

  if (InterviewTypeSchema !== "none") {
    competencies = `
      **Competências para avaliar**:
      ${JSON.stringify(InterviewTypeSchema, null, 2)}`
  } else {
    competencies = `
    **Valores Organizacionais**:
    ${company_values || "Não informado"}`;
    }
  
  let CompetenciesInstructions = "";
  let CompetenciesOutput = "";

  if (InterviewTypeSchema !== "none") {
    CompetenciesInstructions = `
  AVALIAÇÃO POR COMPETÊNCIA (OBRIGATÓRIO):
  - Avalie TODAS as competências listadas.
  - Para cada competência, escolha APENAS UMA das categorias disponíveis:
    "insuficiente", "abaixo_do_esperado", "dentro_expectativas", "excepcional".
  - A escolha deve ser baseada EXCLUSIVAMENTE em evidências da transcrição.
  - Cite trechos ou comportamentos observáveis sempre que possível.
  - Caso NÃO exista informação suficiente na entrevista para classificar a competência, utilize EXATAMENTE a frase: "Sem informações suficientes para avaliação".
  `;

    CompetenciesOutput = `
  **Avaliação por Competência:**
  Para cada competência, informe:
  - Nome da competência
  - Categoria atribuída
  - Justificativa objetiva baseada na entrevista
  `;
  }
  

  const prompt = `
Você é um especialista de recrutamento e seleção com o objetivo de gerar pareceres estruturados e assertivos dos candidatos com base nas entrevistas.
Sua análise deve ser objetiva, evidencial e diretamente conectada aos valores organizacionais.
Importante: você não pode inventar dados, tudo deve estar no texto da transcrição da entrevista.

Você receberá os seguintes dados de entrada para produzir seu parecer:
- Transcrição da entrevista do candidato: Texto gerado a partir da transcrição da entrevista.
- Roteiro da entrevista: Roteiro utilizado durante a entrevista transcrita.
- Descrição da vaga: Como a vaga foi divulgada ao candidato.
- Escopo da função: Atividades que o colaborador deve exercer caso seja contratado.
- Valores organizacionais: valores e informações relevantes da empresa que podem influenciar na contratação.

Com base nesses dados, produza um parecer estruturado, objetivo e imparcial sobre o candidato seguinto o template de output especificado abaixo.

---

#DADOS DE ENTRADA:
**Nome da vaga**
${job_title || "Não informado"}

**Transcrição da entrevista**:
${transcript || "Não informado"}

**Roteiro da entrevista**:
${interview_roadmap || "Não informado"}

**Descrição da vaga**:
${job_description || "Não informado"}

**Escopo da função**:
${job_responsibilities || "Não informado"}

**Valores Organizacionais**:
${company_values || "Não informado"};

**Percepção do Avaliador:**:
${notes || "Não informado"}
---

**INSTRUÇÕES DO PARECER**:
IMPORTANTE:
- Nas instruções abaixo, entenda "ponto" como: competências, comportamentos, habilidades, experiências, comunicação, postura, requisitos e expectativas da vaga e do candidato.
- Considere citar termos técnicos e trechos da entrevista para dar mais credibilidade ao parecer.
- Em caso de desalinhamento de expectativas salariais, benefícios, modelo de trabalho e ambiente de trabalho, deixe  explicito o que está desalinhado.
- Considere a percepção do avaliador como uma informação importante na análise, essa percepção evidencia comportamentos que a transcrição não consegue interpretar.

${CompetenciesInstructions}

ANALISE:
1. Destaque até 4 pontos fortes do candidato.
2. Destaque até 4 pontos de atenção ao candidato: identifique se o candidato tem algum ponto que está desalinhado com a descrição e função da vaga.
3. Identifique qual a motivação do candidato para assumir a vaga em questão. 
4. Identifique os pontos de maior e menor aderência do candidato aos valores da organização.
5. Identifique se teve algo que faltou ser consultado, avaliado ou aprofundado pelo recrutador durante a entrevista, utilize as atividades da vaga e o roteiro da entrevista para encontrar esses gaps.

PREFERÊNCIAS
7. Não utilize títulos nos destaques, por exemplo: Não faça isso "**Ansiedade e pressa**: Sentimentos que podem impactar o desempenho...".

REFINAMENTO DA ANÁISE:
7. Depois de executar os passos anteriores e criar o output conforme template abaiixo, faça:
7.1 Uma revisão final para garantir coerência na análise.
7.2 Filtre informações irrelevantes para o recrutador.
7.4 Garantir qur o refinamento não seja incluído como um novo tópico no output, ele deve somente revisar o output e ajustá-lo se necessário.

---
#Template do Output

**Parecer:** 
[Resumo breve do perfil do candidato com base na fala]

${InterviewTypeSchema !== "none" ? `
**Avaliação por Competência:**
- [Competência]: [Categoria atribuída]  
  Justificativa: [Evidência ou "Sem informações suficientes para avaliação"]
` : ""}

**Pontos Fortes:**  
- [item 1]  
- [item 2]  

**Pontos de Atenção:**  
- [item 1]
- [item 2] 

**Motivação:**
[Resumo das motivações e alinhamento]

**Insights para outras entrevistas:**
- [item 1]
- [item 2]`;

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
