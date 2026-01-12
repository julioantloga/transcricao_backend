/* =============================================================================
   FILE: prompts/cultura.js
   RESPONSABILIDADE: Prompt de avaliação CULTURAL
   ============================================================================= */

export function promptCultura({ data_prompt }) {

  const prompt = `
Você é um especialista de recrutamento e seleção com o objetivo de gerar um parecer estruturado e assertivo de um candidato com base na transcrição de sua entrevista.

Você receberá os seguintes dados de entrada para produzir seu parecer:
- Transcrição da entrevista do candidato: Texto gerado a partir da transcrição da entrevista.
- Roteiro da entrevista: Roteiro utilizado durante a entrevista transcrita.
- Descrição da vaga: Como a vaga foi divulgada ao candidato.
- Escopo da função: Atividades que o colaborador deve exercer caso seja contratado.
- Valores organizacionais: valores e informações relevantes da empresa que podem influenciar na contratação.
- Lista das competências que estão sendo avaliadas e suas escalas de avaliação

Com base nesses dados, produza um parecer estruturado, objetivo e imparcial sobre o candidato seguinto o template de output especificado abaixo.
- RESUMO BREVE
- ANÁLISE DAS COMPETÊNCIAS ESPECIFICADAS
- PONTOS FORTES
- PONTOS DE ATENÇÃO
- MOTIVAÇÃO
- INSIGHTS
---

#DADOS DE ENTRADA:
**Nome do candidato**
${data_prompt.candidate_name}

**Nome da vaga**
${data_prompt.job_title || "Não informado"}

**Transcrição da entrevista**:
${data_prompt.transcript || "Não informado"}

**Roteiro da entrevista**:
${data_prompt.interview_roadmap || "Não informado"}

**Descrição da vaga**:
${data_prompt.job_description || "Não informado"}

**Escopo da função**:
${data_prompt.job_responsibilities || "Não informado"}

**Percepção do Avaliador:**:
${data_prompt.notes || "Não informado"}

**Competências e suas classificações**:
${JSON.stringify(data_prompt.InterviewTypeSchema, null, 2)}
---

**INSTRUÇÕES DO PARECER**:
IMPORTANTE:
- Esta é uma análise de cultura feita pelo RH da empresa.
- Considere o nível de senioridade da vaga, caso seja especificado.
- Você não pode inventar dados, tudo deve estar no texto da transcrição da entrevista.
- Nas instruções abaixo, entenda **ponto** como: competências, comportamentos, habilidades, experiências, comunicação, postura, requisitos e expectativas da vaga e do candidato.
- Considere citar termos técnicos e trechos da entrevista para dar mais credibilidade ao parecer.
- Em caso de desalinhamento de expectativas salariais, benefícios, modelo de trabalho e ambiente de trabalho, deixe explicito o que está desalinhado.
- Considere a percepção do avaliador como uma informação importante na análise, essa percepção evidencia comportamentos que a transcrição não consegue interpretar.

ANALISE:
1. Destaque até 4 pontos fortes do candidato.
2. Destaque até 4 pontos de atenção ao candidato.
3. Identifique qual a motivação do candidato para assumir a vaga.
4. Identifique os pontos de maior e menor aderência aos valores da organização.
5. Identifique gaps de avaliação na entrevista.
6. (OBRIGATÓRIO) AVALIAÇÃO POR COMPETÊNCIA:
   - Escolha apenas uma categoria por competência.
   - Baseie-se exclusivamente na transcrição.
   - Caso não haja dados, use "Sem dados suficientes".

REGRAS DE OUTPUT
- Não utilizar títulos nos destaques.
- Não adicionar tópicos extras além do template.

#Template do Output

**Parecer:** 
[Resumo breve]

**Avaliação por Competência:**
- [Competência]: [Categoria ou "Sem informações suficientes"]
Justificativa: [Evidência]

**Pontos Fortes:**
- item

**Pontos de Atenção:**
- item

**Motivação:**
- texto

**Insights para outras entrevistas:**
- item
`;

  return prompt;
}


