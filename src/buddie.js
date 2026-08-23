// src/buddie.js — Copilot "Buddie" para a transcrição de reunião (Ever i9)
// Usa Claude via ANTHROPIC_KEY (já no ambiente). Chave nunca vai ao navegador.
import express from 'express';
import { searchChunks } from './services/kb-db.js';
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
      model: model || 'claude-sonnet-5',
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

const LANG_NAMES = { pt:'português do Brasil', 'pt-br':'português do Brasil', en:'inglês', 'en-us':'inglês', 'en-gb':'inglês', es:'espanhol', 'es-es':'espanhol', 'es-mx':'espanhol', fr:'francês', de:'alemão', it:'italiano', zh:'mandarim (chinês simplificado)', 'zh-cn':'mandarim (chinês simplificado)', 'zh-hans':'mandarim (chinês simplificado)', ja:'japonês', 'ja-jp':'japonês' };

router.post('/api/buddie', async (req, res) => {
  try {
    const body = req.body || {};
    const context = (body.context || '').toString().slice(0, 12000);
    const prompt = (body.prompt || '').toString().slice(0, 2000);
    const action = (body.action || '').toString();
    const conversation = (body.conversation || '').toString().slice(0, 16000);
    const language = (body.language || '').toString().toLowerCase();

    if (!context.trim() && !prompt.trim()) {
      return res.status(400).json({ error: 'Envie um trecho da transcrição ou uma pergunta.' });
    }

    let system, userContent;

    if (action === 'responder') {
      const inputType = (body.input_type || 'speech').toString();
      const mapped = LANG_NAMES[language];
      const langRule = mapped
        ? `REGRA DE IDIOMA — OBRIGATORIA: escreva TODA a sua resposta em ${mapped}. Mesmo que a pessoa tenha falado em portugues ou em qualquer outro idioma, a resposta final deve estar 100% em ${mapped}, sem uma unica palavra em outro idioma. Responder em idioma diferente de ${mapped} conta como resposta errada.`
        : 'Escreva a sua resposta no mesmo idioma em que a pessoa falou.';
      system = `Voce e o copiloto do usuario durante uma conversa ao vivo — voce ajuda a responder e a conduzir a conversa. ${langRule} Regras de conteudo: se a nova entrada for algo que a OUTRA PESSOA disse, escreva a resposta que o usuario daria, em primeira pessoa, natural e pronta para ser dita em voz alta. Se a nova entrada for uma instrucao ou pergunta do PROPRIO usuario (ex.: reformula mais curto, deixa mais formal, e se eu recusar), atenda o pedido mantendo o contexto. Seja direto e natural, sem titulos e com Markdown minimo. Entregue apenas o texto util da resposta${mapped ? ', escrito integralmente em ' + mapped : ''}.`;
      userContent = `HISTORICO DA CONVERSA:\n"""\n${conversation || '(inicio da conversa)'}\n"""\n\nNOVA ENTRADA (${inputType === 'text' ? 'mensagem do usuario para voce' : 'a outra pessoa acabou de dizer isto'}):\n"""\n${context}\n"""${mapped ? '\n\nLembrete final: a resposta inteira deve estar em ' + mapped + '.' : ''}`;
    } else if (action === 'simular') {
      const langName = LANG_NAMES[language] || 'português do Brasil';
      const simCtx = (body.sim_context || '').toString().slice(0, 1200);
      system = `Você está participando de uma SIMULAÇÃO DE CONVERSA (roleplay) para o usuário praticar. CONTEXTO DA SIMULAÇÃO: ${simCtx}. Você assume o papel do interlocutor apropriado a esse contexto (ex.: se for entrevista de emprego, você é o entrevistador; se for pedir um café, você é o atendente; se for negociação, você é a contraparte) e conversa de forma natural e realista, em primeira pessoa como esse personagem. REGRAS: nunca revele que é uma simulação ou IA; nunca peça esclarecimentos sobre o contexto; nunca faça comentários meta ou saia do personagem; apenas conduza a conversa. Mantenha as falas curtas e naturais, como numa conversa falada real (1 a 3 frases). Escreva SEMPRE em ${langName}.`;
      if (body.sim_start) {
        userContent = 'Inicie a conversa agora — VOCÊ fala primeiro, como o interlocutor. Diga a abertura apropriada ao contexto (uma saudação e/ou a primeira fala ou pergunta). Seja natural e breve.';
      } else {
        userContent = `HISTORICO DA CONVERSA:\n"""\n${conversation || '(inicio)'}\n"""\n\nA outra pessoa (o usuário) acabou de dizer: "${context}"\n\nResponda como o seu personagem, continuando a conversa de forma natural, em ${langName}. Se a conversa chegou a um fim natural, pode se despedir.`;
      }
    } else if (!action && prompt.trim()) {
      system = 'Você é o Buddie, um assistente útil e direto. Responda a qualquer pergunta com clareza e objetividade, em Markdown enxuto (sem enrolação). Se houver um trecho de contexto, use-o quando for relevante. Responda no mesmo idioma da pergunta.';
      userContent = context.trim() ? `CONTEXTO (use se ajudar):\n"""\n${context}\n"""\n\nPERGUNTA: ${prompt}` : prompt;
    } else {
      const instruction = ACTIONS[action] || prompt || 'Analise o trecho e ajude o usuário.';
      system = 'Você é o Buddie, um copilot de reuniões da Ever i9. Responda em português do Brasil, direto e útil, em Markdown enxuto (sem enrolação). Baseie-se no trecho fornecido; se faltar contexto, diga objetivamente o que falta.';
      userContent = `TRECHO DA TRANSCRIÇÃO:\n"""\n${context || '(nenhum trecho selecionado)'}\n"""\n\nPEDIDO: ${instruction}`;
    }

    if (body.brain) {
      try {
        const q = (context || prompt || '').toString().slice(0, 500);
        const chunks = await searchChunks(q, 6, null);
        if (chunks && chunks.length) {
          const kb = chunks.map(x => '[' + (x.title || 'doc') + '] ' + (x.content || '')).join('\n\n').slice(0, 8000);
          userContent += '\n\nCONHECIMENTO DO PROJETO (conceitos reais deste projeto — use se ajudarem a responder com precisao, em vez de generico):\n"""\n' + kb + '\n"""';
          system += ' Se houver um bloco CONHECIMENTO DO PROJETO, baseie-se nele para dar respostas concretas e especificas do projeto.';
        }
      } catch (e) {}
    }
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
    const to = (b.to || '').toString().trim();
    const para = to || (de === 'en-US' ? 'português do Brasil' : 'inglês');
    if (!texto.trim()) return res.status(400).json({ error: 'texto vazio' });
    const system = `Você é um tradutor simultâneo de reuniões corporativas. Traduza o texto para ${para}, preservando sentido, nomes próprios, siglas e termos técnicos (Salesforce, CRM etc.). Responda SOMENTE com a tradução, sem comentários, sem aspas, sem prefixos.`;
    const answer = await callClaude(system, texto, b.model || 'claude-haiku-4-5', 1500);
    res.json({ traducao: answer.trim() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Speech-to-Text via Grok (xAI) — proxy seguro; a chave GROK_KEY nunca vai ao app
router.post('/api/stt', async (req, res) => {
  try {
    const b = req.body || {};
    const b64 = (b.audio || '').toString();
    const mime = (b.mime || 'audio/m4a').toString();
    const lang = (b.language || 'pt').toString();
    if (!b64) return res.status(400).json({ error: 'audio vazio' });
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) return res.status(400).json({ error: 'audio invalido' });
    let ext = 'm4a';
    if (mime.includes('webm')) ext = 'webm';
    else if (mime.includes('wav')) ext = 'wav';
    else if (mime.includes('mp4')) ext = 'mp4';
    else if (mime.includes('aac')) ext = 'aac';
    else if (mime.includes('ogg')) ext = 'ogg';
    else if (mime.includes('mpeg') || mime.includes('mp3')) ext = 'mp3';
    const fd = new FormData();
    fd.append('language', lang);
    fd.append('format', 'true');
    fd.append('filler_words', 'false');
    fd.append('file', new Blob([buf], { type: mime }), 'audio.' + ext); // file por ultimo (exigencia da API)
    const r = await fetch('https://api.x.ai/v1/stt', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.GROK_KEY },
      body: fd
    });
    if (!r.ok) { const t = await r.text(); return res.status(r.status).json({ error: 'xAI ' + r.status + ': ' + t.slice(0,300) }); }
    const d = await r.json();
    res.json({ text: d.text || '', language: d.language, duration: d.duration });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Text-to-Speech via Grok (xAI) — proxy seguro; retorna MP3
router.post('/api/tts', async (req, res) => {
  try {
    const b = req.body || {};
    const text = (b.text || '').toString().slice(0, 15000);
    const voice = (b.voice_id || 'eve').toString();
    const lang = (b.language || 'auto').toString();
    if (!text.trim()) return res.status(400).json({ error: 'texto vazio' });
    const r = await fetch('https://api.x.ai/v1/tts', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.GROK_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice_id: voice, language: lang })
    });
    if (!r.ok) { const t = await r.text(); return res.status(r.status).json({ error: 'xAI ' + r.status + ': ' + t.slice(0,200) }); }
    const buf = Buffer.from(await r.arrayBuffer());
    res.set('Content-Type', 'audio/mpeg');
    res.set('Content-Length', String(buf.length));
    res.send(buf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export { router as buddieRouter };
