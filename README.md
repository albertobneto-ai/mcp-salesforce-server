# MCP Salesforce Provisioning Server

Servidor MCP para provisionamento automático de metadados Salesforce — CRM B2B Algar Telecom.

## Arquitetura

```
Claude AI ──► MCP Server (Heroku) ──► Salesforce Org (via jsforce)
                    │
              Manifests JSON (specs técnicas)
```

## Tools Disponíveis

| Tool | Descrição |
|---|---|
| `describe_org` | Info da org, lista objetos custom, detalha campos |
| `deploy_manifest` | Deploy completo de um manifest JSON |
| `deploy_component` | Deploy de um componente individual |
| `validate_manifest` | Valida manifest sem deploy (checkOnly) |
| `retrieve_metadata` | Recupera metadados existentes da org |
| `run_soql` | Executa queries SOQL |
| `list_manifests` | Lista manifests disponíveis |

## Deploy no Heroku (via GitHub)

### 1. Criar repositório no GitHub

- Vá em github.com → New Repository
- Nome: `mcp-salesforce-server`
- Suba todos os arquivos deste projeto

### 2. Obter Security Token do Salesforce

- Salesforce → Setup → My Personal Information → Reset My Security Token
- O token será enviado por email

### 3. Criar app no Heroku (Dashboard Web)

1. Acesse dashboard.heroku.com
2. **New** → **Create new app**
3. Nome: `mcp-sf-provisioning` (ou outro disponível)
4. Region: United States

### 4. Configurar variáveis de ambiente no Heroku

Em **Settings** → **Config Vars** → **Reveal Config Vars**, adicione:

| Key | Value |
|---|---|
| `SF_LOGIN_URL` | `https://login.salesforce.com` |
| `SF_USERNAME` | `albertobneto.sf@gmail.com` |
| `SF_PASSWORD` | `sua_senha` |
| `SF_SECURITY_TOKEN` | `token_do_email` |

### 5. Conectar GitHub ao Heroku

1. Aba **Deploy** no Heroku
2. **Deployment method** → **GitHub**
3. Conecte sua conta GitHub
4. Busque o repositório `mcp-salesforce-server`
5. Clique **Connect**
6. Em **Automatic Deploys** → **Enable Automatic Deploys**
7. Clique **Deploy Branch** (manual, primeira vez)

### 6. Verificar

Acesse `https://seu-app.herokuapp.com/` — deve retornar o JSON com status e lista de tools.

## Conectar ao Claude

Depois de rodando no Heroku, o endpoint MCP SSE será:

```
https://seu-app.herokuapp.com/sse
```

## Estrutura do Projeto

```
├── Procfile                    # Config Heroku
├── package.json                # Dependências
├── src/
│   ├── index.js                # Servidor MCP + Express
│   ├── salesforce-client.js    # Wrapper jsforce
│   └── manifest-manager.js    # Gerenciador de manifests
└── manifests/
    └── Leads_SalesEngagement.json  # Manifest exemplo
```
