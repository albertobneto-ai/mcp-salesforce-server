// src/services/squad-agent.js — Engine de agentes do Squad
// Executa HF, Spec e Runbook de Deploy (SEM interação com org Salesforce)
import * as sq from './squad-db.js';
import * as openrouter from './openrouter.js';
import * as claude from './claude.js';
import * as kbdb from './kb-db.js';
import hfPrompt from '../prompts/hf.js';
import specPrompt from '../prompts/spec.js';

// ── Prompt do agente Dev (runbook apenas, sem deploy) ──
const devRunbookPrompt = `Você é um Arquiteto Salesforce sênior. Sua função é gerar APENAS um RUNBOOK DE IMPLEMENTAÇÃO e ARTEFATOS DE DEPLOY a partir de uma Especificação Técnica.

⛔ REGRA ABSOLUTA: NÃO execute nenhum deploy. NÃO interaja com nenhuma org Salesforce. 
Gere APENAS os documentos e artefatos textuais.

Gere EXATAMENTE estas seções:

# RUNBOOK DE IMPLEMENTAÇÃO

## 1. Resumo da Spec
Parágrafo resumindo o que será implementado (extraído da spec).

## 2. Pré-requisitos
- Acessos necessários (perfis, permissões, tipo de org)
- Ferramentas (Setup, VS Code + SFDX se Apex, Data Loader se dados)
- Dependências de outras specs que devem existir antes

## 3. Manifest JSON
\`\`\`json
{ ... manifest completo no formato do MCP Server (specName, metadata com customObjects, customFields, validationRules, recordTypes, permissionSets) ... }
\`\`\`
FORMATO de campos: "type":"Text","length":100 | "type":"Picklist","picklist":["V1","V2"] | "type":"Lookup","referenceTo":"Account","relationshipLabel":"..."
⚠️ Picklist SEMPRE como array de strings simples: "picklist": ["V1", "V2"] — NUNCA picklistValues.

## 4. Ordem de Deploy
Tabela numerada com sequência exata:
| Passo | Componente | Tipo | API Name | Ação | Depende de |
Sequência: Objects → Fields → RecordTypes → PageLayouts → ValidationRules → Flows → Apex → PermSets → SharingRules

## 5. Passos Manuais Pós-Deploy
Para cada item que NÃO pode ser deployado via manifest (configurações de UI, ativações, etc):
| # | Ação Manual | Caminho no Setup | Detalhes |

## 6. Dados Iniciais
- Picklist values
- Custom Metadata records
- Dados de teste (mínimo 3 registros por objeto)
- Ordem de inserção (pais antes de filhos)

## 7. Checklist de Validação
| # | O que verificar | Como validar | Resultado esperado |

## 8. Rollback
Procedimento para desfazer em ordem reversa.

---
REGRAS:
- O Manifest JSON deve ser VÁLIDO e pronto para uso com o endpoint /api/deploy-b64
- Inclua TODOS os campos, objetos e automações da spec
- Gere código Apex completo quando aplicável (não pseudo-código)
- Responda APENAS com o documento, sem mensagens extras
`;

// ── Enriquecimento KB ──
async function enrichPrompt(basePrompt, queryText, chunks = 6) {
  try {
    const kbChunks = await kbdb.searchChunks(queryText, chunks, null);
    if (kbChunks.length) {
      return basePrompt +
        '\n\n--- BASE DE CONHECIMENTO INTERNA ---\n' +
        kbChunks.map(c => '[' + c.title + ']\n' + c.content).join('\n\n') +
        '\n--- FIM KB ---\n\nUSE o material acima como referência factual.';
    }
  } catch {}
  return basePrompt;
}

// ── Buscar artefato anterior como contexto ──
async function getPreviousArtifact(cardId, stage) {
  const artifacts = await sq.getArtifacts(cardId);
  // Para spec, busca HF. Para dev, busca spec.
  const stageMap = { spec: 'hf', dev: 'spec', refinamento: 'dev' };
  const prevStage = stageMap[stage];
  if (!prevStage) return null;
  return artifacts.find(a => a.stage === prevStage) || null;
}

// ════════════════════════════════════════
// AGENTE HF — História Funcional
// ════════════════════════════════════════
export async function runHfAgent(cardId) {
  const card = await sq.getCard(cardId);
  if (!card) throw new Error('Card não encontrado');

  const run = await sq.createAgentRun({ card_id: cardId, stage: 'hf', model_used: 'dynamic-pool' });

  try {
    const prompt = await enrichPrompt(hfPrompt, card.description || card.title);
    const messages = [{ role: 'user', content: card.title + '\n\n' + (card.description || '') }];

    const result = await openrouter.callWithDynamicPool(prompt, messages, 16384);

    const artifact = await sq.createArtifact({
      card_id: cardId,
      stage: 'hf',
      artifact_type: 'hf_document',
      content: result.text,
      file_name: `HF_${card.title.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40)}.md`,
      model_used: result.model,
      tokens_in: 0,
      tokens_out: 0,
    });

    await sq.finishAgentRun(run.id, { status: 'done' });
    await sq.moveCard(cardId, 'hf');

    return { success: true, artifact, model: result.label || result.model, run };
  } catch (err) {
    await sq.finishAgentRun(run.id, { status: 'error', error_msg: err.message });
    throw err;
  }
}

