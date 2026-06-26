import { Router } from 'express';
import dns from 'dns';
import { promisify } from 'util';

const router = Router();
const resolveMx = promisify(dns.resolveMx);
const resolve4 = promisify(dns.resolve4);

// Disposable email domains (top 80+)
const DISPOSABLE = new Set([
  'mailinator.com','guerrillamail.com','tempmail.com','throwaway.email','yopmail.com',
  'sharklasers.com','guerrillamailblock.com','grr.la','dispostable.com','trashmail.com',
  'fakeinbox.com','mailnesia.com','maildrop.cc','discard.email','tempr.email',
  'getnada.com','mohmal.com','burnermail.io','temp-mail.org','10minutemail.com',
  'minutemail.com','emailondeck.com','mailtemp.org','tempail.com','crazymailing.com',
  'mytemp.email','cs.email','tmail.ws','harakirimail.com','jetable.org',
  'trashmail.net','trashmail.me','mailcatch.com','mail-temporaire.fr','tempinbox.com',
  'spam4.me','binkmail.com','spamavert.com','filzmail.com','mailexpire.com',
  'spamgourmet.com','guerrillamail.info','guerrillamail.net','guerrillamail.de',
  'guerrillamail.biz','mailnull.com','spamfree24.org','trash-mail.com','mytrashmail.com',
  'mailzilla.com','bugmenot.com','devnullmail.com','rmqkr.net','sharklasers.com',
  'guerrillamailblock.com','pokemail.net','spam.la','koszmail.pl','sogetthis.com',
  'einrot.com','mailmoat.com','discardmail.com','mailsac.com','mailforspam.com',
  'safetymail.info','tempmailaddress.com','emailfake.com','tempmailo.com','emailsensei.com',
  'fakemail.net','mailnator.com','disposableemailaddresses.emailmiser.com',
  'guerrillamail.com','mailinator.net','mailinator2.com','mailtothis.com',
  'meltmail.com','spaml.com','uggsrock.com','trashymail.com','kurzepost.de',
  'objectmail.com','proxymail.eu','rcpt.at','trash-mail.at','trashmail.at'
]);

// Free email providers
const FREE_PROVIDERS = new Set([
  'gmail.com','hotmail.com','outlook.com','yahoo.com','yahoo.com.br',
  'live.com','aol.com','icloud.com','mail.com','protonmail.com',
  'zoho.com','gmx.com','yandex.com','tutanota.com','fastmail.com',
  'bol.com.br','uol.com.br','terra.com.br','ig.com.br','globo.com',
  'r7.com','zipmail.com.br','oi.com.br','pop.com.br'
]);

// RFC 5322 email regex
const EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

async function validateEmail(email) {
  const result = {
    email,
    valid: false,
    status: 'unknown',
    score: 0,
    domain: '',
    checks: {
      syntax: false,
      domainExists: false,
      mxExists: false,
      notDisposable: true,
      notFreeProvider: true
    },
    provider: 'unknown',
    suggestion: null,
    validatedAt: new Date().toISOString()
  };

  // 1. Syntax check
  if (!email || !EMAIL_REGEX.test(email)) {
    result.status = 'invalid';
    result.checks.syntax = false;
    result.score = 0;
    return result;
  }
  result.checks.syntax = true;
  result.score += 20;

  const domain = email.split('@')[1].toLowerCase();
  result.domain = domain;

  // 2. Typo detection
  const typoMap = {
    'gamil.com':'gmail.com', 'gmial.com':'gmail.com', 'gmai.com':'gmail.com',
    'gmal.com':'gmail.com', 'gmail.co':'gmail.com', 'gmail.com.br':'gmail.com',
    'hotmal.com':'hotmail.com', 'hotmial.com':'hotmail.com', 'hotmai.com':'hotmail.com',
    'hotmaill.com':'hotmail.com', 'hitmail.com':'hotmail.com',
    'outlok.com':'outlook.com', 'outllok.com':'outlook.com', 'outook.com':'outlook.com',
    'yaho.com':'yahoo.com', 'yahooo.com':'yahoo.com', 'yhoo.com':'yahoo.com',
    'uol.com':'uol.com.br', 'bol.com':'bol.com.br'
  };
  if (typoMap[domain]) {
    result.suggestion = email.replace(domain, typoMap[domain]);
  }

  // 3. Disposable check
  if (DISPOSABLE.has(domain)) {
    result.checks.notDisposable = false;
    result.status = 'disposable';
    result.score = 10;
    result.provider = 'disposable';
    result.valid = false;
    return result;
  }
  result.score += 20;

  // 4. Free provider check
  if (FREE_PROVIDERS.has(domain)) {
    result.checks.notFreeProvider = false;
    result.provider = 'free';
  } else {
    result.provider = 'corporate';
    result.score += 10;
  }

  // 5. Domain DNS check
  try {
    await resolve4(domain);
    result.checks.domainExists = true;
    result.score += 20;
  } catch {
    result.checks.domainExists = false;
    result.status = 'invalid';
    result.score = Math.min(result.score, 20);
    result.valid = false;
    return result;
  }

  // 6. MX records check
  try {
    const mx = await resolveMx(domain);
    if (mx && mx.length > 0) {
      result.checks.mxExists = true;
      result.score += 30;
    } else {
      result.checks.mxExists = false;
      result.score = Math.min(result.score, 40);
    }
  } catch {
    result.checks.mxExists = false;
    result.score = Math.min(result.score, 40);
  }

  // Final status
  if (result.score >= 80) {
    result.status = 'valid';
    result.valid = true;
  } else if (result.score >= 50) {
    result.status = 'risky';
    result.valid = true;
  } else {
    result.status = 'invalid';
    result.valid = false;
  }

  return result;
}

// GET /validate/:email
router.get('/validate/:email', async (req, res) => {
  const email = decodeURIComponent(req.params.email).trim().toLowerCase();
  console.log('[email-validation] Validating: ' + email);
  try {
    const result = await validateEmail(email);
    console.log('[email-validation] Result: ' + result.status + ' score=' + result.score);
    return res.json(result);
  } catch (err) {
    console.error('[email-validation] Error:', err.message);
    return res.status(500).json({ error: err.message, email });
  }
});

// Health
router.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'email-validation', checks: ['syntax','dns','mx','disposable','free-provider','typo'] });
});

export default router;