/* =============================================================================
   FILE: prompts/geral.js
   RESPONSABILIDADE: Prompt GENÉRICO (sem tipo de entrevista)
   ============================================================================= */

export function promptGeral({ data_prompt }) {

  return `
Você é um especialista em recrutamento e seleção.

Gere um parecer técnico e imparcial com base exclusivamente nas informações fornecidas.

### DADOS
Nome do candidato:
${data_prompt.candidate_name || "Não informado"}

Nome da vaga:
${data_prompt.job_title || "Não informado"}

Transcrição da entrevista:
${data_prompt.transcript || "Não informado"}

Roteiro da entrevista:
${data_prompt.interview_roadmap || "Não informado"}

Descrição da vaga:
${data_prompt.job_description || "Não informado"}

Escopo da função:
${data_prompt.job_responsibilities || "Não informado"}

Valores organizacionais:
${data_prompt.company_values || "Não informado"}

Percepção do avaliador:
${data_prompt.notes || "Não informado"}

### OUTPUT OBRIGATÓRIO
- RESUMO BREVE
- PONTOS FORTES
- PONTOS DE ATENÇÃO
- MOTIVAÇÃO
- INSIGHTS

REGRAS:
- Não inventar dados
- Basear-se apenas na transcrição
- Linguagem objetiva e técnica
`;
}


/* =============================================================================
   FILE: prompts/gestor_lider.js
   RESPONSABILIDADE: Prompt de LIDERANÇA / GESTÃO
   ============================================================================= */

export function promptGestorLider({ data_prompt }) {
  return `
Você é um especialista em entrevistas de LIDERANÇA E GESTÃO.

Avalie liderança, tomada de decisão, gestão de conflitos e visão estratégica.

### COMPETÊNCIAS
${JSON.stringify(data_prompt.InterviewTypeSchema, null, 2)}

### DADOS
Candidato:
${data_prompt.candidate_name || "Não informado"}

Vaga:
${data_prompt.job_title || "Não informado"}

Transcrição:
${data_prompt.transcript || "Não informado"}

Percepção do avaliador:
${data_prompt.notes || "Não informado"}

### OUTPUT
- RESUMO BREVE
- PONTOS FORTES
- PONTOS DE ATENÇÃO
- INSIGHTS
- AVALIAÇÃO POR COMPETÊNCIA
`;
}


/* =============================================================================
   FILE: prompts/tecnica.js
   RESPONSABILIDADE: Prompt de AVALIAÇÃO TÉCNICA
   ============================================================================= */

export function promptTecnica({ data_prompt }) {

  const prompt = `
Você é um especialista em avaliação de candidatos para a vaga ${data_prompt.job_title} e tem o objetivo de gerar um parecer estruturado e assertivo com base na entrevista técnica.

#DADOS DE ENTRADA:
Nome do candidato:
${data_prompt.candidate_name}

Vaga:
${data_prompt.job_title || "Não informado"}

Transcrição:
${data_prompt.transcript || "Não informado"}

Roteiro:
${data_prompt.interview_roadmap || "Não informado"}

Descrição da vaga:
${data_prompt.job_description || "Não informado"}

Escopo da função:
${data_prompt.job_responsibilities || "Não informado"}

Percepção do avaliador:
${data_prompt.notes || "Não informado"}

Competências:
${JSON.stringify(data_prompt.InterviewTypeSchema, null, 2)}

### OUTPUT
- RESUMO BREVE
- AVALIAÇÃO POR COMPETÊNCIA
- PONTOS FORTES
- PONTOS DE ATENÇÃO
- INSIGHTS

REGRAS:
- Basear-se apenas na transcrição
- Não inventar dados
- Classificar todas as competências
`;

  return prompt;
}
