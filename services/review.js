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
  InterviewTypeSchema,
  candidate_name
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
  let CompetenciesEntry = "";
  let CompetenciesOutput = "";

  if (InterviewTypeSchema !== "none") {
    CompetenciesEntry = '- Lista das competências que estão sendo avaliadas e suas escalas de avaliação';
    CompetenciesOutput = '- ANÁLISE DAS COMPETÊNCIAS ESPECIFICADAS'
    CompetenciesInstructions = `
  6. AVALIAÇÃO POR COMPETÊNCIA (OBRIGATÓRIO):
  - Avalie TODAS as competências listadas abaixo:
    ${competencies}

  - Cada competência tem uma descrição e uma instrução para cada categoria
  - Para cada competência, escolha APENAS UMA das categorias disponíveis:"insuficiente", "abaixo_do_esperado", "dentro_expectativas", "excepcional".
  - A escolha deve ser baseada EXCLUSIVAMENTE em evidências da transcrição.
  - Cite trechos ou comportamentos observáveis sempre que possível.
  - Caso NÃO exista informação suficiente na entrevista para classificar a competência, utilize EXATAMENTE a frase: "Sem informações suficientes para avaliação".
  `;
  }

  const prompt = `
Você é um especialista de recrutamento e seleção com o objetivo de gerar um parecer estruturado e assertivo de um candidato com base na transcrição de sua entrevista.

Você receberá os seguintes dados de entrada para produzir seu parecer:
- Transcrição da entrevista do candidato: Texto gerado a partir da transcrição da entrevista.
- Roteiro da entrevista: Roteiro utilizado durante a entrevista transcrita.
- Descrição da vaga: Como a vaga foi divulgada ao candidato.
- Escopo da função: Atividades que o colaborador deve exercer caso seja contratado.
- Valores organizacionais: valores e informações relevantes da empresa que podem influenciar na contratação.
${CompetenciesEntry}

Com base nesses dados, produza um parecer estruturado, objetivo e imparcial sobre o candidato seguinto o template de output especificado abaixo.
- RESUMO BREVE
- PONTOS FORTES
- PONTOS DE ATENÇÃO
- MOTIVAÇÃO
- INSIGHTS
${CompetenciesOutput}
---

#DADOS DE ENTRADA:
**Nome do candidato**
${candidate_name}

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
- Você não pode inventar dados, tudo deve estar no texto da transcrição da entrevista.
- Nas instruções abaixo, entenda **ponto** como: competências, comportamentos, habilidades, experiências, comunicação, postura, requisitos e expectativas da vaga e do candidato.
- Considere citar termos técnicos e trechos da entrevista para dar mais credibilidade ao parecer.
- Em caso de desalinhamento de expectativas salariais, benefícios, modelo de trabalho e ambiente de trabalho, deixe explicito o que está desalinhado.
- Considere a percepção do avaliador como uma informação importante na análise, essa percepção evidencia comportamentos que a transcrição não consegue interpretar.

ANALISE:
1. Destaque até 4 pontos fortes do candidato.
2. Destaque até 4 pontos de atenção ao candidato: identifique se o candidato tem algum ponto que está desalinhado com a descrição e função da vaga.
3. Identifique qual a motivação do candidato para assumir a vaga em questão. 
4. Identifique os pontos de maior e menor aderência do candidato aos valores da organização.
5. Identifique se teve algo que faltou ser consultado, avaliado ou aprofundado pelo recrutador durante a entrevista, utilize as atividades da vaga e o roteiro da entrevista para encontrar esses gaps.
${CompetenciesInstructions}


REFINAMENTO DA ANÁISE:
Depois de executar os passos anteriores e criar o output conforme template abaiixo, faça:
- Uma revisão final para garantir coerência na análise.
- Filtre informações irrelevantes para o recrutador.

REGRAS DE OUTPUT
- Não utilize títulos nos destaques, por exemplo: Não faça isso "**Ansiedade e pressa**: Sentimentos que podem impactar o desempenho...".
- Não inclua o refinamento da análise como um novo tópico no output, ele deve somente revisar o output e ajustá-lo se necessário.

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
