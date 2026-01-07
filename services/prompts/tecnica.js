/* tecnica.js */
export function promptTecnica({ data_prompt }) {

      const prompt = `
Você é um especialista em avaliação de candidatos para a vaga ${data_prompt.job_title} e tem o objetivo de gerar um parecer estruturado e assertivo de um candidato com base na transcrição de sua entrevista técnica.

Você receberá os seguintes dados de entrada para produzir seu parecer:
- Transcrição da entrevista do candidato: Texto gerado a partir da transcrição da entrevista.
- Roteiro da entrevista: Roteiro utilizado durante a entrevista.
- Descrição da vaga: Atente-se aos requisitos técnicos obrigatórios e desejáveis e diferenciais.
- Escopo da função: Atividades que o colaborador deve exercer caso seja contratado.
- Lista das competências que estão sendo avaliadas e suas escalas de avaliação.

Com base nesses dados, produza um parecer estruturado, objetivo e imparcial sobre o candidato seguinto o template de output especificado abaixo.
- RESUMO BREVE
- ANÁLISE DAS COMPETÊNCIAS ESPECIFICADAS
- PONTOS FORTES
- PONTOS DE ATENÇÃO
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

**Percepção do Avaliador**:
${data_prompt.notes || "Não informado"}

**Competências e suas classificações**:
${JSON.stringify(data_prompt.InterviewTypeSchema, null, 2)}
---

**INSTRUÇÕES DO PARECER**:
IMPORTANTE:
- Esta é uma análise técnica para a vaga especificada.
- Considere o nível de senioridade da vaga, caso seja especificado.
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
6. (OBRIGATÓRIO) AVALIAÇÃO POR COMPETÊNCIA - Avalie TODAS as competências listadas nos dados de entrada:
- Cada competência tem uma descrição e uma instrução para cada categoria
- Para cada competência, escolha APENAS UMA das categorias disponíveis:"insuficiente", "abaixo_do_esperado", "dentro_expectativas", "excepcional".
- A escolha deve ser baseada EXCLUSIVAMENTE em evidências da transcrição.
- Cite trechos ou comportamentos observáveis sempre que possível.
- Caso uma competência não tenha dados suficientes para ser avaliada, classifique-a como "Sem dados suficientes"

REGRAS DE OUTPUT
- Não utilize títulos nos destaques, por exemplo: Não faça isso "**Ansiedade e pressa**: Sentimentos que podem impactar o desempenho...".
- Não inclua o refinamento da análise como um novo tópico no output, ele deve somente revisar o output e ajustá-lo se necessário.

---
#Template do Output

**Parecer:** 
[Resumo breve do perfil do candidato com base na fala]

**Avaliação por Competência:**
- [Competência]: [Categoria atribuída ou "Sem informações suficientes para avaliação"]  
Justificativa: [Evidência ou "Sem informações suficientes para avaliação"]

**Pontos Fortes:**  
- [item 1]  
- [item 2]  

**Pontos de Atenção:**  
- [item 1]
- [item 2] 

**Insights para outras entrevistas:**
- [item 1]
- [item 2]`;

    return prompt;
}
