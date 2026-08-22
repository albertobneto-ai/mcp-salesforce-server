// src/buddie.js — Copilot "Buddie" para a transcrição de reunião (Ever i9)
// Usa Claude via ANTHROPIC_KEY (já no ambiente). Chave nunca vai ao navegador.
import express from 'express';
const router = express.Router();

async function callClaude(system, userContent, model, maxTk) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: model || 'claude-haiku-4-5',
      max_tokens: maxTk || 1200,
      system,
      messages: [{ role: 'user', content: userContent }]
    })
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const tb = (data.content || []).find(b => b.type === 'text');
  return (tb && tb.text) || '';
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

    const answer = await callClaude(system, userContent, body.model, 1200);
    res.json({ answer });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Tradução ao vivo da transcrição (PT<->EN) — Haiku, rápido e barato
router.post('/api/traduzir', async (req, res) => {
  try {
    const b = req.body || {};
    const texto = (b.texto || '').toString().slice(0, 6000);
    const de = (b.de || 'pt-BR').toString();
    const para = de === 'en-US' ? 'português do Brasil' : 'inglês';
    if (!texto.trim()) return res.status(400).json({ error: 'texto vazio' });
    const system = `Você é um tradutor simultâneo de reuniões corporativas. Traduza o texto para ${para}, preservando sentido, nomes próprios, siglas e termos técnicos (Salesforce, CRM etc.). Responda SOMENTE com a tradução, sem comentários, sem aspas, sem prefixos.`;
    const answer = await callClaude(system, texto, b.model || 'claude-haiku-4-5', 1500);
    res.json({ traducao: answer.trim() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export { router as buddieRouter };
