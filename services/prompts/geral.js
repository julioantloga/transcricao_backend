/* geral */
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