// ════════════════════════════════════════
// AGENTE SPEC — Especificação Técnica
// ════════════════════════════════════════
export async function runSpecAgent(cardId) {
  const card = await sq.getCard(cardId);
  if (!card) throw new Error('Card não encontrado');

  // Busca HF anterior como input
  const hfArtifact = await getPreviousArtifact(cardId, 'spec');

  const run = await sq.createAgentRun({ card_id: cardId, stage: 'spec', model_used: 'claude-sonnet-4-6' });

  try {
    const inputText = hfArtifact
      ? hfArtifact.content
      : (card.description || card.title);

    const prompt = await enrichPrompt(specPrompt, inputText.slice(0, 500));
    const messages = [{ role: 'user', content: inputText }];

    const result = await claude.call(prompt, messages, 48000);

    const artifact = await sq.createArtifact({
      card_id: cardId,
      stage: 'spec',
      artifact_type: 'spec_document',
      content: result,
      file_name: `SPEC_${card.title.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40)}.md`,
      model_used: 'claude-sonnet-4-6',
    });

    await sq.finishAgentRun(run.id, { status: 'done' });
    await sq.moveCard(cardId, 'spec');

    return { success: true, artifact, model: 'Claude Sonnet 4.6', run };
  } catch (err) {
    await sq.finishAgentRun(run.id, { status: 'error', error_msg: err.message });
    throw err;
  }
}

// ════════════════════════════════════════
// AGENTE DEV — Runbook + Artefatos (SEM deploy)
// ════════════════════════════════════════
export async function runDevAgent(cardId) {
  const card = await sq.getCard(cardId);
  if (!card) throw new Error('Card não encontrado');

  // Busca Spec anterior como input
  const specArtifact = await getPreviousArtifact(cardId, 'dev');

  const run = await sq.createAgentRun({ card_id: cardId, stage: 'dev', model_used: 'claude-sonnet-4-6' });

  try {
    const inputText = specArtifact
      ? specArtifact.content
      : (card.description || card.title);

    const prompt = devRunbookPrompt;
    const messages = [{ role: 'user', content: inputText }];

    const result = await claude.call(prompt, messages, 48000);

    // Salva runbook como artefato
    const artifact = await sq.createArtifact({
      card_id: cardId,
      stage: 'dev',
      artifact_type: 'runbook',
      content: result,
      file_name: `RUNBOOK_${card.title.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40)}.md`,
      model_used: 'claude-sonnet-4-6',
    });

    // Tenta extrair manifest JSON do runbook
    const manifestMatch = result.match(/```json\s*([\s\S]*?)```/);
    if (manifestMatch) {
      try {
        const manifestJson = JSON.parse(manifestMatch[1].trim());
        await sq.createArtifact({
          card_id: cardId,
          stage: 'dev',
          artifact_type: 'manifest_json',
          content: JSON.stringify(manifestJson, null, 2),
          file_name: `MANIFEST_${card.title.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40)}.json`,
          model_used: 'claude-sonnet-4-6',
        });
      } catch {} // JSON inválido, ignora
    }

    await sq.finishAgentRun(run.id, { status: 'done' });
    await sq.moveCard(cardId, 'dev');

    return { success: true, artifact, model: 'Claude Sonnet 4.6', run };
  } catch (err) {
    await sq.finishAgentRun(run.id, { status: 'error', error_msg: err.message });
    throw err;
  }
}

// ── Mapa de agentes por stage ──
export const AGENT_MAP = {
  hf:   { fn: runHfAgent,   label: 'Agente HF',     model: 'Pool Dinâmico',     desc: 'Gera História Funcional (14 seções) a partir do requisito' },
  spec: { fn: runSpecAgent,  label: 'Agente Spec',    model: 'Claude Sonnet 4.6', desc: 'Gera Especificação Técnica (18 seções + Runbook) a partir da HF' },
  dev:  { fn: runDevAgent,   label: 'Agente Deploy',  model: 'Claude Sonnet 4.6', desc: 'Gera Runbook de implementação + Manifest JSON (sem executar deploy)' },
};

// ── Executor genérico ──
export async function executeAgent(cardId, stage) {
  const agent = AGENT_MAP[stage];
  if (!agent) throw new Error(`Sem agente para stage: ${stage}`);
  return agent.fn(cardId);
}
