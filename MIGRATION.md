# Everi9 — Migracao aichat → Node.js

## Arquivos novos (merge no MCP Server)

```
src/
├── chat-app.js            ← Monta rotas no Express existente
├── routes/
│   ├── chat.js            ← /api/chat + /api/chat/stream (SSE)
│   ├── auth.js            ← /api/auth/login + /api/auth/register
│   └── download.js        ← /api/download (.docx)
├── services/
│   ├── claude.js          ← Anthropic API (Claude Sonnet 4.6)
│   └── grok.js            ← xAI API (Grok 4.20)
├── middleware/
│   └── auth.js            ← JWT verify
├── prompts/
│   ├── spec.js            ← System prompt /spec (18 secoes)
│   ├── hf.js              ← System prompt /hf (14 secoes)
│   └── ata.js             ← System prompt /ata (11 secoes)
└── config/
    ├── db.js              ← Pool Postgres
    └── alias-map.js       ← PT-BR → API Names
schema.sql                 ← DDL Postgres
```

## Como integrar no index.js existente

```javascript
// No final do src/index.js, antes do app.listen:
const mountChatApp = require('./chat-app');
mountChatApp(app);
```

## Config Vars novas no Heroku

```
ANTHROPIC_KEY=sk-ant-api03-...
JWT_SECRET=<gerar-uuid>
DATABASE_URL=<auto-heroku-postgres>
GROK_MODEL=grok-4.20-0309-non-reasoning
```

## Dependencias novas (npm install)

```
pg jsonwebtoken bcrypt docx
```

## Setup banco

```bash
heroku addons:create heroku-postgresql:essential-0
heroku pg:psql < schema.sql
```

## Dominio

```bash
heroku domains:add www.everi9.com
# Configurar CNAME no registrador DNS
```
