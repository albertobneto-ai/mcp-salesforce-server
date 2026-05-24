/**
 * Multi-Environment Configuration
 * Maps environment names to Salesforce org credentials
 * 
 * Environment flow: dev → qa → uat → prod
 * 
 * Credentials are loaded from environment variables:
 *   SF_{ENV}_LOGIN_URL, SF_{ENV}_USERNAME, SF_{ENV}_PASSWORD, SF_{ENV}_TOKEN
 * 
 * Example:
 *   SF_QA_LOGIN_URL=https://login.salesforce.com
 *   SF_QA_USERNAME=user@qa.org
 *   SF_QA_PASSWORD=pass
 *   SF_QA_TOKEN=token
 */

const ENVIRONMENTS = {
  dev: {
    name: "Development",
    branch: "develop",
    loginUrl: process.env.SF_DEV_LOGIN_URL || process.env.SF_LOGIN_URL,
    username: process.env.SF_DEV_USERNAME || process.env.SF_USERNAME,
    password: process.env.SF_DEV_PASSWORD || process.env.SF_PASSWORD,
    token: process.env.SF_DEV_TOKEN || process.env.SF_SECURITY_TOKEN,
    description: "Desenvolvimento e testes iniciais",
    autoPromote: true,
  },
  qa: {
    name: "Quality Assurance",
    branch: "staging",
    loginUrl: process.env.SF_QA_LOGIN_URL,
    username: process.env.SF_QA_USERNAME,
    password: process.env.SF_QA_PASSWORD,
    token: process.env.SF_QA_TOKEN,
    description: "Testes integrados e validação funcional",
    autoPromote: false,
  },
  uat: {
    name: "User Acceptance Testing",
    branch: "staging",
    loginUrl: process.env.SF_UAT_LOGIN_URL,
    username: process.env.SF_UAT_USERNAME,
    password: process.env.SF_UAT_PASSWORD,
    token: process.env.SF_UAT_TOKEN,
    description: "Validação pelo usuário final",
    autoPromote: false,
  },
  prod: {
    name: "Production",
    branch: "main",
    loginUrl: process.env.SF_PROD_LOGIN_URL,
    username: process.env.SF_PROD_USERNAME,
    password: process.env.SF_PROD_PASSWORD,
    token: process.env.SF_PROD_TOKEN,
    description: "Ambiente produtivo",
    autoPromote: false,
  },
};

const PROMOTION_ORDER = ["dev", "qa", "uat", "prod"];

function getEnvironment(envName) {
  const env = ENVIRONMENTS[envName];
  if (!env) return null;
  return {
    ...env,
    configured: !!(env.loginUrl && env.username && env.password),
  };
}

function getPromotionTarget(currentEnv) {
  const idx = PROMOTION_ORDER.indexOf(currentEnv);
  if (idx < 0 || idx >= PROMOTION_ORDER.length - 1) return null;
  return PROMOTION_ORDER[idx + 1];
}

function getAllEnvironments() {
  return PROMOTION_ORDER.map((key) => ({
    key,
    ...getEnvironment(key),
  }));
}

export { ENVIRONMENTS, PROMOTION_ORDER, getEnvironment, getPromotionTarget, getAllEnvironments };
