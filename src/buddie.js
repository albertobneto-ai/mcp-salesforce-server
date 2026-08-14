// src/buddie.js — Copilot "Buddie" para a transcrição de reunião (Ever i9)
// Reaproveita OPENROUTER_KEY já configurada no ambiente. Sem chave no navegador.
import express from 'express';
const router = express.Router();

async function callOpenRouter(system, userContent, model, maxTk) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENROUTER_KEY}`
    },
    body: JSON.stringify({
      model: model || 'deepseek/deepseek-chat-v3-0324',
      max_tokens: maxTk || 1200,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userContent }
      ]
    })
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
}

const ACTIONS = {
  resumo: 'Resuma o trecho em tópicos curtos e objetivos.',
  acoes: 'Extraia os itens de ação do trecho: quem faz o quê e prazos, se houver. Liste em bullets.',
  salesforce: 'Você é um Arquiteto Salesforce sênior. Analise o trecho sob a ótica Salesforce (Sales/Service/Revenue Cloud, Data Cloud, Agentforce): implicações técnicas, riscos e próximos passos concretos.',
  recomendacao: 'Dê recomendações práticas e priorizadas com base no trecho.'
};

router.post('/api/buddie', async (req, res) => {
  try {
    const body = req.body || {};
    const context = (body.context || '').toString().slice(0, 12000);
    const prompt = (body.prompt || '').toString().slice(0, 2000);
    const action = (body.action || '').toString();

    if (!context.trim() && !prompt.trim()) {
      return res.status(400).json({ error: 'Envie um trecho da transcrição ou uma pergunta.' });
    }

    const instruction = ACTIONS[action] || prompt || 'Analise o trecho e ajude o usuário.';
    const system = 'Você é o Buddie, um copilot de reuniões da Ever i9. Responda em português do Brasil, direto e útil, em Markdown enxuto (sem enrolação). Baseie-se apenas no trecho fornecido; se faltar contexto, diga objetivamente o que falta.';
    const userContent = `TRECHO DA TRANSCRIÇÃO:\n"""\n${context || '(nenhum trecho selecionado)'}\n"""\n\nPEDIDO: ${instruction}`;

    const answer = await callOpenRouter(system, userContent, body.model, 1200);
    res.json({ answer });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export { router as buddieRouter };
